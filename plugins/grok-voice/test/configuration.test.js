import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGrokConfiguration } from '../src/configuration.js';
import { createGrokSTT, createGrokBatchSTT } from '../src/stt.js';
import { config } from './fixtures.js';

const invalid = [
  { model: 'native-speech-to-speech' }, { sttFormat: { encoding: 'mp3', sampleRateHz: 16000, channels: 1 } },
  { sttFormat: { encoding: 'pcm_s16le', sampleRateHz: 12345, channels: 1 } },
  { ttsFormat: { encoding: 'pcm_f32le', sampleRateHz: 24000, channels: 1 } }, { voice: 'unknown' },
  { languages: ['xx'] }, { languages: ['en', 'en'] }, { languages: [] },
  { streamingMicroPerHour: -1 }, { restMicroPerHour: NaN }, { ttsMicroPerMillionCharacters: Infinity },
  { streamingMicroPerHour: 0 }, { maxInputBytes: 0 }, { maxInputChunkBytes: 64001 },
  { maxTranscriptCharacters: 32769 }, { endpointingMs: 5001 }, { speed: 1.6 },
  { secretRef: 'a literal secret is not a binding reference' }, { accountRef: '' },
  { accountEvidence: {} }, { accountEvidence: { ...config.accountEvidence, zdrEnabled: false } },
  { accountEvidence: { ...config.accountEvidence, dpaAccepted: false } },
  ...['zdrRef', 'dpaRef', 'retentionRef', 'transferRef', 'approvalRef', 'contractRef'].map(key => ({ accountEvidence: { ...config.accountEvidence, [key]: '' } })),
  { accountEvidence: { ...config.accountEvidence, processing: 'US-only' } },
  { accountEvidence: { ...config.accountEvidence, expiresAt: '2020-01-01' } },
  { accountEvidence: { ...config.accountEvidence, reviewedAt: '2026-02-30' } },
];
for (const [index, override] of invalid.entries()) test(`invalid private configuration ${index} rejects before secrets or transport`, () => {
  let secrets = 0, transports = 0;
  const ports = { config: { ...config, ...override }, enabled: true,
    resolveSecret() { secrets++; throw new Error('must not resolve'); },
    connect() { transports++; throw new Error('must not connect'); }, fetchImpl() { transports++; throw new Error('must not fetch'); } };
  assert.throws(() => validateGrokConfiguration(ports.config), TypeError);
  for (const factory of [createGrokSTT, createGrokBatchSTT]) assert.throws(() => factory(ports), TypeError);
  assert.equal(secrets, 0); assert.equal(transports, 0);
});
test('configuration snapshots private evidence and exposes conservative defaults', () => {
  const input = structuredClone(config), selected = validateGrokConfiguration(input);
  input.accountEvidence.zdrEnabled = false;
  assert.equal(selected.accountEvidence.zdrEnabled, true);
  assert.ok(Object.isFrozen(selected.accountEvidence));
  assert.deepEqual(selected.languages, ['de', 'en']);
  assert.equal(selected.streamingMicroPerHour, 200000); assert.equal(selected.restMicroPerHour, 100000);
  assert.equal(selected.ttsMicroPerMillionCharacters, 15000000);
});
