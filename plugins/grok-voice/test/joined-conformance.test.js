import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveVoiceConformance } from '@inspr/aithema-core';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { createComposedBrowserMedia } from '@inspr/aithema-server/composed-voice/client';
import { createComposedComponentAccounting } from '@inspr/aithema-server/composed-voice/accounting';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { SQLiteBudgetLedger } from '../../../packages/server/src/budget.js';
import { createGrokSTT, createGrokTTS } from '../src/components.js';
import { manifest } from '../src/manifest.js';
import { binding } from './admission-fixtures.js';
import { config, harness } from './fixtures.js';
import { ttsHarness } from './tts-fixtures.js';

for (const locale of ['de', 'en']) test(`AIT-349: ${locale} joined public session offline kit, zero parent and observed child costs`, async t => {
  const storage = new SQLiteStorage(), record = storage.create({ locale }), budget = new SQLiteBudgetLedger(storage);
  const accounting = createComposedComponentAccounting({ storage, budget }), sttWire = harness(), ttsWire = ttsHarness();
  const stt = createGrokSTT({ enabled: true, config, resolveSecret: () => 'synthetic-only', connect: sttWire.connect });
  const tts = createGrokTTS({ enabled: true, config, resolveSecret: () => 'synthetic-only', connect: ttsWire.connect });
  const answer = locale === 'de' ? 'Die vollständige Antwort bleibt erhalten.' : 'The complete reply remains in the transcript.';
  let starts = 0, segment, inputOn = true, captureStops = 0, stops = 0, plays = 0, replyNo = 0;
  const liveManifest = { ...manifest, kinds: ['live-voice'], models: manifest.models.filter(m => m.operations.includes('start')) };
  const server = createComposedVoice({ enabled: true, storage, stt, tts, manifest: liveManifest, authorize: () => true,
    binding: binding(),
    admitComponent: request => accounting.admit({ ...request, binding: binding(request.role === 'stt' ? 'grok-voice-transcribe-2.0' : 'grok-voice-tts'), maxMicro: 100000 }),
    commitUtterance(envelope, options = {}) {
      const { callId, providerSessionId, callbackBody } = envelope.payload, role = options.role ?? 'user';
      return storage.postVoiceEvent(record.id, callId, providerSessionId, { callId, providerSessionId,
        turnId: `${providerSessionId}:${role === 'user' ? callbackBody.metadata.utteranceId : options.replyId}`,
        ...(role === 'interrupted' ? { type: 'interrupted', heardLength: 'unknown' }
          : { type: 'final', role, text: role === 'user' ? callbackBody.messages.at(-1).content : options.text }) });
    },
    replyExecutor: { async *execute(envelope) {
      const replyId = `reply-${++replyNo}`;
      yield { type: 'operation', replyId }; yield { type: 'delta', text: answer };
      // The host authority normally persists the generated final before playback.
      storage.postVoiceEvent(record.id, envelope.payload.callId, envelope.payload.providerSessionId, { type: 'final', role: 'assistant',
        callId: envelope.payload.callId, providerSessionId: envelope.payload.providerSessionId,
        turnId: `${envelope.payload.providerSessionId}:${replyId}`, text: answer });
      yield { type: 'completion', replyId, text: answer };
    } } });
  const media = createComposedBrowserMedia({ openRelay: grant => server.connectRelay(grant),
    capture: async () => { inputOn = true; return { stop() { inputOn = false; captureStops++; } }; },
    player: { play() { plays++; }, stop() { stops++; } } });
  const plugin = { manifest: liveManifest, health: server.health, async start(request, options) {
    const admission = budget.admit({ attemptId: options.attempt.attemptId, sessionId: record.id, lane: 'voice', maxMicro: 0,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = budget.claim(admission.attemptId);
    segment = await server.start({ ...request, sessionId: record.id }, { ...options,
      attempt: { ...options.attempt, async consume() { await options.attempt.consume(); claim.consume(); } },
      report(terminal) { budget.settleVoice(claim.claimId, terminal); return options.report(terminal); } }); starts++;
    return media.connect(segment.grant, options);
  } };
  t.after(async () => { await segment?.close(); storage.close(); });
  const persistedEvents = () => storage.read(record.id).filter(e => e.type === 'turn.final').map(e => {
    const turn = e.data;
    return { type: 'final', role: turn.role, turnId: turn.role === 'assistant' ? turn.id.slice(turn.providerSessionId.length + 1)
      : turn.id.slice(turn.providerSessionId.length + 1), text: turn.content, callId: turn.callId,
      providerSessionId: turn.providerSessionId, generation: 1, epoch: 0 };
  });
  const result = await liveVoiceConformance(plugin, { callId: `joined-${locale}` }, { parentMaxMicro: 0, timeoutMs: 2000,
    requestCount: () => starts, persistedEvents,
    providerOpen: () => segment?.state.state !== 'ended' || sttWire.fixtures.activeCount() + ttsWire.fixtures.activeCount() !== 0,
    async probe(command, session, { phase, before } = {}) {
      if (phase === 'before') return { stops, captureStops, context: segment.snapshot().context, played: plays };
      if (command === 'sendText') await segment.idle();
      const applied = command === 'sendText' ? storage.get(record.id).transcript.some(t => t.content === 'typed fixture') && plays > before.played
        : command === 'updateContext' ? segment.snapshot().context.focus === 'fixture'
        : command === 'setInput' ? !inputOn && captureStops > before.captureStops
        : command === 'setOutput' || command === 'interrupt' ? stops > before.stops
        : segment.state.holds.length > 0 === (command === 'pause');
      return { capability: liveManifest.liveVoice.capabilities[command], applied };
    },
    async drive(session, stimulus) {
      if (stimulus) return;
      await session.setOutput(true);
      await session.sendText(locale === 'de' ? 'Bitte weiter.' : 'Please continue.', { deliveryId: `drive-${locale}` });
      await segment.idle();
      return ['typed fixture', locale === 'de' ? 'Bitte weiter.' : 'Please continue.'].flatMap((text, i) => [
        { type: 'final', role: 'user', turnId: storage.get(record.id).transcript.filter(t => t.role === 'user')[i].id.slice(session.providerSessionId.length + 1), text,
          callId: session.callId, providerSessionId: session.providerSessionId, generation: 1, epoch: 0 },
        { type: 'final', role: 'assistant', turnId: `reply-${i + 1}`, text: answer,
          callId: session.callId, providerSessionId: session.providerSessionId, generation: 1, epoch: 0 },
      ]);
    } });
  t.diagnostic(JSON.stringify({ locale, ...result }));
  assert.deepEqual(result, { ok: true, failures: [] });
  const children = storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='tts'").all();
  assert.equal(children.length, 2); assert.ok(children.every(row => row.state === 'settled' && row.settled_micro > 0));
  assert.equal(budget.used(record.id), children.reduce((sum, row) => sum + row.settled_micro, 0));
  assert.equal(sttWire.fixtures.activeCount() + ttsWire.fixtures.activeCount(), 0);
  assert.ok(plays >= 2); assert.equal(manifest.models[0].qualification, 'unverified');
  assert.match(manifest.presentation.label, /not yet qualified in live use/u);
});
