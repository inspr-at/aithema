import { randomUUID } from 'node:crypto';
import { SQLiteStorage } from '../../packages/server/src/storage.js';
import { createVoiceReplyExecutor, createVoiceTurnOperations } from '../../packages/server/src/voice-turns.js';
import { createComposedVoice } from '../../plugins/composed-voice/src/server.js';
import { fixtureVoiceSettings } from '../../plugins/elevenlabs/test/component-fixtures.js';

// Fake pair, actual coordinator and Rule C operation store. Never contacts a
// provider. Neither corpus reference nor WAV content supplies the transcript.
export async function createQualificationServer({ relayOrigin, authenticateRelay }) {
  let current;
  const dispatches = [];
  return {
    networkRelay: {
      handle: request => current?.factory.networkRelay.handle(request) ?? new Response(null, { status: 403 }),
      close: () => current?.factory.networkRelay.close(),
    },
    async createSample({ lane, runId, owner, admit }) {
      if (owner !== 'fixture-owner') throw new Error('Fixture owner required');
      const storage = new SQLiteStorage(), session = storage.create({ ownerToken: owner });
      const turns = createVoiceTurnOperations({ storage }), answer = Promise.withResolvers();
      answer.promise.catch(() => {});
      let hypothesis, sequence = 0;
      const specification = (role, request, retryOf) => ({ attemptId: `${runId}-${lane}-${role}-${++sequence}`, lane,
        role, provider: 'fixture', model: 'fixture', operation: role === 'tts' ? 'speak' : 'stream',
        accountRef: 'offline-fixture', endpoint: 'https://fixture.invalid/stream', maxMicro: 100, request, ...(retryOf ? { retryOf } : {}) });
      const dispatch = async (role, request, retryOf) => {
        const spec = specification(role, request, retryOf), admission = await admit(spec);
        await admission.attempt.consume(); dispatches.push(spec.attemptId);
        await admission.report({ attemptId: spec.attemptId, outcome: retryOf === undefined ? 'uncertain' : 'completed' });
        return spec.attemptId;
      };
      const replyExecutor = createVoiceReplyExecutor({ execute(envelope, options) {
        return turns.run(envelope.payload, async worker => {
          worker.beforeAdmission();
          const first = await dispatch('reasoning', { text: hypothesis });
          // A fake retry exercises the SAME budget boundary with retryOf.
          const retry = await dispatch('reasoning', { text: hypothesis, retry: true }, first);
          worker.admitted(retry);
          return { replyId: `reply-${randomUUID()}`, created: 1, events: (async function* () {
            yield { type: 'delta', text: 'Danke. ' }; yield { type: 'completion', text: 'Danke. ' };
          })() };
        }, options);
      } });
      const ttsPCM = new Uint8Array(144_000), view = new DataView(ttsPCM.buffer);
      for (let i = 0; i < ttsPCM.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 20) * 4000), true);
      const ttsFormat = { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 };
      const factory = createComposedVoice({ enabled: true, storage, relayOrigin, authenticateRelay, replyExecutor,
        authorize: async () => true, commitUtterance: async () => {},
        admitComponent: async ({ role, request, signal, deadlineAt }) => ({ ...await admit(specification(role, request)), signal, deadlineAt }),
        stt: { async *stream({ audio }, options) {
          await options.attempt.consume(); dispatches.push(options.attempt.attemptId);
          for await (const _ of audio) { /* Consume actual worklet packets until server endpointing. */ }
          await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed' });
          hypothesis = 'Wien'; yield { text: hypothesis, final: true };
        } },
        tts: { format: ttsFormat, async *speak(_request, options) {
          await options.attempt.consume(); dispatches.push(options.attempt.attemptId);
          for (let offset = 0; offset < ttsPCM.length; offset += 36_000) yield ttsPCM.slice(offset, offset + 36_000);
          await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed' });
          answer.resolve({ hypothesis, entities: [{ expected: 'Wien', actual: hypothesis }], ttsPCM, ttsFormat,
            ttsConfig: { model: 'eleven_flash_v2_5', voiceId: 'fixture-voice', voiceSettings: fixtureVoiceSettings } });
        } },
      });
      current = { factory };
      const segment = await factory.start({ sessionId: session.id, ownerToken: owner, callId: `call-${lane}-${randomUUID()}` },
        { attempt: { attemptId: `parent-${randomUUID()}`, claimId: 'fixture-parent', maxMicro: 0, consume() {} }, report() {},
          deadlineAt: Date.now() + 60_000, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 });
      return { grant: segment.grant, result: answer.promise, async close() {
        await segment.close(); factory.networkRelay.close(); await turns.idle(); storage.close();
      } };
    },
    dispatches,
  };
}
