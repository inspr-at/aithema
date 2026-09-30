import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, canonicalJson } from '../contracts/validate.js';
import { fixture, authorizationFor, defaultOutput } from './engine-helpers.test.js';

// A real process exit, not a thrown error (a throw would run gate settlement
// finally/catch paths). SQLite FULL/WAL is reopened by a new worker process.
const worker = `
import { fixture, bytes, snapshot, record, defaultOutput } from ${JSON.stringify(new URL('./engine-helpers.test.js', import.meta.url).href)};
const [path, mode, boundary, occurrenceText] = process.argv.slice(1);
let enabled = false, seen = 0, f;
const occurrence = Number(occurrenceText);
const stop = (name) => { if (enabled && name === boundary && ++seen === occurrence) process.exit(42); };
f = fixture(null, { path, checkpoint: stop, handler: (lane, payload) => mode === 'design' && lane === 'reaction'
  ? {say:'Design requested.',question_id:null,tools:[{name:'design_intent'}]} : defaultOutput(lane, payload), ledgerOverrides: {
  admit: (original, auth) => { const result = f.ledger.admit(original, auth); stop('budget.admit_before_journal'); return result; },
  settle: (original, auth) => { const result = f.ledger.settle(original, auth); stop('budget.settle_response_lost'); return result; },
} });
if (mode === 'reaction') f.journal.append(bytes(snapshot({ spec: { items: [], questions: [{question_id:'q',text:'Canonical stored question?',state:'open'}], brief:null, screens:[] } })), f.auth);
const turnSeq = f.personTurn();
await f.engine.start();
if (mode === 'confirmation' || mode === 'confirmation-spec') {
  await f.engine.passSpec();
  const item = f.engine.state.spec.items[0];
  enabled = true;
  const confirmation = {item_ref:item.item_ref,version:item.version,content_sha256:item.content_sha256,principal_ref:'fixture-person'};
  if (mode === 'confirmation') await f.engine.confirmItem(confirmation);
  else {
    f.journal.append(bytes(record('ui.confirm', confirmation)), f.auth);
    f.personTurn();
    await f.engine.passSpec();
  }
} else if (mode === 'design') {
  await f.engine.react(turnSeq);
  enabled = true;
  await f.clock.advance(30_000);
} else if (mode === 'correction') {
  const delivered = await f.engine.react(turnSeq);
  await f.engine.addCorrection({correction_id:'c',claim_ref:'claim',about_reaction_seq:delivered.reaction_seq,text:'Durable correction.'});
  enabled = true; stop('correction.pending');
  await f.engine.deliverCorrections();
} else {
  enabled = true; stop('turn.after_ack');
  if (mode === 'reaction') await f.engine.react(turnSeq); else await f.engine.passSpec();
}
throw new Error('Crash boundary was not reached: ' + boundary);
`;

function crash(mode, boundary, occurrence = 1) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-engine-crash-')), 'host.sqlite');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, path, mode, boundary, String(occurrence)], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 42, child.stderr);
  return path;
}

for (const boundary of ['confirmation.before_append', 'confirmation.after_ack', 'snapshot.before_append', 'snapshot.after_ack']) {
  it(`process crash at confirmation boundary ${boundary}: acknowledged UI action recovers exactly once`, async (t) => {
    const path = crash('confirmation', boundary);
    let editing = false;
    const f = fixture(t, { path, initialize: false, handler: (lane, payload) => {
      if (lane === 'reaction' || !editing) return defaultOutput(lane, payload);
      const item = payload.spec.items.at(-1);
      return { base_rev: payload.base_rev, items: [{ op: 'revise', identity: { item_ref: item.item_ref, version: item.version },
        revision: { content: { ...item.content, statement: 'Revision after confirmation crash.' }, citations: item.citations, provenance: item.provenance } }] };
    } });
    await f.engine.resume({ authorizationFor, replay: false });
    const acknowledged = boundary !== 'confirmation.before_append';
    assert.equal(f.engine.state.spec.items[0].state, acknowledged ? 'confirmed' : 'draft');
    assert.equal(f.records('ui.confirm').length, acknowledged ? 1 : 0);
    assert.equal(f.calls.length, 0);
    assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
    await f.engine.replay();
    assert.equal(f.engine.state.spec.items[0].state, acknowledged ? 'confirmed' : 'draft');
    const results = JSON.parse(f.engine.state.patch.canonical).engine_state.confirmation_results;
    assert.equal(results.length, acknowledged ? 1 : 0);
    if (acknowledged) assert.deepEqual(results[0], { record_seq: f.records('ui.confirm')[0].document.seq, reason: 'confirmed' });
    editing = true; const seq = f.personTurn(); await f.engine.passSpec();
    assert.equal(f.engine.state.consumed_seq, seq);
    assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
    assert.deepEqual(JSON.parse(f.engine.state.patch.canonical).engine_state.confirmation_results, results);
    assert.equal((await f.engine.passSpec()).status, 'idle');
  });
}

for (const boundary of ['spec.after_compute', 'snapshot.before_append', 'snapshot.after_ack']) {
  it(`process crash at confirmation consumption boundary ${boundary}: receipt, effect and watermark recover together`, async (t) => {
    const path = crash('confirmation-spec', boundary);
    const f = fixture(t, { path, initialize: false });
    await f.engine.resume({ authorizationFor });
    const confirmSeq = f.records('ui.confirm')[0].document.seq;
    assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
    const results = JSON.parse(f.engine.state.patch.canonical).engine_state.confirmation_results;
    assert.deepEqual(results, [{ record_seq: confirmSeq, reason: 'confirmed' }]);
    assert.ok(f.engine.state.consumed_seq >= f.records('turn').at(-1).document.seq);
    const rev = f.engine.state.working_rev;
    assert.equal((await f.engine.passSpec()).status, 'idle');
    assert.equal(f.engine.state.working_rev, rev);
    assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
  });
}

for (const boundary of ['design.before_finalize', 'design.after_finalize', 'snapshot.before_append', 'snapshot.after_ack']) {
  it(`process crash at design completion boundary ${boundary}: only unacknowledged completion is re-admitted`, async (t) => {
    const path = crash('design', boundary);
    const f = fixture(t, { path, initialize: false });
    const holds = f.records('budget.hold').length;
    await f.engine.resume({ authorizationFor, replay: false });
    const committed = boundary === 'design.after_finalize' || boundary === 'snapshot.after_ack';
    await f.clock.advance(30_000);
    assert.equal(f.records('budget.hold').length, holds + (committed ? 0 : 1));
    const results = JSON.parse(f.engine.state.patch.canonical).engine_state.design_results;
    assert.equal(results.length, 1);
    assert.equal(results[0].state, 'rendered');
    assert.equal(f.records('reaction').length, 1);
    await f.clock.advance(300_000);
    assert.equal(f.records('budget.hold').length, holds + (committed ? 0 : 1));
  });
}

for (const boundary of ['turn.after_ack', 'spec.after_compute', 'snapshot.before_append', 'snapshot.after_ack']) {
  it(`process crash at lane-B boundary ${boundary}: resume replays and commits exactly one item`, async (t) => {
    const path = crash('spec', boundary);
    const f = fixture(t, { path, initialize: false });
    await f.engine.resume({ authorizationFor });
    const state = f.engine.state;
    assert.equal(state.spec.items.length, 1);
    assert.equal(state.spec.items[0].version, 1);
    assert.equal(state.spec.items[0].content.statement, 'Export fixture entries.');
    assert.equal(f.records('turn').length, 1);
    assert.equal(f.records('reaction').filter((r) => r.document.data.turn_seq > 0).length, 1);
    assert.equal(validate(state.contract, state).ok, true);
    const before = canonicalJson(state.spec);
    await f.engine.replay();
    assert.equal(canonicalJson(f.engine.state.spec), before, 'repeated resume replay is stable');
    assert.equal(f.engine.state.worker_generation, 2);
  });
}

for (const [boundary, occurrence] of [['snapshot.before_append', 1], ['snapshot.after_ack', 1],
  ['reaction.after_prepare', 1], ['reaction.before_append', 1], ['reaction.after_ack', 1],
  ['reaction.before_finalize', 1], ['snapshot.before_append', 2], ['snapshot.after_ack', 2]]) {
  it(`process crash at lane-A boundary ${boundary} #${occurrence}: one durable canonical reaction and marker`, async (t) => {
    const path = crash('reaction', boundary, occurrence);
    const f = fixture(t, { path, initialize: false });
    await f.engine.resume({ authorizationFor });
    const reactions = f.records('reaction');
    assert.equal(reactions.length, 1);
    const row = (await f.engine.transcript()).find((r) => r.record.seq === reactions[0].document.seq);
    assert.equal(row.record.data.text, 'Recorded.\nCanonical stored question?');
    const question = row.segments.find((s) => s.kind === 'question');
    assert.equal(row.record.data.text.slice(question.start, question.end), 'Canonical stored question?');
    assert.equal(f.engine.state.spec.questions[0].asked_in_reaction_seq, row.record.seq);
    assert.equal(f.engine.state.spec.items.length, 1);
    assert.equal(validate(row.record.contract, row.record).ok, true);
    await f.engine.replay(); assert.equal(f.records('reaction').length, 1);
  });
}

for (const boundary of ['correction.pending', 'reaction.after_prepare', 'reaction.before_append', 'reaction.after_ack', 'reaction.before_finalize']) {
  it(`process crash at correction boundary ${boundary}: pending delivery survives and never duplicates`, async (t) => {
    const path = crash('correction', boundary);
    const f = fixture(t, { path, initialize: false });
    await f.engine.resume({ authorizationFor });
    await f.clock.advance(3000);
    assert.equal(f.engine.state.corrections[0].state, 'delivered');
    assert.equal(f.records('reaction').filter((r) => r.document.data.text === 'Durable correction.').length, 1);
    const transcript = await f.engine.transcript();
    assert.equal(transcript.filter((r) => r.segments.some((s) => s.kind === 'correction' && s.correction_id === 'c')).length, 1);
    await f.clock.advance(10_000);
    assert.equal(f.records('reaction').filter((r) => r.document.data.text === 'Durable correction.').length, 1);
  });
}

for (const [boundary, outcome, charge] of [['budget.admit_before_journal', 'void', 0], ['budget.after_admit', 'void', 0],
  ['budget.after_claim', 'unknown', 100], ['budget.after_provider', 'unknown', 100], ['budget.settle_response_lost', 'settled', 7]]) {
  it(`process crash at ${boundary}: authoritative recovery gives ${outcome} and never resends the old claim`, async (t) => {
    const path = crash('spec', boundary);
    const f = fixture(t, { path, initialize: false });
    // This is the ledger, not the journal: the first case has no hold event.
    const old = f.ledger.listOpen({}, f.auth).body.holds[0];
    const oldHoldId = old?.hold_id ?? f.records('budget.hold')[0].document.data.hold_id;
    await f.engine.resume({ authorizationFor });
    const settle = () => f.budget.recover({ hold_id: oldHoldId, worker_generation: f.client.authority.gen, auth_epoch: 1 });
    assert.deepEqual(await settle(), { hold_id: oldHoldId, closed_reason: outcome, charged_micro: charge });
    assert.deepEqual(await settle(), await settle());
    assert.equal(f.ledger.listOpen({}, f.client.authority).body.holds.length, 0);
    assert.equal(f.engine.state.spec.items.length, 1);
    const current = f.records('budget.hold').filter((r) => r.document.writer.generation === 2);
    assert.ok(current.length >= 1);
    assert.ok(current.every((r) => r.document.data.hold_id !== oldHoldId));
    await assert.rejects(f.budget.claim({ hold_id: oldHoldId, request_sha256: '0'.repeat(64), worker_generation: 2, auth_epoch: 1 }), (e) => e.code === 'hold_closed');
  });
}
