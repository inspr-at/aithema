import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../contracts/validate.js';
import { decodeDocument } from '../journal/port.js';
import { BudgetError, budgetBytes, budgetMessage, decodeMessage, encodeMessage } from './port.js';
import { checkDeploymentPeriod, deploymentPeriodAt, deploymentPeriodBounds, notificationThreshold } from './period.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_sessions (
  sid TEXT PRIMARY KEY REFERENCES journal_sessions(sid),
  principal_key TEXT NOT NULL, tenant_key TEXT NOT NULL, currency TEXT NOT NULL,
  session_cap_micro INTEGER NOT NULL CHECK(session_cap_micro >= 0),
  evidence INTEGER NOT NULL CHECK(evidence IN (0,1))
);
CREATE TABLE IF NOT EXISTS budget_caps (
  scope TEXT NOT NULL CHECK(scope IN ('principal','tenant')), scope_key TEXT NOT NULL,
  currency TEXT NOT NULL, cap_micro INTEGER NOT NULL CHECK(cap_micro >= 0),
  PRIMARY KEY(scope, scope_key, currency)
);
CREATE TABLE IF NOT EXISTS budget_holds (
  attempt_id TEXT PRIMARY KEY, hold_id TEXT UNIQUE,
  sid TEXT NOT NULL REFERENCES budget_sessions(sid),
  worker_generation INTEGER NOT NULL, auth_epoch INTEGER NOT NULL,
  lane TEXT NOT NULL, max_micro INTEGER NOT NULL CHECK(max_micro > 0), currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('admitted','denied','closed')),
  closed_reason TEXT CHECK(closed_reason IN ('void','settled','unknown')),
  created_at TEXT NOT NULL, closed_at TEXT,
  original_bytes BLOB NOT NULL, verdict_bytes BLOB NOT NULL,
  principal_key TEXT NOT NULL, tenant_key TEXT NOT NULL, budget_day TEXT NOT NULL,
  CHECK((state = 'denied' AND hold_id IS NULL) OR (state != 'denied' AND hold_id IS NOT NULL)),
  CHECK((state = 'closed' AND closed_reason IS NOT NULL AND closed_at IS NOT NULL)
    OR (state != 'closed' AND closed_reason IS NULL AND closed_at IS NULL))
);
CREATE TABLE IF NOT EXISTS budget_claims (
  claim_id TEXT PRIMARY KEY, hold_id TEXT NOT NULL UNIQUE REFERENCES budget_holds(hold_id),
  request_sha256 TEXT NOT NULL, worker_generation INTEGER NOT NULL, auth_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','settled','unknown')),
  settled_micro INTEGER CHECK(settled_micro >= 0), claimed_at TEXT NOT NULL, settled_at TEXT,
  settlement_bytes BLOB,
  CHECK((state = 'claimed' AND settled_micro IS NULL AND settled_at IS NULL)
    OR (state != 'claimed' AND settled_micro IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS budget_session_sum ON budget_holds(sid,currency,state);
CREATE INDEX IF NOT EXISTS budget_principal_sum ON budget_holds(principal_key,budget_day,currency,state);
CREATE INDEX IF NOT EXISTS budget_tenant_sum ON budget_holds(tenant_key,budget_day,currency,state);
CREATE VIEW IF NOT EXISTS budget_usage AS
SELECT h.*, CASE WHEN h.state = 'admitted' THEN h.max_micro
  WHEN h.closed_reason = 'void' OR h.state = 'denied' THEN 0
  ELSE c.settled_micro END AS charged_or_reserved_micro
FROM budget_holds h LEFT JOIN budget_claims c USING(hold_id);
CREATE TABLE IF NOT EXISTS budget_deployments (
  deployment_id TEXT PRIMARY KEY, currency TEXT NOT NULL, policy_bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_session_deployments (
  sid TEXT PRIMARY KEY REFERENCES budget_sessions(sid),
  deployment_id TEXT NOT NULL REFERENCES budget_deployments(deployment_id)
);
CREATE TABLE IF NOT EXISTS budget_deployment_periods (
  deployment_id TEXT NOT NULL REFERENCES budget_deployments(deployment_id), period_id TEXT NOT NULL,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  ceiling_micro INTEGER NOT NULL CHECK(ceiling_micro >= 0), notify_at_bytes BLOB NOT NULL,
  PRIMARY KEY(deployment_id,period_id)
);
CREATE TABLE IF NOT EXISTS budget_deployment_holds (
  hold_id TEXT PRIMARY KEY REFERENCES budget_holds(hold_id), deployment_id TEXT NOT NULL, period_id TEXT NOT NULL,
  FOREIGN KEY(deployment_id,period_id) REFERENCES budget_deployment_periods(deployment_id,period_id)
);
CREATE INDEX IF NOT EXISTS budget_deployment_sum ON budget_deployment_holds(deployment_id,period_id,hold_id);
CREATE TABLE IF NOT EXISTS budget_deployment_notifications (
  deployment_id TEXT NOT NULL, period_id TEXT NOT NULL, ratio TEXT NOT NULL, sid TEXT NOT NULL, client_event_id TEXT NOT NULL,
  PRIMARY KEY(deployment_id,period_id,ratio),
  FOREIGN KEY(deployment_id,period_id) REFERENCES budget_deployment_periods(deployment_id,period_id),
  FOREIGN KEY(sid,client_event_id) REFERENCES journal_records(sid,client_event_id)
);
`;

function count(n, name) {
  if (!Number.isSafeInteger(n) || n < 0) throw new BudgetError(400, `${name} must be a nonnegative safe integer`);
}

/**
 * Reference host BudgetPort, in the SAME SQLite file as SqliteJournal. Reading
 * journal_sessions under BEGIN IMMEDIATE makes takeover/epoch changes and
 * ledger decisions share one lock and one authority source, without a mirror.
 * Only host setup registers scopes/caps; delegated JSON never chooses them.
 */
export class SqliteBudgetLedger {
  #db;
  #now;

  constructor(filePath, { now = () => Date.now() } = {}) {
    this.#db = new DatabaseSync(filePath);
    this.#now = now;
    try {
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (!this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_sessions'").get()) {
        throw new BudgetError(400, 'Initialize SqliteJournal in the same SQLite file before the ledger');
      }
      // Additive tables also upgrade existing hosts, preserving every original
      // session, hold, verdict and journal byte. Concurrent opens share a lock.
      this.#transaction(() => {
        this.#db.exec(SCHEMA);
        if (!this.#db.prepare('PRAGMA table_info(budget_deployment_periods)').all().some((column) => column.name === 'notify_at_bytes')) {
          // Earlier hosts pinned the entire deployment policy. Its ratios are
          // therefore also the original ratios for every reserved period.
          this.#db.exec("ALTER TABLE budget_deployment_periods ADD COLUMN notify_at_bytes BLOB NOT NULL DEFAULT x'5b5d'");
          for (const row of this.#db.prepare('SELECT deployment_id, policy_bytes FROM budget_deployments').all()) {
            const policy = JSON.parse(Buffer.from(row.policy_bytes).toString('utf8'));
            this.#db.prepare('UPDATE budget_deployment_periods SET notify_at_bytes = ? WHERE deployment_id = ?')
              .run(Buffer.from(canonicalJson(policy.notify_at)), row.deployment_id);
          }
          // Those hosts also wrote period metadata on denial. Only periods
          // with a successful reservation were opened; keep all verdict bytes.
          this.#db.exec(`DELETE FROM budget_deployment_periods AS p WHERE NOT EXISTS
            (SELECT 1 FROM budget_deployment_holds h WHERE h.deployment_id = p.deployment_id AND h.period_id = p.period_id)`);
        }
      });
    } catch (error) { this.#db.close(); throw error; }
  }

  close() { this.#db.close(); }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  /** Immutable host scope registration; future-period ceiling/notifications may change. */
  registerSession({ sid, issuer, principal, currency, session_cap_micro, principal_day_cap_micro, tenant_day_cap_micro, evidence, deployment_period }) {
    for (const [key, value] of Object.entries({ sid, issuer, principal, currency })) {
      if (typeof value !== 'string' || !value.length) throw new BudgetError(400, `${key} is required`);
    }
    if (!/^[A-Z]{3}$/.test(currency) || typeof evidence !== 'boolean') throw new BudgetError(400, 'Invalid currency or evidence');
    for (const [key, value] of Object.entries({ session_cap_micro, principal_day_cap_micro, tenant_day_cap_micro })) count(value, key);
    let deployment = null;
    if (deployment_period !== undefined) {
      try { deployment = checkDeploymentPeriod(deployment_period); }
      catch { throw new BudgetError(400, 'Invalid deployment_period policy'); }
    }
    return this.#transaction(() => {
      const session = this.#db.prepare('SELECT tid FROM journal_sessions WHERE sid = ?').get(sid);
      if (!session) throw new BudgetError(404, 'Journal session not found');
      const principalKey = canonicalJson([issuer, session.tid, principal]);
      const tenantKey = canonicalJson([issuer, session.tid]);
      const existing = this.#db.prepare('SELECT * FROM budget_sessions WHERE sid = ?').get(sid);
      const binding = this.#db.prepare('SELECT deployment_id FROM budget_session_deployments WHERE sid = ?').get(sid);
      if (existing && (existing.principal_key !== principalKey || existing.tenant_key !== tenantKey ||
          existing.currency !== currency || existing.session_cap_micro !== session_cap_micro || existing.evidence !== Number(evidence) ||
          (binding?.deployment_id ?? null) !== (deployment?.deployment_id ?? null))) {
        throw new BudgetError(409, 'Budget registration is immutable');
      }
      if (deployment) {
        const policyBytes = Buffer.from(canonicalJson(deployment));
        const row = this.#db.prepare('SELECT * FROM budget_deployments WHERE deployment_id = ?').get(deployment.deployment_id);
        const prior = row && JSON.parse(Buffer.from(row.policy_bytes).toString('utf8'));
        if (row && (row.currency !== currency || prior.period !== deployment.period || prior.time_zone !== deployment.time_zone)) {
          throw new BudgetError(409, 'Deployment identity, period, time zone and currency are immutable');
        }
        this.#db.prepare(`INSERT INTO budget_deployments VALUES(?,?,?)
          ON CONFLICT(deployment_id) DO UPDATE SET policy_bytes = excluded.policy_bytes`)
          .run(deployment.deployment_id, currency, policyBytes);
      }
      for (const [scope, key, cap] of [['principal', principalKey, principal_day_cap_micro], ['tenant', tenantKey, tenant_day_cap_micro]]) {
        const row = this.#db.prepare('SELECT cap_micro FROM budget_caps WHERE scope = ? AND scope_key = ? AND currency = ?').get(scope, key, currency);
        if (row && row.cap_micro !== cap) throw new BudgetError(409, 'Aggregate scope cap differs from host policy');
        this.#db.prepare('INSERT OR IGNORE INTO budget_caps VALUES(?,?,?,?)').run(scope, key, currency, cap);
      }
      this.#db.prepare('INSERT OR IGNORE INTO budget_sessions VALUES(?,?,?,?,?,?)')
        .run(sid, principalKey, tenantKey, currency, session_cap_micro, Number(evidence));
      if (deployment) this.#db.prepare('INSERT OR IGNORE INTO budget_session_deployments VALUES(?,?)').run(sid, deployment.deployment_id);
    });
  }

  #authorize(authority) {
    if (!authority || !Number.isFinite(authority.exp) || authority.exp <= Math.floor(this.#now() / 1000)) {
      throw new BudgetError(401, 'Missing or expired authority');
    }
    const session = this.#db.prepare(`SELECT j.*, b.principal_key, b.tenant_key, b.currency,
      b.session_cap_micro, b.evidence, d.deployment_id FROM journal_sessions j JOIN budget_sessions b USING(sid)
      LEFT JOIN budget_session_deployments d USING(sid) WHERE sid = ?`).get(authority.sid);
    if (!session) throw new BudgetError(404, 'Budget session not found');
    if (authority.tid !== session.tid || authority.pid !== session.pid) throw new BudgetError(403, 'Budget scope mismatch');
    if (!Array.isArray(authority.capabilities) || !authority.capabilities.includes('aithema.ledger') || authority.writer_kind !== 'worker') {
      throw new BudgetError(403, 'Worker authority with aithema.ledger is required');
    }
    return session;
  }

  #fence(session, authority, body = {}, generation = true) {
    if (session.tombstone || authority.auth_epoch !== session.auth_epoch ||
        (body.auth_epoch !== undefined && body.auth_epoch !== authority.auth_epoch)) return 'revoked';
    if (generation && (session.worker_generation !== authority.gen ||
        (body.worker_generation !== undefined && body.worker_generation !== authority.gen))) return 'fenced_generation';
    return null;
  }

  #requireActive(session) {
    // Suspend is a reversible pause, not an epoch change or tombstone. Only
    // new spend authority is paused; committed claims and recovery can finish.
    if (session.suspended) throw new BudgetError(409, 'Session is suspended');
  }

  #deployment(deploymentId) {
    const row = this.#db.prepare('SELECT policy_bytes FROM budget_deployments WHERE deployment_id = ?').get(deploymentId);
    if (!row) throw new BudgetError(404, 'Deployment budget not found');
    return JSON.parse(Buffer.from(row.policy_bytes).toString('utf8'));
  }

  #deploymentUsage(deploymentId, periodId) {
    const query = this.#db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN u.state = 'admitted' AND c.claim_id IS NULL THEN u.max_micro ELSE 0 END),0) AS admitted_micro,
      COALESCE(SUM(CASE WHEN u.state = 'admitted' AND c.claim_id IS NOT NULL THEN u.max_micro ELSE 0 END),0) AS claimed_micro,
      COALESCE(SUM(CASE WHEN u.state = 'closed' THEN u.charged_or_reserved_micro ELSE 0 END),0) AS settled_micro,
      COUNT(CASE WHEN u.state = 'admitted' THEN 1 END) AS open_holds
      FROM budget_usage u JOIN budget_deployment_holds d USING(hold_id) LEFT JOIN budget_claims c USING(hold_id)
      WHERE d.deployment_id = ? AND d.period_id = ?`);
    query.setReadBigInts(true);
    return query.get(deploymentId, periodId);
  }

  /** One policy authority for admission, notification and reporting; lookup never opens a period. */
  #deploymentPeriod(policy, period) {
    const row = this.#db.prepare('SELECT * FROM budget_deployment_periods WHERE deployment_id = ? AND period_id = ?')
      .get(policy.deployment_id, period.period_id);
    if (!row) return { ...policy, ...period };
    return { ...policy, period_id: row.period_id, start_at: row.start_at, end_at: row.end_at,
      ceiling_micro: row.ceiling_micro, notify_at: JSON.parse(Buffer.from(row.notify_at_bytes).toString('utf8')) };
  }

  #notifyDeployment(period, session, before, after, timestamp) {
    for (const ratio of period.notify_at) {
      const threshold = notificationThreshold(period.ceiling_micro, ratio);
      if (before >= threshold || after < threshold || this.#db.prepare(`SELECT 1 FROM budget_deployment_notifications
        WHERE deployment_id = ? AND period_id = ? AND ratio = ?`).get(period.deployment_id, period.period_id, String(ratio))) continue;
      if (session.last_seq === Number.MAX_SAFE_INTEGER || session.audit_seq === Number.MAX_SAFE_INTEGER) {
        throw new BudgetError(409, 'Journal or audit sequence exhausted');
      }
      const eventId = randomUUID();
      // Existing audit.event journal path, atomically sequenced by the host.
      // A durable marker and its contract-valid event commit with admission:
      // neither replay, restart nor threshold recrossing can duplicate it.
      const doc = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: session.sid, client_event_id: eventId, writer: { kind: 'worker', generation: session.worker_generation },
        recorded_at: timestamp, kind: 'audit.event', data: { audit_seq: ++session.audit_seq,
          name: 'budget.deployment_period.notify', detail: canonicalJson({ scope: 'deployment_period',
            deployment_id: period.deployment_id, period_id: period.period_id, notify_at: ratio,
            ceiling_micro: period.ceiling_micro, reserved_or_charged_micro: Number(after) }) } };
      const original = Buffer.from(canonicalJson(doc));
      decodeDocument(original, { submission: true });
      this.#db.prepare('INSERT INTO journal_records(sid,seq,client_event_id,kind,original_bytes) VALUES(?,?,?,?,?)')
        .run(session.sid, ++session.last_seq, eventId, doc.kind, original);
      this.#db.prepare('UPDATE journal_sessions SET last_seq = ?, audit_seq = ? WHERE sid = ?')
        .run(session.last_seq, session.audit_seq, session.sid);
      this.#db.prepare('INSERT INTO budget_deployment_notifications VALUES(?,?,?,?,?)')
        .run(period.deployment_id, period.period_id, String(ratio), session.sid, eventId);
    }
  }

  /** Trusted host read API, not a delegated cross-tenant/session route. */
  getDeploymentPeriod(query = {}) {
    if (!query || typeof query !== 'object' || Array.isArray(query)
        || Object.keys(query).some((key) => !['deployment_id', 'period_id'].includes(key))) {
      throw new BudgetError(400, 'Invalid deployment period query');
    }
    const { deployment_id, period_id } = query;
    if (typeof deployment_id !== 'string' || deployment_id.length > 128 || deployment_id !== deployment_id.trim()
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deployment_id)) {
      throw new BudgetError(400, 'Invalid deployment_id');
    }
    return this.#transaction(() => {
      const policy = this.#deployment(deployment_id);
      let bounds;
      try { bounds = deploymentPeriodBounds(period_id, policy.time_zone); }
      catch { throw new BudgetError(400, 'Invalid period_id'); }
      const period = this.#deploymentPeriod(policy, bounds);
      const usage = this.#deploymentUsage(deployment_id, period_id);
      return budgetMessage('deployment_period_report', { deployment_id, period_id, ceiling_micro: period.ceiling_micro,
        ...Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Number(value)])) }).body;
    });
  }

  admit(bytes, authority) {
    const original = budgetBytes(bytes);
    const { body } = decodeMessage(original, 'admit_request');
    return this.#transaction(() => {
      const session = this.#authorize(authority);
      if (body.sid !== session.sid) throw new BudgetError(403, 'Admission session mismatch');
      const error = this.#fence(session, authority, body);
      // Host fencing takes precedence over replay: stale workers cannot obtain
      // spend authority even by replaying a formerly successful admission.
      if (error) return budgetMessage('admit_response', { error });
      this.#requireActive(session);
      const existing = this.#db.prepare('SELECT * FROM budget_holds WHERE attempt_id = ?').get(body.attempt_id);
      if (existing) {
        if (!Buffer.from(existing.original_bytes).equals(original)) return budgetMessage('admit_response', { error: 'idempotency_conflict' });
        return decodeMessage(existing.verdict_bytes, 'admit_response');
      }
      if (body.currency !== session.currency) throw new BudgetError(400, 'Admission currency differs from the host budget');
      const timestamp = new Date(this.#now()).toISOString();
      const day = timestamp.slice(0, 10); // UTC admission day; recovery never moves a charge to a different day.
      const policy = session.deployment_id === null ? null : this.#deployment(session.deployment_id);
      const period = policy ? this.#deploymentPeriod(policy, deploymentPeriodAt(Date.parse(timestamp), policy.time_zone)) : null;
      const scopes = [
        ['session_cap', session.session_cap_micro, 'sid = ?', [session.sid]],
        ...[['principal', session.principal_key], ['tenant', session.tenant_key]].map(([scope, key]) => [
          `${scope}_day_cap`, this.#db.prepare('SELECT cap_micro FROM budget_caps WHERE scope = ? AND scope_key = ? AND currency = ?')
            .get(scope, key, body.currency).cap_micro,
          `${scope}_key = ? AND budget_day = ?`, [key, day],
        ]),
      ];
      if (period) scopes.push(['deployment_period_cap', period.ceiling_micro, 'deployment_id = ? AND period_id = ?',
        [period.deployment_id, period.period_id], 'budget_usage JOIN budget_deployment_holds USING(hold_id)']);
      let denied = session.evidence ? null : 'no_evidence';
      let remaining = BigInt(Number.MAX_SAFE_INTEGER);
      let deploymentUsed = 0n;
      for (const [reason, cap, predicate, parameters, source = 'budget_usage'] of scopes) {
        const query = this.#db.prepare(`SELECT COALESCE(SUM(charged_or_reserved_micro),0) AS used
          FROM ${source} WHERE currency = ? AND ${predicate}`);
        query.setReadBigInts(true);
        const used = query.get(body.currency, ...parameters).used;
        if (reason === 'deployment_period_cap') deploymentUsed = used;
        const available = BigInt(cap) - used;
        if (!denied && available < BigInt(body.max_micro)) denied = reason;
        if (available < remaining) remaining = available;
      }
      const holdId = denied ? null : randomUUID();
      const detail = denied === 'deployment_period_cap' ? { detail: { scope: 'deployment_period',
        deployment_id: period.deployment_id, period_id: period.period_id } } : {};
      const response = budgetMessage('admit_response', denied ? { denied, ...detail } : {
        hold_id: holdId, remaining_micro: Number(remaining - BigInt(body.max_micro)),
      });
      this.#db.prepare(`INSERT INTO budget_holds(attempt_id,hold_id,sid,worker_generation,auth_epoch,lane,max_micro,
        currency,state,created_at,original_bytes,verdict_bytes,principal_key,tenant_key,budget_day)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(body.attempt_id, holdId, session.sid, body.worker_generation,
        body.auth_epoch, body.lane, body.max_micro, body.currency, denied ? 'denied' : 'admitted', timestamp,
        original, encodeMessage('admit_response', response.body), session.principal_key, session.tenant_key, day);
      if (period && !denied) {
        // Freeze only the first successful reservation, under the same lock
        // as every cap check, hold, binding and notification. Later policy
        // edits cannot affect this period, even after all holds are voided.
        this.#db.prepare(`INSERT OR IGNORE INTO budget_deployment_periods
          (deployment_id,period_id,start_at,end_at,ceiling_micro,notify_at_bytes) VALUES(?,?,?,?,?,?)`)
          .run(period.deployment_id, period.period_id, period.start_at, period.end_at, period.ceiling_micro,
            Buffer.from(canonicalJson(period.notify_at)));
        this.#db.prepare('INSERT INTO budget_deployment_holds VALUES(?,?,?)').run(holdId, period.deployment_id, period.period_id);
        this.#notifyDeployment(period, session, deploymentUsed, deploymentUsed + BigInt(body.max_micro), timestamp);
      }
      return response;
    });
  }

  #hold(holdId, sid) {
    const hold = this.#db.prepare('SELECT * FROM budget_holds WHERE hold_id = ? AND sid = ?').get(holdId, sid);
    if (!hold) throw new BudgetError(404, 'Budget hold not found');
    return hold;
  }

  #claim(holdId) { return this.#db.prepare('SELECT * FROM budget_claims WHERE hold_id = ?').get(holdId); }

  #journaledHold(hold) {
    // Admission can crash before its journal write (§3.4). Such holds reserve
    // capacity and are enumerated/recovered, but cannot dispatch. JournalPort
    // stored these immutable original bytes; its generation checks are shared.
    const rows = this.#db.prepare("SELECT original_bytes FROM journal_records WHERE sid = ? AND kind = 'budget.hold'").all(hold.sid);
    return rows.some((row) => {
      const doc = decodeDocument(row.original_bytes);
      return doc.writer.generation === hold.worker_generation && canonicalJson(doc.data) === canonicalJson({
        hold_id: hold.hold_id, attempt_id: hold.attempt_id, lane: hold.lane, max_micro: hold.max_micro, currency: hold.currency,
      });
    });
  }

  claim(bytes, authority) {
    const { body } = decodeMessage(budgetBytes(bytes), 'claim_request');
    return this.#transaction(() => {
      const session = this.#authorize(authority);
      const error = this.#fence(session, authority, body);
      if (error) return budgetMessage('claim_response', { error });
      this.#requireActive(session);
      const hold = this.#hold(body.hold_id, session.sid);
      if (hold.state === 'closed') return budgetMessage('claim_response', { error: 'hold_closed' });
      if (this.#claim(hold.hold_id)) return budgetMessage('claim_response', { error: 'already_claimed' });
      if (hold.auth_epoch !== body.auth_epoch) return budgetMessage('claim_response', { error: 'revoked' });
      if (hold.worker_generation !== body.worker_generation) return budgetMessage('claim_response', { error: 'fenced_generation' });
      if (!this.#journaledHold(hold)) throw new BudgetError(409, 'An acknowledged matching budget.hold record is required before dispatch');
      const claimId = randomUUID();
      this.#db.prepare(`INSERT INTO budget_claims(claim_id,hold_id,request_sha256,worker_generation,auth_epoch,state,claimed_at)
        VALUES(?,?,?,?,?,'claimed',?)`).run(claimId, hold.hold_id, body.request_sha256, body.worker_generation,
        body.auth_epoch, new Date(this.#now()).toISOString());
      return budgetMessage('claim_response', { claim_id: claimId });
    });
  }

  #settlement(hold, claim) {
    return budgetMessage('recover_response', { hold_id: hold.hold_id, closed_reason: hold.closed_reason,
      charged_micro: hold.closed_reason === 'void' ? 0 : claim.settled_micro });
  }

  #close(hold, claim, reason, charged) {
    const timestamp = new Date(this.#now()).toISOString();
    if (claim) this.#db.prepare('UPDATE budget_claims SET state = ?, settled_micro = ?, settled_at = ? WHERE claim_id = ?')
      .run(reason, charged, timestamp, claim.claim_id);
    this.#db.prepare("UPDATE budget_holds SET state = 'closed', closed_reason = ?, closed_at = ? WHERE hold_id = ?")
      .run(reason, timestamp, hold.hold_id);
    return budgetMessage('recover_response', { hold_id: hold.hold_id, closed_reason: reason, charged_micro: charged });
  }

  settle(bytes, authority) {
    const original = budgetBytes(bytes);
    const { body } = decodeMessage(original, 'settle_request');
    return this.#transaction(() => {
      const session = this.#authorize(authority);
      const claim = this.#db.prepare(`SELECT c.* FROM budget_claims c JOIN budget_holds h USING(hold_id)
        WHERE c.claim_id = ? AND h.sid = ?`).get(body.claim_id, session.sid);
      if (!claim) throw new BudgetError(404, 'Budget claim not found');
      // Committed claim owners may finish after takeover/revocation. This is
      // the narrow §6.3 exception to control-route fencing, not a new claim.
      if (authority.gen !== claim.worker_generation || authority.auth_epoch !== claim.auth_epoch) {
        throw new BudgetError(403, 'Settlement authority does not own this committed claim');
      }
      const hold = this.#hold(claim.hold_id, session.sid);
      if (claim.settlement_bytes && !Buffer.from(claim.settlement_bytes).equals(original)) {
        throw new BudgetError(409, 'Settlement retry has different bytes', 'idempotency_conflict');
      }
      if (hold.state === 'closed') return this.#settlement(hold, claim);
      if (body.outcome === 'settled' && body.actual_micro > hold.max_micro) {
        throw new BudgetError(400, 'Actual cost exceeds the admitted maximum');
      }
      const unknown = body.outcome === 'unknown' || this.#fence(session, authority) !== null;
      const response = this.#close(hold, claim, unknown ? 'unknown' : 'settled', unknown ? hold.max_micro : body.actual_micro);
      this.#db.prepare('UPDATE budget_claims SET settlement_bytes = ? WHERE claim_id = ?').run(original, claim.claim_id);
      // v1 has no settle_response; use the existing settlement-shaped response.
      return response;
    });
  }

  recover(bytes, authority) {
    const { body } = decodeMessage(budgetBytes(bytes), 'recover_request');
    return this.#transaction(() => {
      const session = this.#authorize(authority);
      const error = this.#fence(session, authority, body);
      if (error) return budgetMessage('recover_response', { error });
      const hold = this.#hold(body.hold_id, session.sid);
      const claim = this.#claim(hold.hold_id);
      if (hold.state === 'closed') return this.#settlement(hold, claim);
      return this.#close(hold, claim, claim ? 'unknown' : 'void', claim ? hold.max_micro : 0);
    });
  }

  listOpen({ cursor = null, limit = 1000 } = {}, authority) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new BudgetError(400, 'Enumeration limit must be 1..1000');
    return this.#transaction(() => {
      const session = this.#authorize(authority);
      const error = this.#fence(session, authority, {}, false); // read route deliberately does not fence gen
      if (error) throw new BudgetError(409, error, error);
      let after = 0;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || cursor.length > 256) throw new BudgetError(400, 'Invalid ledger cursor');
        const prefix = `${session.sid}:`;
        const value = cursor.slice(prefix.length);
        if (!cursor.startsWith(prefix) || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new BudgetError(400, 'Invalid or foreign ledger cursor');
        }
        after = Number(value);
      }
      // Keyset pagination, never OFFSET: draining prior pages must not skip
      // rows. A new admission has a larger rowid and remains discoverable.
      const rows = this.#db.prepare(`SELECT h.rowid AS cursor_id, h.hold_id, h.attempt_id, c.claim_id FROM budget_holds h
        LEFT JOIN budget_claims c USING(hold_id) WHERE h.sid = ? AND h.state = 'admitted' AND h.rowid > ?
        ORDER BY h.rowid LIMIT ?`).all(session.sid, after, limit + 1);
      const page = rows.slice(0, limit);
      return budgetMessage('holds_list', { sid: session.sid, state: 'open',
        holds: page.map((row) => ({ hold_id: row.hold_id, attempt_id: row.attempt_id, claimed: row.claim_id !== null })),
        next_cursor: rows.length > limit ? `${session.sid}:${page.at(-1).cursor_id}` : null,
      });
    });
  }

  /** Output check only; never called as a pre-send veto after commitment. */
  isCurrent(authority) {
    return this.#transaction(() => this.#fence(this.#authorize(authority), authority) === null);
  }
}
