import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import { applyConfirmations } from '../runtime/engine/patch.js';
import { validateEngineMetadata } from '../runtime/engine/metadata.js';
import { fixture, authorizationFor, bytes, record, snapshot, item, flush } from './engine-helpers.test.js';

const binding = (row = item(), overrides = {}) => ({ item_ref: row.item_ref, version: row.version,
  content_sha256: row.content_sha256, principal_ref: 'fixture-person', ...overrides });
const noEdit = (lane, payload) => ({ base_rev: payload.base_rev, items: [] });
const seed = (f) => f.journal.append(bytes(snapshot({ spec: { items: [item()], questions: [], brief: null, screens: [] } })), f.auth);
const journalConfirm = (f, data = binding()) => f.journal.append(bytes(record('ui.confirm', data)), f.auth).document.seq;
const metadata = (f) => JSON.parse(f.engine.state.patch.canonical).engine_state;
const results = (f) => metadata(f).confirmation_results;
const revise = (payload) => {
  const original = payload.spec.items.at(-1);
  return { base_rev: payload.base_rev, items: [{ op: 'revise', identity: { item_ref: original.item_ref, version: original.version },
    revision: { content: { ...original.content, statement: `Changed complete item version ${original.version + 1}.` },
      citations: original.citations, provenance: original.provenance } }] };
};

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

it('revising a version in the same lane-B batch consumes its stale confirmation atomically as a bound no-op', async (t) => {
  const original = item();
  const f = fixture(t, { handler: (lane, payload) => ({ base_rev: payload.base_rev, items: [{ op: 'revise',
    identity: { item_ref: original.item_ref, version: 1 }, revision: { content: { ...original.content, statement: 'Changed complete item.' },
      citations: [], provenance: original.provenance } }] }) });
  seed(f); await f.engine.start(); const seq = journalConfirm(f);
  assert.equal((await f.engine.passSpec()).status, 'committed');
  assert.equal(f.engine.state.consumed_seq, seq);
  assert.equal(f.engine.state.working_rev, 2);
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
  assert.deepEqual(results(f), [{ record_seq: seq, reason: 'superseded' }]);
  assert.equal((await f.engine.passSpec()).status, 'idle');
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
  assert.equal(f.engine.state.working_rev, 3);
  assert.deepEqual(results(f), [{ record_seq: seq, reason: 'superseded' }]);
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
      const patch = JSON.parse(document.patch.canonical);
      patch.engine_state.confirmation_results = [];
      const canonical = canonicalJson(patch);
      f.journal.append(bytes({ ...document, client_event_id: randomUUID(),
        spec: { ...document.spec, items: [item()], brief: 'Concurrent update' }, patch: { canonical, sha256: sha256Hex(canonical) } }), auth);
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

for (const entry of ['start', 'resume', 'recoverJournal']) {
  it(`confirmation receipts survive ${entry}: public confirm then turn then revision never reapplies or skips the turn`, async (t) => {
    const f = fixture(t, { handler: (lane, payload) => revise(payload) }); seed(f); await f.engine.start();
    const earlierTurn = f.personTurn();
    await f.engine.confirmItem(binding());
    const confirmSeq = f.records('ui.confirm')[0].document.seq;
    const expected = [{ record_seq: confirmSeq, reason: 'confirmed' }];
    assert.deepEqual(results(f), expected);
    assert.equal(f.engine.state.consumed_seq, 0, 'early UI effect must not skip earlier unconsumed events');
    let active = f;
    if (entry === 'recoverJournal') await f.engine.recoverJournal();
    else {
      f.engine.close();
      active = fixture(t, { path: f.path, initialize: false, handler: (lane, payload) => revise(payload) });
      if (entry === 'start') await active.engine.start();
      else await active.engine.resume({ authorizationFor, replay: false });
    }
    const turnSeq = active.personTurn();
    assert.equal((await active.engine.passSpec()).status, 'committed');
    assert.ok(active.calls[0].payload.events.some((r) => r.seq === turnSeq), 'turn is consumed by lane B');
    assert.ok(active.calls[0].payload.events.some((r) => r.seq === earlierTurn), 'early confirmation cannot advance past unprocessed turns');
    assert.equal(active.engine.state.consumed_seq, turnSeq);
    assert.deepEqual(active.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
    assert.deepEqual(results(active), expected, 'same confirm retains its original immutable receipt');
    assert.equal(active.records('ui.confirm').length, 1);
    assert.equal((await active.engine.passSpec()).status, 'idle');
  });
}

it('confirm then revise consumes each event once and never authorizes the replacement', async (t) => {
  let editing = false;
  const f = fixture(t, { handler: (lane, payload) => editing ? revise(payload) : noEdit(lane, payload) });
  seed(f); await f.engine.start(); const confirmSeq = journalConfirm(f);
  await f.engine.passSpec();
  assert.equal(f.engine.state.consumed_seq, confirmSeq);
  assert.equal(f.engine.state.spec.items[0].state, 'confirmed');
  editing = true; const turnSeq = f.personTurn(); await f.engine.passSpec();
  assert.equal(f.engine.state.consumed_seq, turnSeq);
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
  assert.deepEqual(results(f), [{ record_seq: confirmSeq, reason: 'confirmed' }]);
  assert.equal(f.calls[1].payload.events.some((r) => r.kind === 'ui.confirm'), false);
});

it('revise then confirm consumes the stale version as a no-op and applies only the current version', async (t) => {
  let editing = true;
  const f = fixture(t, { handler: (lane, payload) => editing ? revise(payload) : noEdit(lane, payload) });
  seed(f); await f.engine.start(); f.personTurn(); await f.engine.passSpec(); editing = false;
  const stale = journalConfirm(f), current = journalConfirm(f, binding(f.engine.state.spec.items.at(-1)));
  await f.engine.passSpec();
  assert.equal(f.engine.state.consumed_seq, current);
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'confirmed']);
  assert.deepEqual(results(f), [{ record_seq: stale, reason: 'superseded' }, { record_seq: current, reason: 'confirmed' }]);
  const duplicate = journalConfirm(f, binding(f.engine.state.spec.items.at(-1)));
  await f.engine.passSpec();
  assert.equal(f.engine.state.consumed_seq, duplicate);
  assert.deepEqual(results(f).at(-1), { record_seq: duplicate, reason: 'already_confirmed' });
  assert.equal((await f.engine.passSpec()).status, 'idle');
});

for (const state of ['confirmed', 'superseded']) {
  it(`content_sha256 binding is still enforced for a ${state} no-op confirmation`, async (t) => {
    const f = fixture(t, { handler: noEdit });
    const old = { ...item(), state };
    const items = state === 'confirmed' ? [old] : [old, { ...item(), version: 2,
      supersedes_item_version: { item_ref: old.item_ref, version: 1 } }];
    f.journal.append(bytes(snapshot({ spec: { items, questions: [], brief: null, screens: [] } })), f.auth);
    await f.engine.start(); const before = f.engine.state;
    journalConfirm(f, binding(old, { content_sha256: '0'.repeat(64) }));
    await assert.rejects(f.engine.passSpec(), (e) => e.reason === 'invalid_confirmation');
    assert.deepEqual(f.engine.state, before);
    await assert.rejects(f.engine.confirmItem(binding(old, { content_sha256: '0'.repeat(64) })), (e) => e.reason === 'invalid_confirmation');
    assert.equal(f.records('ui.confirm').length, 1, 'invalid public action is never appended');
  });
}

it('an already-confirmed action journals a no-op receipt through the public path', async (t) => {
  const f = fixture(t, { handler: noEdit }); seed(f); await f.engine.start();
  await f.engine.confirmItem(binding()); await f.engine.confirmItem(binding());
  const records = f.records('ui.confirm').map((r) => r.document.seq);
  assert.deepEqual(results(f), [{ record_seq: records[0], reason: 'confirmed' }, { record_seq: records[1], reason: 'already_confirmed' }]);
  await f.engine.passSpec();
  assert.equal(f.engine.state.consumed_seq, records.at(-1));
  assert.equal(results(f).length, 2);
});

it('confirmation CAS retry consumes a concurrent revision as a no-op without losing a later current-version confirmation', async (t) => {
  let f, conflict = true;
  f = fixture(t, { handler: noEdit, journalOverrides: { append: (original, auth) => {
    const document = JSON.parse(original);
    if (document.contract === 'aithema.spec.snapshot' && JSON.parse(document.patch.canonical).operation?.lane === 'confirmation' && conflict) {
      conflict = false;
      const old = { ...item(), state: 'superseded' }, content = { ...item().content, statement: 'Concurrent version.' };
      const newer = { ...item(), version: 2, content, content_sha256: sha256Hex(canonicalJson(content)),
        supersedes_item_version: { item_ref: old.item_ref, version: 1 } };
      const patch = JSON.parse(document.patch.canonical); patch.engine_state.confirmation_results = [];
      const canonical = canonicalJson(patch);
      f.journal.append(bytes({ ...document, client_event_id: randomUUID(), spec: { ...document.spec, items: [old, newer] },
        patch: { canonical, sha256: sha256Hex(canonical) } }), auth);
    }
    return f.journal.append(original, auth);
  } } });
  seed(f); await f.engine.start(); await f.engine.confirmItem(binding());
  assert.equal(f.engine.metrics.cas_retries, 1);
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'draft']);
  assert.equal(results(f)[0].reason, 'superseded');
  await f.engine.confirmItem(binding(f.engine.state.spec.items.at(-1)));
  await f.engine.passSpec();
  assert.deepEqual(f.engine.state.spec.items.map((row) => row.state), ['superseded', 'confirmed']);
  assert.equal(results(f).length, 2);
});

it('the shared confirmation authority skips receipted records even when called directly twice', async (t) => {
  const f = fixture(t); seed(f); await f.engine.start(); await f.engine.confirmItem(binding());
  const state = structuredClone(f.engine.state), meta = metadata(f), confirmations = f.records('ui.confirm').map((r) => r.document);
  const before = canonicalJson({ state, meta });
  applyConfirmations(state, meta, confirmations);
  applyConfirmations(state, meta, confirmations);
  assert.equal(canonicalJson({ state, meta }), before);
});

for (const corruption of ['null', 'duplicate', 'unknown_seq', 'snapshot_seq', 'wrong_reason', 'false_confirmation', 'false_supersession', 'false_noop']) {
  it(`malformed confirmation receipts cannot suppress replay: ${corruption}`, async (t) => {
    const f = fixture(t); seed(f); await f.engine.start(); await f.engine.confirmItem(binding());
    const state = structuredClone(f.engine.state), meta = metadata(f), events = f.records().map((r) => r.document);
    if (corruption === 'null') meta.confirmation_results = null;
    if (corruption === 'duplicate') meta.confirmation_results.push({ ...meta.confirmation_results[0] });
    if (corruption === 'unknown_seq') meta.confirmation_results[0].record_seq = 999;
    if (corruption === 'snapshot_seq') meta.confirmation_results[0].record_seq = 1;
    if (corruption === 'wrong_reason') meta.confirmation_results[0].reason = 'ignored';
    if (corruption === 'false_confirmation') state.spec.items[0].state = 'draft';
    if (corruption === 'false_supersession') meta.confirmation_results[0].reason = 'superseded';
    if (corruption === 'false_noop') { state.spec.items[0].state = 'draft'; meta.confirmation_results[0].reason = 'not_draft'; }
    assert.throws(() => validateEngineMetadata(state, meta, events), (e) => e.reason === 'invalid_resume');
  });
}
