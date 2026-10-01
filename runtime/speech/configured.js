import { canonicalJson } from '../../contracts/validate.js';
import { computeCapabilityMatrix, resolveSettings } from '../settings/index.js';
import { SPEECH_CANDIDATES, speechAdapterDescriptors } from '../settings/speech.js';
import { OpenAISpeechToText, OpenAITextToSpeech, LocalChatterboxTextToSpeech,
  ElevenLabsSpeechToText, ElevenLabsTextToSpeech } from './http.js';
import { WhisperCppSpeechToText } from './whisper.js';
import { speechError } from './common.js';

const adapters = Object.freeze({ 'whisper-cpp': WhisperCppSpeechToText, 'chatterbox-local': LocalChatterboxTextToSpeech,
  'openai-stt': OpenAISpeechToText, 'openai-tts': OpenAITextToSpeech,
  'elevenlabs-stt': ElevenLabsSpeechToText, 'elevenlabs-tts': ElevenLabsTextToSpeech });

/** Trusted service composition entry point. Re-resolves settings/evidence at
 * start AND before each output authority check. No capability verdict, model,
 * endpoint, ceiling, price or secret binding is accepted from the browser.
 * binding carries operator-owned runtime values (apiKey or local CLI paths).
 * Context is a function so withdrawal and health changes are observed.
 */
export function createConfiguredSpeechAdapter({ lane, settings, context, budget, binding = {}, fetchImpl, now = () => new Date().toISOString() }) {
  if (!['stt', 'tts'].includes(lane) || typeof context !== 'function') throw new TypeError('Speech lane and current settings context required');
  const document = structuredClone(settings);
  const current = () => {
    const input = context();
    const options = { ...input, now: now(), adapters: [...(input.adapters ?? []),
      ...speechAdapterDescriptors(document.provider_templates, { unhealthy: input.unhealthySpeechAdapters ?? [] })] };
    const matrix = computeCapabilityMatrix(document, options);
    if (!matrix.lanes[lane].enabled) throw speechError(matrix.lanes[lane].reason, 'Speech lane is unavailable');
    return resolveSettings(document, options);
  };
  const initial = current();
  const row = initial.lanes[lane], template = row.template;
  const candidate = SPEECH_CANDIDATES.find((candidate) => candidate.id === template.adapter && candidate.lane === lane);
  if (!candidate || candidate.provider !== template.provider || candidate.product !== template.product
      || candidate.location !== template.location || (candidate.location === 'operator' && template.deployment !== 'self_hosted')) {
    throw speechError('adapter_unsupported', 'Speech template is unsupported');
  }
  if (binding.account_ref !== template.account_ref || binding.secret_ref !== template.secret.ref) {
    throw speechError('secret_binding_invalid', 'Speech runtime binding does not match the qualified account');
  }
  const signature = canonicalJson({ template, model: row.model, preferences: initial.preferences });
  const guard = () => {
    const resolved = current();
    if (canonicalJson({ template: resolved.lanes[lane].template, model: resolved.lanes[lane].model,
      preferences: resolved.preferences }) !== signature) throw speechError('settings_changed', 'Speech selection changed');
  };
  const guardedBudget = {
    get authority() { return budget.authority; },
    admit: (body) => { guard(); return budget.admit(body); },
    claim: (body) => { guard(); return budget.claim(body); },
    settle: (...args) => budget.settle(...args), recover: (...args) => budget.recover(...args), listOpen: (...args) => budget.listOpen(...args),
    isCurrent: async (owner) => { try { guard(); } catch { return false; } return budget.isCurrent(owner); },
  };
  const instance = new adapters[template.adapter]({ budget: guardedBudget,
    endpoint: template.endpoint, modelId: row.model, allowedModels: [row.model],
    voiceId: initial.preferences.voice.tts_voice, allowedVoices: template.voices,
    maxMicro: initial.policy.spend.provider_max[lane], currency: initial.policy.spend.currency,
    apiKey: binding.apiKey, command: binding.command, args: binding.args, modelPath: binding.modelPath,
    priceUsage: binding.priceUsage, fetchImpl });
  return Object.freeze(lane === 'stt' ? {
    streamTranscribe: (request) => { guard(); return instance.streamTranscribe(request); },
    transcribe: (request) => { guard(); return instance.transcribe(request); },
  } : {
    sampleRate: instance.sampleRate,
    streamSynthesize: (request) => { guard(); return instance.streamSynthesize(request); },
    synthesize: (request) => { guard(); return instance.synthesize(request); },
  });
}
