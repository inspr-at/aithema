import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sttConformance, ttsConformance } from '@inspr/aithema-core';
import { createVoxtralSTT, createVoxtralTTS, STT_FORMAT as voxSTT, TTS_FORMAT as voxTTS } from '../plugins/voxtral/src/index.js';
import { createElevenLabsSTT, createElevenLabsTTS, STT_FORMAT as elSTT, TTS_FORMAT as elTTS } from '../plugins/elevenlabs/src/components.js';
import { fixtureSocket, fixtureConfig, fixtureConsent, fixtureBinding, sttWire, ttsWire } from '../plugins/elevenlabs/test/component-fixtures.js';

const text = 'A😀 B';
function local(provider, role) {
  let mode, requests = 0, active = 0;
  const stalled = () => new Promise(() => {});
  const stalledEvents = () => ({ [Symbol.asyncIterator]() { return this; }, next: stalled,
    async return() { return { done: true }; } });
  const connect = async () => {
    requests++; active++;
    let closed = false;
    const close = () => { if (!closed) { closed = true; active--; } };
    if (provider === 'elevenlabs') {
      const socket = fixtureSocket({ role, text, partials: ['wrong', text], onClose: close });
      const events = socket.events;
      socket.events = (async function* () {
        if (mode.startsWith('active-')) { await stalled(); return; }
        if (mode === 'provider-error') { yield JSON.stringify(role === 'stt' ? sttWire.rateLimited : { error: 'Synthetic error' }); return; }
        if (mode === 'overflow-total' && role === 'tts') {
          for (let n = 0; n < 16; n++) yield JSON.stringify({ ...ttsWire.audio, audio: 'AAAA'.repeat(349_524) });
          yield JSON.stringify(ttsWire.done); return;
        }
        if (mode === 'overflow') { yield JSON.stringify(role === 'stt' ? sttWire.session() : { ...ttsWire.audio, audio: 'AAAA'.repeat(400_000) });
          if (role === 'stt') yield JSON.stringify(sttWire.partial('x'.repeat(32_769))); return; }
        for await (const wire of events) {
          const value = JSON.parse(wire);
          if (mode === 'missing-final' && (value.message_type === 'committed_transcript' || value.isFinal)) return;
          yield wire;
        }
      })();
      if (mode.startsWith('active-')) socket.events = stalledEvents();
      return socket;
    }
    return { send() {}, close, events: mode.startsWith('active-') ? stalledEvents() : (async function* () {
      if (mode.startsWith('active-')) { await stalled(); return; }
      yield JSON.stringify({ type: 'session.created' });
      if (mode === 'provider-error') { yield JSON.stringify({ type: 'error', status: 429 }); return; }
      if (mode === 'overflow') { yield JSON.stringify({ type: 'transcription.text.delta', text: 'x'.repeat(32_769) }); return; }
      yield JSON.stringify({ type: 'transcription.text.delta', text: 'A' });
      yield JSON.stringify({ type: 'transcription.text.delta', text: '😀 B' });
      if (mode !== 'missing-final') yield JSON.stringify({ type: 'transcription.done', text });
    })() };
  };
  const fetchImpl = async () => {
    requests++; active++; let closed = false, index = 0;
    const close = () => { if (!closed) { closed = true; active--; } };
    const events = mode === 'overflow-total' ? [...Array(16).fill({ type: 'speech.audio.delta', audio_data: 'AAAA'.repeat(349_524) }), { type: 'speech.audio.done', usage: {} }]
      : mode === 'provider-error' ? [{ type: 'error', status: 429 }]
      : mode === 'overflow' ? [{ type: 'speech.audio.delta', audio_data: 'AAAA'.repeat(400_000) }]
      : [{ type: 'speech.audio.delta', audio_data: 'AAAAAA==' }, ...(mode === 'missing-final' ? [] : [{ type: 'speech.audio.done', usage: {} }])];
    return new Response(new ReadableStream({ pull(controller) {
      if (mode.startsWith('active-')) return stalled();
      if (index < events.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`));
      else { controller.close(); close(); }
    }, cancel: close }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const component = (provider === 'voxtral' ? role === 'stt' ? createVoxtralSTT : createVoxtralTTS
    : role === 'stt' ? createElevenLabsSTT : createElevenLabsTTS)({ enabled: true, config: fixtureConfig,
    consent: fixtureConsent(fixtureBinding(role)), resolveSecret: () => 'synthetic-only', connect, fetchImpl });
  return { component, fixtures: { formats: [provider === 'voxtral' ? role === 'stt' ? voxSTT : voxTTS : role === 'stt' ? elSTT : elTTS],
    incompatibleFormats: [[{ encoding: 'unsupported-fixture', sampleRateHz: 1, channels: 99 }]],
    prepare(value) { mode = value.mode; }, requestCount: () => requests, activeCount: () => active, observedMicro: () => 0,
    expectedText: text, expectedTranscripts: provider === 'voxtral'
      ? [{ text: 'A', final: false }, { text, final: false }, { text, final: true }]
      : [{ text: 'wrong', final: false }, { text, final: false }, { text, final: true }] } };
}

test('provider diagnostic timeout guard detects a stalled component', async () => {
  const { component, fixtures } = local('voxtral', 'stt');
  const transcribe = component.transcribe.bind(component);
  let first = true;
  const stalledComponent = { ...component, transcribe(...args) {
    if (first) { first = false; return new Promise(() => {}); }
    return transcribe(...args);
  } };
  const result = await sttConformance(stalledComponent, { audio: new Uint8Array(64000), language: 'en' }, fixtures);
  assert.ok(result.failures.some(failure => /conformance timeout/u.test(failure)), JSON.stringify(result));
});

// AIT-323: package component helpers must pass the kits using synthetic transports.
// This matrix runs in the existing CI unit job; no live provider qualification.
for (const provider of ['voxtral', 'elevenlabs']) for (const role of ['stt', 'tts']) {
  test(`${provider} ${role} helper offline conformance`, async t => {
    const { component, fixtures } = local(provider, role);
    const result = await (role === 'stt' ? sttConformance : ttsConformance)(component,
      role === 'stt' ? { audio: new Uint8Array(64000), language: 'en' } : { text, voice: 'fixture-voice' }, fixtures);
    t.diagnostic(JSON.stringify({ provider, role, ...result }));
    assert.deepEqual(result.failures, [], JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.ok(!result.failures.some(failure => /fixture preparation|conformance timeout/u.test(failure)), JSON.stringify(result));
  });
}

for (const provider of ['voxtral', 'elevenlabs']) for (const role of ['stt', 'tts']) {
  test(`${provider} ${role} declares conservative component capabilities and formats`, async () => {
    const { component, fixtures } = local(provider, role);
    assert.deepEqual(component.capabilities, role === 'stt'
      ? { streaming: true, languages: ['de', 'en'], partialTranscripts: true }
      : { streaming: true, languages: ['de', 'en'], heardPrefix: 'unavailable' });
    assert.equal(component.speakAligned, undefined);
    assert.deepEqual(await component.negotiateAudioFormat(fixtures.formats, {}), fixtures.formats[0]);
  });
}

for (const provider of ['voxtral', 'elevenlabs']) for (const reportRejected of [false, true]) {
  test(`${provider} TTS over-ceiling preflight settles undispatched${reportRejected ? ' and propagates report rejection' : ''}`, async () => {
    const { component, fixtures } = local(provider, 'tts');
    const reports = [], reportError = new Error('Synthetic preflight report rejection');
    let consumed = 0;
    const options = { attempt: { attemptId: 'preflight', claimId: 'preflight-claim', maxMicro: 1,
      consume() { consumed++; } }, report(terminal) {
      reports.push(terminal);
      if (reportRejected) throw reportError;
    } };
    await assert.rejects(async () => {
      for await (const chunk of component.speak({ text, voice: 'fixture-voice', format: fixtures.formats[0].encoding }, options)) {
        assert.fail(`Unexpected audio: ${chunk.byteLength}`);
      }
    }, reportRejected ? error => error === reportError : { code: 'not-admitted' });
    assert.equal(consumed, 1);
    assert.equal(fixtures.requestCount(), 0);
    assert.equal(fixtures.activeCount(), 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].attemptId, 'preflight');
    assert.equal(reports[0].outcome, 'cancelled');
    assert.equal(reports[0].chargedMicro, 0);
    assert.deepEqual(reports[0].usage, { attemptId: 'preflight', role: 'tts', unit: 'characters',
      quantity: 0, upstreamMicro: 0, source: 'undispatched', estimated: false });
  });
}
