// Synthetic wire fixtures, never recorded provider traffic. Checked against OPS live probes 2026-10-16 (code 7613fb5, mbp2606).
// STT source: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
// Sections: Handshake (xi-api-key, model_id, audio_format, commit_strategy);
// AsyncAPI Specification / components/schemas:
// SessionStarted -> session(); MessagesSessionStartedConfig -> session().config;
// InputAudioChunk -> chunk() (including required commit and sample_rate);
// PartialTranscript -> partial(); CommittedTranscript -> final();
// ScribeRateLimitedError -> rateLimited; ScribeAuthError -> authError.
// TTS source: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
// Sections: Handshake (xi-api-key, voice_id, model_id, output_format);
// Send / InitializeConnection -> initialize; SendText -> text(); CloseConnection -> end;
// Receive / AudioOutput -> audio; FinalOutput -> done.
// Live evidence: fixtures/ait-250/{tts-final-flag,stt-empty-commit}.json.
// These are non-secret OPS summaries, not raw provider frames. TTS observed only
// isFinal and no request-id; STT empty commit accepted but returned zero text
// after four partials. Response payloads below remain synthetic.
// STT commit=true accompanies audio per the API Messages example. The guide
// says processing starts after 2 s; short inputs therefore need accounted padding:
// https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies
// Remaining account-specific behavior still needs OPS verification.
export const unverified = Object.freeze(['STT nonempty commit live qualification/minimum billing',
  'PCM24k account/model availability', 'tariffs/billable whitespace/rounding',
  'server usage/receipts', 'latency/quality', 'retention/residency']);
export const sttWire = {
  session: () => ({ message_type: 'session_started', session_id: 'fixture-session',
    config: { audio_format: 'pcm_16000', language_code: null, model_id: 'scribe_v2_realtime', sample_rate: 16000 } }),
  chunk: (audio_base_64, commit = false) => ({ message_type: 'input_audio_chunk', audio_base_64, commit, sample_rate: 16000 }),
  partial: text => ({ message_type: 'partial_transcript', text }),
  final: text => ({ message_type: 'committed_transcript', text }),
  rateLimited: { message_type: 'rate_limited', error: 'Synthetic limit' },
  authError: { message_type: 'auth_error', error: 'Synthetic auth refusal' },
};
export const ttsWire = {
  initialize: { text: ' ' }, text: text => ({ text, flush: true }), end: { text: '' },
  audio: { alignment: null, audio: 'AAAAAA==', isFinal: false, normalizedAlignment: null },
  done: { alignment: null, audio: null, isFinal: true, normalizedAlignment: null },
};

// In-process duplex fixture: response finality depends on outbound commit/end,
// so tests cannot accidentally pass by having prerecorded finals race ingress.
export function fixtureSocket({ role, text = 'Grüß Gott', partials = [text.slice(0, 4)], beforeFinal = async () => {}, onSend = () => {}, onClose = () => {} }) {
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(); let ended = false, audioBytes = 0, committedText = text;
  return { send(wire) {
    const frame = JSON.parse(wire); onSend(frame);
    if (role === 'stt') {
      audioBytes += Buffer.from(frame.audio_base_64, 'base64').byteLength;
      if (frame.commit) committedText = frame.audio_base_64 && audioBytes >= 64_000 ? text : '';
    }
    if (role === 'stt' ? frame.commit === true : frame.text === '') ready.resolve();
  }, close() { if (!ended) { ended = true; onClose(); closed.resolve(); } },
  events: (async function* () {
    if (role === 'stt') { yield JSON.stringify(sttWire.session()); for (const partial of partials) yield JSON.stringify(sttWire.partial(partial)); }
    if (await Promise.race([ready.promise.then(() => true), closed.promise.then(() => false)])) {
      await beforeFinal();
      if (role === 'stt') yield JSON.stringify(sttWire.final(committedText));
      else { yield JSON.stringify(ttsWire.audio); yield JSON.stringify(ttsWire.done); }
    }
  })() };
}

export function fixtureBinding(role) {
  return { plugin: 'elevenlabs', model: role === 'stt' ? 'scribe_v2_realtime' : 'eleven_flash_v2_5',
    endpoint: 'https://api.elevenlabs.io', accountRef: 'fixture-account', secretRef: 'synthetic-only', routing: {},
    legal: { purpose: 'voice-elevenlabs', consentVersion: 1, recipient: 'ElevenLabs, Inc.', processors: [],
      dataCategories: ['speech-input', 'transcription', 'spoken-answers'] } };
}
export const session = { id: 'fixture-session', consentRevision: 1 };
export function fixtureConsent(binding, covered = true) {
  return { session, binding, port: { async coverage({ scope, consentRevision }) {
    return { ...scope, scope, covered, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  } } };
}
export const fixtureConfig = { secretRef: 'synthetic-only', voiceId: 'fixture-voice', sttMicroPerSecond: 10, ttsMicroPerCharacter: 2 };
export const fixtureVoiceSettings = { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: false, speed: 0.9 };
