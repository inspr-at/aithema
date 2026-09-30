import { it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import { createTextSession, confirmBatch } from '../workspace/text-session.js';
import { prepareWorkingItemRevision, confirmWorkingItemVersion } from '../lib/working-spec.js';
import { JournalClient } from '../runtime/journal/client.js';
import { routePath } from './host-kit/host.js';
import { record as mockRecord, snapshot as mockSnapshot } from './host-kit/fixtures.js';
import { binding, bytes, mockEngine, save, valid } from './fixtures/e2e/support.mjs';

const wire = (document) => {
  const { seq, ...body } = document;
  return Buffer.from(canonicalJson(body));
};

async function setup(t) {
  const s = mockEngine(t);
  const text = 'Synthetic export as CSV.';
  const source = mockRecord(s.f.sid, 'source', { label: 'synthetic.txt', media_type: 'text/plain', sha256: sha256Hex(text),
    durability: 'resumable', text, segments: [{ id: 'leaf', start: 0, end: [...text].length }] });
  const sourceOp = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(source) });
  const imported = await s.intake.execute(sourceOp, s.auth);
  await s.engine.start();
  const port = createTextSession({ engine: s.engine, journal: s.client, journalPort: s.journal, principalRef: 'person-1', now: s.clock.wallNow });
  await port.submitTurn({ text: 'Please export entries as CSV.' }); await port.idle();
  const turn = (await s.journal.recordsAfter(0, s.auth)).find((r) => r.document.kind === 'turn');
  await s.intake.execute(s.intake.prepare({ op: 'post_turn', n: 1, bytes: turn.bytes,
    conversation_source_id: imported.result.data.host_ids.source_id }), s.auth);
  const item = s.engine.state.spec.items[0];
  await confirmBatch(port, binding(item));
  const state = s.engine.state;
  const op = s.intake.prepare({ op: 'submit', n: 1, bytes: wire(state),
    context: { sid: s.f.sid, records: (await s.journal.recordsAfter(0, s.auth)).map((r) => r.document).filter((r) => r.contract === "aithema.journal.record"), turnOrdinals: new Map([[turn.document.seq, 0]]) } });
  await save(s, { pending_ops: [op] });
  const response = await s.intake.execute(op, s.auth);
  await s.client.append(bytes(mockRecord(s.f.sid, 'op.result', response.result.data)));
  await save(s, { spec: response.snapshot.spec, pending_ops: [] });
  await s.engine.transcript();
  return { ...s, sessionPort: port, response, op, sourceOp, sourceId: imported.result.data.host_ids.source_id,
    id: response.result.data.host_ids.draft_id };
}

async function replacement(s, prior = s.response, n = 1) {
  const old = prior.snapshot.spec.items.find((row) => row.state === 'proposed');
  const domain = { host_mode: 'review', items: prior.snapshot.spec.items };
  const draft = prepareWorkingItemRevision(domain, { item_ref: old.item_ref, version: old.version }, {
    content: { ...old.content, statement: `Export CSV revision ${old.version + 1}.` }, citations: old.citations, provenance: old.provenance,
  });
  const confirmation = { item_ref: draft.item_ref, version: draft.version, content_sha256: draft.content_sha256, principal_ref: 'person-1' };
  await s.journal.append(bytes(mockRecord(s.f.sid, 'ui.confirm', confirmation)), s.auth);
  const next = confirmWorkingItemVersion(draft, confirmation, 'review');
  const doc = mockSnapshot(s.f.sid, [...domain.items.map((row) => row === old ? { ...row, state: 'superseded' } : row), next]);
  const records = (await s.journal.recordsAfter(0, s.auth)).map((r) => r.document).filter((r) => r.contract === "aithema.journal.record");
  const turns = records.filter((row) => row.kind === 'turn');
  const op = s.intake.prepare({ op: 'replace', n, bytes: bytes(doc), supersedes_draft_id: old.host.draft_id,
    context: { sid: s.f.sid, records, turnOrdinals: new Map(turns.map((row, i) => [row.seq, i])) } });
  return { op, doc, old, next };
}

const accept = (s, id) => s.f.host.request({ method: 'POST', path: routePath('intake', s.f.sid, 'accept', id),
  person: s.f.host.personSession(s.f.sid, 'person-1') });

it('(b) engine → mock adapter: evidence mappings, confirmed new feature, three immutable versions and explicit person acceptance', async (t) => {
  const s = await setup(t);
  assert.equal(s.response.snapshot.spec.items[0].state, 'proposed');
  assert.equal(s.engine.state.spec.items[0].citations.length, 2);
  assert.equal(s.engine.state.spec.items[0].host.draft_id, s.id);
  const originals = structuredClone(s.response.snapshot.spec.items[0]);
  const second = await replacement(s);
  const response2 = await s.intake.execute(second.op, s.auth);
  const third = await replacement(s, response2, 2);
  const response3 = await s.intake.execute(third.op, s.auth);
  assert.deepEqual(response3.snapshot.spec.items.map((row) => [row.version, row.state]), [[1, 'superseded'], [2, 'superseded'], [3, 'proposed']]);
  assert.deepEqual(response3.snapshot.spec.items[0].content, originals.content);
  assert.deepEqual(response3.snapshot.spec.items[2].supersedes_item_version, { item_ref: originals.item_ref, version: 2 });
  assert.equal(accept(s, s.id).body.code, 'draft_superseded');
  const id3 = response3.result.data.host_ids.draft_id;
  const accepted = accept(s, id3); assert.equal(accepted.status, 200); valid(accepted.body.snapshot);
  assert.deepEqual(accept(s, id3).body, accepted.body, 'person acceptance replays its original result');
  const host = await s.intake.snapshot(s.auth);
  assert.deepEqual(host.snapshot.spec.items.map((row) => row.state), ['superseded', 'superseded', 'accepted']);
  assert.throws(() => prepareWorkingItemRevision({ host_mode: 'review', items: host.snapshot.spec.items },
    { item_ref: originals.item_ref, version: 3 }, { content: originals.content, citations: originals.citations, provenance: originals.provenance }), { code: 'already_accepted' });
});

for (const first of ['accept', 'replace']) {
  it(`(b) concurrent accept/replace, explicit ${first}-first commit order: atomic arbitration and exact retry`, async (t) => {
    const s = await setup(t);
    const next = await replacement(s);
    const gates = { accept: Promise.withResolvers(), replace: Promise.withResolvers() };
    // Both contenders are pending before either host transaction may run.
    const accepting = gates.accept.promise.then(() => accept(s, s.id));
    const replacing = gates.replace.promise.then(() => s.intake.execute(next.op, s.auth));
    const results = Promise.allSettled([accepting, replacing]);
    gates[first].resolve();
    await (first === 'accept' ? accepting : replacing);
    gates[first === 'accept' ? 'replace' : 'accept'].resolve();
    const [accepted, replaced] = await results;
    const state = (await s.intake.snapshot(s.auth)).snapshot;
    if (first === 'accept') {
      assert.equal(accepted.value.status, 200);
      assert.equal(replaced.status, 'rejected'); assert.equal(replaced.reason.code, 'already_accepted');
      assert.deepEqual(state.spec.items.map((row) => row.state), ['accepted']);
    } else {
      assert.equal(accepted.value.body.code, 'draft_superseded');
      assert.equal(replaced.status, 'fulfilled');
      assert.deepEqual(state.spec.items.map((row) => row.state), ['superseded', 'proposed']);
      const id = replaced.value.result.data.host_ids.draft_id;
      assert.equal(accept(s, id).status, 200);
      assert.deepEqual(await s.intake.execute(next.op, s.auth), replaced.value, 'exact replacement retry returns the original bytes/result even after acceptance');
      const envelope = JSON.parse(next.op.payload);
      envelope.document_bytes += ' ';
      const changed = canonicalJson(envelope);
      await assert.rejects(s.intake.execute({ ...next.op, payload: changed, payload_sha256: sha256Hex(changed) }, s.auth), { status: 409, code: 'idempotency_conflict' });
      assert.equal((await s.intake.snapshot(s.auth)).snapshot.spec.items.at(-1).state, 'accepted');
    }
    valid(state);
  });
}

it('(b) replacement vs replacement commits one successor and refuses the loser with draft_superseded', async (t) => {
  const s = await setup(t);
  const first = await replacement(s, s.response, 1), second = await replacement(s, s.response, 2);
  const results = await Promise.allSettled([s.intake.execute(first.op, s.auth), s.intake.execute(second.op, s.auth)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.code, 'draft_superseded');
  assert.equal((await s.intake.snapshot(s.auth)).snapshot.spec.items.length, 2);
});

for (const acknowledged of [false, true]) {
  it(`(b) mock-host restart retries persisted adapter bytes exactly (host write acknowledged=${acknowledged})`, async (t) => {
    const s = await setup(t);
    const next = await replacement(s);
    await save(s, { pending_ops: [next.op] });
    const receipt = acknowledged ? await s.intake.execute(next.op, s.auth) : null;
    s.engine.close();
    const fresh = new JournalClient({ port: s.journal, authority: s.auth, now: s.clock.wallNow });
    let retry;
    await fresh.resume({ retryOp: async (op, auth) => {
      retry = op; assert.deepEqual(op.payload_bytes, Buffer.from(next.op.payload));
      assert.equal(auth.gen, 2); return s.intake.retryOp(op, auth);
    } });
    assert.equal(retry.payload, next.op.payload);
    const state = (await s.intake.snapshot(fresh.authority)).snapshot;
    assert.deepEqual(state.spec.items.map((row) => row.state), ['superseded', 'proposed']);
    if (receipt) assert.equal(state.spec.items.at(-1).host.draft_id, receipt.result.data.host_ids.draft_id);
    const writes = s.requests.filter((r) => r.opKey === next.op.op_key);
    assert.equal(writes.length, acknowledged ? 2 : 1);
    assert.ok(writes.every((r) => r.body === JSON.parse(next.op.payload).document_bytes));
    const records = await s.journal.recordsAfter(0, fresh.authority);
    assert.equal(records.filter((r) => r.document.kind === 'op.result' && r.document.data.op_key === next.op.op_key).length, 1);
    // The host integration reconciles the successful replacement projection
    // into its next complete journal snapshot before the new engine starts.
    await save({ ...s, client: fresh }, { spec: state.spec, pending_ops: [] });
    const restarted = s.makeEngine(fresh); t.after(() => restarted.close());
    await restarted.start();
    assert.deepEqual(restarted.state.spec.items.map((row) => row.state), ['superseded', 'proposed']);
    assert.deepEqual(restarted.state.spec.items.at(-1).citations, next.next.citations);
    assert.equal(restarted.state.worker_generation, 2);
    assert.equal(restarted.state.pending_ops.length, 0);
    await assert.rejects(s.journal.append(bytes(mockRecord(s.f.sid)), s.auth), { code: 'fenced_generation' });
    valid(restarted.state);
    valid(state);
  });
}
