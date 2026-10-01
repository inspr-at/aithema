import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as runtime from '../runtime/index.js';
import * as design from '../runtime/design/index.js';
import { canExecute, canonicalJson, contractEntry, sha256Hex, validate } from '../contracts/validate.js';
import { ControlledRenderer, TextEngine } from '../runtime/engine/index.js';
import { FakeClock, authorizationFor } from './engine-helpers.test.js';
import { engineFixture } from './fixtures/design/engine-helpers.mjs';
import { requestDesign, textDesign as textToDesign } from './fixtures/design/engine.mjs';
import { screen, submission } from './fixtures/design/helpers.mjs';

const completions = (f) => JSON.parse(f.engine.state.patch.canonical).engine_state.design_results;

it('(c) runtime entry point re-exports every public design API', () => {
  for (const [name, value] of Object.entries(design)) assert.equal(runtime[name], value, name);
});

it('(a,b) text turn uses the default real renderer and atomically persists its binding and completion', async (t) => {
  const f = engineFixture(t);
  await textToDesign(f);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].spec.items[0].content.statement, 'Export fixture entries.');
  assert.equal(f.records('design.input').length, 1);
  const row = f.records('design.input')[0];
  const artifact = design.renderStoredDesign(row);
  const expected = { screen_ref: row.document.data.screen_ir.screen_ref,
    design_input_seq: row.document.seq, design_rev: artifact.design_rev };
  assert.deepEqual(f.engine.state.spec.screens, [expected]);
  assert.deepEqual(completions(f)[0].screen, expected);
  const snapshot = f.journal.cursor(f.client.authority).snapshot;
  assert.deepEqual(snapshot.document.spec.screens, [expected]);
  assert.equal(validate(snapshot.document.contract, snapshot.document).ok, true);
  assert.ok(snapshot.document.seq > row.document.seq, 'input acknowledgement precedes the binding snapshot');
  assert.ok(artifact.html.includes('Export fixture entries.'));
  assert.doesNotMatch(snapshot.document.patch.canonical, /<!doctype|stylesheets/);
  assert.deepEqual(f.errors, []);
});

it('(a) the controlled renderer remains explicitly injectable without inventing a screen binding', async (t) => {
  const clock = new FakeClock();
  const renderer = new ControlledRenderer({ clock });
  const f = engineFixture(t, { clock, renderer, getDesignInput() { throw new Error('Stub must not read design inputs'); } });
  await textToDesign(f);
  assert.equal(renderer.calls.length, 1);
  assert.equal(completions(f)[0].state, 'rendered');
  assert.deepEqual(f.engine.state.spec.screens, []);
  assert.equal(f.records('design.input').length, 0);
});

it('(b) injected real renderer bindings are persisted through the paid wrapper too', async (t) => {
  const f = engineFixture(t);
  const renderer = new design.DesignRenderer({ journal: f.client, clock: f.clock, getInput: () => submission() });
  const injected = engineFixture(t, { path: f.path, initialize: false, clock: f.clock, renderer });
  await textToDesign(injected);
  assert.equal(injected.engine.state.spec.screens.length, 1);
  assert.equal(injected.engine.state.spec.screens[0].design_rev, design.renderStoredDesign(f.records('design.input')[0]).design_rev);
});

it('(b) a failed completion write retains the screen binding and recovers without another render', async (t) => {
  let fail = true;
  const f = engineFixture(t, { checkpoint(point) {
    if (fail && point === 'design.before_finalize') throw new Error('Synthetic completion failure');
  } });
  await textToDesign(f);
  assert.equal(f.engine.design.state.pending_completions.length, 1);
  assert.equal(f.engine.design.state.pending_completions[0].screen.design_input_seq, f.records('design.input')[0].document.seq);
  assert.deepEqual(f.engine.state.spec.screens, []);
  fail = false;
  await f.engine.recoverJournal();
  assert.equal(f.engine.state.spec.screens.length, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.records('design.input').length, 1);
  const rev = f.engine.state.working_rev;
  await f.engine.recoverJournal(); await f.clock.advance(9000);
  assert.equal(f.engine.state.working_rev, rev);
  assert.deepEqual(f.engine.design.state.pending_completions, []);
});

it('(b) restart restores completed bindings without re-admission or re-reading design inputs', async (t) => {
  const f = engineFixture(t);
  await textToDesign(f);
  const screens = f.engine.state.spec.screens;
  assert.equal(screens.length, 1);
  f.engine.close();
  const resumed = engineFixture(t, { path: f.path, initialize: false, getDesignInput() { throw new Error('Resume must hydrate inputs'); } });
  await resumed.engine.resume({ authorizationFor, replay: false });
  await resumed.clock.advance(30_000);
  assert.deepEqual(resumed.engine.state.spec.screens, screens);
  assert.equal(resumed.engine.design.state.intents[0].state, 'rendered');
  assert.deepEqual(resumed.engine.design.state.intents[0].screen, screens[0]);
  assert.equal(resumed.records('design.input').length, 1);
  assert.equal(resumed.records('budget.hold').filter((r) => r.document.data.lane === 'design').length, 1);
});

for (const brand of ['a', 'b']) {
  it(`(d) text turn → default real screen → process crash → byte-identical branded regeneration (${brand})`, () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aithema-design-engine-')), 'host.sqlite');
    const child = fileURLToPath(new URL('./fixtures/design/engine-restart-child.mjs', import.meta.url));
    const write = spawnSync(process.execPath, [child, 'write', path, brand], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(write.error, undefined);
    assert.equal(write.signal, 'SIGKILL', write.stderr);
    const resume = spawnSync(process.execPath, [child, 'resume', path], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(resume.error, undefined);
    assert.equal(resume.status, 0, resume.stderr);
    const before = JSON.parse(readFileSync(`${path}.before.json`, 'utf8'));
    const after = JSON.parse(readFileSync(`${path}.after.json`, 'utf8'));
    for (const key of ['binding', 'artifact', 'exported', 'bytes']) assert.deepEqual(after[key], before[key]);
  });
}

it('(a) missing or invalid input readers fail explicitly instead of reporting a stub render success', async (t) => {
  const f = engineFixture(t);
  assert.throws(() => new TextEngine({ ...f.engineOptions, getDesignInput: 7 }), { reason: 'invalid_configuration' });
  const engine = new TextEngine({ ...f.engineOptions, getDesignInput: undefined });
  t.after(() => engine.close());
  await textToDesign({ ...f, engine });
  assert.equal(engine.design.state.intents[0].state, 'render_failed');
  assert.equal(engine.design.state.intents[0].attempts, 2);
  assert.equal(engine.design.state.runs[0].error, 'invalid_configuration');
  assert.deepEqual(engine.state.spec.screens, []);
  assert.equal(f.records('design.input').length, 0);
});

it('(b) coalesced intents share one newest-revision binding without duplicate screens', async (t) => {
  const f = engineFixture(t, { designWaitMs: 30_000 });
  await f.engine.start(); f.personTurn(); await f.engine.passSpec();
  const firstRev = f.engine.state.working_rev;
  f.engine.design.intent({ intent_id: 'first', working_rev: firstRev });
  await f.clock.advance(10_000);
  f.personTurn(); await f.engine.passSpec();
  const latest = f.engine.state.working_rev;
  f.engine.design.intent({ intent_id: 'second', working_rev: latest });
  await f.clock.advance(20_000);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].working_rev, latest);
  assert.equal(completions(f).length, 2);
  assert.equal(f.engine.state.spec.screens.length, 1);
  for (const result of completions(f)) {
    assert.equal(result.rendered_rev, latest);
    assert.deepEqual(result.screen, f.engine.state.spec.screens[0]);
  }
});

it('(b) rerender replaces a screen binding and preserves other screen refs', async (t) => {
  let f, reads = 0;
  const fInput = (revision) => {
    const screen_ir = screen();
    screen_ir.screen_ref = ++reads === 2 ? 'second-screen' : 'first-screen';
    screen_ir.title = `Revision ${revision.working_rev}`;
    return submission('a', { screen_ir, client_event_id: `00000000-0000-4000-8000-${String(reads).padStart(12, '0')}` });
  };
  f = engineFixture(t, { getDesignInput: fInput });
  await textToDesign(f);
  const first = f.engine.state.spec.screens[0];
  f.engine.design.intent({ intent_id: 'other', working_rev: f.engine.state.working_rev }); await f.clock.advance(0);
  const second = f.engine.state.spec.screens[1];
  f.engine.design.intent({ intent_id: 'replace', working_rev: f.engine.state.working_rev }); await f.clock.advance(0);
  assert.equal(f.engine.state.spec.screens.length, 2);
  assert.notEqual(f.engine.state.spec.screens[0].design_rev, first.design_rev);
  assert.ok(f.engine.state.spec.screens[0].design_input_seq > first.design_input_seq);
  assert.deepEqual(f.engine.state.spec.screens[1], second);
  assert.equal(completions(f).length, 3);
});

it('(b) a real render persists its captured revision binding while a newer spec pass commits', async (t) => {
  let release, captured;
  const f = engineFixture(t, { handler(lane, payload) {
    const result = requestDesign(lane, payload);
    if (lane === 'spec') result.brief = `Spec pass at ${payload.base_rev}`;
    return result;
  }, getDesignInput(revision) {
    captured = revision;
    return new Promise((resolve) => { release = resolve; });
  } });
  await textToDesign(f);
  assert.equal(f.engine.design.state.busy, true);
  const capturedRev = captured.working_rev;
  f.personTurn(); await f.engine.passSpec();
  const latest = f.engine.state;
  assert.ok(latest.working_rev > capturedRev);
  const screen_ir = screen(); screen_ir.title = `Captured ${capturedRev}`;
  release(submission('a', { screen_ir }));
  await f.clock.advance(0);
  assert.equal(completions(f)[0].rendered_rev, capturedRev);
  assert.equal(f.engine.state.spec.brief, latest.spec.brief);
  assert.deepEqual(f.engine.state.spec.items, latest.spec.items);
  assert.equal(f.engine.state.spec.screens[0].design_rev, design.renderStoredDesign(f.records('design.input')[0]).design_rev);
  assert.deepEqual(f.errors, []);
});

for (const [name, mutate] of [
  ['missing digest', (b) => { delete b.design_rev; }],
  ['unsafe screen ref', (b) => { b.screen_ref = 'bad<script>'; }],
  ['zero sequence', (b) => { b.design_input_seq = 0; }],
  ['wrong captured revision', (b) => { b.working_rev += 1; }],
  ['forged digest', (b) => { b.design_rev = '0'.repeat(64); }],
  ['wrong screen identity', (b) => { b.screen_ref = 'other'; }],
  ['missing acknowledged input', (b) => { b.design_input_seq = 999; }],
  ['turn in place of design input', (b) => { b.design_input_seq = 1; }],
]) {
  it(`(b) rejects ${name} before persisting a rendered completion or binding`, async (t) => {
    const clock = new FakeClock(); let row;
    const renderer = new ControlledRenderer({ clock, plan: (request) => {
      const output = { ...design.renderStoredDesign(row), screen_ref: row.document.data.screen_ir.screen_ref,
        working_rev: request.revision.working_rev };
      mutate(output);
      return { duration_ms: 0, fail: false, output };
    } });
    const f = engineFixture(t, { clock, renderer });
    f.personTurn(); row = await f.client.append(submission());
    await f.engine.start(); await f.engine.passSpec();
    f.engine.design.intent({ intent_id: 'malformed', working_rev: f.engine.state.working_rev });
    await clock.advance(0);
    assert.equal(completions(f)[0]?.state, 'render_failed');
    assert.equal(completions(f)[0]?.attempts, 2);
    assert.equal(Object.hasOwn(completions(f)[0], 'screen'), false);
    assert.deepEqual(f.engine.state.spec.screens, []);
    assert.deepEqual(f.engine.design.state.pending_completions, []);
  });
}

it('(b) versioned snapshot bindings accept legacy screen refs and reject invalid digests or unknown fields', async (t) => {
  const f = engineFixture(t); await textToDesign(f);
  const doc = f.engine.state;
  assert.equal(contractEntry(doc.contract).minor, 2);
  assert.equal(doc.minor, 2); assert.equal(doc.min_reader, 0);
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.equal(canExecute(doc, { [doc.contract]: { major: 1, minor: 1 } }).ok, true);
  const legacy = structuredClone(doc);
  delete legacy.spec.screens[0].design_rev;
  legacy.minor = 0; legacy.min_reader = 0;
  assert.equal(validate(legacy.contract, legacy).ok, true);
  for (const digest of ['', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64) + '\n']) {
    const invalid = structuredClone(doc); invalid.spec.screens[0].design_rev = digest;
    assert.equal(validate(invalid.contract, invalid).ok, false);
  }
  const unknown = structuredClone(doc); unknown.spec.screens[0].html = '<script>';
  assert.equal(validate(unknown.contract, unknown).ok, false);
});

it('(b) a thirteenth distinct screen fails explicitly and cannot poison completion persistence', async (t) => {
  let reads = 0;
  const f = engineFixture(t, { getDesignInput() {
    const screen_ir = screen(); screen_ir.screen_ref = `screen${++reads}`;
    return submission('a', { screen_ir, client_event_id: `00000000-0000-4000-8000-${String(reads).padStart(12, '0')}` });
  } });
  await f.engine.start(); f.personTurn(); await f.engine.passSpec();
  for (let i = 0; i < 13; i++) {
    f.engine.design.intent({ intent_id: `bounded${i}`, working_rev: f.engine.state.working_rev });
    await f.clock.advance(0);
  }
  assert.equal(f.engine.state.spec.screens.length, 12);
  assert.equal(completions(f).at(-1).state, 'render_failed');
  assert.equal(completions(f).at(-1).attempts, 2);
  assert.deepEqual(f.engine.design.state.pending_completions, []);
  assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
});

it('(b) pending completion bindings count towards the screen bound during a snapshot outage', async (t) => {
  let fail = true, reads = 0;
  const f = engineFixture(t, { checkpoint(point) {
    if (fail && point === 'design.before_finalize') throw new Error('Synthetic completion outage');
  }, getDesignInput() {
    const screen_ir = screen(); screen_ir.screen_ref = `pending${++reads}`;
    return submission('a', { screen_ir, client_event_id: `00000000-0000-4000-8000-${String(reads).padStart(12, '0')}` });
  } });
  await f.engine.start(); f.personTurn(); await f.engine.passSpec();
  for (let i = 0; i < 13; i++) {
    f.engine.design.intent({ intent_id: `outage${i}`, working_rev: f.engine.state.working_rev });
    await f.clock.advance(0);
  }
  assert.equal(f.engine.design.state.intents.at(-1).state, 'render_failed');
  assert.equal(f.engine.design.state.intents.at(-1).attempts, 2);
  assert.deepEqual(f.engine.state.spec.screens, []);
  fail = false;
  await f.engine.recoverJournal();
  assert.equal(f.engine.state.spec.screens.length, 12);
  assert.equal(completions(f).length, 13);
  assert.deepEqual(f.engine.design.state.pending_completions, []);
});

it('(b) restoring a completion cannot replace its acknowledged binding', async (t) => {
  const f = engineFixture(t); await textToDesign(f);
  const original = completions(f);
  const forged = structuredClone(original);
  forged[0].screen.design_rev = '0'.repeat(64);
  assert.throws(() => f.engine.design.restore(forged), { code: 'idempotency_conflict' });
  assert.deepEqual(f.engine.design.state.intents[0].screen, original[0].screen);
});

for (const target of ['spec binding', 'completion binding']) {
  it(`(b) restart rejects a forged ${target} even with a valid snapshot digest`, async (t) => {
    const f = engineFixture(t); await textToDesign(f);
    const { seq, ...next } = structuredClone(f.engine.state);
    next.client_event_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    next.expected_prev_rev = next.working_rev++;
    if (target === 'spec binding') next.spec.screens[0].design_rev = '0'.repeat(64);
    else {
      const patch = JSON.parse(next.patch.canonical);
      patch.engine_state.design_results[0].screen.design_rev = '0'.repeat(64);
      next.patch.canonical = canonicalJson(patch); next.patch.sha256 = sha256Hex(next.patch.canonical);
    }
    await f.client.append(Buffer.from(canonicalJson(next)));
    f.engine.close();
    const resumed = engineFixture(t, { path: f.path, initialize: false });
    await assert.rejects(() => resumed.engine.resume({ authorizationFor, replay: false }), { reason: 'invalid_design_binding' });
    assert.equal(resumed.reads.length, 0);
  });
}
