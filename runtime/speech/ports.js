/**
 * Request-scoped speech ports, matching the reasoning port's stream/promise
 * pair and AbortSignal contract. Partial output is evidence, never a complete
 * turn. Adapters own cancellation; ports do not persist or play audio.
 *
 * @typedef {{bytes: Uint8Array, mimeType: 'audio/wav', language?: string,
 *   model?: string, signal?: AbortSignal, executionContext: {attempt_id: string}}} SpeechRequest
 * @typedef {{text: string, voice?: string, model?: string, signal?: AbortSignal,
 *   executionContext: {attempt_id: string}}} SynthesisRequest
 * @typedef {{streamTranscribe(request: SpeechRequest): AsyncIterable<string>,
 *   transcribe(request: SpeechRequest): Promise<{text: string}>}} SpeechToText
 * @typedef {{streamSynthesize(request: SynthesisRequest): AsyncIterable<Uint8Array>,
 *   synthesize(request: SynthesisRequest): Promise<{bytes: Uint8Array, mimeType: string, sampleRate: number}>}} TextToSpeech
 * @typedef {{detect(request: {bytes: Uint8Array, signal?: AbortSignal}): Promise<{speech: boolean, rms: number}>}} VoiceActivityDetection
 */

function port(adapter, methods, label) {
  if (methods.some((method) => typeof adapter?.[method] !== 'function')) {
    throw new TypeError(`${label} adapter must implement ${methods.join(' and ')}`);
  }
  return Object.freeze(Object.fromEntries(methods.map((method) => [method, (request) => adapter[method](request)])));
}

/** @param {SpeechToText} adapter @returns {SpeechToText} */
export function createSpeechToTextPort(adapter) {
  return port(adapter, ['streamTranscribe', 'transcribe'], 'speech-to-text');
}

/** @param {TextToSpeech} adapter @returns {TextToSpeech} */
export function createTextToSpeechPort(adapter) {
  return port(adapter, ['streamSynthesize', 'synthesize'], 'text-to-speech');
}

/** @param {VoiceActivityDetection} adapter @returns {VoiceActivityDetection} */
export function createVadPort(adapter) { return port(adapter, ['detect'], 'VAD'); }
