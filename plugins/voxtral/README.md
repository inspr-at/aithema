# Voxtral module — not yet qualified in live use

The private workspace package `@inspr/aithema-plugin-voxtral` adds supported
`/server`, `/components`, `/configuration`, and `/manifest` entrypoints. The root
exports `createVoxtralComponents`, which validates private server configuration
and guards each operation behind the shared AIT-328 preflight. Supply a
`private:…` secret reference and an explicit saved `voiceId`; inline credentials
and unknown configuration fields are rejected. Await `preflight` before admitting
any claims. Capture must be PCM16/16 kHz/mono and playback float32/24 kHz/mono;
invocations cannot change the negotiated format or saved voice. Preflight checks
syntax and the selected voice, without proving voice ownership or availability.

The component manifest keeps `id: voxtral` and STT/TTS kinds. The separate live
pipeline manifest uses `id: voxtral-voice`. It describes the intended composed
pipeline, not an assembled live provider. Both remain unqualified with unverified
processing locations and no heard-position receipt. No browser entrypoint exists
yet. AIT-331 owns account/evidence and regional admission; AIT-330 owns transport,
relay and browser assembly using `@inspr/aithema-server/composed-voice` exports
and relative public browser source URLs under `script-src 'self'`. AIT-332 owns
charging integration. The package stays `private: true` until AIT-339 includes it
in the released modules; no release version or inclusion policy changes here.

`/components` (`src/index.js`) preserves the existing realtime STT and streamed
TTS helpers and their fixture configuration for source consumers. Both default to
disabled and require explicitly injected transports and a private `resolveSecret`
function. There is no default network client, environment lookup, or stored key.
Configuration accepts an HTTPS API origin, secret reference, saved voice ID,
target delay, and verified pricing. It makes no EU-routing or retention claim.

STT uses `voxtral-mini-transcribe-realtime-2602`, WebSocket `session.update`,
`input_audio.append`, and `input_audio.end`. Only `transcription.done` establishes
finality. Input is signed PCM16 at 16 kHz; TTS uses `voxtral-mini-tts-2603`,
`POST /v1/audio/speech`, saved `voice_id`, `response_format: pcm`, and streamed
`speech.audio.delta` / `speech.audio.done` events. Output negotiation declares
float32 PCM at 24 kHz; OPS must confirm the physical output format during live
qualification. Fragmented SSE, CRLF, bounds, terminal presence, errors, and
cancellation are tested entirely against synthetic wire messages.

Synthetic fixture sources, consulted 2026-10-14:

- [Mistral realtime guide](https://docs.mistral.ai/studio/audio/speech_to_text/realtime_transcription)
- [Mistral speech API schema](https://docs.mistral.ai/api/endpoint/audio/speech)
- [Mistral speech-generation guide](https://docs.mistral.ai/studio/audio/text_to_speech/speech)
- [Mistral public protocol models](https://github.com/mistralai/client-python/tree/main/src/mistralai/client/models)

Tariffs default to the public estimates of $0.006/min STT and $16/million TTS
characters, reported as estimates with their source. Missing terminal evidence
retains uncertain exposure, including cancelled dispatched requests. No fixture
proves vendor accuracy, latency, remote closure, retention, or regional eligibility.
Account/legal evidence, credentials and any future live qualification remain
with the controller/OPS. AIT-329 uses offline fixtures only, with no provider API
calls, keys or paid runs.
