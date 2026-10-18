# Next release — unreleased

- Hosts can implement STT/TTS providers with the supported `@inspr/aithema-core/voice-components` contract: typed ports, capability declarations and separate claim accounting with uncertain costs retained at the admitted maximum. Provider prototypes remain source-only; installed ElevenLabs live voice is unchanged.

- For hosts: Claude HTML bindings now accept OpenRouter reasoning efforts (`none`, `low`, `medium`, `high`, `xhigh`, `max`), including Opus 5.5 `high`. `maxTokens` covers reasoning plus visible output, the full allowance is reserved at the output rate, and shared-cap exhaustion refuses before dispatch; `none` preserves the existing request bytes.
