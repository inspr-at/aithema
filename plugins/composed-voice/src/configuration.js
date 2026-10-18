import { PluginError } from '../../../packages/core/src/invocation.js';
import { processingScope } from '../../../packages/core/src/presets.js';
import { consentCoverage } from '@inspr/aithema-core';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { preflightVoiceComposition } from '../../../packages/core/src/voice-components.js';
import { createElevenLabsSTT, createElevenLabsTTS } from '../../elevenlabs/src/components.js';
import { createVoxtralSTT, createVoxtralTTS, TTS_FORMAT as VOXTRAL_OUTPUT } from '../../voxtral/src/index.js';

const factories = Object.freeze({ elevenlabs: { stt: createElevenLabsSTT, tts: createElevenLabsTTS },
  voxtral: { stt: createVoxtralSTT, tts: createVoxtralTTS } });

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
  const outputAudioFormat = config.tts === 'voxtral' ? VOXTRAL_OUTPUT : ports.tts?.format ?? composition?.playback;
  const settings = composition ?? {
    capture: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    playback: outputAudioFormat, languages: ['de', 'en'],
    voice: config.voice ?? componentOptions[config.tts]?.tts?.config?.voiceId,
  };
  const preflight = preflightVoiceComposition({ ...settings, stt: ports.stt, tts: ports.tts });
  // Factories stay synchronous. Consumers can await readiness, and every operation
  // awaits the same result. Observe rejection even when an offline host never starts.
  void preflight.catch(() => {});
  const guarded = {};
  for (const role of ['stt', 'tts']) {
    const port = ports[role];
    guarded[role] = { ...port, capabilities: port?.capabilities,
      ...(typeof port?.negotiateAudioFormat === 'function' ? { negotiateAudioFormat: port.negotiateAudioFormat.bind(port) } : {}) };
    for (const method of ['transcribe', 'stream', 'speak', 'speakAligned']) {
      if (typeof port?.[method] !== 'function') continue;
      guarded[role][method] = method === 'transcribe' ? async (...args) => {
        await preflight; return port[method](...args);
      } : async function* (...args) { await preflight; yield* port[method](...args); };
    }
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
