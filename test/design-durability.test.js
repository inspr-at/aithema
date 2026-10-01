import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../contracts/validate.js';
import { JournalError, SqliteJournal, JournalClient } from '../runtime/journal/index.js';
import { renderHydratedDesign, renderStoredDesign, DesignRenderer } from '../runtime/design/index.js';
import { DesignScheduler } from '../runtime/engine/design.js';
import { FakeClock } from './engine-helpers.test.js';
import { authority, bytes, now, session } from './fixtures/journal/helpers.mjs';
import { errorCode, input, stored, submission } from './fixtures/design/helpers.mjs';

function hostFixture(t) {
  const host = new SqliteJournal(':memory:', { now });
  host.createSession(bytes(session()));
  t.after(() => host.close());
  const client = new JournalClient({ port: host, authority: authority(), now });
  return { host, client };
}

it('(e) SIGKILL and a new process hydrate both brands and regenerate every HTML/CSS/export byte identically', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aithema-design-restart-'));
  // Keep synthetic crash evidence in the OS temp directory. Host policy for
  // this worker prohibits cleanup tools; no fixture invokes one indirectly.
  const path = join(dir, 'host.sqlite');
  const child = fileURLToPath(new URL('./fixtures/design/restart-child.mjs', import.meta.url));
  const first = spawnSync(process.execPath, [child, 'write', path], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(first.error); assert.equal(first.signal, 'SIGKILL', first.stderr);
  const second = spawnSync(process.execPath, [child, 'resume', path], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(second.error); assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(`${path}.after.json`, 'utf8'), readFileSync(`${path}.before.json`, 'utf8'));
  const results = JSON.parse(readFileSync(`${path}.after.json`));
  assert.notEqual(results[0].artifact.design_rev, results[1].artifact.design_rev);
  assert.equal(results[0].artifact.html, renderStoredDesign({ bytes: Buffer.from(results[0].bytes, 'base64'), document: { ...JSON.parse(Buffer.from(results[0].bytes, 'base64')), seq: 1 } }).html);
});

it('(d) append precedes rendering, exact retry reuses host seq, and old-generation writes are fenced', async (t) => {
  const { host, client } = hostFixture(t);
  const clock = new FakeClock(); let observed = 0;
  const renderer = new DesignRenderer({ clock, journal: { async append(raw) {
    observed++;
    assert.equal(renderer.activeCount, 1);
    return client.append(raw);
  } }, getInput: () => submission() });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  const first = await renderer.render(request);
  assert.equal(observed, 1);
  assert.equal(first.design_input_seq, 1); assert.equal(renderer.activeCount, 0);
  const next = await client.append(submission());
  assert.equal(next.document.seq, 1); assert.equal(host.cursor(client.authority).last_seq, 1);
  const takeover = host.takeover(client.authority);
  assert.equal(takeover.worker_generation, 2);
  await assert.rejects(() => renderer.render(request), errorCode('fenced_generation'));
  assert.equal(observed, 2);
});

it('(d) host failure produces no output and retains exact pending bytes for recovery', async (t) => {
  const { host } = hostFixture(t);
  let fail = true;
  const client = new JournalClient({ port: { append: (raw, auth) => {
    if (fail) throw new JournalError(503, 'Synthetic unavailable host');
    return host.append(raw, auth);
  } }, authority: authority(), now });
  const renderer = new DesignRenderer({ clock: new FakeClock(), journal: client, getInput: () => submission() });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  await assert.rejects(() => renderer.render(request), /Synthetic unavailable host/);
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [submission()]);
  fail = false; await client.flush();
  const artifact = await renderer.render(request);
  assert.equal(artifact.design_input_seq, 1); assert.equal(host.cursor(client.authority).last_seq, 1);
});

it('(d) mismatched acknowledgement, missing bodies and tampered hydration are explicit failures', async () => {
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  const row = stored(); row.bytes = Buffer.from(row.bytes.toString() + '\n');
  const renderer = new DesignRenderer({ clock: new FakeClock(), getInput: () => submission(), journal: { append: () => row } });
  await assert.rejects(() => renderer.render(request), errorCode('design_input_invalid'));
  const hydrated = { screen_ir_bytes: Buffer.from(canonicalJson(input().screen_ir)), tokens_bytes: Buffer.from(canonicalJson(input().tokens)), record_bytes: submission(), design_input_seq: 7 };
  assert.equal(renderHydratedDesign(hydrated).design_input_seq, 7);
  assert.throws(() => renderHydratedDesign({ ...hydrated, tokens_bytes: Buffer.from('{}') }), errorCode('design_input_invalid'));
  assert.throws(() => renderHydratedDesign({ ...hydrated, record_bytes: null }), errorCode('design_input_invalid'));
});

it('(e) existing scheduler runs the real render port, coalesces revisions and retries only once', async (t) => {
  const { client, host } = hostFixture(t);
  const clock = new FakeClock(); let revision = 1; const calls = []; const output = [];
  const renderer = new DesignRenderer({ clock, journal: client, getInput: (rev, { attempt }) => {
    calls.push({ ...rev, attempt });
    if (calls.length === 1) throw new Error('Synthetic first-attempt failure');
    return submission('a', { screen_ir: { ...input().screen_ir, title: `Revision ${rev.working_rev}` } });
  } });
  const original = renderer.render.bind(renderer);
  renderer.render = async (request) => { const result = await original(request); output.push(result); return result; };
  const scheduler = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: revision }) });
  t.after(() => scheduler.stop());
  scheduler.intent({ intent_id: 'first', working_rev: revision });
  await clock.advance(10_000); revision = 2;
  scheduler.intent({ intent_id: 'second', working_rev: revision });
  await clock.advance(20_000);
  assert.deepEqual(calls, [{ working_rev: 2, attempt: 1 }, { working_rev: 2, attempt: 2 }]);
  assert.equal(output.length, 1); assert.equal(output[0].working_rev, 2);
  assert.equal(host.cursor(client.authority).last_seq, 1);
  assert.equal(scheduler.state.runs[0].started_at, 30_000);
  for (const intent of scheduler.state.intents) { assert.equal(intent.state, 'rendered'); assert.equal(intent.served_at, 30_000); }
  assert.equal(renderer.activeCount, 0);
});

it('(e) expired starts, overlap and late input-reader completion cannot render after a deadline', async (t) => {
  const { host, client } = hostFixture(t);
  const clock = new FakeClock(); let release;
  const renderer = new DesignRenderer({ clock, journal: client, getInput: () => new Promise((resolve) => { release = resolve; }) });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  const first = renderer.render(request);
  const rejected = assert.rejects(first, errorCode('design_deadline'));
  await assert.rejects(() => renderer.render(request), errorCode('design_overlap'));
  await clock.advance(60_001); release(submission()); await rejected;
  assert.equal(host.cursor(client.authority).last_seq, 0);
  assert.equal(renderer.activeCount, 0);
  await assert.rejects(() => renderer.render(request), errorCode('design_deadline'));
});

it('(e) a slow acknowledgement cannot return late HTML or admit overlapping retries', async () => {
  const clock = new FakeClock(); let release;
  const renderer = new DesignRenderer({ clock, getInput: () => submission(), journal: { append: () => new Promise((resolve) => { release = resolve; }) } });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  const first = renderer.render(request);
  const rejected = assert.rejects(first, errorCode('design_deadline'));
  await clock.advance(1);
  await assert.rejects(() => renderer.render(request), errorCode('design_overlap'));
  await clock.advance(60_000); release(stored()); await rejected;
  assert.equal(renderer.activeCount, 0);
});

it('(e) the attempt deadline fires while the input reader is still pending and late completion performs no append', async (t) => {
  const { host, client } = hostFixture(t);
  const clock = new FakeClock(); let release;
  const renderer = new DesignRenderer({ clock, journal: client, getInput: () => new Promise((resolve) => { release = resolve; }) });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 120_000 };
  const failed = assert.rejects(renderer.render(request), errorCode('design_deadline'));
  await clock.advance(60_000);
  await failed;
  assert.equal(renderer.activeCount, 1, 'outstanding I/O retains the guard');
  await assert.rejects(() => renderer.render({ ...request, attempt: 2 }), errorCode('design_overlap'));
  release(submission()); await clock.advance(0);
  assert.equal(renderer.activeCount, 0);
  assert.equal(host.cursor(client.authority).last_seq, 0);
});

it('(d,e) a committed late acknowledgement yields no HTML, then retry reuses the exact input without calling the reader', async (t) => {
  const { host, client } = hostFixture(t);
  const clock = new FakeClock(); let release; let reads = 0; let appends = 0;
  const renderer = new DesignRenderer({ clock, getInput: () => { reads++; return submission(); }, journal: {
    async append(raw) {
      const row = await client.append(raw);
      if (++appends === 1) return new Promise((resolve) => { release = () => resolve(row); });
      return row;
    },
  } });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  const failed = assert.rejects(renderer.render(request), errorCode('design_deadline'));
  await clock.advance(60_000); await failed;
  assert.equal(host.cursor(client.authority).last_seq, 1);
  assert.equal(renderer.activeCount, 1);
  release(); await clock.advance(0);
  const artifact = await renderer.render({ ...request, attempt: 2, deadline: 120_000 });
  assert.equal(artifact.design_input_seq, 1);
  assert.equal(reads, 1); assert.equal(appends, 2);
  assert.equal(host.cursor(client.authority).last_seq, 1);
});

it('(d) retry preserves input bytes even when a failed append mutates its borrowed buffer', async () => {
  const clock = new FakeClock(); let reads = 0; let appends = 0;
  const renderer = new DesignRenderer({ clock, getInput: (revision) => {
    reads++; revision.working_rev = 99; return submission();
  }, journal: { append(raw) {
    assert.deepEqual(raw, submission());
    if (++appends === 1) { raw.fill(0); throw new JournalError(503, 'Synthetic failed write'); }
    return stored();
  } } });
  const request = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  await assert.rejects(() => renderer.render(request), /Synthetic failed write/);
  const artifact = await renderer.render({ ...request, attempt: 2 });
  assert.equal(reads, 1); assert.equal(artifact.working_rev, 1);
  assert.equal(request.revision.working_rev, 1);
});

it('(e) invalid requests fail before reading inputs or writing the journal', async () => {
  let calls = 0;
  const renderer = new DesignRenderer({ clock: new FakeClock(), getInput: () => { calls++; }, journal: { append: () => { calls++; } } });
  const valid = { revision: { working_rev: 1 }, attempt: 1, deadline: 60_000 };
  for (const request of [null, { ...valid, revision: null }, { ...valid, revision: { working_rev: 0 } }, { ...valid, attempt: 3 }]) {
    await assert.rejects(() => renderer.render(request), errorCode('design_input_invalid'));
  }
  for (const deadline of [undefined, NaN, Infinity, -1]) {
    await assert.rejects(() => renderer.render({ ...valid, deadline }), errorCode('design_deadline'));
  }
  assert.equal(calls, 0);
});

it('(e) double failure terminates a real scheduled run and sustained audio cannot defer later continuous revisions beyond 30 seconds', async (t) => {
  const { client } = hostFixture(t);
  const clock = new FakeClock(); let revision = 1; const output = []; const calls = [];
  const renderer = new DesignRenderer({ clock, journal: client, getInput: (rev, { attempt }) => {
    calls.push({ ...rev, attempt });
    if (rev.working_rev === 1) throw new Error('Synthetic failure on both attempts');
    return submission('a', { screen_ir: { ...input().screen_ir, title: `Revision ${rev.working_rev}` },
      client_event_id: `00000000-0000-4000-8000-${String(rev.working_rev).padStart(12, '0')}` });
  } });
  const scheduler = new DesignScheduler({ clock, renderer, waitMs: 0, getRevision: () => ({ working_rev: revision }), onComplete: (results) => output.push(...results) });
  t.after(() => scheduler.stop());
  scheduler.setAudioBusy(true);
  scheduler.intent({ intent_id: 'failure', working_rev: 1 });
  await clock.advance(20_000);
  assert.equal(output[0].state, 'render_failed'); assert.equal(output[0].attempts, 2);
  for (let i = 2; i <= 6; i++) {
    revision = i; scheduler.intent({ intent_id: `intent${i}`, working_rev: i });
    await clock.advance(10_000); scheduler.setAudioBusy(true);
    await clock.advance(10_000);
    const intent = scheduler.state.intents.at(-1);
    assert.equal(intent.state, 'rendered'); assert.equal(intent.rendered_rev, i);
    assert.ok(intent.started_at - intent.arrived_at <= 30_000);
    assert.ok(intent.served_at - intent.arrived_at <= 150_000);
  }
  assert.equal(calls.length, 7); assert.equal(renderer.activeCount, 0);
});

for (const [activeRetry, nextRetry] of [[false, false], [true, false], [false, true], [true, true]]) {
  it(`(e) real port freshness with active retry=${activeRetry}, next retry=${nextRetry} stays inside §5.1`, async (t) => {
    const { client } = hostFixture(t);
    const clock = new FakeClock(); let revision = 1; const calls = [];
    const renderer = new DesignRenderer({ clock, journal: client, getInput: (rev, { attempt }) => {
      assert.equal(renderer.activeCount, 1);
      calls.push({ working_rev: rev.working_rev, attempt });
      return new Promise((resolve, reject) => clock.setTimeout(() => {
        const retry = rev.working_rev === 1 ? activeRetry : nextRetry;
        if (retry && attempt === 1) reject(new Error('Synthetic input-reader failure'));
        else resolve(submission(rev.working_rev === 1 ? 'a' : 'b', {
          screen_ir: { ...input().screen_ir, title: `Revision ${rev.working_rev}` },
        }));
      }, 55_000));
    } });
    const scheduler = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: revision }) });
    t.after(() => scheduler.stop());
    scheduler.intent({ intent_id: 'active', working_rev: 1 });
    await clock.advance(30_001); revision = 2;
    scheduler.intent({ intent_id: 'newer', working_rev: 2 });
    await clock.advance(270_000);
    const bound = 150_000 + 60_000 * (Number(activeRetry) + Number(nextRetry));
    const intent = scheduler.state.intents.find((i) => i.intent_id === 'newer');
    assert.equal(intent.state, 'rendered');
    assert.ok(intent.served_at - intent.arrived_at <= bound);
    assert.equal(calls.length, 2 + Number(activeRetry) + Number(nextRetry));
    assert.equal(renderer.activeCount, 0);
    for (const run of scheduler.state.runs) assert.ok(run.ended_at - run.started_at <= 60_000 * run.attempts);
  });
}
