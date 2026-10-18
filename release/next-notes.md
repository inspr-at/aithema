# Next release — unreleased

- Hosts can implement STT/TTS providers with the supported `@inspr/aithema-core/voice-components` contract: typed ports, capability declarations and separate claim accounting with uncertain costs retained at the admitted maximum. Provider prototypes remain source-only; installed ElevenLabs live voice is unchanged.

- For hosts: run `sttConformance` and `ttsConformance` from `@inspr/aithema-core` against offline provider fixtures to check the voice-component contract, including fresh claims, terminal accounting, cancellation, bounds and playback-confirmed aligned prefixes. See `docs/embedding.md`.
