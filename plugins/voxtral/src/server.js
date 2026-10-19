import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { preflightVoiceComposition, VoiceCompositionError, componentInvocation } from '@inspr/aithema-core/voice-components';
import { createVoxtralSTT, createVoxtralTTS } from './index.js';
import { validateVoxtralConfiguration, STT_FORMAT, TTS_FORMAT, STT_MODEL, TTS_MODEL } from './configuration.js';

export * from './index.js';
export { validateVoxtralConfiguration, STT_MODEL, TTS_MODEL } from './configuration.js';
export { manifest, componentManifest } from './manifest.js';

/** Guarded speech selection using AIT-328's pure preflight. Await preflight
 * before parent/child admission; every component invocation also awaits it.
 * This is not account admission or a live provider. No default transports. */
export function createVoxtralComponents({ composition, ...options } = {}) {
  const config = validateVoxtralConfiguration(options.config);
  const stt = createVoxtralSTT({ ...options, config });
  const tts = Object.freeze(Object.create(createVoxtralTTS({ ...options, config }), {
    validateVoice: { value: voice => voice === config.voiceId },
  }));
  const settings = composition === undefined
    ? { capture: STT_FORMAT, playback: TTS_FORMAT, languages: config.languages, voice: config.voiceId }
    : composition;
  const preflight = (async () => {
    for (const [role, actual] of [['capture', STT_FORMAT], ['playback', TTS_FORMAT]]) {
      if (!settings?.[role] || ['encoding', 'sampleRateHz', 'channels'].some(key => settings[role][key] !== actual[key])) {
        throw new VoiceCompositionError(`composition-${role}-format`, `Composition ${role} must match the runtime audio format`);
      }
    }
    return deepFreeze(await preflightVoiceComposition({ ...settings, stt, tts }));
  })();
  void preflight.catch(() => {});
  const guard = (port, role) => {
    const wrapper = Object.create(port);
    const check = async (input, operation) => {
      let ready;
      try { ready = await voiceOperation(operation, () => preflight); }
      catch (error) {
        if (['cancelled', 'deadline'].includes(error?.code) && operation?.attempt && typeof operation.report === 'function') {
          // Release an already supplied claim through shared once-only accounting.
          // A pre-aborted scope guarantees zero consume and zero dispatch, even
          // when the shared negotiation timed out before the caller's deadline.
          const signal = AbortSignal.abort(new DOMException('Preflight wait ended', error.code === 'deadline' ? 'TimeoutError' : 'AbortError'));
          await componentInvocation({ ...operation, signal }, { role,
            unit: role === 'stt' ? 'seconds' : 'characters', model: role === 'stt' ? STT_MODEL : TTS_MODEL });
        }
        throw error;
      }
      const format = role === 'stt' ? ready.capture : ready.playback;
      if (input?.format !== format.encoding) throw new VoiceCompositionError(
        role === 'stt' ? 'composition-capture-format' : 'composition-playback-format', 'Invocation must match the preflight audio format');
      if (role === 'tts' && input.voice !== undefined && input.voice !== ready.voice) {
        throw new VoiceCompositionError('composition-voice-invalid', 'Invocation must use the configured saved voice');
      }
    };
    for (const method of ['transcribe', 'stream', 'speak']) {
      if (typeof port[method] !== 'function') continue;
      Object.defineProperty(wrapper, method, { value: method === 'transcribe' ? async (input, operation) => {
        const request = { ...input };
        await check(request, operation); return port[method](request, operation);
      } : async function* (input, operation) {
        const request = { ...input };
        await check(request, operation); yield* port[method](request, operation);
      } });
    }
    return Object.freeze(wrapper);
  };
  return Object.freeze({ stt: guard(stt, 'stt'), tts: guard(tts, 'tts'), preflight,
    outputFormat: TTS_FORMAT.encoding, outputAudioFormat: TTS_FORMAT });
}
