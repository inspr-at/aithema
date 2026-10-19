# Voxtral module — not yet qualified in live use

The private workspace package `@inspr/aithema-plugin-voxtral` adds supported
`/server`, `/components`, `/configuration`, `/manifest`, and `/client`
entrypoints. The root exports `createVoxtralComponents`, which validates private server configuration
and guards each operation behind the shared AIT-328 preflight. Supply a
`private:…` secret reference and an explicit saved `voiceId`; inline credentials
and unknown configuration fields are rejected. Await `preflight` before admitting
any claims. Cancelled preflight waits settle supplied claims once with zero cost
and no consumption through shared component accounting. Capture must be
PCM16/16 kHz/mono and playback float32/24 kHz/mono;
invocations cannot change the negotiated format or saved voice. Preflight checks
syntax and the selected voice, without proving voice ownership or availability.

The component manifest keeps `id: voxtral` and STT/TTS kinds. The separate live
pipeline manifest uses `id: voxtral-voice`. It describes the assembled composed
pipeline. Both remain unqualified with unverified
processing locations and no heard-position receipt. The browser entrypoint exports
`createVoxtralVoiceClient` and metadata through relative public source URLs, as
required by the live manifest schema. AIT-331 adds the private account/evidence and regional authority described below;
AIT-330 supplies transport,
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

AIT-331 adds `createVoxtralProviderAuthority` and
`validateVoxtralAccountConfiguration` on the server/root entrypoint, and
`voxtralEndpoints` on server/root/configuration. The authority is an admission
building block. `createVoxtralVoiceProvider` merges
`authority.ports.serverAdapter` into its server adapter. Pass the actual selected
`componentBindings` and `plugins` for `stt`, `reasoning`, and `tts`, and list every
host processor as `{ binding, plugin, operation }` in nonempty `hostProcessing`.
Supply `consent.coverage` and an authoritative synchronous `getSession(id)`.
The adapter opts into the runtime's `requiresReasoningBinding` contract, so the
feature matrix and admission pass the session's actual selected reasoning binding.
Direct callers must pass that authoritative selection as
`admissionReason({ session, preset, policy, reasoningBinding }, options)` both
before dispatch and before accepting late results. Missing or changed reasoning
bindings are denied; a qualified alternative provider cannot form an EU chain.
It rechecks every link through core's
`bindingReason`, the captured consent revision and current session after each
coverage await, then all grants and evidence again before success. Replaced
bindings require a new authority. Consent-scope construction errors propagate
and admission fails closed; an empty scope list never substitutes for consent.
`evaluate` reports independent link verdicts
and `euEligible`; it does not itself grant consent. The adapter hook feeds the
ordinary feature matrix. `processingDetail()` supplies safe account-processing
copy for AIT-337, without evidence references, account identity or a new region
label. It is separate from the full-chain eligibility verdict.

The component preflight remains usable without account evidence for offline
format checks. Account fields, when supplied, must validate; the provider
authority always requires them. All snapshots are deeply frozen copies. Public
manifests remain unqualified. No account access or provider calls are made.

For Markus's prepared Desk question, the exact required private configuration
and evidence fields for literal **“In der EU”** are below. All `private:…` values
are references to owner-held records, never credentials or documents to place in
public metadata. These are requirements, not assertions that Mistral provides them.

| Field | Required value/evidence |
| --- | --- |
| `config.endpoint` | `https://api.eu.mistral.ai`, with no global fallback |
| `config.accountRef`, `config.secretRef` | Private references to the approved account and its credential; no key value |
| `config.voiceId` | Explicit saved voice ID (syntax only; rights/live validation remains separate) |
| `accountEvidence.accountRef`, `.secretRef`, `.endpoint` | Exactly the three configuration values above |
| `.dpaAccepted`, `.dpaRef` | `true`; private reference to the applicable account DPA/contract and its exact-country undertaking |
| `.recipient`, `.recipientCountries` | Actual contracting recipient name and all recipient-seat country codes, all EU members |
| `.undertaking.region` | Exactly `EU`; `EU/EFTA` and `uncommitted` never qualify |
| `.undertaking.processingCountries` | Nonempty explicit list of guaranteed ISO two-letter EU countries covering inference and control/account processing; no EFTA-only country |
| `.undertaking.controlPlaneIncluded` | `true`, backed by the undertaking; excluding the control plane does not qualify |
| `.zdrEnabled`, `.zdrRef` | `true`; private approval reference explicitly covering realtime WebSocket transcription, reasoning and speech synthesis on this account/endpoint |
| `.zdrEndpoints` | Exactly the three complete service URLs below, including the realtime model query |
| `.trainingOptOut`, `.trainingRef` | `true`; private evidence that these services are not used for training, separate from ZDR |
| `.availabilityRef` | Private account evidence that the three selected models and realtime path are available at the regional endpoint |
| `.reviewedAt`, `.expiresAt` | Valid `YYYY-MM-DD` dates in UTC; review at or before now, expiry strictly after now and review (expiry is midnight UTC) |
| `.services.stt` | `{ model: 'voxtral-mini-transcribe-realtime-2602', endpoint: 'wss://api.eu.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602' }` |
| `.services.reasoning` | `{ model: '<approved Mistral model ID>', endpoint: 'https://api.eu.mistral.ai/v1/chat/completions' }` |
| `.services.tts` | `{ model: 'voxtral-mini-tts-2603', endpoint: 'https://api.eu.mistral.ai/v1/audio/speech' }` |

Every STT/reasoning/TTS private binding must match the account, secret reference,
regional origin, selected service model and `legal.evidence.dpaRef` above, with
no routing overrides. Plugins must be `voxtral`, `mistral`, `voxtral` respectively.
Its `legal.recipient`, `countries`, and `processingCountries` must match the
account undertaking; `training` must be `false`. Normal core evidence also needs
`legal.approved: true`, `evidence.qualified: true`, matching account/secret/model/
endpoint/routing, current numeric `verifiedAt` and `expiresAt` timestamps, and the
actual purpose, consent version, processors, data categories and retention terms.
Every host-processing binding independently needs the same core evidence quality,
EU recipient seats and guaranteed EU processing countries, and no training.
`policy.endpoints` must permit every binding origin, including the host processors.
Current exact-scope consent must cover STT `stream`, reasoning `stream`, TTS
`speak`, and each host operation at the current session consent revision. Human
evidence cannot replace the visitor's consent.

Until those records exist the EU option stays unavailable. Regional-only evidence
is described as “Processed in Mistral's EU/EFTA region; account and control data may
be processed elsewhere.” Global routing has no inference-location commitment.

AIT-330 exports `createVoxtralVoiceProvider` and `createVoxtralTransports` on
`/server` (and root). The provider requires `enabled: true`, the private account
configuration, a zero-upstream parent binding, component bindings, reasoning
plugin, complete host processing, consent, `getSession`, storage and explicit
`resolveSecret`/`connect`/`fetchImpl` ports. Alternatively inject a server-side
ws-compatible `WebSocket` constructor; it is never selected from globals.
`createVoxtralTransports({ endpoint, WebSocket, fetchImpl })` returns both ports;
its exact STT/TTS URL checks use AIT-331's allowlist and disable redirects.
The saved regional origin is retained without any global fallback. Keys are
resolved only inside server component invocation after a separately admitted claim.

The ordinary voice mount supplies `bindCallbacks` authorities, including the
current reasoning/session authorization and late-result fence. Provide a private
`admitComponent(request)` port that returns a separately admitted speech claim;
the assembly adds the immutable role binding and checks mounted authorization.
No reservation formula or automatic speech charging is installed here (AIT-332).
The adapter awaits component preflight before admission and start. A deadline
while preflight is pending cannot consume a claim or resolve a credential.
A supplied `authenticateRelay(request)` returns the existing authenticated owner;
`relayOrigin` pins the host origin. The mount registers `POST /composed/relay`.
No owner identity is taken from a grant or URL, and grants remain single-use.

`createVoxtralVoiceClient({ control, network, audio })` uses the shared composed
browser media, authenticated network relay, PCM capture and float32 player.
The control port provides `start`, `close`, `pause`, `resume`, `heartbeat` and
`recover` (plus `takeover` when offered by the host). Tests may inject `openRelay`,
`capture`, and `player` instead. Construction starts no media. Existing lifecycle,
input/output meters and `retryPlayback` remain available on the returned session;
blocked playback invokes `onPlaybackBlocked` for the existing explicit retry gesture.
The shared capture asset is available as
`@inspr/aithema-server/composed-voice/pcm-capture-worklet.js` and is resolved by the
shared capture factory relative to its own browser source URL. Serve that asset
and its public module graph under the host's existing same-origin static mount.

Server WebSocket reassembly is capped at 256,000 bytes; the application queue
holds at most 16 messages and 512,000 bytes, and send buffering is capped too.
SSE messages retain the shared wire ceiling, 1 MiB decoded-event ceiling and
16,000,000-byte synthesis ceiling. Cancellation closes sockets, cancels readers,
and closes/cancels late transport results. TTS preserves auth/rate-limit failures
and safe moderation reasons: `tts-moderation-refused` for recognized machine
markers, `tts-forbidden-or-moderation` for an otherwise unclassified HTTP 403.
Provider text is never copied into those errors. A 403 alone does not distinguish
authentication from content moderation; see the [Mistral speech guide](https://docs.mistral.ai/studio/audio/text_to_speech/speech).

AIT-330's offline fixtures are `test/fixtures.js` (synthetic regional account,
DPA and host chain), `test/wire.test.js` (request shapes and fragmented SSE),
and `test/assembly.test.js` (injected WebSocket, relay grants and browser media).
No fixture proves live qualification, acoustic quality, physical sample rate,
latency, retention, regional availability or remote cancellation.
