# Voxtral component adapters — offline contract fixtures

`src/index.js` exports realtime STT and streamed TTS components. Both default to
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
The single $25 live run, account/legal checks, keys, and ElevenLabs comparison
remain with the controller/OPS under Markus's Mistral-first decision.
