import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchQualificationHost, createQualificationHost } from '../ops/qualification-live-host.mjs';
import { fixtureBinding } from '../../elevenlabs/test/component-fixtures.js';

const binding = () => ({
  stt: { ...fixtureBinding('stt'), secretRef: 'ELEVENLABS_API_KEY', microPerSecond: 10 },
  tts: { ...fixtureBinding('tts'), secretRef: 'ELEVENLABS_API_KEY', voiceId: 'fixture-voice', microPerCharacter: 2 },
  reasoning: { plugin: 'openrouter', model: 'anthropic/fixture', effort: 'none',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions', accountRef: 'fixture-account', secretRef: 'OPENROUTER_API_KEY',
    maxMicro: 100000, maxTokens: 128, maxInputTokens: 4096, rates: { inputMicro: 1, outputMicro: 2 },
    legal: { purpose: 'models-international', consentVersion: 1, recipient: 'OpenRouter, Inc.', processors: ['Anthropic'], dataCategories: ['messages'] } },
  baseline: { ...fixtureBinding('stt'), model: 'agent_fixture', agentId: 'agent_fixture', secretRef: 'ELEVENLABS_API_KEY', microPerMinute: 1000 },
  maxDurationSeconds: 60, reasoningAttempts: 2,
});
const decision = { contract: 'synthetic-contract', items: ['voice-elevenlabs', 'models-international'] };

test('launcher passes file paths and explicit loopback flags, then uses normal visitor cookie and consent APIs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-host-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let launched;
  const host = await launchQualificationHost({ binding: binding(), hostOrigin: 'http://127.0.0.1:4567',
    keysFile: '/unopened/provider.keys', controlFile: '/unopened/control.json', runDirectory: directory, consentDecision: decision,
    forkImpl(file, args, options) {
      launched = { file, args, options };
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
      queueMicrotask(() => child.emit('message', { url: 'http://127.0.0.1:4567' })); return child;
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/api/sessions')) return Response.json({ id: 'fixture-session' }, { status: 201, headers: { 'set-cookie': 'aithema-visitor=fixture-owner; HttpOnly' } });
      if (options.method !== 'POST') return Response.json({ contract: decision.contract });
      return Response.json({ granted: true });
    },
  });
  assert.deepEqual(host.ownerHeaders, { cookie: 'aithema-visitor=fixture-owner' });
  assert.equal(host.sessionId, 'fixture-session');
  const values = launched.options.env;
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
  await host.close(); await host.close();
  await assert.rejects(readFile(values.AITHEMA_COMPOSED_BINDING_FILE), { code: 'ENOENT' });
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
