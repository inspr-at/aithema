import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../../contracts/validate.js';

export const sid = '11111111-1111-4111-8111-111111111111';
export const otherSid = '22222222-2222-4222-8222-222222222222';
export const time = Date.parse('2026-09-30T07:00:00Z');
export const now = () => time;
export const bytes = (doc) => Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
export const envelope = (contract) => ({ contract, major: 1, minor: 0, min_reader: 0 });
export function session(overrides = {}) {
  return { ...envelope('aithema.session.create'), sid, tid: 'fixture-tenant', pid: 'fixture-project',
    host_mode: 'review', preset_ref: 'local-l1', lang: 'en', authz_epoch: 1, submission: { auto: false }, ...overrides };
}
export function authority(overrides = {}) {
  return { sid, tid: 'fixture-tenant', pid: 'fixture-project', gen: 1, auth_epoch: 1,
    writer_kind: 'worker', capabilities: ['aithema.journal.read', 'aithema.journal.write'],
    exp: Math.floor(time / 1000) + 900, ...overrides };
}
export function record(kind, data, overrides = {}) {
  return { ...envelope('aithema.journal.record'), sid, client_event_id: randomUUID(),
    writer: { kind: 'worker', generation: 1 }, recorded_at: new Date(time).toISOString(), kind, data, ...overrides };
}
export function turn(overrides = {}) {
  return record('turn', { speaker: 'person', participant_ref: 'fixture-person', channel: 'text',
    trust: 'authenticated_person', lang: 'en', body: 'A fixture person requests an export.' }, overrides);
}
export function source(overrides = {}) {
  const text = '🧪 Fixture source: export as CSV.';
  return record('source', { label: 'fixture.txt', media_type: 'text/plain', sha256: sha256Hex(text),
    durability: 'non_resumable', text, segments: [{ id: 'leaf', start: 2, end: [...text].length }] }, overrides);
}
export function item({ citations = [], leaves = [] } = {}) {
  const content = { statement: 'Export fixture entries.', acceptance_criteria: [], constraint_refs: [] };
  return { item_ref: 'REQ-fixture', kind: 'requirement', version: 1, content,
    content_sha256: sha256Hex(canonicalJson(content)), citations,
    provenance: { intent: 'requested', derived_from: leaves }, state: 'draft', supersedes_item_version: null, host: null };
}
export function snapshot(overrides = {}) {
  const canonical = canonicalJson({ op: 'fixture-pass' });
  return { ...envelope('aithema.spec.snapshot'), sid, client_event_id: randomUUID(),
    working_rev: 1, expected_prev_rev: 0, consumed_seq: 0, worker_generation: 1, host_mode: 'review',
    spec: { items: [], questions: [], brief: null, screens: [] }, pending_ops: [], corrections: [],
    patch: { sha256: sha256Hex(canonical), canonical }, ...overrides };
}
export function pendingOp(overrides = {}) {
  const payload = ' { "fixture" : "🧪 export" }\n';
  return { op_key: `${sid}:source:1`, op: 'post_source', payload, payload_sha256: sha256Hex(payload), ...overrides };
}
export const code = (expected, status = 409) => (error) => error.code === expected && error.status === status;
