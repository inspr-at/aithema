import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
const integer = n => Number.isSafeInteger(n) && n >= 0;
// Slim port of Gen-2 runtime/budget/{sqlite,gate}: reservation under BEGIN IMMEDIATE,
// UNIQUE claims, burned before provider opening, conservative unknown recovery.
export class SQLiteBudgetLedger {
  constructor(storage, { sessionCapMicro = 10_000_000 } = {}) {
    if (!integer(sessionCapMicro)) throw new TypeError('Invalid budget cap');
    this.storage = storage; this.db = storage.db; this.sessionCapMicro = sessionCapMicro;
    this.db.exec(`CREATE TABLE IF NOT EXISTS budget_attempts (
      attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), lane TEXT NOT NULL,
      max_micro INTEGER NOT NULL CHECK(max_micro >= 0), claim_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('admitted','claimed','dispatched','settled')),
      request_sha256 TEXT NOT NULL, binding_sha256 TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('completed','cancelled','uncertain')), usage TEXT,
      settled_micro INTEGER CHECK(settled_micro >= 0), terminal_json TEXT,
      CHECK((state='settled' AND outcome IS NOT NULL AND settled_micro IS NOT NULL)
        OR (state!='settled' AND outcome IS NULL AND settled_micro IS NULL)));
      CREATE INDEX IF NOT EXISTS budget_session ON budget_attempts(session_id);`);
  }
  used(sessionId) {
    return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_micro ELSE max_micro END),0) AS n
      FROM budget_attempts WHERE session_id=?`).get(sessionId).n;
  }
  canAdmit(sessionId, maxMicro) { return integer(maxMicro) && maxMicro <= this.sessionCapMicro - this.used(sessionId); }
  admit({ attemptId = randomUUID(), sessionId, lane, maxMicro, requestSha256, bindingSha256 }) {
    if (!integer(maxMicro) || !['reaction', 'understanding'].includes(lane) ||
      ![attemptId, sessionId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(v)) ||
      ![requestSha256, bindingSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v))) throw new TypeError('Invalid admission');
    return this.storage.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM budget_attempts WHERE attempt_id=?').get(attemptId)) throw new PluginError('already-claimed');
      if (!this.canAdmit(sessionId, maxMicro)) throw new PluginError('not-admitted', 'Budget denied');
      this.db.prepare(`INSERT INTO budget_attempts(attempt_id,session_id,lane,max_micro,state,request_sha256,binding_sha256)
        VALUES (?,?,?,?,'admitted',?,?)`).run(attemptId, sessionId, lane, maxMicro, requestSha256, bindingSha256);
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
        ...(terminal.outcome === 'uncertain' ? {} : { usage: terminal.usage }) });
      if (row.state === 'settled') {
        if (row.terminal_json !== bytes) throw new PluginError('already-claimed');
        return this.get(row.attempt_id); // exact terminal retries are idempotent
      }
      const actual = terminal.outcome === 'uncertain' ? row.max_micro
        : terminal.usage.inputTokens * rates.inputMicro + terminal.usage.outputTokens * rates.outputMicro;
      // A malformed or under-reserved provider result never releases reserved money.
      const uncertain = !integer(actual) || actual > row.max_micro;
      this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,usage=?,settled_micro=?,terminal_json=? WHERE claim_id=?")
        .run(uncertain ? 'uncertain' : terminal.outcome, terminal.usage ? JSON.stringify(terminal.usage) : null,
          uncertain ? row.max_micro : actual, bytes, claimId);
      return this.get(row.attempt_id);
    });
  }
  get(attemptId) { return this.db.prepare('SELECT * FROM budget_attempts WHERE attempt_id=?').get(attemptId); }
  recover(sessionId) {
    return this.storage.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM budget_attempts WHERE state!='settled' AND (? IS NULL OR session_id=?)").all(sessionId ?? null, sessionId ?? null);
      for (const row of rows) {
        const claimed = row.claim_id !== null;
        const terminal = { attemptId: row.attempt_id, outcome: claimed ? 'uncertain' : 'cancelled',
          ...(claimed ? {} : { usage: { inputTokens: 0, outputTokens: 0 } }) };
        this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,settled_micro=?,terminal_json=? WHERE attempt_id=?")
          .run(terminal.outcome, claimed ? row.max_micro : 0, JSON.stringify(terminal), row.attempt_id);
      }
      return rows.length;
    });
  }
}
