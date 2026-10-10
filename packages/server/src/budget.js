import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
const integer = n => Number.isSafeInteger(n) && n >= 0;
// Slim port of Gen-2 runtime/budget/{sqlite,gate}: reservation under BEGIN IMMEDIATE,
// UNIQUE claims, burned before provider opening, conservative unknown recovery.
export class SQLiteBudgetLedger {
  constructor(storage, { sessionCapMicro = 10_000_000, visitorCapMicro = sessionCapMicro } = {}) {
    if (!integer(sessionCapMicro) || !integer(visitorCapMicro)) throw new TypeError('Invalid budget cap');
    this.storage = storage; this.db = storage.db; this.sessionCapMicro = sessionCapMicro; this.visitorCapMicro = visitorCapMicro;
    this.db.exec(`PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS budget_attempts (
      attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), lane TEXT NOT NULL,
      max_micro INTEGER NOT NULL CHECK(max_micro >= 0), claim_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('admitted','claimed','dispatched','settled')),
      request_sha256 TEXT NOT NULL, binding_sha256 TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('completed','cancelled','uncertain')), usage TEXT,
      settled_micro INTEGER CHECK(settled_micro >= 0), terminal_json TEXT,
      overrun INTEGER NOT NULL DEFAULT 0 CHECK(overrun IN (0,1)),
      CHECK((state='settled' AND outcome IS NOT NULL AND settled_micro IS NOT NULL)
        OR (state!='settled' AND outcome IS NULL AND settled_micro IS NULL)));
      CREATE INDEX IF NOT EXISTS budget_session ON budget_attempts(session_id);`);
    if (!this.db.prepare('PRAGMA table_info(budget_attempts)').all().some(column => column.name === 'overrun')) {
      this.db.exec('ALTER TABLE budget_attempts ADD COLUMN overrun INTEGER NOT NULL DEFAULT 0 CHECK(overrun IN (0,1))');
    }
    const columns = this.db.prepare('PRAGMA table_info(budget_attempts)').all();
    for (const name of ['max_visitor_micro', 'settled_visitor_micro']) {
      if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE budget_attempts ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0 CHECK(${name} >= 0)`);
    }
    if (!columns.some(c => c.name === 'voice_reconciliation_json')) this.db.exec('ALTER TABLE budget_attempts ADD COLUMN voice_reconciliation_json TEXT');
  }
  visitorUsed(sessionId) {
    return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_visitor_micro ELSE max_visitor_micro END),0) AS n
      FROM budget_attempts WHERE session_id=? AND lane='voice'`).get(sessionId).n;
  }
  used(sessionId) {
    return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_micro ELSE max_micro END),0) AS n
      FROM budget_attempts WHERE session_id=?`).get(sessionId).n;
  }
  canAdmit(sessionId, maxMicro, maxVisitorMicro = 0) { return integer(maxMicro) && integer(maxVisitorMicro) &&
    maxMicro <= this.sessionCapMicro - this.used(sessionId) && maxVisitorMicro <= this.visitorCapMicro - this.visitorUsed(sessionId); }
  admit({ attemptId = randomUUID(), sessionId, lane, maxMicro, maxVisitorMicro = 0, requestSha256, bindingSha256 }) {
    if (!integer(maxMicro) || !integer(maxVisitorMicro) || !['reaction', 'understanding', 'voice', 'concept', 'extractor'].includes(lane) ||
      lane === 'extractor' && (maxMicro !== 0 || maxVisitorMicro !== 0) ||
      ![attemptId, sessionId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(v)) ||
      ![requestSha256, bindingSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v))) throw new TypeError('Invalid admission');
    return this.storage.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM budget_attempts WHERE attempt_id=?').get(attemptId)) throw new PluginError('already-claimed');
      if (!this.canAdmit(sessionId, maxMicro, maxVisitorMicro)) throw new PluginError('not-admitted', 'Budget denied');
      this.db.prepare(`INSERT INTO budget_attempts(attempt_id,session_id,lane,max_micro,state,request_sha256,binding_sha256)
        VALUES (?,?,?,?,'admitted',?,?)`).run(attemptId, sessionId, lane, maxMicro, requestSha256, bindingSha256);
      this.db.prepare('UPDATE budget_attempts SET max_visitor_micro=? WHERE attempt_id=?').run(maxVisitorMicro, attemptId);
      return { attemptId, maxMicro };
    });
  }
  claim(attemptId) {
    return this.storage.transaction(() => {
      const claimId = randomUUID();
      const result = this.db.prepare("UPDATE budget_attempts SET state='claimed',claim_id=? WHERE attempt_id=? AND state='admitted'").run(claimId, attemptId);
      if (!result.changes) throw new PluginError('already-claimed');
      let consumed = false;
      return Object.freeze({ attemptId, claimId, consume: () => {
        if (consumed) throw new PluginError('already-claimed');
        consumed = true;
        const result = this.db.prepare("UPDATE budget_attempts SET state='dispatched' WHERE attempt_id=? AND claim_id=? AND state='claimed'").run(attemptId, claimId);
        if (!result.changes) throw new PluginError('already-claimed');
      } });
    });
  }
  settle(claimId, terminal, rates = { inputMicro: 0, outputMicro: 0 }) {
    if (!terminal || !['completed', 'cancelled', 'uncertain'].includes(terminal.outcome) ||
      !['inputMicro', 'outputMicro'].every(k => integer(rates[k]))) throw new TypeError('Invalid terminal report');
    if (terminal.outcome !== 'uncertain' && (!terminal.usage || !['inputTokens', 'outputTokens'].every(k => integer(terminal.usage[k])))) throw new TypeError('Invalid usage');
    return this.storage.transaction(() => {
      const row = this.db.prepare('SELECT * FROM budget_attempts WHERE claim_id=?').get(claimId);
      if (!row || terminal.attemptId !== row.attempt_id) throw new PluginError('not-admitted');
      const bytes = JSON.stringify({ attemptId: terminal.attemptId, outcome: terminal.outcome,
        ...(terminal.outcome === 'uncertain' ? {} : { usage: terminal.usage }),
        ...(typeof terminal.servedModel === 'string' && terminal.servedModel.trim() ? { servedModel: terminal.servedModel } : {}) });
      if (row.state === 'settled') {
        if (row.terminal_json !== bytes) throw new PluginError('already-claimed');
        return this.get(row.attempt_id); // exact terminal retries are idempotent
      }
      const dispatched = row.state === 'dispatched';
      const actual = !dispatched ? 0 : terminal.outcome === 'uncertain' ? row.max_micro
        : terminal.usage.inputTokens * rates.inputMicro + terminal.usage.outputTokens * rates.outputMicro;
      // Unknown dispatched usage retains the maximum; known overruns remain visible as actual spend.
      const uncertain = !integer(actual);
      const usage = dispatched ? terminal.usage : { inputTokens: 0, outputTokens: 0 };
      this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,usage=?,settled_micro=?,terminal_json=?,overrun=? WHERE claim_id=?")
        .run(!dispatched ? 'cancelled' : uncertain ? 'uncertain' : terminal.outcome, usage ? JSON.stringify(usage) : null,
          uncertain ? row.max_micro : actual, bytes, actual > row.max_micro ? 1 : 0, claimId);
      return this.get(row.attempt_id);
    });
  }
  settleVoice(claimId, terminal) {
    const known = terminal?.closureConfirmed === true && ['completed', 'cancelled'].includes(terminal.outcome) &&
      ['providerSeconds', 'providerMinutes', 'pausedSeconds', 'visitorSeconds'].every(k => Number.isFinite(terminal.usage?.[k]) && terminal.usage[k] >= 0) &&
      ['upstreamMicro', 'visitorMicro'].every(k => integer(terminal.usage?.[k]));
    if (!terminal || !['completed', 'cancelled', 'uncertain'].includes(terminal.outcome) ||
      terminal.outcome !== 'uncertain' && !known) throw new TypeError('Invalid voice terminal');
    return this.storage.transaction(() => {
      const row = this.db.prepare('SELECT * FROM budget_attempts WHERE claim_id=? AND lane=\'voice\'').get(claimId);
      if (!row || row.attempt_id !== terminal.attemptId) throw new PluginError('not-admitted');
      const bytes = JSON.stringify(terminal);
      if (row.state === 'settled') {
        if (row.terminal_json !== bytes) throw new PluginError('already-claimed');
        return this.get(row.attempt_id);
      }
      const dispatched = row.state === 'dispatched', uncertain = dispatched && !known;
      const actual = !dispatched ? 0 : uncertain ? row.max_micro : terminal.usage.upstreamMicro;
      this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,usage=?,settled_micro=?,terminal_json=?,overrun=?,settled_visitor_micro=? WHERE claim_id=?")
        .run(!dispatched ? 'cancelled' : uncertain ? 'uncertain' : terminal.outcome,
          terminal.usage ? JSON.stringify(terminal.usage) : null, actual, bytes, actual > row.max_micro ? 1 : 0, !dispatched ? 0 : uncertain ? row.max_visitor_micro : terminal.usage.visitorMicro, claimId);
      return this.get(row.attempt_id);
    });
  }
  reconcileVoice(attemptId, terminal) {
    // Later authenticated details correct costs without emitting a second terminal.
    if (terminal?.closureConfirmed !== true || !terminal.usage ||
      !['upstreamMicro', 'visitorMicro'].every(k => integer(terminal.usage[k])) ||
      !['providerSeconds', 'providerMinutes', 'pausedSeconds', 'visitorSeconds'].every(k => Number.isFinite(terminal.usage[k]) && terminal.usage[k] >= 0)) {
      throw new TypeError('Confirmed voice reconciliation required');
    }
    return this.storage.transaction(() => {
      const row = this.get(attemptId);
      if (!row || row.lane !== 'voice' || row.state !== 'settled') throw new PluginError('not-admitted');
      const bytes = JSON.stringify(terminal);
      if (row.voice_reconciliation_json !== null) {
        const recorded = JSON.parse(row.voice_reconciliation_json);
        if (recorded.providerSessionId !== terminal.providerSessionId ||
          Object.keys({ ...recorded.usage, ...terminal.usage }).some(key => recorded.usage[key] !== terminal.usage[key])) {
          throw new PluginError('already-claimed', 'Voice reconciliation already settled');
        }
        return row;
      }
      this.db.prepare('UPDATE budget_attempts SET usage=?,settled_micro=?,settled_visitor_micro=?,overrun=?,voice_reconciliation_json=? WHERE attempt_id=?')
        .run(JSON.stringify(terminal.usage), terminal.usage.upstreamMicro, terminal.usage.visitorMicro,
          terminal.usage.upstreamMicro > row.max_micro ? 1 : 0, bytes, attemptId);
      return this.get(attemptId);
    });
  }
  get(attemptId) { return this.db.prepare('SELECT * FROM budget_attempts WHERE attempt_id=?').get(attemptId); }
  recover(sessionId) {
    return this.storage.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM budget_attempts WHERE state!='settled' AND (? IS NULL OR session_id=?)").all(sessionId ?? null, sessionId ?? null);
      for (const row of rows) {
        const dispatched = row.state === 'dispatched';
        const terminal = { attemptId: row.attempt_id, outcome: dispatched ? 'uncertain' : 'cancelled',
          ...(row.lane === 'voice' ? { closureConfirmed: !dispatched, chargedMicro: dispatched ? row.max_micro : 0,
            ...(dispatched ? {} : { usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } }) }
            : dispatched ? {} : { usage: { inputTokens: 0, outputTokens: 0 } }) };
        this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,settled_micro=?,usage=?,terminal_json=?,settled_visitor_micro=? WHERE attempt_id=?")
          .run(terminal.outcome, dispatched ? row.max_micro : 0, terminal.usage ? JSON.stringify(terminal.usage) : null,
            JSON.stringify(terminal), dispatched ? row.max_visitor_micro : 0, row.attempt_id);
      }
      return rows.length;
    });
  }
}
