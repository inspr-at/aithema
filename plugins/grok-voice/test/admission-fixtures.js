import assert from 'node:assert/strict';
import * as server from '../src/server.js';
import { config } from './fixtures.js';

export function binding(model = 'grok-voice') {
  const at = Date.now();
  return { plugin: 'grok-voice', model, endpoint: 'https://api.x.ai', effort: 'none',
    secretRef: config.secretRef, accountRef: config.accountRef, maxMicro: 0, maxTokens: 1,
    rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 900,
    upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0, adapterConfig: {},
    legal: { approved: true, purpose: 'voice-xai', consentVersion: 1, recipient: 'SpaceXAI LLC', processors: [],
      countries: ['US'], training: false, retention: 'private account ZDR',
      dataCategories: ['speech-input', 'transcripts', 'answer-text', 'connection-data'],
      evidence: { qualified: true, accountRef: config.accountRef, secretRef: config.secretRef, model,
        endpoint: 'https://api.x.ai', routing: {}, verifiedAt: at - 1000, expiresAt: at + 60000 } } };
}
export function provider(overrides = {}) {
  assert.equal(typeof server.createGrokVoiceProvider, 'function');
  return server.createGrokVoiceProvider({ enabled: true, config, binding: binding(),
    componentBindings: { stt: binding('grok-voice-transcribe-2.0'), tts: binding('grok-voice-tts') },
    resolveSecret: () => 'synthetic-only', connect() { assert.fail('No outbound transport expected'); },
    storage: { saveVoiceCall() {}, authorize() {} }, consent: { async coverage({ scope, consentRevision }) {
      return { ...scope, scope, covered: true, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60000 };
    } }, admitComponent() {}, ...overrides });
}
