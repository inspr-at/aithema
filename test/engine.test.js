import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TextEngine, EngineError, renderReaction, validateReaction, likelyExtraQuestion, applySpecPatch } from '../runtime/engine/index.js';
import { canonicalJson, sha256Hex, validate, loadContractFile } from '../contracts/validate.js';
import { fixture, defaultOutput, flush, authorizationFor, bytes, record, snapshot, item, sid } from './engine-helpers.test.js';
import { pendingOp } from './fixtures/journal/helpers.mjs';

const question = { question_id: 'export-format', text: 'Which export format do you need?', state: 'open' };
const initialQuestions = (f) => f.journal.append(bytes(snapshot({ spec: { items: [], questions: [question], brief: null, screens: [] } })), f.auth);
const deferred = () => Promise.withResolvers();

it('lane B is single-flight across concurrent callers and preserves immutable domain drafts', async (t) => {
  const wait = deferred();
  const f = fixture(t, { handler: async (lane, payload) => { if (lane === 'spec') await wait.promise; return defaultOutput(lane, payload); } });
  f.personTurn();
  await f.engine.start();
  const first = f.engine.passSpec();
  const second = f.engine.passSpec();
  await flush();
  assert.equal(f.calls.length, 1);
  wait.resolve();
  assert.deepEqual(await second, await first);
  const state = f.engine.state;
  assert.equal(state.spec.items.length, 1);
  assert.equal(state.spec.items[0].state, 'draft');
  assert.equal(state.spec.items[0].version, 1);
  assert.equal(validate(state.contract, state).ok, true);
  assert.equal((await f.engine.passSpec()).status, 'idle');
});

it('CAS loser re-reads consumed_seq instead of applying or paying for the same events twice', async (t) => {
  let journal;
  let conflict = true;
  const f = fixture(t, { journalOverrides: { append: (original, auth) => {
    const document = JSON.parse(original);
    if (document.contract === 'aithema.spec.snapshot' && conflict) {
      conflict = false;
      journal.append(bytes({ ...document, client_event_id: '33333333-3333-4333-8333-333333333333' }), auth);
    }
    return journal.append(original, auth);
  } } });
  journal = f.journal;
  f.personTurn();
  await f.engine.start();
  assert.equal((await f.engine.passSpec()).status, 'idle');
  assert.equal(f.engine.metrics.cas_retries, 1);
  assert.equal(f.engine.state.spec.items.length, 1);
  assert.equal(f.engine.state.spec.items[0].version, 1);
  assert.equal(f.calls.length, 1, 'consumed event must not trigger another provider pass');
});

it('CAS loss to an unrelated revision discards stale patch and recomputes under a new hold', async (t) => {
  let journal;
  let conflict = true;
  const f = fixture(t, { journalOverrides: { append: (original, auth) => {
    const document = JSON.parse(original);
    if (document.contract === 'aithema.spec.snapshot' && conflict) {
      conflict = false;
      journal.append(bytes(snapshot({ spec: { items: [], questions: [], brief: 'Concurrent update', screens: [] } })), auth);
    }
    return journal.append(original, auth);
  } } });
  journal = f.journal;
  f.personTurn(); await f.engine.start();
  await f.engine.passSpec();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((c) => c.payload.base_rev), [0, 1]);
  assert.equal(f.engine.state.spec.brief, 'Concurrent update');
  assert.equal(f.engine.state.spec.items.length, 1);
  assert.equal(new Set(f.records('budget.hold').map((r) => r.document.data.attempt_id)).size, 2);
});

it('canonical question text comes from engine state and its durable transcript segment follows say', async (t) => {
  const f = fixture(t);
  initialQuestions(f); const seq = f.personTurn(); await f.engine.start();
  const delivered = await f.engine.react(seq);
  const row = (await f.engine.transcript()).find((r) => r.record.seq === delivered.reaction_seq);
  assert.equal(row.record.data.text, `Recorded.\n${question.text}`);
  const mark = row.segments.find((segment) => segment.kind === 'question');
  assert.equal(mark.question_id, question.question_id);
  assert.equal(row.record.data.text.slice(mark.start, mark.end), question.text);
  assert.equal(f.engine.state.spec.questions[0].asked_in_reaction_seq, delivered.reaction_seq);
  assert.equal(f.engine.state.spec.questions[0].state, 'asked');
  assert.equal((await f.engine.react(seq)).status, 'already_delivered');
  assert.equal(f.calls.length, 1);
  f.engine.close();
  const resumed = fixture(t, { path: f.path, initialize: false });
  await resumed.engine.resume({ authorizationFor, replay: false });
  const row2 = (await resumed.engine.transcript()).find((r) => r.record.seq === delivered.reaction_seq);
  assert.deepEqual(row2, row);
  assert.equal(resumed.calls.length, 0);
});

it('heuristic flags likely extra questions, regenerates once with separate holds, and permits a flagged second answer', async (t) => {
  const f = fixture(t, { handler: () => ({ say: 'Would you like this?', question_id: null, tools: [] }) });
  const seq = f.personTurn(); await f.engine.start();
  await f.engine.react(seq);
  assert.equal(f.calls.length, 2);
  assert.equal(f.engine.metrics.likely_extra_questions, 2);
  assert.equal(f.engine.metrics.reaction_regenerations, 1);
  assert.equal(f.records('budget.hold').length, 2);
  assert.equal(f.records('reaction')[0].document.data.text, 'Would you like this?');
  assert.equal(likelyExtraQuestion('This is a statement.'), false);
});

for (const output of ['free text', { say: 'One. Two. Three.', question_id: null, tools: [] },
  { say: 'x'.repeat(241), question_id: null, tools: [] }, { say: 'Hi.', question_id: 'invented', tools: [] },
  { say: 'Hi.', question_id: null, tools: [{ name: 'confirm' }] }, { say: 'Hi.', question_id: null, tools: [], question: 'Invented?' },
  { say: 'Hi.', question_id: null }, { say: 7, question_id: null, tools: [] }]) {
  it(`invalid structured output fails closed: ${canonicalJson(output).slice(0, 70)}`, async (t) => {
    const f = fixture(t, { handler: () => output });
    const seq = f.personTurn(); await f.engine.start();
    await assert.rejects(f.engine.react(seq), (e) => e instanceof EngineError && e.reason === 'invalid_output');
    assert.equal(f.records('reaction').length, 0);
    assert.equal(f.records('budget.settle').length, 1, 'complete but malformed response is still paid');
  });
}

it('public structured APIs reject accessors without invocation and normalize raw exceptions', () => {
  let invoked = false;
  const hostile = { get say() { invoked = true; throw new Error('hostile'); }, question_id: null, tools: [] };
  assert.throws(() => validateReaction(hostile, []), EngineError);
  assert.equal(invoked, false);
  assert.throws(() => renderReaction(null, []), EngineError);
  assert.throws(() => applySpecPatch(null, null, null, null), EngineError);
  assert.throws(() => new TextEngine({}), EngineError);
  assert.throws(() => new TextEngine(null), EngineError);
  assert.throws(() => new TextEngine(), EngineError);
});

for (const kind of ['aithema.spec.snapshot', 'reaction']) {
  it(`lost ${kind} acknowledgement blocks scheduling until retained bytes recover without duplicate output`, async (t) => {
    let journal;
    let lose = true;
    const f = fixture(t, { journalOverrides: { append: (original, auth) => {
      const document = JSON.parse(original);
      const result = journal.append(original, auth);
      if (lose && (document.contract === kind || document.kind === kind)) { lose = false; throw new Error('Lost acknowledgement'); }
      return result;
    } } });
    journal = f.journal;
    const seq = f.personTurn(); await f.engine.start();
    await assert.rejects(kind === 'reaction' ? f.engine.react(seq) : f.engine.passSpec(), EngineError);
    const calls = f.calls.length;
    assert.throws(() => f.engine.react(seq), (e) => e.reason === 'ack_uncertain');
    await f.engine.recoverJournal();
    assert.equal(f.calls.length, calls);
    if (kind === 'reaction') {
      assert.equal(f.records('reaction').length, 1);
      assert.equal((await f.engine.react(seq)).status, 'already_delivered');
    } else {
      assert.equal(f.engine.state.spec.items.length, 1);
      assert.equal((await f.engine.passSpec()).status, 'idle');
    }
  });
}

it('lane B cannot confirm from quoted instructions, mutate accepted items, or cite assistant chains', async (t) => {
  const f = fixture(t, { handler: (lane, payload) => ({ base_rev: payload.base_rev, items: [{ op: 'confirm', identity: { item_ref: 'REQ-fixture', version: 1 } }] }) });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), (e) => e.reason === 'invalid_output');
  const accepted = item(); accepted.state = 'accepted'; accepted.host = { op_key: `${sid}:submit:1`, proposal_ref: 'proposal-1' };
  const state = snapshot({ spec: { items: [accepted], questions: [], brief: null, screens: [] } });
  assert.throws(() => applySpecPatch(state, { claims: {} }, { base_rev: 1, items: [{ op: 'revise', identity: { item_ref: accepted.item_ref, version: 1 }, revision: { content: accepted.content, citations: [], provenance: accepted.provenance } }] }, { sid, records: [] }), (e) => e.code === 'already_accepted');
  const assistant = record('reaction', { turn_seq: 0, text: 'Export', delivered_prefix: 'Export', certainty: 'delivered', complete: true }, { seq: 1 });
  const input = item({ leaves: [1] });
  for (const key of ['version', 'content_sha256', 'state', 'supersedes_item_version', 'host']) delete input[key];
  assert.throws(() => applySpecPatch(snapshot({ working_rev: 1 }), { claims: {} }, { base_rev: 1, items: [{ op: 'add', item: input }] }, { sid, records: [assistant] }), (e) => e.code === 'citation_invalid');
});

it('partial heard prefixes are evidence for lane B and never complete assistant context for lane A', async (t) => {
  const f = fixture(t);
  const seq = f.personTurn();
  f.journal.append(bytes(record('reaction', { turn_seq: seq, text: 'A mistaken full claim', delivered_prefix: 'A mistaken', certainty: 'uncertain', complete: false })), f.auth);
  await f.engine.start(); await f.engine.react(seq); await f.engine.passSpec();
  assert.equal(f.calls.find((c) => c.lane === 'reaction').payload.history.some((r) => r.kind === 'reaction' && !r.data.complete), false);
  const partial = f.calls.find((c) => c.lane === 'spec').payload.events.find((r) => r.kind === 'reaction' && !r.data.complete);
  assert.match(partial.context, /person heard \(uncertain\): A mistaken/);
});

it('corrections persist, same-claim supersession is precise, and the next reaction delivers pending corrections', async (t) => {
  const f = fixture(t); const seq = f.personTurn(); await f.engine.start();
  const original = await f.engine.react(seq);
  const correction = (id, claim, text) => ({ correction_id: id, claim_ref: claim, about_reaction_seq: original.reaction_seq, text });
  await f.engine.addCorrection(correction('c1', 'claim-A', 'Correct value: one.'));
  await f.engine.addCorrection(correction('c2', 'claim-B', 'Correct value: two.'));
  await f.engine.addCorrection(correction('c3', 'claim-A', 'Correct value: three.'));
  assert.deepEqual(f.engine.state.corrections.map((c) => c.state), ['superseded', 'pending', 'pending']);
  await assert.rejects(f.engine.addCorrection(correction('c2', 'claim-B', 'Changed.')), (e) => e.code === 'idempotency_conflict');
  await f.engine.react(f.personTurn());
  assert.deepEqual(f.engine.state.corrections.map((c) => c.state), ['superseded', 'delivered', 'delivered']);
  const text = f.records('reaction').map((r) => r.document.data.text);
  assert.ok(text.includes('Correct value: two.') && text.includes('Correct value: three.'));
  assert.ok(!text.includes('Correct value: one.'));
});

it('three seconds of silence delivers a durable short unprompted correction, survives restart, and never pays again', async (t) => {
  const f = fixture(t); const seq = f.personTurn(); await f.engine.start();
  const original = await f.engine.react(seq);
  await f.engine.addCorrection({ correction_id: 'c1', claim_ref: 'claim-A', about_reaction_seq: original.reaction_seq, text: 'Correction: use CSV.' });
  await f.clock.advance(2999);
  assert.equal(f.engine.state.corrections[0].state, 'pending');
  f.engine.close();
  const resumed = fixture(t, { path: f.path, initialize: false, clock: f.clock });
  await resumed.engine.resume({ authorizationFor, replay: false });
  await f.clock.advance(1);
  assert.equal(resumed.engine.state.corrections[0].state, 'delivered');
  const reactions = resumed.records('reaction');
  assert.equal(reactions.length, 2);
  assert.equal(reactions[1].document.data.turn_seq, 0);
  assert.equal(reactions[1].document.data.text, 'Correction: use CSV.');
  assert.equal(resumed.calls.length, 0);
  await f.clock.advance(10_000);
  assert.equal(resumed.records('reaction').length, 2);
});

it('input activity defers the silence timer without dropping corrections', async (t) => {
  const f = fixture(t); await f.engine.start(); const seq = f.personTurn();
  const reaction = await f.engine.react(seq);
  await f.engine.addCorrection({ correction_id: 'c1', claim_ref: 'a', about_reaction_seq: reaction.reaction_seq, text: 'Correction.' });
  await f.clock.advance(2000); f.engine.noteActivity();
  await f.clock.advance(2999); assert.equal(f.engine.state.corrections[0].state, 'pending');
  await f.clock.advance(1); assert.equal(f.engine.state.corrections[0].state, 'delivered');
});

it('a spec patch creates pending corrections durably in the same CAS as its revision', async (t) => {
  let reactionSeq;
  const f = fixture(t, { handler: (lane, payload) => lane === 'reaction' ? defaultOutput(lane, payload) : {
    base_rev: payload.base_rev, items: [], corrections: [{ correction_id: 'c1', claim_ref: 'a', about_reaction_seq: reactionSeq, text: 'Correction.' }],
  } });
  const seq = f.personTurn(); await f.engine.start(); reactionSeq = (await f.engine.react(seq)).reaction_seq;
  await f.engine.passSpec(); assert.equal(f.engine.state.corrections[0].state, 'pending');
  await f.clock.advance(3000); assert.equal(f.engine.state.corrections[0].state, 'delivered');
});

it('each reasoning pass admits and commits a fresh single-use claim before provider execution', async (t) => {
  let f;
  f = fixture(t, { handler: (lane, payload) => {
    const holds = f.ledger.listOpen({}, f.auth).body.holds;
    assert.equal(holds.length, 1);
    assert.equal(holds[0].claimed, true, 'mutation: removing gate dispatch must fail here');
    assert.equal(f.records('budget.claim').length, f.calls.length);
    return defaultOutput(lane, payload);
  } });
  const seq = f.personTurn(); await f.engine.start(); await f.engine.react(seq); await f.engine.passSpec();
  assert.equal(f.records('budget.hold').length, 2);
  assert.equal(f.records('budget.claim').length, 2);
  assert.equal(f.records('budget.settle').length, 2);
  const writers = loadContractFile('record-writers.json').writers;
  for (const row of f.records()) {
    assert.equal(validate(row.document.contract, row.document).ok, true);
    if (row.document.kind) assert.ok(writers[row.document.kind].includes(row.document.writer.kind));
  }
});

it('budget denial stops every new paid pass and leaves person text acknowledged', async (t) => {
  const f = fixture(t, { cap: 0 });
  const seq = f.personTurn(); await f.engine.start();
  assert.deepEqual(await f.engine.react(seq), { status: 'denied', reason: 'budget_denied' });
  assert.deepEqual(await f.engine.passSpec(), { status: 'denied', reason: 'budget_denied' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.records('turn').length, 1);
  assert.equal(f.engine.state.consumed_seq, 0);
});

it('unknown provider/cost outcomes charge the maximum; no same-claim resend', async (t) => {
  const f = fixture(t, { priceUsage: () => { throw new Error('Unknown final usage'); } });
  const seq = f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.react(seq), EngineError);
  assert.equal(f.records('budget.settle')[0].document.data.outcome, 'unknown');
  assert.equal(f.records('budget.settle')[0].document.data.charged_micro, 100);
  assert.equal(f.records('reaction').length, 0);
});

it('withdrawal locally stops an in-flight waiter, refuses new claims and discards charged late output', async (t) => {
  const wait = deferred(); const f = fixture(t, { handler: async (lane, payload) => { await wait.promise; return defaultOutput(lane, payload); } });
  const seq = f.personTurn(); await f.engine.start();
  const operation = f.engine.react(seq); await flush();
  assert.equal(f.calls.length, 1);
  f.authz.revoke(2);
  await assert.rejects(operation, EngineError);
  assert.throws(() => f.engine.passSpec(), (e) => e.code === 'revoked');
  assert.equal(f.calls[0].signal.aborted, false, 'committed claims may finish at the provider');
  wait.resolve(); await f.engine.drain();
  assert.equal(f.records('reaction').length, 0);
  assert.equal(f.records('budget.settle')[0].document.data.outcome, 'unknown');
  assert.equal(f.records('budget.settle')[0].document.data.charged_micro, 100);
});

it('revocation during a committed claim response still sends once and discards the result', async (t) => {
  let f;
  f = fixture(t, { ledgerOverrides: { claim: (original, auth) => {
    const receipt = f.ledger.claim(original, auth); f.authz.revoke(2); return receipt;
  } } });
  const seq = f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.react(seq), EngineError); await f.engine.drain();
  assert.equal(f.calls.length, 1);
  assert.equal(f.records('reaction').length, 0);
  assert.equal(f.records('budget.settle')[0].document.data.outcome, 'unknown');
});

it('journal refusals with foundation codes are never mistaken for CAS loss', async (t) => {
  const f = fixture(t, { journalOverrides: { append: (original, auth) => {
    if (JSON.parse(original).contract === 'aithema.spec.snapshot') throw Object.assign(new Error('Fenced'), { status: 409, code: 'fenced_generation' });
    return f.journal.append(original, auth);
  } } });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), (e) => e.code === 'fenced_generation');
  assert.equal(f.calls.length, 1); assert.equal(f.engine.metrics.cas_retries, 0);
});

it('settings evidence expiry denies inference before admission without fallback', async (t) => {
  const f = fixture(t);
  const settings = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/settings.executable.json', import.meta.url))).doc;
  // Reuse the real dependencies; this deliberately expired fixture is resolved
  // at each pass, never cached as an enabled provider selection.
  const engine = new TextEngine({ journal: f.client, journalPort: f.port, budget: f.budget, authorization: f.authz,
    reasoning: { streamChat() { throw new Error('Provider must not run'); }, understand() {} },
    maxMicro: { reaction: 100, spec: 100, design: 100 }, priceUsage: () => 1, settings,
    clock: { ...f.clock, now: f.clock.now, wallNow: () => Date.parse('2030-01-01T00:00:00Z'), setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout } });
  t.after(() => engine.close());
  const seq = f.personTurn(); await engine.start();
  const result = await engine.react(seq);
  assert.equal(result.status, 'denied'); assert.equal(result.reason, 'evidence_expired');
  assert.equal(f.records('budget.hold').length, 0);
});

it('working_spec_only produces valid draft snapshots without host proposals or submission ops', async (t) => {
  const f = fixture(t, { hostMode: 'working_spec_only' });
  f.personTurn(); await f.engine.start(); await f.engine.passSpec();
  const state = f.engine.state;
  assert.equal(validate(state.contract, state).ok, true);
  assert.equal(state.spec.items[0].state, 'draft');
  assert.equal(state.spec.items[0].host, null);
  assert.deepEqual(state.pending_ops, []);
});

it('engine resume consumes byte-exact pending intake results and removes only acknowledged operations', async (t) => {
  const f = fixture(t);
  const pending = pendingOp();
  f.journal.append(bytes(snapshot({ pending_ops: [pending] })), f.auth);
  const retried = [];
  await f.engine.resume({ authorizationFor, retryOp: (op) => {
    retried.push(op);
    return { source_id: '44444444-4444-4444-8444-444444444444' };
  } });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].op_key, pending.op_key);
  assert.deepEqual(retried[0].payload_bytes, Buffer.from(pending.payload));
  assert.deepEqual(f.engine.state.pending_ops, []);
  assert.equal(f.records('op.result').length, 1);
});

it('host takeover after a committed claim response still sends once, charges maximum and publishes no late reaction', async (t) => {
  let f;
  f = fixture(t, { ledgerOverrides: { claim: (original, auth) => {
    const committed = f.ledger.claim(original, auth); f.journal.takeover(auth); return committed;
  } } });
  const seq = f.personTurn(); await f.engine.start();
  assert.deepEqual(await f.engine.react(seq), { status: 'discarded' });
  assert.equal(f.calls.length, 1); assert.equal(f.records('reaction').length, 0);
  const oldHold = f.records('budget.hold')[0].document.data.hold_id;
  f.budget.setAuthority({ ...f.auth, gen: 2 });
  assert.equal((await f.budget.recover({ hold_id: oldHold, worker_generation: 2, auth_epoch: 1 })).charged_micro, 100);
  assert.ok(f.budget.auditErrors.length > 0, 'late generation journal writes are fenced');
});

it('revocation before claim commitment sends nothing and surfaces the host refusal', async (t) => {
  let f;
  f = fixture(t, { ledgerOverrides: { claim: (original, auth) => {
    f.journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })), { ...auth, writer_kind: 'host' });
    return f.ledger.claim(original, auth);
  } } });
  const seq = f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.react(seq), (e) => e.code === 'revoked');
  assert.equal(f.calls.length, 0);
});

it('host reads have a ten-second deadline even when an adapter never responds', async (t) => {
  const f = fixture(t, { journalOverrides: { cursor: () => new Promise(() => {}) } });
  const start = f.engine.start();
  const failed = assert.rejects(start, (e) => e instanceof EngineError && e.status === 504);
  await f.clock.advance(10_000);
  await failed;
  assert.equal(f.calls.length, 0);
});

it('malformed engine receipts cannot suppress a person turn even in a contract-valid snapshot', async (t) => {
  const f = fixture(t); const seq = f.personTurn();
  const metadata = { version: 1, claims: {}, outbox: null, last_activity_at: f.clock.wallNow(), receipts: [{
    client_event_id: '44444444-4444-4444-8444-444444444444', turn_seq: seq, reaction_seq: 999,
    segments: [], tools: [], working_rev: 1,
  }] };
  const canonical = canonicalJson({ operation: {}, engine_state: metadata });
  const doc = snapshot({ patch: { canonical, sha256: sha256Hex(canonical) } });
  assert.equal(validate(doc.contract, doc).ok, true);
  f.journal.append(bytes(doc), f.auth);
  await assert.rejects(f.engine.start(), (e) => e.reason === 'invalid_resume');
  assert.equal(f.calls.length, 0);
});

it('missing acknowledged replay records fail before any paid pass', async (t) => {
  let f;
  f = fixture(t, { journalOverrides: { recordsAfter: (after, auth, through) => f.journal.recordsAfter(after, auth, through).filter((r) => r.document.seq !== 1) } });
  f.personTurn(); f.personTurn();
  await assert.rejects(f.engine.start(), (e) => e.reason === 'invalid_journal');
  assert.equal(f.calls.length, 0);
});

it('immutable replay cache fetches only the tail while retaining real earlier turn ordinals', async (t) => {
  let f;
  const afters = [];
  f = fixture(t, { journalOverrides: { recordsAfter: (after, auth, through) => { afters.push(after); return f.journal.recordsAfter(after, auth, through); } } });
  f.personTurn(); await f.engine.start(); await f.engine.passSpec(); await f.engine.passSpec();
  assert.equal(afters.filter((after) => after === 0).length, 1);
  assert.ok(afters.some((after) => after > 0));
  assert.equal(f.engine.state.spec.items[0].citations[0].locator, 'turn:0');
});
