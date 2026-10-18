import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { preflightVoiceComposition, VoiceCompositionError } from '@inspr/aithema-core/voice-components';
import { createGrokSTT } from './stt.js';
import { createGrokTTS } from './tts.js';
import { validateGrokConfiguration, STT_FORMAT, TTS_FORMAT } from './configuration.js';
export * from './components.js';

/** Pure component selection, never full-chain legal/financial admission. No
 * prototype configuration imports or reasoning binding policy changes. Await
 * preflight before admitting any parent or child claim; guards enforce it too. */
export function createGrokComponents({ composition, ...options } = {}) {
  const config = validateGrokConfiguration(options.config);
  const stt = createGrokSTT({ ...options, config }), tts = createGrokTTS({ ...options, config });
  const settings = composition ?? { capture: STT_FORMAT, playback: TTS_FORMAT, languages: config.languages, voice: config.voice };
  const preflight = (async () => {
    for (const [role, actual] of [['capture', STT_FORMAT], ['playback', TTS_FORMAT]]) {
      if (!settings[role] || ['encoding', 'sampleRateHz', 'channels'].some(key => settings[role][key] !== actual[key])) {
        throw new VoiceCompositionError(`composition-${role}-format`, `Composition ${role} must match the runtime audio format`);
      }
    }
    return preflightVoiceComposition({ ...settings, stt, tts });
  })();
  void preflight.catch(() => {});
  const guard = port => {
    const wrapper = Object.create(port);
    for (const method of ['transcribe', 'stream', 'speak']) {
      if (typeof port[method] !== 'function') continue;
      Object.defineProperty(wrapper, method, { value: method === 'transcribe' ? async (...args) => {
        await voiceOperation(args[1], () => preflight); return port[method](...args);
      } : async function* (...args) { await voiceOperation(args[1], () => preflight); yield* port[method](...args); } });
    }
    return Object.freeze(wrapper);
  };
  return Object.freeze({ stt: guard(stt), tts: guard(tts), preflight, outputFormat: TTS_FORMAT.encoding, outputAudioFormat: TTS_FORMAT });
}
