import { deepFreeze } from './resolver.js';

/** Operator selection hints, not residency claims or live health probes.
 * Model and voice names are supplied by the qualified template, never guessed.
 * P19 must qualify EU candidates; no new evidence documents are invented here.
 */
export const SPEECH_CANDIDATES = deepFreeze([
  { id: 'whisper-cpp', provider: 'local', product: 'whisper-cpp', lane: 'stt', location: 'operator', preset: 'local-l1',
    reason: 'Separate whisper.cpp CLI with zero-cost admission and parent-crash supervision.' },
  { id: 'chatterbox-local', provider: 'local', product: 'chatterbox', lane: 'tts', location: 'operator', preset: 'local-l1',
    reason: 'Separate local Chatterbox service exposing an OpenAI-compatible raw PCM bridge; nothing bundled.' },
  { id: 'openai-stt', provider: 'openai', product: 'openai-api', lane: 'stt', location: 'cloud', preset: 'eu-e1',
    reason: 'OpenAI-compatible completed-utterance transcription; Europe admission needs account-bound product evidence, including CH.' },
  { id: 'openai-tts', provider: 'openai', product: 'openai-api', lane: 'tts', location: 'cloud', preset: 'eu-e1',
    reason: 'OpenAI-compatible PCM synthesis candidate; EU qualification remains an evidence and quality gate.' },
  { id: 'elevenlabs-stt', provider: 'elevenlabs', product: 'elevenlabs-scribe', lane: 'stt', location: 'cloud', preset: 'cloud-c1',
    reason: 'Scribe is first class in international C1. Only Enterprise evidence can qualify EU residency.' },
  { id: 'elevenlabs-tts', provider: 'elevenlabs', product: 'elevenlabs-tts', lane: 'tts', location: 'cloud', preset: 'cloud-c1',
    reason: 'ElevenLabs PCM synthesis is first class in C1. EU-E1 requires Enterprise and full account-bound evidence.' },
]);

/** Capabilities use the same server-owned descriptor shape as text adapters. */
export function speechAdapterDescriptors(templates, { unhealthy = [] } = {}) {
  return SPEECH_CANDIDATES.map((candidate) => {
    const selected = templates.filter((template) => template.adapter === candidate.id
      && template.provider === candidate.provider && template.product === candidate.product && template.location === candidate.location);
    return {
      id: candidate.id, products: [candidate.product], execution_locations: [candidate.location],
      models: { [candidate.lane]: [...new Set(selected.flatMap((template) => template.models))] },
      voices: [...new Set(selected.flatMap((template) => template.voices))], healthy: !unhealthy.includes(candidate.id),
    };
  });
}
