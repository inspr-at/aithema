import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex, validate } from '../../contracts/validate.js';
import { envelope, capabilities } from './protocol.js';
import { MockHost, routePath } from './host.js';
import { testKey, signToken, TokenVerifier } from './tokens.js';

export const issuer = 'https://host.example';
export const audience = 'host.example';
export const initialTime = 1_790_000_000;

export function authorization(sid = randomUUID(), overrides = {}) {
  return envelope('aithema.authz', { sid, tid: 'tenant-1', pid: 'project-1', epoch: 1,
    participants: [{ participant_ref: 'person-1', role: 'owner', notice_ref: 'notice-test' }],
    purposes: ['intake', 'specification'], processors: [], settings_sha256: sha256Hex('synthetic settings'),
    basis_label: 'synthetic test authorization', created_at: new Date(initialTime * 1000).toISOString(), withdrawn_at: null,
    ...overrides,
  });
}

export function claims(sid, overrides = {}) {
  return { iss: issuer, aud: audience, sub: 'plugin-aithema', act: { sub: 'person-1' },
    tid: 'tenant-1', pid: 'project-1', sid, gen: 1, auth_epoch: 1,
    capabilities: [...capabilities.delegated_allowed], iat: initialTime, exp: initialTime + 900, ...overrides,
  };
}

export function sessionClaims(sid, overrides = {}) {
  return { iss: issuer, aud: 'aithema', sub: 'person-1', tid: 'tenant-1', pid: 'project-1', sid,
    scope: ['session.converse', 'session.upload', 'session.confirm', 'session.export'],
    actor_kind: 'person', host_mode: 'review', auth_epoch: 1, iat: initialTime, exp: initialTime + 900, ...overrides,
  };
}

/** Fresh keys, clock and state per fixture; nothing is global or persisted. */
export function fixture(options = {}) {
  let time = initialTime;
  const now = () => time;
  const key = testKey(options.alg);
  const verifier = new TokenVerifier({ issuer, audience, keys: [key], now });
  const host = new MockHost({ verifier, now, caps: options.caps });
  const authz = authorization(options.sid, options.authz);
  const sid = authz.sid;
  host.createSession(authz, options.session);
  const liveGrant = host.liveGrant(sid);
  const token = (overrides = {}) => signToken(key, claims(sid, { iat: time, exp: time + 900, ...overrides }));
  const request = (area, action, body, extras = {}) => host.request({ method: body === undefined ? 'GET' : 'POST',
    path: routePath(area, sid, action), token: token(), liveGrant, ...(body === undefined ? {} : { body }), ...extras,
  });
  return { host, key, verifier, sid, authz, token, request, liveGrant, now,
    advance: (seconds) => { time += seconds; },
  };
}

export function record(sid, kind = 'turn', data = null, overrides = {}) {
  const defaults = {
    turn: { speaker: 'person', participant_ref: 'person-1', channel: 'text', trust: 'authenticated_person', lang: 'en', body: 'Add a synthetic export.' },
    source: { label: 'synthetic.txt', media_type: 'text/plain', sha256: sha256Hex('Synthetic source'),
      durability: 'resumable', text: 'Synthetic source', segments: [{ id: 's1', start: 0, end: 16 }] },
    'design.input': { screen_ir: { screens: [] }, screen_ir_sha256: sha256Hex(canonicalJson({ screens: [] })),
      tokens: { color: 'blue' }, tokens_sha256: sha256Hex(canonicalJson({ color: 'blue' })) },
    'op.result': { op_key: `${sid}:submit:1`, host_ids: { draft_id: randomUUID() } },
  };
  return envelope('aithema.journal.record', { sid, client_event_id: randomUUID(), writer: { kind: 'worker', generation: 1 },
    recorded_at: new Date(initialTime * 1000).toISOString(), kind, data: data ?? defaults[kind], ...overrides,
  });
}

export function item(overrides = {}) {
  const content = { statement: 'A synthetic export.', acceptance_criteria: [], constraint_refs: [] };
  return { item_ref: 'REQ-1', kind: 'requirement', version: 1, content, content_sha256: sha256Hex(canonicalJson(content)),
    citations: [], provenance: { intent: 'inferred', derived_from: [] }, state: 'confirmed',
    supersedes_item_version: null, host: null, ...overrides,
  };
}

export function snapshot(sid, items = [], overrides = {}) {
  const canonical = canonicalJson({ op: 'synthetic-patch' });
  return envelope('aithema.spec.snapshot', { sid, client_event_id: randomUUID(), working_rev: 1, expected_prev_rev: 0,
    consumed_seq: 0, worker_generation: 1, host_mode: 'review',
    spec: { items, questions: [], brief: null, screens: [] }, pending_ops: [], corrections: [],
    patch: { canonical, sha256: sha256Hex(canonical) }, ...overrides,
  });
}

export function budgetRequest(type, body) {
  return envelope('aithema.budget.message', { type: `${type}_request`, body });
}

export function admitRequest(sid, n = 1, overrides = {}) {
  const body = { sid, worker_generation: 1, auth_epoch: 1, lane: 'spec', max_micro: 100, currency: 'EUR', ...overrides };
  return budgetRequest('admit', { attempt_id: `${sid}:${body.worker_generation}:${body.lane}:${n}`, ...body });
}

export function claimRequest(holdId, overrides = {}) {
  return budgetRequest('claim', { hold_id: holdId, worker_generation: 1, auth_epoch: 1, request_sha256: sha256Hex('synthetic request'), ...overrides });
}

export function recoverRequest(holdId, overrides = {}) {
  return budgetRequest('recover', { hold_id: holdId, worker_generation: 1, auth_epoch: 1, ...overrides });
}

export function confirm(f, candidate) {
  const result = f.request('journal', 'records', record(f.sid, 'ui.confirm', {
    item_ref: candidate.item_ref, version: candidate.version, content_sha256: candidate.content_sha256, principal_ref: 'person-1',
  }));
  if (result.status !== 200) throw new Error('Fixture confirmation failed');
}

/** Traverse transport metadata and validate every embedded domain document. */
export function validDocuments(value) {
  if (!value || typeof value !== 'object') return;
  if (value.contract) {
    const result = validate(value.contract, value);
    if (!result.ok) throw new Error(`Invalid returned document: ${JSON.stringify(result)}`);
    return;
  }
  for (const child of Object.values(value)) validDocuments(child);
}
