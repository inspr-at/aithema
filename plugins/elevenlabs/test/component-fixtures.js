// Synthetic wire fixtures, never recorded provider traffic. Checked 2026-10-15.
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
// UNVERIFIED: TTS final field spelling: page Messages examples say `is_final`,
// AsyncAPI FinalOutput says `isFinal`. Fixture uses page example; live spelling
// must be confirmed before OPS runner. We deliberately reject ambiguous shapes.
// UNVERIFIED: empty audio_base_64 with commit=true accepted by STT server (schema
// permits empty base64; acceptance/minimum audio duration not proven offline).
// UNVERIFIED: actual PCM16 LE mono pcm_24000 payload and account/model support;
// configured tariffs, billable whitespace/rounding, server usage/receipts, latency,
// retention/residency and quality. No fabricated provider usage fields are emitted.
export const unverified = Object.freeze(['TTS is_final vs isFinal', 'STT empty commit chunk acceptance/minimum duration',
  'PCM24k signed-16 LE mono/account/model availability', 'tariffs/billable whitespace/rounding',
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
  audio: { audio: 'AAAAAA==', is_final: false }, done: { is_final: true },
};

// In-process duplex fixture: response finality depends on outbound commit/end,
// so tests cannot accidentally pass by having prerecorded finals race ingress.
export function fixtureSocket({ role, text = 'Grüß Gott', beforeFinal = async () => {}, onSend = () => {}, onClose = () => {} }) {
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(); let ended = false;
  return { send(wire) {
    const frame = JSON.parse(wire); onSend(frame);
    if (role === 'stt' ? frame.commit === true : frame.text === '') ready.resolve();
  }, close() { if (!ended) { ended = true; onClose(); closed.resolve(); } },
  events: (async function* () {
    if (role === 'stt') { yield JSON.stringify(sttWire.session()); yield JSON.stringify(sttWire.partial(text.slice(0, 4))); }
    if (await Promise.race([ready.promise.then(() => true), closed.promise.then(() => false)])) {
      await beforeFinal();
      if (role === 'stt') yield JSON.stringify(sttWire.final(text));
      else { yield JSON.stringify(ttsWire.audio); yield JSON.stringify(ttsWire.done); }
    }
  })() };
}

export function fixtureBinding(role) {
  return { plugin: 'elevenlabs', model: role === 'stt' ? 'scribe_v2_realtime' : 'eleven_flash_v2_5',
    endpoint: 'https://api.elevenlabs.io', accountRef: 'fixture-account', routing: {},
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
