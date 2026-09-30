import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import { JournalClient, SqliteJournal, hydrateSnapshot, reopenDesign, snapshotDependencies } from '../runtime/journal/index.js';
import { authority, bytes, code, item, now, pendingOp, record, session, sid, snapshot, source, turn } from './fixtures/journal/helpers.mjs';

const designFixture = JSON.parse(readFileSync(new URL('./fixtures/journal/design-input.json', import.meta.url), 'utf8'));
export function rendererStub(input) {
  // Controlled fixture renderer, no real renderer/provider or remote resource.
  return Buffer.concat([Buffer.from('fixture-render\n'), input.screen_ir_bytes, Buffer.from('\n'), input.tokens_bytes]);
}

function setup(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-journal-resume-')), 'journal.sqlite');
  let journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session()));
  t.after(() => journal.close());
  return {
    get journal() { return journal; },
    restart() { journal.close(); journal = new SqliteJournal(path, { now }); return journal; },
    client(port = journal, grant = authority()) { return new JournalClient({ port, authority: grant, now }); },
  };
}

function design() {
  return record('design.input', { ...structuredClone(designFixture),
    screen_ir_sha256: sha256Hex(canonicalJson(designFixture.screen_ir)),
    tokens_sha256: sha256Hex(canonicalJson(designFixture.tokens)) });
}

function completeFixture(journal, overrides = {}) {
  const person = journal.append(bytes(turn()), authority()); // earlier turn, outside replay
  const document = journal.append(bytes(source()), authority());
  const summaryLeaf = journal.append(bytes(turn({ data: { ...turn().data, body: 'A second fixture leaf retained by a summary.' } })), authority());
  const input = journal.append(bytes(design()), authority());
  const spec = {
    items: [item({ citations: [{ record_seq: person.document.seq, locator: 'turn:1', quote: 'requests an export' },
      { record_seq: document.document.seq, locator: 'seg:leaf', quote: 'export as CSV' }],
    leaves: [person.document.seq, document.document.seq, summaryLeaf.document.seq] })],
    questions: [], brief: 'Summary backed by all three evidence leaves.',
    screens: [{ screen_ref: 'fixture-export', design_input_seq: input.document.seq }],
  };
  const committed = journal.append(bytes(snapshot({ spec, consumed_seq: 4, ...overrides })), authority());
  return { person, document, summaryLeaf, input, committed };
}

it('(b,d) restart hydrates the COMPLETE named closure via records-by-ids, validates citations, and reopens fixture bytes', async (t) => {
  const fixture = setup(t);
  const before = completeFixture(fixture.journal);
  const originalRendered = rendererStub({ screen_ir_bytes: Buffer.from(canonicalJson(designFixture.screen_ir)),
    tokens_bytes: Buffer.from(canonicalJson(designFixture.tokens)) });
  fixture.restart();
  const idsRead = [];
  const port = {
    takeover: (a) => fixture.journal.takeover(a), append: (b, a) => fixture.journal.append(b, a),
    recordsAfter: (n, a, through) => fixture.journal.recordsAfter(n, a, through),
    recordsByIds: (ids, a) => { idsRead.push([...ids]); return fixture.journal.recordsByIds(ids, a); },
  };
  const resumed = await fixture.client(port).resume();
  assert.deepEqual(idsRead, [[1, 2, 3, 4]]);
  assert.deepEqual([...resumed.closure.keys()], [1, 2, 3, 4]);
  assert.deepEqual(resumed.replay, [], 'earlier leaves cannot be recovered from the replay window');
  assert.equal(resumed.cursor.worker_generation, 2);
  assert.deepEqual(resumed.closure.get(4).bytes, before.input.bytes);
  const rendered = await reopenDesign(resumed.snapshot, resumed.closure, 'fixture-export', (input) => {
    assert.deepEqual(input.record_bytes, before.input.bytes);
    return rendererStub(input);
  });
  assert.deepEqual(rendered, originalRendered);
  assert.equal(validate(resumed.snapshot.contract, resumed.snapshot).ok, true);
  assert.equal(fixture.journal.recordsAfter(5, authority())[0].document.kind, 'audit.restart');
});

it('(b) summary leaves are hydrated even when omitted from direct citations', async (t) => {
  const fixture = setup(t);
  fixture.journal.append(bytes(turn()), authority());
  fixture.journal.append(bytes(source()), authority());
  const spec = { items: [item({ leaves: [1, 2] })], questions: [], brief: 'Flattened summary leaves', screens: [] };
  fixture.journal.append(bytes(snapshot({ spec, consumed_seq: 2 })), authority());
  const resumed = await fixture.client().resume();
  assert.deepEqual(snapshotDependencies(resumed.snapshot), [1, 2]);
  assert.deepEqual([...resumed.closure.keys()], [1, 2]);
});

for (const [name, change] of [
  ['missing segment', (spec) => { spec.items[0].citations[1].locator = 'seg:missing'; }],
  ['quote outside selected segment', (spec) => { spec.items[0].citations[1].quote = '🧪'; }],
  ['wrong turn quote', (spec) => { spec.items[0].citations[0].quote = 'invented quotation'; }],
  ['source locator on a turn', (spec) => { spec.items[0].citations[0].locator = 'seg:leaf'; }],
  ['turn locator on a source', (spec) => { spec.items[0].citations[1].locator = 'turn:1'; }],
  ['zero turn locator', (spec) => { spec.items[0].citations[0].locator = 'turn:0'; }],
  ['unsafe turn locator', (spec) => { spec.items[0].citations[0].locator = 'turn:999999999999999999999'; }],
  ['missing record', (spec) => { spec.items[0].provenance.derived_from.push(100); }],
  ['screen ref to a source', (spec) => { spec.screens[0].design_input_seq = 2; }],
  ['citation to design input', (spec) => { spec.items[0].citations[0].record_seq = 4; }],
]) {
  it(`(b,d) resume rejects ${name} BEFORE retrying pending intake operations`, async (t) => {
    const fixture = setup(t);
    const first = completeFixture(fixture.journal);
    const spec = structuredClone(first.committed.document.spec);
    change(spec);
    fixture.journal.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: 4,
      spec, pending_ops: [pendingOp()] })), authority());
    let retries = 0;
    await assert.rejects(fixture.client().resume({ retryOp: () => { retries++; return {}; } }), code('citation_invalid', 422));
    assert.equal(retries, 0);
  });
}

for (const directlyCited of [true, false]) {
  it(`(b,d) ${directlyCited ? 'direct citations' : 'summary leaf chains'} through assistant turns are rejected`, async (t) => {
    const fixture = setup(t);
    const ai = turn({ data: { ...turn().data, speaker: 'assistant', trust: 'assistant', body: 'Assistant output is not person evidence.' } });
    fixture.journal.append(bytes(ai), authority());
    fixture.journal.append(bytes(snapshot({ consumed_seq: 1, spec: {
      items: [item({ citations: directlyCited ? [{ record_seq: 1, locator: 'turn:1' }] : [], leaves: [1] })],
      questions: [], brief: null, screens: [],
    } })), authority());
    await assert.rejects(fixture.client().resume(), code('citation_invalid', 422));
  });
}

it('(b) hydration fails closed on missing, duplicate, foreign, unexpected or changed host records', async (t) => {
  const fixture = setup(t);
  const { committed } = completeFixture(fixture.journal);
  const valid = fixture.journal.recordsByIds([1, 2, 3, 4], authority());
  const variants = [valid.slice(1), [...valid, valid[0]], [...valid, { ...valid[0], document: { ...valid[0].document, seq: 10 } }],
    valid.map((r, i) => i ? r : { ...r, document: { ...r.document, sid: '22222222-2222-4222-8222-222222222222' } }),
    valid.map((r, i) => i ? r : { ...r, document: { ...r.document, data: { ...r.document.data, body: 'fabricated' } } })];
  for (const records of variants) {
    await assert.rejects(hydrateSnapshot({ recordsByIds: () => records }, committed, authority()), code('citation_invalid', 422));
  }
  await assert.rejects(reopenDesign(committed.document, new Map(), 'fixture-export', rendererStub), code('citation_invalid', 422));
});

it('(b) missing earlier dependency is a citation_invalid, not a silent partial closure', async (t) => {
  const fixture = setup(t);
  fixture.journal.append(bytes(turn()), authority());
  fixture.journal.append(bytes(turn()), authority());
  const saved = fixture.journal.append(bytes(snapshot({ consumed_seq: 2, spec: {
    items: [item({ leaves: [1] })], questions: [], brief: null, screens: [],
  } })), authority());
  await assert.rejects(hydrateSnapshot({ recordsByIds: () => { const e = new Error('Not found'); e.status = 404; throw e; } },
    saved, authority()), code('citation_invalid', 422));
});

it('(d) snapshot committed with ops pending → retry byte-exact → op.result; next snapshot removes manifest', async (t) => {
  const fixture = setup(t);
  const op = pendingOp();
  fixture.journal.append(bytes(snapshot({ pending_ops: [op] })), authority());
  fixture.restart();
  const client = fixture.client();
  let calls = 0;
  const resumed = await client.resume({ retryOp: async (request, grant) => {
    calls++;
    assert.equal(request.op_key, op.op_key);
    assert.deepEqual(request.payload_bytes, Buffer.from(op.payload));
    assert.equal(grant.gen, 2);
    return { source_id: '33333333-3333-4333-8333-333333333333' };
  } });
  assert.equal(calls, 1);
  assert.equal(resumed.completedOps.size, 1);
  const result = fixture.journal.recordsAfter(1, client.authority).find((r) => r.document.kind === 'op.result');
  assert.equal(validate(result.document.contract, result.document).ok, true);
  await client.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, worker_generation: 2,
    consumed_seq: result.document.seq, pending_ops: [] })));
  assert.deepEqual(fixture.journal.cursor(client.authority).snapshot.document.pending_ops, []);
});

it('(d) op acknowledged but op.result missing → host idempotency returns existing row, no duplicate effect', async (t) => {
  const fixture = setup(t);
  const op = pendingOp();
  fixture.journal.append(bytes(snapshot({ pending_ops: [op] })), authority());
  const intakeRows = new Map([[op.op_key, { payload: Buffer.from(op.payload), ids: { proposal_ref: 'fixture-P1' } }]]);
  let effects = 1; // intake already committed, worker crashed before journalling acknowledgement
  fixture.restart();
  const resumed = await fixture.client().resume({ retryOp: ({ op_key, payload_bytes }) => {
    const existing = intakeRows.get(op_key);
    if (existing) { assert.deepEqual(payload_bytes, existing.payload); return existing.ids; }
    effects++; throw new Error('Unexpected second intake write');
  } });
  assert.equal(effects, 1);
  assert.deepEqual(resumed.completedOps.get(op.op_key), { proposal_ref: 'fixture-P1' });
});

it('(d) durable op.result suppresses retry after another crash even while old snapshot still lists pending op', async (t) => {
  const fixture = setup(t);
  const op = pendingOp();
  fixture.journal.append(bytes(snapshot({ pending_ops: [op] })), authority());
  fixture.journal.append(bytes(record('op.result', { op_key: op.op_key, host_ids: { proposal_ref: 'fixture-P1' } })), authority());
  fixture.restart();
  let retries = 0;
  const resumed = await fixture.client().resume({ retryOp: () => { retries++; return {}; } });
  assert.equal(retries, 0);
  assert.equal(resumed.completedOps.size, 1);
});

it('(d) intake idempotency_conflict is surfaced without retry or op.result', async (t) => {
  const fixture = setup(t);
  fixture.journal.append(bytes(snapshot({ pending_ops: [pendingOp()] })), authority());
  const { JournalError } = await import('../runtime/journal/port.js');
  let calls = 0;
  await assert.rejects(fixture.client().resume({ retryOp: () => {
    calls++; throw new JournalError(409, 'fixture conflict', 'idempotency_conflict');
  } }), code('idempotency_conflict'));
  assert.equal(calls, 1);
  assert.equal(fixture.journal.recordsAfter(1, authority()).filter((r) => r.document.kind === 'op.result').length, 0);
});

it('(d) restart without snapshot replays every turn, and resume is single-flight', async (t) => {
  const fixture = setup(t);
  fixture.journal.append(bytes(turn()), authority());
  fixture.restart();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const port = { takeover: async (a) => { await gate; return fixture.journal.takeover(a); },
    append: (b, a) => fixture.journal.append(b, a), recordsByIds: (ids, a) => fixture.journal.recordsByIds(ids, a),
    recordsAfter: (n, a, through) => fixture.journal.recordsAfter(n, a, through) };
  const client = fixture.client(port);
  const pending = client.resume();
  await assert.rejects(client.resume(), { status: 409 });
  release();
  const resumed = await pending;
  assert.equal(resumed.snapshot, null);
  assert.equal(resumed.closure.size, 0);
  assert.deepEqual(resumed.replay.map((r) => r.document.kind), ['turn']);
});

it('design digest tampering is refused at append, preserving the immutable fixture', (t) => {
  const fixture = setup(t);
  const input = design();
  input.data.screen_ir.nodes[0].text = 'Tampered';
  assert.throws(() => fixture.journal.append(bytes(input), authority()), { status: 400 });
});
