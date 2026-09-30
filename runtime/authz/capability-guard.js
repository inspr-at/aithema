import { AuthzError, capabilities, freeze } from './common.js';

// Operation identifiers select EXACT contract rows; HTTP adapters map their
// matched routes to these identifiers, never infer a capability from a prefix.
const bindings = [
  ['POST …/intake/sources | …/transcript-turns | …/drafts | …/drafts/{id}/replace',
    ['intake.sources', 'intake.transcript-turns', 'intake.drafts', 'intake.replace']],
  ['GET …/intake', ['intake.read']],
  ['POST …/drafts/{id}/accept', ['intake.accept']],
  ['POST /journal/sessions/{sid}/records | snapshots | op.result', ['journal.append', 'journal.snapshot', 'journal.op-result']],
  ['GET /journal/sessions/{sid}/records | …/cursor', ['journal.records', 'journal.cursor']],
  ['GET /journal/sessions/{sid}/authority', ['journal.authority']],
  ['ledger admit | claim | settle', ['ledger.admit', 'ledger.claim', 'ledger.settle']],
  ['ledger recover(hold_id)', ['ledger.recover']],
  ['GET /ledger/sessions/{sid}/holds?state=open', ['ledger.holds']],
  ['POST /v1/sessions | /v1/sessions/{sid}/host-event | …/revoke | …/context',
    ['service.create', 'service.host-event', 'service.revoke', 'service.context']],
];
export const ROUTES = freeze(Object.fromEntries(bindings.flatMap(([route, ids]) => {
  const rows = capabilities.routes.filter((row) => row.route === route);
  if (rows.length !== 1) throw new TypeError(`Expected exactly one capability row for ${route}`);
  return ids.map((id) => [id, structuredClone(rows[0])]);
})));

/** Both host handlers and the outbound gate use this independent scope check. */
export class CapabilityGuard {
  #verifier;
  constructor({ verifier }) { this.#verifier = verifier; }

  /** Current scope is HOST-owned, never request JSON. liveGrant is a host verdict. */
  authorize(route, token, current, { liveGrant = false } = {}) {
    const row = Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
    if (!row) throw new AuthzError(403, 'Unknown authorization route');
    if (['person-only', 'host-to-service'].includes(row.class)) {
      throw new AuthzError(403, 'This route requires separate person or host service authentication');
    }
    const { claims } = this.#verifier.verifyDelegated(token); // Signature and exp on EVERY call.
    if (!claims.capabilities.includes(row.capability)) throw new AuthzError(403, `Missing ${row.capability}`);
    for (const key of ['tid', 'pid', 'sid'].filter((key) => row.checks.includes(key))) {
      if (typeof current?.[key] !== 'string' || claims[key] !== current[key]) throw new AuthzError(403, 'Route scope mismatch');
    }
    if (row.checks.includes('epoch')) {
      if (!Number.isSafeInteger(current.auth_epoch) || current.auth_epoch < 1) throw new AuthzError(403, 'Missing current epoch');
      if (current.revoked || current.tombstone || current.auth_epoch !== claims.auth_epoch) throw new AuthzError(409, 'Session revoked', 'revoked');
    }
    if (row.checks.some((check) => check.startsWith('gen'))) {
      if (!Number.isSafeInteger(current.worker_generation) || current.worker_generation < 1) throw new AuthzError(403, 'Missing current generation');
      if (current.worker_generation !== claims.gen) throw new AuthzError(409, 'Worker generation fenced', 'fenced_generation');
      if (current.suspended) throw new AuthzError(409, 'Session suspended', 'revoked');
    }
    if (row.checks.includes('ephemeral LiveGrant') && !liveGrant) throw new AuthzError(403, 'Ephemeral LiveGrant required');
    return freeze({ tid: claims.tid, pid: claims.pid, sid: claims.sid, gen: claims.gen,
      auth_epoch: claims.auth_epoch, exp: claims.exp, writer_kind: 'worker', capabilities: [row.capability] });
  }
}
