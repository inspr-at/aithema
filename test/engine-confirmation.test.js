import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalJson, validate } from '../contracts/validate.js';
import { fixture, authorizationFor, bytes, record, snapshot, item, flush } from './engine-helpers.test.js';

const binding = (row = item(), overrides = {}) => ({ item_ref: row.item_ref, version: row.version,
  content_sha256: row.content_sha256, principal_ref: 'fixture-person', ...overrides });
const noEdit = (lane, payload) => ({ base_rev: payload.base_rev, items: [] });
const seed = (f) => f.journal.append(bytes(snapshot({ spec: { items: [item()], questions: [], brief: null, screens: [] } })), f.auth);
const journalConfirm = (f, data = binding()) => f.journal.append(bytes(record('ui.confirm', data)), f.auth).document.seq;

for (const hostMode of ['review', 'working_spec_only']) {
  it(`lane B applies a matching trusted confirmation after model edits (${hostMode})`, async (t) => {
    const f = fixture(t, { hostMode, handler: noEdit });
    f.journal.append(bytes(snapshot({ host_mode: hostMode, spec: { items: [item()], questions: [], brief: null, screens: [] } })), f.auth);
    await f.engine.start();
    const seq = journalConfirm(f);
    assert.equal((await f.engine.passSpec()).status, 'committed');
    assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
    assert.equal(f.engine.state.consumed_seq, seq);
    assert.ok(f.calls[0].payload.events.some((r) => r.kind === 'ui.confirm'));
    assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
  });
}

for (const overrides of [{ content_sha256: '0'.repeat(64) }, { version: 2 }, { item_ref: 'unknown' }]) {
  it(`lane B refuses mismatched confirmation without advancing its watermark: ${JSON.stringify(overrides)}`, async (t) => {
    const f = fixture(t, { handler: noEdit }); seed(f); await f.engine.start();
    const before = f.engine.state;
    journalConfirm(f, binding(item(), overrides));
    await assert.rejects(f.engine.passSpec(), (error) => error.reason === 'invalid_confirmation');
    assert.equal(f.engine.state.working_rev, before.working_rev);
    assert.equal(f.engine.state.consumed_seq, before.consumed_seq);
    assert.equal(f.engine.state.spec.items[0].state, 'draft');
    await assert.rejects(f.engine.passSpec(), (error) => error.reason === 'invalid_confirmation');
  });
}

it('revising the confirmed version in the same lane-B batch fails atomically', async (t) => {
  const original = item();
  const f = fixture(t, { handler: (lane, payload) => ({ base_rev: payload.base_rev, items: [{ op: 'revise',
    identity: { item_ref: original.item_ref, version: 1 }, revision: { content: { ...original.content, statement: 'Changed complete item.' },
      citations: [], provenance: original.provenance } }] }) });
  seed(f); await f.engine.start(); journalConfirm(f);
  await assert.rejects(f.engine.passSpec(), (error) => error.reason === 'invalid_confirmation');
  assert.equal(f.engine.state.consumed_seq, 0);
  assert.equal(f.engine.state.working_rev, 1);
  assert.deepEqual(f.engine.state.spec.items, [original]);
});

for (const entry of ['start', 'resume', 'passSpec']) {
  it(`${entry} recovers a historical confirmation below consumed_seq without losing the exact binding`, async (t) => {
    const f = fixture(t, { handler: noEdit }); seed(f);
    if (entry === 'passSpec') await f.engine.start();
    const seq = journalConfirm(f);
    f.journal.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: seq,
      spec: { items: [item()], questions: [], brief: null, screens: [] } })), f.auth);
    if (entry === 'resume') await f.engine.resume({ authorizationFor, replay: false });
    else await f.engine[entry]();
    assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
    assert.equal(f.engine.state.consumed_seq, seq);
    assert.equal(f.engine.state.working_rev, 3);
    if (entry !== 'passSpec') assert.equal(f.calls.length, 0, 'trusted recovery needs no inference');
  });
}

it('historical confirmations do not authorize a newer version', async (t) => {
  const f = fixture(t); seed(f); const seq = journalConfirm(f);
  const old = { ...item(), state: 'superseded' };
  const newer = { ...item(), version: 2, supersedes_item_version: { item_ref: old.item_ref, version: 1 } };
  f.journal.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: seq,
    spec: { items: [old, newer], questions: [], brief: null, screens: [] } })), f.auth);
  await f.engine.start();
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
  assert.equal(f.engine.state.working_rev, 2);
});

it('public confirmation journals before its effect and normalizes invalid input', async (t) => {
  let f;
  f = fixture(t, { checkpoint: (point) => {
    if (point === 'confirmation.before_append') {
      assert.equal(f.records('ui.confirm').length, 0);
      assert.equal(f.engine.state.spec.items[0].state, 'draft');
    }
    if (point === 'confirmation.after_ack') {
      assert.equal(f.records('ui.confirm').length, 1);
      assert.equal(f.engine.state.spec.items[0].state, 'draft');
    }
  } });
  seed(f); await f.engine.start();
  await assert.rejects(f.engine.confirmItem(binding(item(), { content_sha256: '0'.repeat(64) })), (error) => error.reason === 'invalid_confirmation');
  assert.equal(f.records('ui.confirm').length, 0);
  const state = await f.engine.confirmItem(binding());
  assert.equal(state.spec.items[0].state, 'confirmed');
  assert.equal(f.calls.length, 0);
  const row = f.records('ui.confirm')[0].document;
  assert.equal(validate(row.contract, row).ok, true);
  assert.equal(row.writer.kind, 'worker');
  let invoked = false;
  assert.throws(() => f.engine.confirmItem({ get item_ref() { invoked = true; return 'REQ-fixture'; } }), (error) => error.name === 'EngineError');
  assert.equal(invoked, false);
});

it('lost confirmation acknowledgement recovers retained bytes and applies exactly once', async (t) => {
  let f, lose = true;
  f = fixture(t, { journalOverrides: { append: (original, auth) => {
    const result = f.journal.append(original, auth);
    if (JSON.parse(original).kind === 'ui.confirm' && lose) { lose = false; throw new Error('Lost confirmation ack'); }
    return result;
  } } });
  seed(f); await f.engine.start();
  await assert.rejects(f.engine.confirmItem(binding()));
  assert.equal(f.engine.state.spec.items[0].state, 'draft');
  assert.throws(() => f.engine.passSpec(), (error) => error.reason === 'ack_uncertain');
  await f.engine.recoverJournal();
  assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
  assert.equal(f.records('ui.confirm').length, 1);
  assert.equal(f.engine.state.working_rev, 2);
  await f.engine.recoverJournal();
  assert.equal(f.engine.state.working_rev, 2);
  assert.equal(f.calls.length, 0);
});

it('confirmation CAS loss re-reads current state without duplicating the write-ahead action', async (t) => {
  let f, conflict = true;
  f = fixture(t, { journalOverrides: { append: (original, auth) => {
    const document = JSON.parse(original);
    if (document.contract === 'aithema.spec.snapshot' && JSON.parse(document.patch.canonical).operation?.lane === 'confirmation' && conflict) {
      conflict = false;
      f.journal.append(bytes({ ...document, client_event_id: randomUUID(), spec: { ...document.spec, items: [item()], brief: 'Concurrent update' } }), auth);
    }
    return f.journal.append(original, auth);
  } } });
  seed(f); await f.engine.start(); await f.engine.confirmItem(binding());
  assert.equal(f.engine.metrics.cas_retries, 1);
  assert.equal(f.engine.state.spec.brief, 'Concurrent update');
  assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
  assert.equal(f.engine.state.working_rev, 3);
  assert.equal(f.records('ui.confirm').length, 1);
});

it('a confirmation arriving during model computation forces a fresh CAS pass before any revision is consumed', async (t) => {
  const waiting = Promise.withResolvers();
  const f = fixture(t, { handler: async (lane, payload) => { await waiting.promise; return noEdit(lane, payload); } });
  seed(f); await f.engine.start(); f.personTurn();
  const pass = f.engine.passSpec(); await flush();
  await f.engine.confirmItem(binding());
  waiting.resolve(); await pass;
  assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
  assert.equal(f.engine.metrics.cas_retries, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(canonicalJson(f.engine.state.spec.items[0].content), canonicalJson(item().content));
});
