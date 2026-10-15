import { PluginError } from '../../../packages/core/src/invocation.js';
import { processingScope } from '../../../packages/core/src/presets.js';
import { consentCoverage } from '../../../packages/core/src/index.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { createElevenLabsSTT, createElevenLabsTTS } from '../../elevenlabs/src/components.js';
import { createVoxtralSTT, createVoxtralTTS, TTS_FORMAT as VOXTRAL_OUTPUT } from '../../voxtral/src/index.js';

const factories = Object.freeze({ elevenlabs: { stt: createElevenLabsSTT, tts: createElevenLabsTTS },
  voxtral: { stt: createVoxtralSTT, tts: createVoxtralTTS } });

/** Selection is host configuration only. There is deliberately no default transport.
 * Bindings carry the host's actual recipients/processors; vendor names imply no grant. */
export function configureComposedComponents({ enabled, config, componentOptions = {}, consent, reasoningBinding, authorize }) {
  if (!factories[config.stt] || !factories[config.tts] || typeof authorize !== 'function') throw new TypeError('Select configured STT and TTS components');
  const ports = {}, scopes = [];
  for (const role of ['stt', 'tts']) {
    const vendor = config[role], options = componentOptions[vendor]?.[role];
    if (!options?.binding?.legal || options.binding.plugin !== vendor) throw new TypeError('Component processing binding required');
    const operation = role === 'stt' ? 'stream' : 'speak';
    scopes.push(processingScope(options.binding, operation));
    ports[role] = factories[vendor][role]({ ...options, enabled,
      consent: { ...consent, binding: options.binding } });
  }
  if (reasoningBinding?.plugin !== 'openrouter' || reasoningBinding.legal?.purpose !== 'models-international' ||
    reasoningBinding.legal.consentVersion !== 1) throw new TypeError('Existing OpenRouter reasoning processing binding required');
  scopes.push(processingScope(reasoningBinding, 'stream'));
  return { ...ports, outputFormat: config.tts === 'voxtral' ? VOXTRAL_OUTPUT.encoding : ports.tts.format.encoding,
    async authorize(request, options) {
      if (!consent?.session) throw new PluginError('not-admitted');
      for (const scope of scopes) {
        if (!await voiceOperation(options, opts => consentCoverage(consent.port, consent.session, scope, opts))) return false;
      }
      return authorize(request, options);
    } };
}
