import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import { createExtensionRegistry, registerExtension } from '../lib/extensions.js';
import * as working from '../lib/working-spec.js';
import { createStream, replaceProposal, approveBaselineFromProposals } from '../lib/stream.js';
import { exportHandoverJson, exportHandoverCsv, parseHandoverJson, handoverToCsv } from '../lib/export.js';
import { AeonIntake } from '../runtime/hosts/aeon/intake.js';

const sid = '00000000-0000-4000-8000-000000000000';
const draftId = '10000000-0000-4000-8000-000000000000';
const nextDraftId = '20000000-0000-4000-8000-000000000000';
const authority = { party_ref: 'party:synthetic', roles: ['delivery_party'] };
const at = '2026-09-30T00:00:00Z';
const identity = { item_ref: 'REQ-1', version: 1 };
const descriptor = { namespace: 'x-demo.readiness', version: '1.0', title: 'Readiness', schema: {
  type: 'object', additionalProperties: false, required: ['score'], properties: {
    score: { type: 'number' }, quote: { type: 'string', maxLength: 20000 }, track: { type: 'string', maxLength: 20, enum: ['short', 'full'] },
  },
} };
const registry = createExtensionRegistry([descriptor]);
const extensions = { 'x-demo.readiness@1': { version: '1.0', data: { score: 0.5, quote: 'Use the synthetic status endpoint verbatim.', track: 'short' } } };
const input = () => ({ item_ref: 'REQ-1', kind: 'requirement', content: { statement: 'A synthetic status endpoint.', acceptance_criteria: [], constraint_refs: [] }, citations: [], provenance: { intent: 'inferred', derived_from: [] }, extensions: structuredClone(extensions) });
const confirmation = item => ({ item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' });
const host = (op = 'submit', counter = 1, aeon = false) => ({ op_key: `${sid}:${op}:${counter}`, ...(aeon ? { draft_id: counter === 1 ? draftId : nextDraftId } : { proposal_ref: `proposal:${counter}` }) });
const submission = (aeon = false) => ({ bindings: [{ ...identity, host: host('submit', 1, aeon) }], contributed_at: at });
const draft = (mode = 'review') => working.addWorkingItem(working.createWorkingSpec(mode), input(), registry);
const confirmed = (mode = 'review') => { const spec = draft(mode); return working.confirmWorkingItem(spec, confirmation(spec.items[0]), registry); };
const proposed = (aeon = false) => working.projectSubmission(confirmed(), authority, submission(aeon), registry).spec;
const revision = spec => ({ content: { ...spec.items.at(-1).content, statement: 'A revised synthetic endpoint.' }, citations: [], provenance: { intent: 'inferred', derived_from: [] } });
const candidate = spec => {
  const item = working.prepareWorkingItemRevision(spec, identity, revision(spec), registry);
  return working.confirmWorkingItemVersion(item, confirmation(item), 'review', registry);
};
const snapshot = items => {
  const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/snapshot.review.json', import.meta.url), 'utf8'));
  return { ...fixture.doc, minor: 1, sid, client_event_id: sid, working_rev: 1, expected_prev_rev: 0,
    consumed_seq: 0, spec: { items, questions: [], brief: null, screens: [] }, pending_ops: [], corrections: [], patch: { canonical: '{}', sha256: sha256Hex('{}') } };
};
const corrupt = (spec, data) => { const copy = structuredClone(spec); copy.items[0].extensions = structuredClone(data); return copy; };
const attacks = {
  unknown: { 'x-other.readiness@1': { version: '1.0', data: { score: 1 } } },
  invalid: { 'x-demo.readiness@1': { version: '1.0', data: { score: 'high' } } },
  limit: { 'x-demo.readiness@1': { version: '1.0', data: { score: 1, quote: 'a'.repeat(20000) } } },
};

const calls = {
  assertWorkingSpec: bad => working.assertWorkingSpec(corrupt(draft(), bad), registry),
  createWorkingSpec: bad => working.createWorkingSpec('review', corrupt(draft(), bad).items, registry),
  addWorkingItem: bad => working.addWorkingItem(working.createWorkingSpec('review'), { ...input(), extensions: bad }, registry),
  prepareWorkingItemRevision: bad => working.prepareWorkingItemRevision(draft(), identity, { ...revision(draft()), extensions: bad }, registry),
  reviseWorkingItem: bad => working.reviseWorkingItem(draft(), identity, { ...revision(draft()), extensions: bad }, registry),
  confirmWorkingItemVersion: bad => { const item = corrupt(draft(), bad).items[0]; return working.confirmWorkingItemVersion(item, confirmation(item), 'review', registry); },
  confirmWorkingItem: bad => { const spec = corrupt(draft(), bad); return working.confirmWorkingItem(spec, confirmation(spec.items[0]), registry); },
  projectSubmission: bad => working.projectSubmission(corrupt(confirmed(), bad), authority, submission(), registry),
  recordWorkingItemReplacement: bad => { const spec = proposed(); return working.recordWorkingItemReplacement(spec, identity, { ...candidate(spec), extensions: bad }, host('replace', 2), registry); },
  projectWorkingItemReplacement: bad => { const spec = proposed(); return working.projectWorkingItemReplacement(spec, authority, identity, { ...candidate(spec), extensions: bad }, { host: host('replace', 2), contributed_at: at }, registry); },
  recordHostDecision: bad => working.recordHostDecision(corrupt(proposed(), bad), identity, host(), 'accepted', registry),
};

for (const [name, invoke] of Object.entries(calls)) {
  for (const [kind, attack] of Object.entries(attacks)) {
    it(`(b) ${name} refuses ${kind} extensions through the shared authority`, () => {
      const before = canonicalJson(attack);
      assert.throws(() => invoke(attack), { code: `extension_${kind}`, status: 422 });
      assert.equal(canonicalJson(attack), before, 'caller data remains unchanged');
    });
  }
}

it('(b) valid extensions survive creation, revision, confirmation, submission, replacement and terminal acceptance', () => {
  const initial = draft();
  const originalHash = initial.items[0].content_sha256;
  assert.deepEqual(initial.items[0].extensions, extensions);
  const revised = working.reviseWorkingItem(initial, identity, revision(initial), registry);
  assert.deepEqual(revised.items[1].extensions, extensions);
  const cleared = working.reviseWorkingItem(initial, identity, { ...revision(initial), extensions: {} }, registry);
  assert.deepEqual(cleared.items[1].extensions, {});
  const projection = working.projectSubmission(confirmed(), authority, submission(), registry);
  assert.equal(Object.hasOwn(projection.proposals[0], 'extensions'), false);
  assert.deepEqual(projection.spec.items[0].extensions, extensions);
  const replacement = working.projectWorkingItemReplacement(projection.spec, authority, identity, candidate(projection.spec), { host: host('replace', 2), contributed_at: at }, registry);
  assert.equal(Object.hasOwn(replacement.proposal, 'extensions'), false);
  assert.deepEqual(replacement.spec.items[1].extensions, extensions);
  const accepted = working.recordHostDecision(replacement.spec, { ...identity, version: 2 }, host('replace', 2), 'accepted', registry);
  assert.deepEqual(accepted.items[1].extensions, extensions);
  assert.ok(Object.isFrozen(accepted.items[1].extensions['x-demo.readiness@1'].data));
  assert.equal(initial.items[0].content_sha256, originalHash);
  for (const spec of [initial, revised, cleared, projection.spec, replacement.spec, accepted]) assert.equal(validate('aithema.spec.snapshot', snapshot(spec.items)).ok, true);
});

it('(b) validating the complete spec also protects untouched history and retry/no-op paths', () => {
  const bad = corrupt(proposed(), attacks.invalid);
  assert.throws(() => working.addWorkingItem(bad, { ...input(), item_ref: 'REQ-2' }, registry), { code: 'extension_invalid' });
  const replacement = candidate(proposed());
  assert.throws(() => working.recordWorkingItemReplacement(bad, identity, replacement, host('replace', 2), registry), { code: 'extension_invalid' });
  const accepted = working.recordHostDecision(proposed(), identity, host(), 'accepted', registry);
  assert.throws(() => working.recordHostDecision(corrupt(accepted, attacks.invalid), identity, host(), 'accepted', registry), { code: 'extension_invalid' });
  const ready = confirmed();
  assert.throws(() => working.confirmWorkingItem(corrupt(ready, attacks.invalid), confirmation(ready.items[0]), registry), { code: 'extension_invalid' });
  assert.throws(() => working.projectSubmission(corrupt(confirmed('working_spec_only'), attacks.invalid), null, null, registry), { code: 'extension_invalid' });
});

it('(b,c) historical minor data remains writable after a later minor is registered', () => {
  const next = structuredClone(descriptor);
  next.version = '1.1';
  next.schema.properties.optional = { type: 'boolean' };
  const later = registerExtension(registry, next);
  assert.doesNotThrow(() => working.createWorkingSpec('review', draft().items, later));
  assert.doesNotThrow(() => working.confirmWorkingItem(draft(), confirmation(draft().items[0]), later));
  assert.throws(() => working.createWorkingSpec('review', draft().items), { code: 'extension_unknown' });
});

it('(b,e) snapshot contracts check map shape, version matching and canonical size limits without importing a registry', () => {
  const doc = snapshot(draft().items);
  assert.equal(validate(doc.contract, doc).ok, true);
  for (const bad of [null, [], { 'invalid-key': { version: '1.0', data: {} } }, { 'x-demo.readiness@1': { version: '1.0', data: {}, extra: true } }]) {
    const changed = structuredClone(doc); changed.spec.items[0].extensions = bad;
    assert.equal(validate(changed.contract, changed).ok, false);
  }
  for (const bad of [attacks.limit, { 'x-demo.readiness@2': { version: '1.0', data: {} } }]) {
    const changed = structuredClone(doc); changed.spec.items[0].extensions = bad;
    assert.equal(validate(changed.contract, changed).ok, false);
  }
});

it('(d) handover exports validated typed extensions for every working item version, with CSV and parse round trips', () => {
  const spec = working.reviseWorkingItem(draft(), identity, revision(draft()), registry);
  const stream = createStream('stream:synthetic', ['new_product']);
  const options = { registry, workingSpec: spec };
  const exported = exportHandoverJson(stream, at, options);
  assert.deepEqual(exported.extensions, [1, 2].map(item_version => ({ item_ref: 'REQ-1', item_version, namespace: 'x-demo.readiness', version: '1.0', data: extensions['x-demo.readiness@1'].data })));
  assert.deepEqual(parseHandoverJson(exported, { registry }), exported);
  assert.ok(Object.isFrozen(exported.extensions[0].data));
  assert.equal(exported.baseline, null);
  assert.ok(exportHandoverCsv(stream, undefined, at, options).includes('x-demo.readiness@1.0'));
  assert.ok(handoverToCsv(exported, undefined, { registry }).includes('synthetic status endpoint verbatim'));
  for (const [kind, attack] of Object.entries(attacks)) assert.throws(() => exportHandoverJson(stream, at, { registry, workingSpec: corrupt(spec, attack) }), { code: `extension_${kind}` });
});

it('(d) stream proposal exports retain validated analysis after decisions and prefer the linked working spec', () => {
  const projection = working.projectSubmission(confirmed(), authority, submission(), registry);
  const stream = { ...createStream('stream:synthetic', ['new_product']), proposals: projection.proposals.map(proposal => ({ ...proposal, extensions })), decisions: [{ proposal_ref: 'proposal:1', outcome: 'approved' }] };
  const exported = exportHandoverJson(stream, at, { registry });
  assert.equal(exported.pending_proposals.length, 0);
  assert.deepEqual(exported.extensions[0], { proposal_ref: 'proposal:1', namespace: 'x-demo.readiness', version: '1.0', data: extensions['x-demo.readiness@1'].data });
  assert.equal(exportHandoverJson({ ...stream, working_spec: projection.spec }, at, { registry }).extensions[0].item_ref, 'REQ-1');
  const changed = structuredClone(stream);
  changed.proposals[0].extensions = attacks.invalid;
  assert.throws(() => exportHandoverJson(changed, at, { registry }), { code: 'extension_invalid' });
});

it('(d) handover parsing and CSV refuse untyped, duplicate, unknown, invalid and oversized extension sections', () => {
  const exported = exportHandoverJson(createStream('stream:synthetic', ['new_product']), at, { registry, workingSpec: draft() });
  const entry = exported.extensions[0];
  for (const section of [{ arbitrary: true }, [{ ...entry, extra: true }], [{ ...entry, item_version: 0 }], [entry, entry], [{ ...entry, namespace: 'bad' }], [{ ...entry, data: { score: 'bad' } }]]) {
    assert.throws(() => parseHandoverJson({ ...exported, extensions: section }, { registry }), { code: 'extension_invalid' });
    assert.throws(() => handoverToCsv({ ...exported, extensions: section }, undefined, { registry }), { code: 'extension_invalid' });
  }
  assert.throws(() => parseHandoverJson(exported), { code: 'extension_unknown' });
  assert.throws(() => parseHandoverJson({ ...exported, extensions: [{ ...entry, data: { score: 1, quote: 'a'.repeat(20000) } }] }, { registry }), { code: 'extension_limit' });
});

it('(f) extension-free item shapes, confirmation content hashes and handover canonical bytes remain unchanged', () => {
  const without = input(); delete without.extensions;
  const plain = working.addWorkingItem(working.createWorkingSpec('review'), without);
  assert.equal(Object.hasOwn(plain.items[0], 'extensions'), false);
  assert.equal(plain.items[0].content_sha256, draft().items[0].content_sha256);
  const stream = createStream('stream:synthetic', ['new_product']);
  assert.equal(canonicalJson(exportHandoverJson(stream, at)), canonicalJson({ handover_version: 'aithema.handover/0.1', stream_ref: stream.stream_ref, exported_at: at, baseline: null, pending_proposals: [], decisions: [] }));
});

for (const op of ['submit', 'replace']) {
  it(`(d) Aeon ${op} forwards original draft bytes and extensions unchanged without network`, async () => {
    const previous = { ...confirmed().items[0], state: 'superseded', host: host('submit', 1, true) };
    const next = op === 'replace' ? { ...candidate(proposed(true)), state: 'confirmed', host: null } : confirmed().items[0];
    const doc = snapshot(op === 'replace' ? [previous, next] : [next]);
    const original = Buffer.from(`\n${JSON.stringify(doc, null, 2)}\n`);
    const requests = [];
    const http = { scope: { sid }, async request(request) {
      requests.push(request);
      const projected = structuredClone(doc);
      projected.spec.items.at(-1).state = 'proposed';
      projected.spec.items.at(-1).host = host(op, 2, true);
      return { result: { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0, sid, client_event_id: nextDraftId,
        writer: { kind: 'worker', generation: 1 }, recorded_at: at, kind: 'op.result', data: { op_key: `${sid}:${op}:2`, host_ids: { draft_id: nextDraftId } } },
        snapshot: projected, supersedes_draft_id: op === 'replace' ? draftId : null };
    } };
    const intake = new AeonIntake({ http, supportsReplace: true });
    const prepared = intake.prepare({ op, n: 2, bytes: original, supersedes_draft_id: op === 'replace' ? draftId : null });
    assert.equal(JSON.parse(prepared.payload).document_bytes, original.toString());
    const response = await intake.execute(prepared, { sid });
    assert.deepEqual(requests[0].bytes, original);
    assert.deepEqual(response.snapshot.spec.items.at(-1).extensions, extensions);
    assert.deepEqual(JSON.parse(requests[0].bytes).spec.items.at(-1).extensions, extensions);
    await intake.retryOp(prepared, { sid });
    assert.deepEqual(requests[1].bytes, original);
  });
}

it('(d) Aeon refuses a host acknowledgement that changes otherwise schema-valid extension data', async () => {
  const doc = snapshot(confirmed().items);
  const http = { scope: { sid }, async request() {
    const projected = structuredClone(doc);
    projected.spec.items[0].state = 'proposed';
    projected.spec.items[0].host = host('submit', 1, true);
    projected.spec.items[0].extensions['x-demo.readiness@1'].data.score = 1;
    return { result: { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0, sid, client_event_id: nextDraftId, writer: { kind: 'worker', generation: 1 }, recorded_at: at,
      kind: 'op.result', data: { op_key: `${sid}:submit:1`, host_ids: { draft_id: draftId } } }, snapshot: projected, supersedes_draft_id: null };
  } };
  const intake = new AeonIntake({ http });
  const prepared = intake.prepare({ op: 'submit', n: 1, bytes: Buffer.from(canonicalJson(doc)) });
  await assert.rejects(intake.execute(prepared, { sid }), { status: 502 });
});

it('(b) mutation coverage enumerates every exported working-spec boundary', () => {
  assert.deepEqual(Object.keys(calls).sort(), Object.keys(working).sort());
});

it('(d,f) actual standalone replace and approval retain extensions without changing baseline digests', () => {
  const projection = working.projectSubmission(confirmed(), authority, submission(), registry);
  const replacement = working.projectWorkingItemReplacement(projection.spec, authority, identity, candidate(projection.spec), { host: host('replace', 2), contributed_at: at }, registry);
  const originalStream = { ...createStream('stream:synthetic', ['new_product']), proposals: projection.proposals };
  const replaced = replaceProposal(originalStream, authority, 'proposal:1', replacement.proposal);
  const approver = { party_ref: 'person:synthetic', roles: ['requirements_approver'] };
  const accepted = approveBaselineFromProposals(replaced, approver, ['proposal:2'], 'baseline:synthetic', at);
  const plain = structuredClone(replaced);
  for (const proposal of plain.proposals) delete proposal.extensions;
  const plainAccepted = approveBaselineFromProposals(plain, approver, ['proposal:2'], 'baseline:synthetic', at);
  assert.equal(accepted.baselines.at(-1).content_digest, plainAccepted.baselines.at(-1).content_digest);
  assert.equal(accepted.baselines.at(-1).revision_seal, plainAccepted.baselines.at(-1).revision_seal);
  const acceptedSpec = working.recordHostDecision(replacement.spec, { ...identity, version: 2 }, host('replace', 2), 'accepted', registry);
  const handover = exportHandoverJson(accepted, at, { registry, workingSpec: acceptedSpec });
  assert.equal(handover.pending_proposals.length, 0);
  assert.equal(handover.extensions.length, 2);
  assert.deepEqual(handover.extensions[1].data, extensions['x-demo.readiness@1'].data);
});
