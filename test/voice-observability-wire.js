import { SQLiteStorage } from '../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../packages/server/src/voice-turns.js';
import { createCompletionsHandler } from '../plugins/elevenlabs/src/facade.js';
import { beginInvocation, PluginError } from '../packages/core/src/invocation.js';
import { normalizeVoiceWire, VOICE_WIRE_EPOCH } from './voice-wire-fixtures.js';
import { voiceOperation } from '../packages/core/src/live-voice.js';

// AIT-102's v1 request/response format. This harness reads an independent oracle;
// it never regenerates expected bytes from the adapter being tested.
export async function replayObservabilityCallbacks(fixture, log) {
  const now = () => VOICE_WIRE_EPOCH + 10_000;
  const storage = new SQLiteStorage(), session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now, log });
  const call = { callId: 'call_observability', providerSessionId: 'conv_observability', facadeSecretRef: 'fixture-observability-ref',
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  let admissions = 0, release;
  const handler = createCompletionsHandler({ now, log, getCall: () => call, resolveSecret: () => 'fixture-observability-value',
    buildRequest: ({ messages }) => ({ system: 'Private synthetic canonical prompt', locale: 'de', messages }),
    turnOperations: { run: (context, execute, options) => turns.run({ ...context, sessionId: session.id }, execute, options) },
    admitReasoning({ request, options, beforeAdmission }) {
      beforeAdmission();
      const attemptId = `fixture-attempt-${++admissions}`;
      return { request, producer: { plugin: 'fixture', model: 'fixture-model' },
        options: { ...options, attempt: { attemptId, claimId: `fixture-claim-${admissions}`, consume() {} }, report() {} }, finish() {},
        plugin: { async *stream(input, opts) {
          const invocation = await beginInvocation(opts); let completed = false;
          try {
            invocation.dispatch();
            const partial = input.messages.at(-1).content === 'Private synthetic partial turn';
            yield partial ? 'Teilantwort. ' : 'Welche Farbe? ';
            await release.promise;
            if (partial) throw new PluginError('provider', 'Private synthetic failure https://error.example.test');
            yield 'Blau.'; invocation.usage({ inputTokens: 8, outputTokens: 4 }); completed = true;
          } finally { await invocation.finish(completed); }
        } } };
    } });
  const callbacks = [];
  try {
    for (const record of fixture.callbacks) {
      release = Promise.withResolvers();
      const response = await handler(new Request(record.request.url, record.request));
      const reader = response.body.getReader(), decoder = new TextDecoder(); let body = '';
      try {
        for (;;) {
          const item = await voiceOperation({ deadlineAt: Date.now() + 5000 }, () => reader.read());
          if (item.done) { body += decoder.decode(); break; }
          body += decoder.decode(item.value, { stream: true });
          if (body.includes('"delta":{"content":')) release.resolve();
        }
      } finally { release.resolve(); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      callbacks.push({ ...record, response: { status: response.status, headers: Object.fromEntries(response.headers), body: normalizeVoiceWire(body) } });
    }
    await turns.idle();
    turns.observeClosure({ sessionId: session.id, ...call, endedAt: now() }, { closureConfirmed: true, usage: { costEstimated: false } });
    return { ...fixture, callbacks, admissions };
  } finally { release?.resolve(); await turns.idle(); storage.close(); }
}
