import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../contracts/validate.js';
import { confirmBatch } from '../workspace/text-session.js';
import { approveBaselineFromProposals } from '../lib/stream.js';
import { buildRevisionReview } from '../lib/revision-review.js';
import { hydrateSnapshot, reopenDesign, snapshotDependencies, validateCitations } from '../runtime/journal/hydrate.js';
import { validateItemProvenance } from '../runtime/provenance.js';
import { actor, authorizationFor, binding, bytes, designData, designRecord, fixture, output, referenceSubmission, renderFixture, textSession, valid } from './fixtures/e2e/support.mjs';
import { crash } from './fixtures/e2e/run-crash.mjs';

for (const [mode, boundary] of [
  ['reaction', 'turn.after_ack'], ['reaction', 'reaction.after_prepare'], ['reaction', 'reaction.before_append'],
  ['reaction', 'reaction.mid'], ['reaction', 'reaction.after_ack'], ['reaction', 'reaction.before_finalize'],
  ['spec', 'spec.after_compute'], ['spec', 'snapshot.before_append'], ['spec', 'snapshot.after_ack'],
  ['op', 'op.pending'], ['op', 'op.after_ack'], ['op', 'op.result'],
]) {
  it(`(a) process crash ${boundary}: acknowledged bytes, citation closure, design fixture and idempotent host operations survive`, async (t) => {
    const path = crash(mode, boundary);
    const fetched = [];
    let f;
    f = fixture(t, { path, initialize: false, handler: output, journalOverrides: {
      recordsByIds: (ids, auth) => { fetched.push([...ids]); return f.journal.recordsByIds(ids, auth); },
    } });
    const before = f.journal.cursor(f.auth);
    const dependencies = snapshotDependencies(before.snapshot.document);
    assert.ok(dependencies.some((seq) => seq < before.snapshot.document.consumed_seq));
    const host = referenceSubmission(f); t.after(() => host.store.close());
    const retries = [];
    const oldOp = before.snapshot.document.pending_ops[0];
    await f.engine.resume({ authorizationFor, retryOp: async (op, auth) => {
      retries.push(op); assert.deepEqual(op.payload_bytes, Buffer.from(oldOp.payload));
      assert.equal(op.payload_sha256, oldOp.payload_sha256);
      return host.execute(op, auth);
    } });
    assert.ok(fetched.some((ids) => canonicalJson(ids) === canonicalJson(dependencies)), 'resume explicitly hydrates every earlier dependency');
    for (const ack of JSON.parse(readFileSync(`${path}.acks.json`))) {
      const row = f.journal.recordsByIds([ack.seq], f.client.authority)[0];
      assert.deepEqual(row.bytes, Buffer.from(ack.bytes, 'base64'), `acknowledged seq ${ack.seq} retained byte-exact`);
    }
    const records = f.records();
    assert.equal(new Set(records.map((r) => r.document.client_event_id)).size, records.length);
    assert.equal(records.filter((r) => r.document.kind === 'turn').length, mode === 'op' ? 1 : 2);
    const cursor = f.journal.cursor(f.client.authority);
    const closure = await hydrateSnapshot(f.port, cursor.snapshot, f.client.authority);
    assert.equal(validateCitations(f.engine.state, closure), true);
    const evidence = [...closure.values()].map((r) => r.document);
    const turns = f.records('turn').map((r) => r.document);
    for (const item of f.engine.state.spec.items) validateItemProvenance(item, {
      sid: f.client.authority.sid, records: evidence, turnOrdinals: new Map(turns.map((r, i) => [r.seq, i])),
    });
    assert.ok(evidence.some((r) => r.kind === 'source'));
    assert.ok(evidence.some((r) => r.kind === 'turn' && r.seq <= f.engine.state.consumed_seq));
    const opened = await reopenDesign(f.engine.state, closure, 'export', renderFixture);
    assert.deepEqual(opened, renderFixture({ screen_ir_bytes: Buffer.from(canonicalJson(designData.screen_ir)), tokens_bytes: Buffer.from(canonicalJson(designData.tokens)) }));
    const originalInput = evidence.find((r) => r.kind === 'design.input');
    const { seq, ...input } = originalInput;
    assert.deepEqual(closure.get(seq).bytes, bytes(designRecord()), 'immutable fixture bytes reopened from the host');
    assert.deepEqual(input.data, designData);
    valid(f.engine.state); for (const row of records) valid(row.document);
    if (mode === 'op') {
      assert.equal(retries.length, boundary === 'op.result' ? 0 : 1);
      const project = host.store.getProject(host.projectRef, actor);
      assert.equal(project.stream.proposals.length, 1);
      assert.equal(project.revision, 2, 'exact retry never creates a second host write');
      assert.equal(f.records('op.result').length, 1);
      assert.equal(f.engine.state.pending_ops.length, 0);
    }
    if (boundary === 'reaction.mid') {
      const partial = f.records('reaction').find((r) => !r.document.data.complete).document;
      assert.equal(partial.data.delivered_prefix, 'Rec');
      assert.ok(f.calls.some(({ lane, payload }) => lane === 'spec' && payload.events.some((r) => r.seq === partial.seq && r.context.includes('Rec'))));
      assert.ok(f.calls.filter(({ lane }) => lane === 'reaction').every(({ payload }) => !payload.history.some((r) => r.seq === partial.seq)));
    }
    const spec = canonicalJson(f.engine.state.spec);
    const hostRev = host.store.getProject(host.projectRef, actor).revision;
    await f.engine.replay();
    assert.equal(canonicalJson(f.engine.state.spec), spec);
    assert.equal(host.store.getProject(host.projectRef, actor).revision, hostRev);
    const port = textSession(f, () => host.submitConfirmed());
    await confirmBatch(port, binding(f.engine.state.spec.items[0]), { einreichen: true });
    const submitted = host.store.getProject(host.projectRef, actor);
    assert.equal(submitted.stream.proposals.length, 1, 'post-restart Einreichen cannot duplicate the recovered host write');
    const review = buildRevisionReview(submitted.stream);
    const approved = approveBaselineFromProposals(submitted.stream, actor, review.proposals.map((p) => p.proposal_ref),
      'baseline:restarted', '2026-09-30T07:00:00Z', review.review_digest);
    assert.equal(approved.baselines.length, 1, 'a separate full host review is still required after restart');
    host.store.apply({ actor, projectRef: host.projectRef, expectedRevision: submitted.revision,
      mutate: (live) => ({ ...live, stream: approved }) });
    assert.equal(f.engine.state.spec.items[0].state, 'proposed');
    valid(f.engine.state);
  });
}

for (const missing of ['source', 'turn', 'design.input']) {
  it(`(a) incomplete hydrated ${missing} closure stops restart before provider calls or pending host writes`, async (t) => {
    const path = crash('op', 'op.pending');
    let f, writes = 0;
    f = fixture(t, { path, initialize: false, handler: output, journalOverrides: {
      recordsByIds: (ids, auth) => f.journal.recordsByIds(ids, auth).filter((r) => r.document.kind !== missing),
    } });
    await assert.rejects(f.engine.resume({ authorizationFor, retryOp: () => { writes++; } }), (e) => e.code === 'citation_invalid');
    assert.equal(f.calls.length, 0); assert.equal(writes, 0);
  });
}
