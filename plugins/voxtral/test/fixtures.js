import assert from 'node:assert/strict';
import * as server from '../src/server.js';
import { componentManifest } from '../src/manifest.js';
import { publicReasoningManifest } from '@inspr/aithema-core';

export const at = Date.parse('2026-10-19T12:00:00Z');
export const origin = 'https://api.eu.mistral.ai';
export const urls = { stt: 'wss://api.eu.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602',
  reasoning: `${origin}/v1/chat/completions`, tts: `${origin}/v1/audio/speech` };
export function fixture() {
  const config = { endpoint: origin, secretRef: 'private:synthetic/key', voiceId: 'fixture-voice', accountRef: 'private:synthetic/account',
    accountEvidence: { accountRef: 'private:synthetic/account', secretRef: 'private:synthetic/key', endpoint: origin,
      dpaAccepted: true, dpaRef: 'private:synthetic/dpa', recipient: 'Synthetic Mistral EU entity', recipientCountries: ['FR'],
      undertaking: { region: 'EU', processingCountries: ['FR', 'DE'], controlPlaneIncluded: true },
      zdrEnabled: true, zdrRef: 'private:synthetic/zdr', zdrEndpoints: Object.values(urls),
      trainingOptOut: true, trainingRef: 'private:synthetic/no-training', availabilityRef: 'private:synthetic/availability',
      reviewedAt: '2026-10-19', expiresAt: '2026-10-20', services: {
        stt: { model: 'voxtral-mini-transcribe-realtime-2602', endpoint: urls.stt },
        reasoning: { model: 'mistral-synthetic', endpoint: urls.reasoning },
        tts: { model: 'voxtral-mini-tts-2603', endpoint: urls.tts } } } };
  function binding(plugin, model, endpoint = origin) {
    return { plugin, model, endpoint, maxMicro: 0, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, accountRef: config.accountRef, secretRef: config.secretRef, effort: 'none',
      legal: { approved: true, purpose: 'voice-mistral', consentVersion: 1, recipient: config.accountEvidence.recipient,
        countries: ['FR'], processingCountries: ['FR', 'DE'], processors: [], training: false, retention: 'synthetic ZDR',
        dataCategories: ['speech-input', 'transcripts', 'answer-text', 'connection-data'], evidence: {
          qualified: true, accountRef: config.accountRef, secretRef: config.secretRef, model, endpoint,
          routing: {}, verifiedAt: at - 1000, expiresAt: at + 60000, dpaRef: config.accountEvidence.dpaRef } } };
  }
  const componentBindings = { stt: binding('voxtral', config.accountEvidence.services.stt.model),
    reasoning: binding('mistral', 'mistral-synthetic'), tts: binding('voxtral', config.accountEvidence.services.tts.model) };
  const plugins = { stt: { manifest: componentManifest }, tts: { manifest: componentManifest },
    reasoning: { manifest: publicReasoningManifest('mistral', 'Mistral', origin) } };
  const hostBinding = binding('synthetic-host', 'host-process', 'https://host.test');
  const hostProcessing = [{ binding: hostBinding, plugin: { manifest: { id: 'synthetic-host', placement: 'server',
    models: [{ id: 'host-process', efforts: ['none'], operations: ['process'] }] } }, operation: 'process' }];
  let clock = at, session = { id: 'session', consentRevision: 1, processingPreset: 'eu' };
  const covered = [];
  const consent = { async coverage({ scope, consentRevision }) { covered.push(scope); return {
    ...scope, scope, covered: true, consentRevision, checkedAt: clock, expiresAt: clock + 10000 }; } };
  const args = { config, componentBindings, plugins, hostProcessing, consent, now: () => clock, getSession: () => session };
  const request = { session, reasoningBinding: componentBindings.reasoning, preset: 'eu', policy: { endpoints: [origin, 'https://host.test'] } };
  const create = () => { assert.equal(typeof server.createVoxtralProviderAuthority, 'function'); return server.createVoxtralProviderAuthority(args); };
  return { config, componentBindings, plugins, hostProcessing, consent, covered, args, request, create,
    setClock: value => { clock = value; }, setSession: value => { session = value; } };
}
