import { AuthzError, capabilities, freeze } from './common.js';

// Operation identifiers select EXACT contract rows; HTTP adapters map their
// matched routes to these identifiers, never infer a capability from a prefix.
const names = [
  ['intake.sources', 'intake.transcript-turns', 'intake.drafts', 'intake.replace'],
  ['intake.read'], ['intake.accept'],
  ['journal.append', 'journal.snapshot', 'journal.op-result'],
  ['journal.records', 'journal.cursor'], ['journal.authority'],
  ['ledger.admit', 'ledger.claim', 'ledger.settle'], ['ledger.recover'], ['ledger.holds'],
  ['service.create', 'service.host-event', 'service.revoke', 'service.context'],
];
export const ROUTES = freeze(Object.fromEntries(names.flatMap((ids, i) =>
  ids.map((id) => [id, structuredClone(capabilities.routes[i])]))));

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
      if (current.tombstone || current.auth_epoch !== claims.auth_epoch) throw new AuthzError(409, 'Session revoked', 'revoked');
    }
    if (row.checks.some((check) => check.startsWith('gen'))) {
      if (!Number.isSafeInteger(current.worker_generation) || current.worker_generation < 1) throw new AuthzError(403, 'Missing current generation');
      if (current.worker_generation !== claims.gen) throw new AuthzError(409, 'Worker generation fenced', 'fenced_generation');
      if (current.suspended) throw new AuthzError(409, 'Session suspended', 'revoked');
    }
    if (row.checks.includes('ephemeral LiveGrant') && !liveGrant) throw new AuthzError(403, 'Ephemeral LiveGrant required');
    return freeze({ tid: claims.tid, pid: claims.pid, sid: claims.sid, gen: claims.gen,
      auth_epoch: claims.auth_epoch, exp: claims.exp, writer_kind: 'worker', capabilities: [...claims.capabilities] });
  }
}
