import { PluginError } from '../../../packages/core/src/invocation.js';
import { processingScope } from '../../../packages/core/src/presets.js';
import { consentCoverage } from '@inspr/aithema-core';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { preflightVoiceComposition, VoiceCompositionError } from '../../../packages/core/src/voice-components.js';
import { createElevenLabsSTT, createElevenLabsTTS } from '../../elevenlabs/src/components.js';
import { createVoxtralSTT, createVoxtralTTS, TTS_FORMAT as VOXTRAL_OUTPUT } from '../../voxtral/src/index.js';

const factories = Object.freeze({ elevenlabs: { stt: createElevenLabsSTT, tts: createElevenLabsTTS },
  voxtral: { stt: createVoxtralSTT, tts: createVoxtralTTS } });
// The coordinator accepts s16 PCM and the browser captures 16 kHz mono audio.
const captureAudioFormat = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });

/** Selection is host configuration only. There is deliberately no default transport.
 * Bindings carry the host's actual recipients/processors; vendor names imply no grant. */
export function configureComposedComponents({ enabled, config, componentOptions = {}, consent, reasoningBinding, authorize,
  componentFactories = factories, composition }) {
  if (!['stt', 'tts'].every(role => Object.hasOwn(componentFactories, config[role]) &&
    typeof componentFactories[config[role]]?.[role] === 'function') || typeof authorize !== 'function') throw new TypeError('Select configured STT and TTS components');
  const ports = {}, scopes = [];
  for (const role of ['stt', 'tts']) {
    const vendor = config[role], options = componentOptions[vendor]?.[role];
    if (!options?.binding?.legal || options.binding.plugin !== vendor) throw new TypeError('Component processing binding required');
    const operation = role === 'stt' ? 'stream' : 'speak';
    scopes.push(processingScope(options.binding, operation));
    ports[role] = componentFactories[vendor][role]({ ...options, enabled,
      consent: { ...consent, binding: options.binding } });
  }
  if (reasoningBinding?.plugin !== 'openrouter' || reasoningBinding.legal?.purpose !== 'models-international' ||
    reasoningBinding.legal.consentVersion !== 1) throw new TypeError('Existing OpenRouter reasoning processing binding required');
  scopes.push(processingScope(reasoningBinding, 'stream'));
  const outputAudioFormat = config.tts === 'voxtral' ? VOXTRAL_OUTPUT : ports.tts?.format;
  const settings = composition ?? {
    capture: captureAudioFormat,
    playback: outputAudioFormat, languages: ['de', 'en'],
    voice: config.voice ?? componentOptions[config.tts]?.tts?.config?.voiceId,
  };
  const preflight = (async () => {
    // Explicit preferences cannot negotiate formats that the runtime won't use.
    if (composition) for (const [role, actual] of [['capture', captureAudioFormat], ['playback', outputAudioFormat]]) {
      if (!actual || !composition[role] || ['encoding', 'sampleRateHz', 'channels'].some(key => composition[role][key] !== actual[key])) {
        throw new VoiceCompositionError(`composition-${role}-format`, `Composition ${role} must match the runtime audio format`);
      }
    }
    return preflightVoiceComposition({ ...settings, capture: captureAudioFormat, playback: outputAudioFormat, stt: ports.stt, tts: ports.tts });
  })();
  // Factories stay synchronous. Consumers can await readiness, and every operation
  // awaits the same result. Observe rejection even when an offline host never starts.
  void preflight.catch(() => {});
  const guarded = {};
  for (const role of ['stt', 'tts']) {
    const port = ports[role];
    // Inherit the full port surface, including non-enumerable/prototype members.
    const wrapper = Object.create(port ?? null);
    for (const method of ['transcribe', 'stream', 'speak', 'speakAligned']) {
      if (typeof port?.[method] !== 'function') continue;
      Object.defineProperty(wrapper, method, { value: method === 'transcribe' ? async (...args) => {
        await voiceOperation(args[1], () => preflight); return port[method](...args);
      } : async function* (...args) { await voiceOperation(args[1], () => preflight); yield* port[method](...args); } });
    }
    guarded[role] = Object.isFrozen(port) ? Object.freeze(wrapper) : wrapper;
  }
  return { ...guarded, preflight, outputAudioFormat, outputFormat: outputAudioFormat?.encoding,
    async authorize(request, options) {
      await voiceOperation(options, () => preflight);
      if (!consent?.session) throw new PluginError('not-admitted');
      for (const scope of scopes) {
        if (!await voiceOperation(options, opts => consentCoverage(consent.port, consent.session, scope, opts))) return false;
      }
      return authorize(request, options);
    } };
}
