import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchQualificationHost, createQualificationHost } from '../ops/qualification-live-host.mjs';
import { fixtureBinding, fixtureVoiceSettings } from '../../elevenlabs/test/component-fixtures.js';

const binding = () => ({
  stt: { ...fixtureBinding('stt'), secretRef: 'ELEVENLABS_API_KEY', microPerSecond: 10 },
  tts: { ...fixtureBinding('tts'), secretRef: 'ELEVENLABS_API_KEY', voiceId: 'fixture-voice', microPerCharacter: 2, voiceSettings: fixtureVoiceSettings },
  reasoning: { plugin: 'openrouter', model: 'anthropic/fixture', effort: 'none',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions', accountRef: 'fixture-account', secretRef: 'OPENROUTER_API_KEY',
    maxMicro: 100000, maxTokens: 128, maxInputTokens: 32768, rates: { inputMicro: 1, outputMicro: 2 },
    legal: { purpose: 'models-international', consentVersion: 1, recipient: 'OpenRouter, Inc.', processors: ['Anthropic'], dataCategories: ['messages'] } },
  baseline: { ...fixtureBinding('stt'), model: 'agent_fixture', agentId: 'agent_fixture', secretRef: 'ELEVENLABS_API_KEY', microPerMinute: 1000, tts: { model: 'eleven_turbo_v2', voiceId: 'fixture-voice', voiceSettings: fixtureVoiceSettings } },
  baselineOrigin: 'https://start2.example', baselineReasoningCeilingMicro: 23, maxDurationSeconds: 60, reasoningAttempts: 2,
});
const decision = { contract: 'synthetic-contract', items: ['voice-elevenlabs', 'models-international'] };

test('launcher supports a deep run directory with a private short socket and normal visitor APIs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-host-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, 'deep-run-'.repeat(20));
  const socketRoot = await mkdtemp('/tmp/aq-test-'); t.after(() => rm(socketRoot, { recursive: true, force: true }));
  const calls = []; let launched;
  const host = await launchQualificationHost({ binding: binding(), hostOrigin: 'http://127.0.0.1:4567',
    keysFile: '/unopened/provider.keys', controlFile: '/unopened/control.json', runDirectory, consentDecision: decision, tmpdirImpl: () => socketRoot,
    forkImpl(file, args, options) {
      launched = { file, args, options };
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
      queueMicrotask(() => child.emit('message', { url: 'http://127.0.0.1:4567' })); return child;
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/api/sessions')) {
        const index = calls.filter(call => call.url.endsWith('/api/sessions')).length;
        return Response.json({ id: index === 1 ? 'fixture-session' : `fixture-session-${index}` }, { status: 201, headers: { 'set-cookie': 'aithema-visitor=fixture-owner; HttpOnly' } });
      }
      if (options.method !== 'POST') return Response.json({ contract: decision.contract });
      return Response.json({ granted: true });
    },
  });
  assert.deepEqual(host.ownerHeaders, { cookie: 'aithema-visitor=fixture-owner' });
  assert.equal(host.sessionId, 'fixture-session');
  const values = launched.options.env;
  t.after(() => host.close());
  const socketDirectory = dirname(values.AITHEMA_ADMIN_SOCKET);
  assert.equal(dirname(socketDirectory), socketRoot);
  assert.ok(Buffer.byteLength(values.AITHEMA_ADMIN_SOCKET) < (process.platform === 'darwin' ? 104 : 108));
  assert.equal((await stat(socketDirectory)).mode & 0o777, 0o700);
  assert.ok(values.AITHEMA_DB.startsWith(runDirectory + '/'));
  assert.ok(values.AITHEMA_COMPOSED_BINDING_FILE.startsWith(runDirectory + '/'));
  // Simulate the host's socket artifact, which shutdown must remove too.
  await writeFile(values.AITHEMA_ADMIN_SOCKET, 'fixture');
  assert.equal(values.AITHEMA_COMPOSED_QUALIFICATION, '1'); assert.equal(values.AITHEMA_LISTEN_HOST, '127.0.0.1');
  assert.equal(values.AITHEMA_COMPOSED_KEYS_FILE, '/unopened/provider.keys');
  assert.equal(values.AITHEMA_COMPOSED_CONTROL_FILE, '/unopened/control.json');
  assert.match(values.AITHEMA_COMPOSED_QUALIFICATION_MODULE, /qualification-live-server.mjs$/);
  assert.equal(values.ELEVENLABS_API_KEY, undefined); assert.equal(values.OPENROUTER_API_KEY, undefined);
  assert.equal(values.AITHEMA_VOICE_MODE, 'off', 'avoid production agent provisioning during host startup');
  assert.deepEqual(JSON.parse(await readFile(values.AITHEMA_COMPOSED_BINDING_FILE, 'utf8')), binding());
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].options.body), { granted: true, processing: decision });
  assert.equal(calls[2].options.headers.cookie, host.ownerHeaders.cookie);
  assert.equal(await host.prepareCandidateSession(), 'fixture-session');
  assert.equal(calls.length, 3, 'first sample uses the newly created empty session');
  assert.equal(await host.prepareCandidateSession(), 'fixture-session-2');
  assert.equal(calls.length, 6, 'later samples get fresh canonical history and the same explicit consent decision');
  assert.equal(calls[3].options.headers.cookie, host.ownerHeaders.cookie);
  assert.deepEqual(JSON.parse(calls[5].options.body), { granted: true, processing: decision });
  await host.close(); await host.close();
  await assert.rejects(readFile(values.AITHEMA_COMPOSED_BINDING_FILE), { code: 'ENOENT' });
  await assert.rejects(stat(socketDirectory), { code: 'ENOENT' });
  assert.ok((await stat(dirname(values.AITHEMA_DB))).isDirectory(), 'retain evidence directory');
});

test('launcher refuses accounting omissions, malformed binding and missing explicit consent before spawning', async () => {
  await assert.rejects(createQualificationHost(), /verifyCeiling/);
  let forks = 0;
  const base = { binding: binding(), hostOrigin: 'http://127.0.0.1:4567', keysFile: '/unopened/provider.keys',
    controlFile: '/unopened/control.json', forkImpl() { forks++; assert.fail(); } };
  await assert.rejects(launchQualificationHost(base), /operator consent decision/);
  await assert.rejects(launchQualificationHost({ ...base, binding: undefined }), /binding/);
  await assert.rejects(launchQualificationHost({ ...base, consentDecision: decision, hostOrigin: 'https://example.test' }), /loopback/);
  assert.equal(forks, 0);
});


test('launcher refuses an over-long OS tmpdir before spawning and cleans its private directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-path-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Multibyte path also guards against checking JS character count instead of bytes.
  const socketRoot = join(directory, 'é'.repeat(60));
  await mkdir(socketRoot);
  const runDirectory = join(directory, 'runs');
  let forks = 0;
  await assert.rejects(launchQualificationHost({ binding: binding(), hostOrigin: 'http://127.0.0.1:4567',
    keysFile: '/unopened/provider.keys', controlFile: '/unopened/control.json', runDirectory,
    consentDecision: decision, tmpdirImpl: () => socketRoot,
    forkImpl() { forks++; assert.fail('must refuse before host startup'); },
  }), /Qualification admin socket path is too long: requires \d+ bytes including NUL; (darwin|linux) limit is (104|108).*shorter OS temporary directory/);
  assert.equal(forks, 0);
  assert.deepEqual(await readdir(socketRoot), []);
  const [generated] = await readdir(runDirectory);
  assert.deepEqual(await readdir(join(runDirectory, generated)), []);
});

for (const failure of ['fork', 'startup', 'visitor']) {
  test(`launcher cleans socket and binding after ${failure} failure`, async t => {
    const directory = await mkdtemp('/tmp/aq-fail-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const socketRoot = join(directory, 'tmp'), runDirectory = join(directory, 'runs');
    await mkdir(socketRoot);
    let values, killed = false;
    await assert.rejects(launchQualificationHost({ binding: binding(), hostOrigin: 'http://127.0.0.1:4567',
      keysFile: '/unopened/provider.keys', controlFile: '/unopened/control.json', runDirectory,
      consentDecision: decision, tmpdirImpl: () => socketRoot,
      forkImpl(file, args, options) {
        values = options.env;
        if (failure === 'fork') throw new Error('synthetic spawn failure');
        const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
        child.kill = () => { killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
        queueMicrotask(() => {
          if (failure === 'startup') { child.exitCode = 1; child.emit('exit', 1); }
          else child.emit('message', { url: 'http://127.0.0.1:4567' });
        });
        return child;
      },
      async fetchImpl() { throw new Error('synthetic visitor failure'); },
    }), /Qualification host setup refused/);
    assert.deepEqual(await readdir(socketRoot), []);
    await assert.rejects(readFile(values.AITHEMA_COMPOSED_BINDING_FILE), { code: 'ENOENT' });
    assert.equal(killed, failure === 'visitor');
  });
}
