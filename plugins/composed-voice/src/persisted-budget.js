import { DatabaseSync } from 'node:sqlite';
import { accessSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createQualificationBudget, QUALIFICATION_THRESHOLDS } from './qualification.js';
import { PluginError } from '../../../packages/core/src/invocation.js';

export const qualificationRequestDigest = request => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const read = db => {
  const row = db.prepare('SELECT snapshot FROM qualification WHERE id=1').get();
  if (!row) throw new Error('Persisted qualification budget required');
  const snapshot = JSON.parse(row.snapshot);
  if (snapshot.version !== 1) throw new Error('Unknown qualification snapshot');
  const restored = createQualificationBudget(snapshot).snapshot();
  if (snapshot.exposureMicro !== restored.exposureMicro || restored.blocked && snapshot.blocked !== true) throw new Error('Corrupt qualification exposure');
  return snapshot;
};
function open(path, create = false) {
  if (typeof path !== 'string' || !path || path === ':memory:') throw new TypeError('Durable budget path required');
  if (!create) accessSync(path);
  const db = new DatabaseSync(path, { open: true, readOnly: false, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    if (create) db.exec('CREATE TABLE IF NOT EXISTS qualification (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Read-only CLI preflight, before the account-specific OPS module is loaded. */
export function readPersistedQualificationSnapshot(path) {
  if (typeof path !== 'string' || !path || path === ':memory:') throw new TypeError('Durable budget path required');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return structuredClone(read(db)); } finally { db.close(); }
}

/** Separate, explicit OPS initialization. Never resets an existing run. SQLite
 * FULL commits are the atomic snapshot boundary and release locks after crashes. */
export function initializeQualificationBudget({ path, capMicro = QUALIFICATION_THRESHOLDS.capMicro } = {}) {
  const snapshot = { version: 1, ...createQualificationBudget({ capMicro }).snapshot() }, db = open(path, true);
  try { db.prepare('INSERT INTO qualification (id,snapshot) VALUES(1,?)').run(JSON.stringify(snapshot)); }
  finally { db.close(); }
}

export function openPersistedQualificationBudget({ path, verifyCeiling, verifyReceipt, now = Date.now } = {}) {
  if (typeof verifyCeiling !== 'function' || typeof verifyReceipt !== 'function') throw new TypeError('Verified ceiling and receipt ports required');
  const db = open(path); let closed = false;
  try { read(db); } catch (error) { db.close(); throw error; }
  function change(mutate) {
    if (closed) throw new Error('Budget closed');
    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = read(db), result = mutate(snapshot);
      snapshot.exposureMicro = snapshot.records.reduce((sum, row) => sum + row.exposureMicro, 0);
      if (!Number.isSafeInteger(snapshot.exposureMicro) || snapshot.exposureMicro > snapshot.capMicro ||
        snapshot.records.some(row => row.exposureMicro > row.maxMicro)) snapshot.blocked = true;
      db.prepare('UPDATE qualification SET snapshot=? WHERE id=1').run(JSON.stringify(snapshot));
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function ceilingFor(attempt) {
    if (['provider', 'model', 'operation', 'accountRef', 'endpoint'].some(key => typeof attempt[key] !== 'string' || !attempt[key]) ||
      !Number.isSafeInteger(attempt.maxMicro) || attempt.maxMicro < 0 || !/^[a-f0-9]{64}$/u.test(attempt.requestDigest)) throw new TypeError('Complete verified pricing identity required');
    const proof = await verifyCeiling(structuredClone(attempt));
    if (!proof || proof.verified !== true || typeof proof.reference !== 'string' || !proof.reference ||
      !Number.isFinite(proof.expiresAt) || proof.expiresAt <= now() ||
      ['provider', 'model', 'operation', 'accountRef', 'endpoint', 'requestDigest', 'maxMicro'].some(key => proof[key] !== attempt[key])) {
      throw new PluginError('not-admitted', 'Verified provider attempt ceiling required');
    }
    return Object.fromEntries(['verified', 'reference', 'expiresAt', 'provider', 'model', 'operation', 'accountRef', 'endpoint', 'requestDigest', 'maxMicro'].map(key => [key, proof[key]]));
  }
  const rowFor = (snapshot, attemptId) => {
    const row = snapshot.records.find(row => row.attemptId === attemptId);
    if (!row) throw new PluginError('not-admitted'); return row;
  };
  const api = {
    async verifyPricing(attempt) { return ceilingFor({ ...attempt, requestDigest: qualificationRequestDigest(attempt.request) }); },
    claimRun(runId) {
      if (typeof runId !== 'string' || !runId) throw new TypeError('Explicit run identity required');
      change(snapshot => {
        if (snapshot.blocked || snapshot.runs?.includes(runId)) throw new PluginError('not-admitted', 'Run already claimed or blocked; no silent rerun');
        (snapshot.runs ??= []).push(runId);
      });
    },
    snapshot() { if (closed) throw new Error('Budget closed'); return structuredClone(read(db)); },
    async admit({ attemptId, lane, provider, model, operation, accountRef, endpoint, role, maxMicro, request, retryOf = null }) {
      if (typeof attemptId !== 'string' || !attemptId || !['candidate', 'baseline'].includes(lane) ||
        !['stt', 'tts', 'reasoning'].includes(role) || [provider, model, operation, accountRef, endpoint].some(x => typeof x !== 'string' || !x) ||
        !Number.isSafeInteger(maxMicro) || maxMicro < 0 || request === undefined) throw new TypeError('Complete attempt identity required');
      const exactRequest = structuredClone(request);
      const attempt = { attemptId, lane, provider, model, operation, accountRef, endpoint, role, maxMicro, requestDigest: qualificationRequestDigest(exactRequest), retryOf };
      const ceiling = await ceilingFor({ ...attempt, request: exactRequest });
      change(snapshot => {
        if (snapshot.records.some(row => row.attemptId === attemptId)) throw new PluginError('already-claimed');
        if (snapshot.blocked || snapshot.exposureMicro + maxMicro > snapshot.capMicro) throw new PluginError('not-admitted', 'Qualification cap reached');
        if (retryOf && !snapshot.records.some(row => row.attemptId === retryOf)) throw new TypeError('Unknown retry predecessor');
        snapshot.records.push({ ...attempt, ceiling, exposureMicro: maxMicro, state: 'reserved' });
      });
      let consumed = false;
      const admission = {
        attemptId, claimId: `qualification-${attemptId}`, maxMicro,
        async consume() {
          const proof = await ceilingFor({ ...attempt, request: exactRequest });
          change(snapshot => {
            const row = rowFor(snapshot, attemptId);
            if (snapshot.blocked) throw new PluginError('not-admitted');
            if (row.state !== 'reserved') throw new PluginError('already-claimed');
            row.state = 'dispatched'; row.ceiling = proof; row.dispatchedAt = now();
          }); // COMMIT completes before a caller can dispatch anything.
          consumed = true;
        },
        report(terminal) {
          const overrun = change(snapshot => {
            const row = rowFor(snapshot, attemptId);
            if (row.state === 'settled') throw new PluginError('already-claimed');
            if (terminal?.attemptId !== attemptId || !['completed', 'cancelled', 'uncertain'].includes(terminal.outcome) ||
              row.state === 'reserved' && terminal.outcome !== 'cancelled') throw new TypeError('Invalid terminal');
            // Provider tariff estimates and browser charges never release a reservation.
            // Only a separately authenticated receipt can do so after dispatch.
            const charge = terminal.chargedMicro ?? terminal.usage?.upstreamMicro;
            if (Number.isSafeInteger(charge) && charge > row.exposureMicro) row.exposureMicro = charge;
            if (row.state === 'reserved') row.exposureMicro = 0;
            row.state = 'settled'; row.outcome = terminal.outcome; row.reportedAt = now();
            return row.exposureMicro > row.maxMicro;
          });
          if (overrun) throw new PluginError('limit', 'Qualification spend overrun');
        },
      };
      // Adapter admission shape, plus a guarded helper for OPS-owned transports.
      return { attempt: admission, report: admission.report,
        async dispatch(action) {
          if (typeof action !== 'function') throw new TypeError('Dispatch function required');
          await admission.consume();
          try { return await action({ attempt: admission, report: admission.report }); }
          finally {
            const row = api.snapshot().records.find(row => row.attemptId === attemptId);
            if (consumed && row.state === 'dispatched') admission.report({ attemptId, outcome: 'uncertain' });
          }
        } };
    },
    async reconcile(receipt) {
      const original = api.snapshot().records.find(row => row.attemptId === receipt?.attemptId);
      if (!original || original.state === 'reserved') throw new PluginError('not-admitted');
      if (await verifyReceipt(structuredClone(receipt), structuredClone(original)) !== true ||
        receipt.estimated !== false || !Number.isSafeInteger(receipt.chargedMicro) || receipt.chargedMicro < 0 ||
        typeof receipt.receiptId !== 'string' || !receipt.receiptId ||
        ['provider', 'model', 'operation', 'accountRef', 'endpoint'].some(key => receipt[key] !== original[key])) throw new PluginError('not-admitted', 'Authenticated matching server receipt required');
      const overrun = change(snapshot => {
        const row = rowFor(snapshot, receipt.attemptId);
        if (snapshot.records.some(other => other.attemptId !== receipt.attemptId && other.receipt?.receiptId === receipt.receiptId)) throw new PluginError('already-claimed');
        if (row.receipt) {
          if (['receiptId', 'attemptId', 'chargedMicro', 'estimated', 'provider', 'model', 'operation', 'accountRef', 'endpoint'].some(key => row.receipt[key] !== receipt[key])) throw new PluginError('already-claimed');
          return row.exposureMicro > row.maxMicro;
        }
        row.reconciled = true; row.receipt = structuredClone(receipt); row.exposureMicro = receipt.chargedMicro; row.reconciledAt = now();
        return row.exposureMicro > row.maxMicro;
      });
      if (overrun) throw new PluginError('limit', 'Qualification spend overrun');
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
  return Object.freeze(api);
}
