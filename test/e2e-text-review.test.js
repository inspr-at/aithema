import { it } from 'node:test';
import assert from 'node:assert/strict';
import { confirmBatch } from '../workspace/text-session.js';
import { buildRevisionReview, acceptRevisionReview } from '../lib/revision-review.js';
import { approveBaselineFromProposals, currentBaseline } from '../lib/stream.js';
import { actor, binding, bootstrap, fixture, output, referenceSubmission, textSession, valid, workspaceFixture } from './fixtures/e2e/support.mjs';

it('(a) reference host: text, full-item hash-bound Einreichen, immutable projection and explicit baseline review', async (t) => {
  const f = fixture(t, { handler: output });
  await bootstrap(f);
  const host = referenceSubmission(f); t.after(() => host.store.close());
  const port = textSession(f, () => host.submitConfirmed());
  const w = await workspaceFixture(t, port);
  const item = f.engine.state.spec.items[0];
  const page = await w.request(w.path, { json: false });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(item.content.statement));
  for (const criterion of item.content.acceptance_criteria) assert.ok(page.text.includes(criterion));
  assert.ok(page.text.includes(binding(item)), 'rendered confirmation binds ref, version and complete-content hash');
  const wrong = await w.request(`${w.path}/text/confirm`, { method: 'POST', form: { action: 'einreichen', binding: binding({ ...item, content_sha256: '0'.repeat(64) }) } });
  assert.equal(wrong.status, 409);
  assert.equal(f.records('ui.confirm').length, 0);
  assert.equal(host.store.getProject(host.projectRef, actor).stream.proposals.length, 0);
  const submitted = await w.request(`${w.path}/text/confirm`, { method: 'POST', form: { action: 'einreichen', binding: binding(item) } });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.json().submitted, true);
  assert.match(submitted.json().message, /Submitted to the host/);
  const project = host.store.getProject(host.projectRef, actor);
  const proposal = project.stream.proposals[0];
  assert.deepEqual(proposal.content, item.content);
  assert.equal(proposal.content_sha256, item.content_sha256);
  assert.deepEqual(proposal.citations, item.citations);
  assert.equal(currentBaseline(project.stream), null, 'confirmation and submission are not acceptance');
  const review = buildRevisionReview(project.stream);
  assert.equal(review.proposals.length, 1);
  assert.throws(() => acceptRevisionReview(project.stream, [proposal.proposal_ref], '0'.repeat(64)), /review/);
  const receipt = acceptRevisionReview(project.stream, [proposal.proposal_ref], review.review_digest);
  assert.equal(receipt.selected_proposals[0].proposal_ref, proposal.proposal_ref);
  assert.throws(() => approveBaselineFromProposals(project.stream, { ...actor, roles: ['delivery_party'] }, [proposal.proposal_ref], 'baseline:bad'), /approv/);
  const reviewed = approveBaselineFromProposals(project.stream, actor, [proposal.proposal_ref], 'baseline:e2e', '2026-09-30T07:00:00Z', review.review_digest);
  assert.equal(currentBaseline(reviewed).requirements[0].statement, item.content.statement);
  host.store.apply({ actor, projectRef: host.projectRef, expectedRevision: project.revision,
    mutate: (live) => ({ ...live, stream: reviewed }) });
  assert.equal(host.store.getProject(host.projectRef, actor).stream.baselines.length, 1);
  valid(f.engine.state);
});

for (const mode of ['review', 'working_spec_only']) {
  it(`(m2) Einreichen obeys transitions.json and reports actual submission (${mode})`, async (t) => {
    const f = fixture(t, { handler: output, hostMode: mode });
    await f.engine.start();
    let calls = 0;
    const port = textSession(f, async () => { calls++; });
    await port.submitTurn({ text: 'Please export entries as CSV.' }); await port.idle();
    const w = await workspaceFixture(t, port);
    const item = f.engine.state.spec.items[0];
    const response = await w.request(`${w.path}/text/confirm`, { method: 'POST', form: { action: 'einreichen', binding: binding(item) } });
    assert.equal(response.status, 200, response.text);
    assert.equal(calls, mode === 'review' ? 1 : 0);
    assert.equal(response.json().submitted, mode === 'review');
    assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
    assert.equal(f.records('ui.confirm').length, 1);
    if (mode === 'working_spec_only') {
      assert.match(response.json().message, /not sent to the host/);
      assert.doesNotMatch(response.json().message, /Submitted to the host/);
      const again = await confirmBatch(port, binding(item), { einreichen: true });
      assert.equal(again.submitted, false); assert.equal(calls, 0);
      assert.equal(f.records('ui.confirm').length, 1);
    }
    valid(f.engine.state);
  });
}

for (const brokenView of [false, true]) {
  it(`(m1) enabled speech refuses legacy transcription before parsing/spending with an attached text session (view failure=${brokenView})`, async (t) => {
    const f = fixture(t); await f.engine.start();
    const port = textSession(f);
    const w = await workspaceFixture(t, brokenView ? { ...port, view: async () => { throw new Error('View unavailable'); } } : port,
      { speech: { enabled: true, kind: 'mock', providerId: 'mock', model: 'mock-stt', allowedModels: ['mock-stt'] } });
    let calls = 0;
    w.workspace.controller.transcribeSpeech = async () => { calls++; throw new Error('Legacy speech reached'); };
    const before = w.workspace.store.getProject(w.project.project_ref, actor);
    const response = await w.request(`${w.path}/transcribe`, { method: 'POST', body: 'deliberately invalid audio',
      headers: { 'content-type': 'multipart/form-data; boundary=bad' } });
    assert.equal(response.status, 409, response.text);
    assert.equal(response.json().code, 'text_session_required');
    assert.equal(calls, 0);
    assert.deepEqual(w.workspace.store.getProject(w.project.project_ref, actor), before);
    assert.equal(f.records('budget.hold').length, 0);
    assert.equal(f.records('turn').length, 0);
  });
}
