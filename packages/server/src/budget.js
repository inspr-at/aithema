import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
import { generationId } from '../../core/src/cost.js';
const integer = n => Number.isSafeInteger(n) && n >= 0;
const confirmed = "state='settled' AND (outcome!='uncertain' OR cost_reconciliation_json IS NOT NULL OR voice_reconciliation_json IS NOT NULL) AND COALESCE(json_extract(usage,'$.costEstimated'),0)=0 AND COALESCE(json_extract(cost_reconciliation_json,'$.estimated'),0)=0";
// Slim port of Gen-2 runtime/budget/{sqlite,gate}: reservation under BEGIN IMMEDIATE,
// UNIQUE claims, burned before provider opening, conservative unknown recovery.
export class SQLiteBudgetLedger {
  constructor(storage, { sessionCapMicro = 10_000_000, visitorCapMicro = sessionCapMicro, now = Date.now } = {}) {
    if (!integer(sessionCapMicro) || !integer(visitorCapMicro)) throw new TypeError('Invalid budget cap');
    this.now = now; this.storage = storage; this.db = storage.db; this.sessionCapMicro = sessionCapMicro; this.visitorCapMicro = visitorCapMicro;
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
    for (const name of ['max_visitor_micro', 'settled_visitor_micro', 'voice_exposure_micro', 'voice_visitor_exposure_micro', 'voice_closing']) {
      if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE budget_attempts ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0 CHECK(${name} >= 0)`);
    }
    if (!columns.some(c => c.name === 'voice_estimate_json')) this.db.exec('ALTER TABLE budget_attempts ADD COLUMN voice_estimate_json TEXT');
    if (!columns.some(c => c.name === 'voice_reconciliation_json')) this.db.exec('ALTER TABLE budget_attempts ADD COLUMN voice_reconciliation_json TEXT');
    for (const name of ['owner_hash', 'provider_cost_json', 'cost_reconciliation_json']) {
      if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE budget_attempts ADD COLUMN ${name} TEXT`);
    }
    this.db.prepare(`UPDATE budget_attempts SET owner_hash=(SELECT json_extract(snapshot,'$.ownerHash') FROM sessions WHERE id=session_id)
      WHERE owner_hash IS NULL`).run();
    this.db.exec(`CREATE TABLE IF NOT EXISTS budget_corrections (
      id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, lane TEXT NOT NULL, at_ms INTEGER NOT NULL,
      old_micro INTEGER NOT NULL, new_micro INTEGER NOT NULL,
      old_visitor_micro INTEGER NOT NULL, new_visitor_micro INTEGER NOT NULL,
      previous_json TEXT NOT NULL, evidence_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS budget_correction_attempt ON budget_corrections(attempt_id);
      CREATE TRIGGER IF NOT EXISTS budget_corrections_no_update BEFORE UPDATE ON budget_corrections
      BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE INDEX IF NOT EXISTS budget_owner ON budget_attempts(owner_hash);
      CREATE INDEX IF NOT EXISTS budget_cost_pending ON budget_attempts(attempt_id)
      WHERE state='settled' AND provider_cost_json IS NOT NULL AND COALESCE(json_extract(provider_cost_json,'$.reconciled'),0)=0;
      CREATE INDEX IF NOT EXISTS budget_cost_legacy ON budget_attempts(attempt_id)
      WHERE state='settled' AND provider_cost_json IS NULL AND outcome='uncertain' AND lane IN ('reaction','understanding');
      CREATE INDEX IF NOT EXISTS budget_cost_deferred ON budget_attempts(json_extract(provider_cost_json,'$.retryAt'))
      WHERE state='settled' AND COALESCE(json_extract(provider_cost_json,'$.reconciled'),0)=1
        AND json_extract(provider_cost_json,'$.retryAt') IS NOT NULL;`);
  }
  breakdown(sessionId, { visitor = false, ownerHash } = {}) {
    const settled = visitor ? 'settled_visitor_micro' : 'settled_micro', maximum = visitor ? 'max_visitor_micro' : 'max_micro';
    const filter = ownerHash === undefined ? 'session_id=?' : 'owner_hash=?';
    return this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state!='settled' AND voice_closing=0 THEN ${maximum} ELSE 0 END),0) AS reservedMicro,
      COALESCE(SUM(CASE WHEN ${confirmed} THEN ${settled} ELSE 0 END),0) AS confirmedSpendMicro,
      COALESCE(SUM(CASE WHEN state!='settled' AND voice_closing=1 THEN ${maximum}
        WHEN state='settled' AND NOT (${confirmed}) THEN ${settled} ELSE 0 END),0) AS uncertainSpendMicro
      FROM budget_attempts WHERE ${filter} ${visitor ? "AND lane='voice'" : ''}`).get(ownerHash ?? sessionId);
  }
  // Visitor presentation only. Admission, uncertainty and charging continue to
  // use breakdown()/used() and their full maxima. Reading never settles a row.
  displayBreakdown(sessionId, { ownerHash, now = this.now() } = {}) {
    const filter = ownerHash === undefined ? 'session_id=?' : 'owner_hash=?';
    const rows = this.db.prepare(`SELECT *, (${confirmed}) AS confirmed FROM budget_attempts WHERE ${filter}`).all(ownerHash ?? sessionId);
    const costs = { reservedMicro: 0, confirmedSpendMicro: 0, uncertainSpendMicro: 0 };
    for (const row of rows) {
      if (row.confirmed) { costs.confirmedSpendMicro += row.settled_micro; continue; }
      let expected = row.state === 'settled' ? row.settled_micro : row.max_micro;
      if (row.lane === 'voice' && (row.state !== 'settled' || row.outcome === 'uncertain' && !row.voice_reconciliation_json)) {
        const estimate = JSON.parse(row.voice_estimate_json ?? 'null'), usage = JSON.parse(row.usage ?? 'null');
        const ceiling = estimate?.maxMicro ?? row.max_micro;
        const elapsed = estimate?.startedAt === undefined ? 0 : Math.max(0, (estimate.endedAt ?? now) - estimate.startedAt);
        expected = Math.min(ceiling, Math.ceil(elapsed / 60_000 * (estimate?.upstreamMicroPerMinute ?? 0)));
        if (integer(usage?.upstreamMicro)) expected = Math.max(expected, usage.costEstimated === true ? Math.min(ceiling, usage.upstreamMicro) : usage.upstreamMicro);
      } else if (row.provider_cost_json && (row.state !== 'settled' || row.outcome === 'uncertain' && !row.cost_reconciliation_json)) {
        const record = JSON.parse(row.provider_cost_json);
        // Same persisted lane/byte fallback as AIT-163. A real receipt is not
        // capped; estimates are bounded by the reservation, including bytes.
        expected = record.chargedMicro ?? Math.max(record.observedCostMicro ?? 0, Math.min(row.max_micro, record.estimateMicro ?? row.max_micro));
        if (row.state !== 'settled' && row.state !== 'dispatched') expected = 0;
      }
      costs.uncertainSpendMicro += expected;
    }
    return costs;
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
  admit({ attemptId = randomUUID(), sessionId, lane, maxMicro, maxVisitorMicro = 0, requestSha256, bindingSha256, providerCost, voiceExposure, voiceEstimate }) {
    if (voiceEstimate !== undefined && (lane !== 'voice' || !['upstreamMicroPerMinute', 'visitorMicroPerMinute'].every(k => integer(voiceEstimate?.[k])))) throw new TypeError('Invalid voice estimate');
    if (!integer(maxMicro) || !integer(maxVisitorMicro) || !['reaction', 'understanding', 'voice', 'concept', 'extractor'].includes(lane) ||
      lane === 'extractor' && (maxMicro !== 0 || maxVisitorMicro !== 0) ||
      voiceExposure !== undefined && (lane !== 'voice' || !integer(voiceExposure?.maxMicro) || !integer(voiceExposure?.maxVisitorMicro) ||
        voiceExposure.maxMicro < maxMicro || voiceExposure.maxVisitorMicro < maxVisitorMicro) ||
      ![attemptId, sessionId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(v)) ||
      ![requestSha256, bindingSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v))) throw new TypeError('Invalid admission');
    return this.storage.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM budget_attempts WHERE attempt_id=?').get(attemptId)) throw new PluginError('already-claimed');
      if (!this.canAdmit(sessionId, maxMicro, maxVisitorMicro)) throw new PluginError('not-admitted', 'Budget denied');
      this.db.prepare(`INSERT INTO budget_attempts(attempt_id,session_id,lane,max_micro,state,request_sha256,binding_sha256)
        VALUES (?,?,?,?,'admitted',?,?)`).run(attemptId, sessionId, lane, maxMicro, requestSha256, bindingSha256);
      this.db.prepare('UPDATE budget_attempts SET max_visitor_micro=? WHERE attempt_id=?').run(maxVisitorMicro, attemptId);
      if (voiceExposure) this.db.prepare('UPDATE budget_attempts SET voice_exposure_micro=?,voice_visitor_exposure_micro=? WHERE attempt_id=?')
        .run(voiceExposure.maxMicro, voiceExposure.maxVisitorMicro, attemptId);
      if (voiceEstimate) this.db.prepare('UPDATE budget_attempts SET voice_estimate_json=? WHERE attempt_id=?')
        .run(JSON.stringify({ ...voiceEstimate, maxMicro }), attemptId);
      const ownerHash = this.db.prepare("SELECT json_extract(snapshot,'$.ownerHash') AS h FROM sessions WHERE id=?").get(sessionId).h;
      this.db.prepare('UPDATE budget_attempts SET owner_hash=?,provider_cost_json=? WHERE attempt_id=?')
        .run(ownerHash ?? null, providerCost ? JSON.stringify(providerCost) : null, attemptId);
      return { attemptId, maxMicro };
    });
  }
  observeCost(attemptId, evidence) {
    if (evidence.generationId !== undefined && !generationId(evidence.generationId) ||
      evidence.chargedMicro !== undefined && !integer(evidence.chargedMicro) ||
      evidence.observedCostMicro !== undefined && !integer(evidence.observedCostMicro)) throw new TypeError('Invalid provider cost evidence');
    const lateReceipt = this.storage.transaction(() => {
      const row = this.get(attemptId);
      if (!row?.provider_cost_json) throw new PluginError('not-admitted');
      const previous = JSON.parse(row.provider_cost_json);
      if (previous.generationId && evidence.generationId && previous.generationId !== evidence.generationId ||
        previous.chargedMicro !== undefined && evidence.chargedMicro !== undefined && previous.chargedMicro !== evidence.chargedMicro) throw new PluginError('already-claimed');
      const changed = evidence.generationId && evidence.generationId !== previous.generationId ||
        evidence.chargedMicro !== undefined && evidence.chargedMicro !== previous.chargedMicro ||
        evidence.observedCostMicro !== undefined && evidence.observedCostMicro > (previous.observedCostMicro ?? 0);
      const next = { ...previous, ...evidence, ...(changed ? { reconciled: false } : {}), ...(evidence.observedCostMicro !== undefined
          ? { observedCostMicro: Math.max(previous.observedCostMicro ?? 0, evidence.observedCostMicro) } : {}) };
      if (changed) delete next.retryAt;
      this.db.prepare('UPDATE budget_attempts SET provider_cost_json=? WHERE attempt_id=?').run(JSON.stringify(next), attemptId);
      return row.state === 'settled' && evidence.chargedMicro !== undefined
        ? { ...evidence, ...(previous.generationId ? { generationId: previous.generationId } : {}) } : null;
    });
    if (lateReceipt) this.reconcileCost(attemptId, lateReceipt);
  }
  markCostDispatch(attemptId) {
    this.db.prepare("UPDATE budget_attempts SET provider_cost_json=json_set(provider_cost_json,'$.dispatchStarted',1) WHERE attempt_id=? AND state='dispatched'").run(attemptId);
  }
  reconcileCost(attemptId, evidence) {
    if (!integer(evidence?.chargedMicro) || evidence.estimated !== undefined && typeof evidence.estimated !== 'boolean') throw new TypeError('Provider cost required');
    return this.storage.transaction(() => {
      const row = this.get(attemptId);
      if (!row || row.state !== 'settled' || !row.provider_cost_json) throw new PluginError('not-admitted');
      const record = JSON.parse(row.provider_cost_json);
      if (record.generationId && record.generationId !== evidence.generationId) throw new PluginError('not-admitted');
      if (row.cost_reconciliation_json) {
        const previous = JSON.parse(row.cost_reconciliation_json);
        if (previous.estimated === true && evidence.estimated !== true) {
          // A receipt may supersede the visitor estimate once; the first terminal remains immutable.
        } else if (previous.estimated === true && evidence.estimated === true && evidence.chargedMicro > previous.chargedMicro) {
          // Additional observed usage can raise an estimate, never lower it.
        } else {
          if (previous.chargedMicro !== evidence.chargedMicro || previous.generationId && previous.generationId !== evidence.generationId) throw new PluginError('already-claimed');
          return row;
        }
      }
      if (row.outcome !== 'uncertain' && row.settled_micro !== evidence.chargedMicro) throw new PluginError('already-claimed');
      this.auditCorrection(row, evidence.chargedMicro, row.settled_visitor_micro, evidence);
      this.db.prepare('UPDATE budget_attempts SET settled_micro=?,overrun=?,cost_reconciliation_json=? WHERE attempt_id=?')
        .run(evidence.chargedMicro, evidence.chargedMicro > row.max_micro ? 1 : 0, JSON.stringify(evidence), attemptId);
      return this.get(attemptId);
    });
  }
  auditCorrection(row, newMicro, newVisitorMicro, evidence) {
    this.db.prepare(`INSERT INTO budget_corrections(attempt_id,lane,at_ms,old_micro,new_micro,
      old_visitor_micro,new_visitor_micro,previous_json,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.attempt_id, row.lane, Date.now(), row.settled_micro, newMicro, row.settled_visitor_micro,
        newVisitorMicro, JSON.stringify({ terminal: row.terminal_json, usage: row.usage,
          cost: row.cost_reconciliation_json, voice: row.voice_reconciliation_json }), JSON.stringify(evidence));
  }
  attachCost(attemptId, record) {
    this.db.prepare('UPDATE budget_attempts SET provider_cost_json=? WHERE attempt_id=? AND provider_cost_json IS NULL')
      .run(JSON.stringify(record), attemptId);
  }
  pendingCosts() {
    // Keep the predicates identical to the partial indexes: the legacy branch
    // must not turn the normal receipt lookup into a full-ledger OR scan.
    return this.db.prepare(`SELECT * FROM budget_attempts WHERE state='settled' AND provider_cost_json IS NOT NULL
      AND COALESCE(json_extract(provider_cost_json,'$.reconciled'),0)=0
      UNION ALL SELECT * FROM budget_attempts WHERE state='settled' AND provider_cost_json IS NULL
        AND outcome='uncertain' AND lane IN ('reaction','understanding') ORDER BY attempt_id`).all();
  }
  deferredCosts(atMs) {
    return this.db.prepare(`SELECT * FROM budget_attempts WHERE state='settled'
      AND COALESCE(json_extract(provider_cost_json,'$.reconciled'),0)=1
      AND json_extract(provider_cost_json,'$.retryAt') IS NOT NULL
      AND json_extract(provider_cost_json,'$.retryAt')<=? ORDER BY attempt_id`).all(atMs);
  }
  acknowledgeCost(attemptId, retryAt = null, retryAttempts = null) {
    if (retryAttempts !== null && !integer(retryAttempts)) throw new TypeError('Invalid cost retry count');
    this.db.prepare(`UPDATE budget_attempts SET provider_cost_json=json_set(provider_cost_json,'$.reconciled',1,'$.retryAt',?,
      '$.retryAttempts',COALESCE(?,json_extract(provider_cost_json,'$.retryAttempts'),0))
      WHERE attempt_id=?`).run(retryAt, retryAttempts, attemptId);
  }
  extendVoice(attemptId, { maxMicro, maxVisitorMicro }, ownerCanAdmit) {
    if (![maxMicro, maxVisitorMicro].every(integer)) throw new TypeError('Invalid voice extension');
    return this.storage.transaction(() => {
      const row = this.get(attemptId);
      if (!row || row.lane !== 'voice' || row.state !== 'dispatched') throw new PluginError('not-admitted');
      maxMicro = Math.max(maxMicro, row.max_micro); maxVisitorMicro = Math.max(maxVisitorMicro, row.max_visitor_micro);
      const extra = { maxMicro: maxMicro - row.max_micro, maxVisitorMicro: maxVisitorMicro - row.max_visitor_micro };
      if (!this.canAdmit(row.session_id, extra.maxMicro, extra.maxVisitorMicro) || ownerCanAdmit?.(extra) === false) throw new PluginError('not-admitted', 'Budget denied');
      this.db.prepare("UPDATE budget_attempts SET max_micro=?,max_visitor_micro=?,voice_estimate_json=json_set(voice_estimate_json,'$.maxMicro',?) WHERE attempt_id=?").run(maxMicro, maxVisitorMicro, maxMicro, attemptId);
      return { maxMicro, maxVisitorMicro };
    });
  }
  retainVoiceExposure(attemptId) {
    // Existing provider liability is not new admission. Record it even when it
    // exceeds the allowance; every subsequent admission sees the full exposure.
    return this.storage.transaction(() => {
      const row = this.get(attemptId);
      if (!row || row.lane !== 'voice' || row.state !== 'dispatched') throw new PluginError('not-admitted');
      this.freezeVoiceEstimate(attemptId);
      const maxMicro = Math.max(row.max_micro, row.voice_exposure_micro);
      const maxVisitorMicro = Math.max(row.max_visitor_micro, row.voice_visitor_exposure_micro);
      this.db.prepare('UPDATE budget_attempts SET max_micro=?,max_visitor_micro=?,voice_closing=1 WHERE attempt_id=?')
        .run(maxMicro, maxVisitorMicro, attemptId);
      return { maxMicro, maxVisitorMicro };
    });
  }
  freezeVoiceEstimate(attemptId) {
    this.db.prepare("UPDATE budget_attempts SET voice_estimate_json=json_set(voice_estimate_json,'$.endedAt',?) WHERE attempt_id=? AND json_extract(voice_estimate_json,'$.endedAt') IS NULL")
      .run(this.now(), attemptId);
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
        const result = this.db.prepare("UPDATE budget_attempts SET state='dispatched',voice_estimate_json=json_set(voice_estimate_json,'$.startedAt',?) WHERE attempt_id=? AND claim_id=? AND state='claimed'").run(this.now(), attemptId, claimId);
        if (!result.changes) throw new PluginError('already-claimed');
      } });
    });
  }
  settle(claimId, terminal, rates = { inputMicro: 0, outputMicro: 0 }) {
    if (!terminal || !['completed', 'cancelled', 'uncertain'].includes(terminal.outcome) ||
      !['inputMicro', 'outputMicro'].every(k => integer(rates[k])) ||
      terminal.chargedMicro !== undefined && !integer(terminal.chargedMicro)) throw new TypeError('Invalid terminal report');
    if (terminal.outcome !== 'uncertain' && (!terminal.usage || !['inputTokens', 'outputTokens'].every(k => integer(terminal.usage[k])))) throw new TypeError('Invalid usage');
    return this.storage.transaction(() => {
      const row = this.db.prepare('SELECT * FROM budget_attempts WHERE claim_id=?').get(claimId);
      if (!row || terminal.attemptId !== row.attempt_id) throw new PluginError('not-admitted');
      const bytes = JSON.stringify({ attemptId: terminal.attemptId, outcome: terminal.outcome,
        ...(terminal.outcome === 'uncertain' ? {} : { usage: terminal.usage }),
        ...(terminal.chargedMicro !== undefined ? { chargedMicro: terminal.chargedMicro } : {}),
        ...(typeof terminal.servedModel === 'string' && terminal.servedModel.trim() ? { servedModel: terminal.servedModel } : {}) });
      if (row.state === 'settled') {
        if (row.terminal_json !== bytes) throw new PluginError('already-claimed');
        return this.get(row.attempt_id); // exact terminal retries are idempotent
      }
      const dispatched = row.state === 'dispatched';
      if (row.provider_cost_json) this.db.prepare("UPDATE budget_attempts SET provider_cost_json=json_set(provider_cost_json,'$.settledAt',?) WHERE attempt_id=?")
        .run(Date.now(), row.attempt_id);
      const actual = !dispatched ? 0 : terminal.chargedMicro ?? (terminal.outcome === 'uncertain' ? row.max_micro
        : terminal.usage.inputTokens * rates.inputMicro + terminal.usage.outputTokens * rates.outputMicro);
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
      this.freezeVoiceEstimate(row.attempt_id);
      const dispatched = row.state === 'dispatched', uncertain = dispatched && !known;
      const actual = !dispatched ? 0 : uncertain ? Math.max(row.max_micro, row.voice_exposure_micro,
        integer(terminal.chargedMicro) ? terminal.chargedMicro : 0) : terminal.usage.upstreamMicro;
      this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,usage=?,settled_micro=?,terminal_json=?,overrun=?,settled_visitor_micro=? WHERE claim_id=?")
        .run(!dispatched ? 'cancelled' : uncertain ? 'uncertain' : terminal.outcome,
          terminal.usage ? JSON.stringify(terminal.usage) : null, actual, bytes, actual > row.max_micro ? 1 : 0,
          !dispatched ? 0 : uncertain ? Math.max(row.max_visitor_micro, row.voice_visitor_exposure_micro) : terminal.usage.visitorMicro, claimId);
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
        if (recorded.providerSessionId !== terminal.providerSessionId) throw new PluginError('already-claimed');
        if (recorded.usage.costEstimated === true && terminal.usage.costEstimated !== true) {
          // A duration estimate may be replaced once by the provider's actual charge.
        } else if (recorded.providerSessionId !== terminal.providerSessionId ||
          Object.keys({ ...recorded.usage, ...terminal.usage }).some(key => recorded.usage[key] !== terminal.usage[key])) {
          throw new PluginError('already-claimed', 'Voice reconciliation already settled');
        }
        else return row;
      }
      this.auditCorrection(row, terminal.usage.upstreamMicro, terminal.usage.visitorMicro, terminal);
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
        if (row.lane === 'voice') this.freezeVoiceEstimate(row.attempt_id);
        const providerRecord = row.provider_cost_json ? JSON.parse(row.provider_cost_json) : null;
        const dispatched = row.state === 'dispatched' && (!providerRecord || providerRecord.dispatchStarted === 1);
        const evidence = row.provider_cost_json ? JSON.parse(row.provider_cost_json) : null;
        const actual = dispatched && integer(evidence?.chargedMicro) ? evidence.chargedMicro : null;
        if (providerRecord) this.db.prepare("UPDATE budget_attempts SET provider_cost_json=json_set(provider_cost_json,'$.settledAt',?) WHERE attempt_id=?")
          .run(Date.now(), row.attempt_id);
        const exposure = dispatched && row.lane === 'voice' ? Math.max(row.max_micro, row.voice_exposure_micro) : row.max_micro;
        const visitorExposure = dispatched && row.lane === 'voice' ? Math.max(row.max_visitor_micro, row.voice_visitor_exposure_micro) : row.max_visitor_micro;
        const terminal = { attemptId: row.attempt_id, outcome: dispatched ? actual !== null ? 'completed' : 'uncertain' : 'cancelled',
          ...(row.lane === 'voice' ? { closureConfirmed: !dispatched, chargedMicro: dispatched ? exposure : 0,
            ...(dispatched ? {} : { usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } }) }
            : dispatched && actual === null ? {} : { usage: { inputTokens: 0, outputTokens: 0 } }),
          ...(actual !== null ? { chargedMicro: actual } : {}) };
        this.db.prepare("UPDATE budget_attempts SET state='settled',outcome=?,settled_micro=?,usage=?,terminal_json=?,settled_visitor_micro=? WHERE attempt_id=?")
          .run(terminal.outcome, dispatched ? actual ?? exposure : 0, terminal.usage ? JSON.stringify(terminal.usage) : null,
            JSON.stringify(terminal), dispatched ? visitorExposure : 0, row.attempt_id);
      }
      return rows.length;
    });
  }
}
