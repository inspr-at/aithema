import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhisperCppSpeechToText } from '../runtime/speech/index.js';
import { config, events, host, sttRequest } from './fixtures/speech/helpers.mjs';

const fake = fileURLToPath(new URL('./fixtures/speech/fake-whisper.mjs', import.meta.url));
const parentFixture = fileURLToPath(new URL('./fixtures/speech/crash-parent.mjs', import.meta.url));
function options(client, mode = 'success', pidFile) {
  return config(client, undefined, { maxMicro: 0, command: process.execPath,
    args: [fake, mode, ...(pidFile ? [pidFile] : [])], modelPath: fake });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
async function eventually(predicate) {
  const until = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < until, 'Process condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('(a) whisper.cpp emits transcript through a zero-cost hold/claim and reaps a normal child', { timeout: 5000 }, async (t) => {
  const { client, journal } = host(t, true);
  const adapter = new WhisperCppSpeechToText(options(client));
  assert.deepEqual(await adapter.transcribe(sttRequest()), { text: 'Synthetische Sprache' });
  const records = events(journal);
  assert.deepEqual(records.map((r) => r.kind), ['budget.hold', 'budget.claim', 'budget.settle']);
  assert.equal(records[0].data.lane_kind, 'operator_local'); assert.equal(records[0].data.max_micro, 0);
  assert.equal(records[2].data.outcome, 'settled'); assert.equal(records[2].data.charged_micro, 0);
  assert.deepEqual((await client.listOpen()).holds, []);
});

for (const mode of ['fail', 'invalid', 'overflow']) {
  it(`whisper.cpp ${mode} never produces a completed transcript and settles unknown at zero`, { timeout: 5000 }, async (t) => {
    const { client, journal } = host(t, true);
    await assert.rejects(new WhisperCppSpeechToText(options(client, mode)).transcribe(sttRequest()));
    assert.equal(events(journal).at(-1).data.outcome, 'unknown');
    assert.equal(events(journal).at(-1).data.charged_micro, 0);
  });
}

it('(d) abort mid-child stream kills inference and its descendant group, reaps and suppresses late output', { timeout: 7000 }, async (t) => {
  const { client, journal } = host(t, true);
  const pidFile = join(mkdtempSync(join(tmpdir(), 'speech-child-pids-')), 'pids.json');
  const abort = new AbortController();
  const iterator = new WhisperCppSpeechToText(options(client, 'stall', pidFile)).streamTranscribe(sttRequest(abort.signal));
  assert.equal((await iterator.next()).value, 'Synthetische Sprache');
  await eventually(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile));
  assert.ok(alive(pids.pid)); assert.ok(alive(pids.descendant));
  const pending = iterator.next(), rejected = assert.rejects(pending, { name: 'AbortError' });
  abort.abort(); await rejected;
  await eventually(() => !alive(pids.pid) && !alive(pids.descendant));
  await eventually(() => !alive(pids.supervisor));
  assert.equal(existsSync(pids.audioPath), false);
  assert.equal((await iterator.next()).done, true);
  assert.equal(events(journal).at(-1).data.outcome, 'unknown');
  assert.equal(events(journal).at(-1).data.charged_micro, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

it('(d) a SIGKILL parent crash leaves neither inference nor its descendant orphaned', { timeout: 7000 }, async (t) => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'speech-crash-pids-')), 'pids.json');
  const parent = spawn(process.execPath, [parentFixture, fake, pidFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  parent.stdout.resume(); parent.stderr.resume();
  t.after(() => { if (alive(parent.pid)) parent.kill('SIGKILL'); });
  await eventually(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile));
  assert.ok(alive(pids.pid)); assert.ok(alive(pids.descendant));
  const closed = once(parent, 'close'); parent.kill('SIGKILL'); await closed;
  await eventually(() => !alive(pids.pid) && !alive(pids.descendant));
  await eventually(() => !alive(pids.supervisor));
  assert.equal(existsSync(pids.audioPath), false);
});

it('pre-abort, wrong model and malformed audio never spawn a whisper child', async (t) => {
  const { client, journal } = host(t, true);
  const pidFile = join(mkdtempSync(join(tmpdir(), 'speech-no-child-')), 'pids.json');
  const adapter = new WhisperCppSpeechToText(options(client, 'stall', pidFile));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(adapter.transcribe(sttRequest(abort.signal)), { name: 'AbortError' });
  await assert.rejects(adapter.transcribe({ ...sttRequest(), model: 'unknown' }));
  await assert.rejects(adapter.transcribe({ ...sttRequest(), bytes: Buffer.from('bad') }));
  assert.equal(existsSync(pidFile), false); assert.deepEqual(events(journal), []);
  assert.throws(() => new WhisperCppSpeechToText({ ...options(client), command: 'relative' }));
  assert.throws(() => new WhisperCppSpeechToText({ ...options(client), maxMicro: 1 }));
});

it('child timeout is bounded, kills the group and settles unknown', { timeout: 7000 }, async (t) => {
  const { client, journal } = host(t, true);
  const pidFile = join(mkdtempSync(join(tmpdir(), 'speech-timeout-pids-')), 'pids.json');
  const adapter = new WhisperCppSpeechToText({ ...options(client, 'stall', pidFile), limits: { maxDurationMs: 2000 } });
  await assert.rejects(adapter.transcribe(sttRequest()), (error) => error.reason === 'timeout');
  await eventually(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile)); await eventually(() => !alive(pids.pid) && !alive(pids.descendant));
  assert.equal(events(journal).at(-1).data.outcome, 'unknown');
});

it('early child iterator return terminates the process group and settles unknown', { timeout: 5000 }, async (t) => {
  const { client, journal } = host(t, true);
  const pidFile = join(mkdtempSync(join(tmpdir(), 'speech-return-pids-')), 'pids.json');
  const iterator = new WhisperCppSpeechToText(options(client, 'stall', pidFile)).streamTranscribe(sttRequest());
  assert.equal((await iterator.next()).value, 'Synthetische Sprache');
  await eventually(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile));
  await iterator.return();
  await eventually(() => !alive(pids.pid) && !alive(pids.descendant) && !alive(pids.supervisor));
  assert.equal(existsSync(pids.audioPath), false);
  assert.equal(events(journal).at(-1).data.outcome, 'unknown');
});
