import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { replayObservabilityCallbacks } from '../../../test/voice-observability-wire.js';
import { readConversationDetails, reconcileUsage } from '../src/server.js';

const load = name => readFile(new URL(`../../../test/fixtures/${name}.json`, import.meta.url), 'utf8');

test('AIT-139: independent v1 callback fixtures replay growth, truncation, retry and partial streams offline', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline replay must never access a provider'));
  const bytes = await load('voice-observability-callbacks'), fixture = JSON.parse(bytes), logs = [];
  assert.equal(fixture.format, 'aithema-voice-wire'); assert.equal(fixture.version, 1);
  const observed = await replayObservabilityCallbacks(fixture, record => logs.push(typeof record === 'string' ? JSON.parse(record) : record));
  assert.deepEqual(observed, fixture);
  assert.equal(JSON.stringify(observed, null, 2) + '\n', bytes, 'Preserve all independently authored wire bytes');
  const turns = logs.filter(row => row.event.startsWith('voice.turn.'));
  assert.equal(turns.filter(row => row.event === 'voice.turn.admission').length, 4);
  assert.equal(turns.filter(row => row.event === 'voice.turn.first-token').length, 4);
  assert.equal(turns.filter(row => row.event === 'voice.turn.completion').length, 4);
  assert.equal(turns.filter(row => row.event === 'voice.turn.closure').length, 4);
  const fields = new Set(['event', 'callHash', 'turnHash', 'generationHash', 'attemptHash', 'admissionMs', 'firstTokenMs', 'totalMs',
    'outcome', 'cause', 'closureConfirmed', 'costEstimated', 'reconciliationAgeMs',
    'time', 'level', 'status', 'latencyMs', 'requestBytes', 'responseBytes', 'errorCode', 'callIdHash']);
  for (const row of logs) for (const key of Object.keys(row)) assert.ok(fields.has(key), key);
  assert.doesNotMatch(JSON.stringify(logs), /Private|fixture-person@|https?:|Bearer|authorization|headers|prompt|speech/iu);
});

test('AIT-139: independent delayed closure and usage fixtures replay through an injected wire port', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline replay must never access a provider'));
  const fixture = JSON.parse(await load('voice-observability-reconciliation'));
  const binding = { apiBaseUrl: 'https://api.example.test', secretRef: 'fixture-ref', upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300 };
  for (const record of fixture.reconciliation) {
    let requests = 0;
    const details = await readConversationDetails(binding, record.call.providerSessionId, { deadlineAt: Date.now() + 1000 }, {
      resolveSecret: () => 'fixture-observability-value', fetchImpl: async (url, options) => {
        requests++; assert.deepEqual({ method: 'GET', url, headers: options.headers, redirect: options.redirect }, record.request);
        return new Response(record.response.body, { status: record.response.status });
      } });
    assert.equal(requests, 1);
    assert.deepEqual(reconcileUsage({ call: record.call, details, binding, maxMicro: 1000 }), record.terminal, record.name);
  }
});

test('AIT-139: the original ElevenLabs baseline remains byte-identical', async () => {
  const bytes = await load('elevenlabs-wire');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '6c5dd15cf80f6824b7ca64a99440485a839ae60b609169639dba25ae8dd32955');
});
