# Grok Voice (xAI) — component pipeline (AIT-317, AIT-344–AIT-351)

**not yet qualified in live use**

Architecture: xAI STT → Aithema's separately admitted reasoning → xAI TTS.
Aithema owns answers. This workspace package provides STT, streaming TTS,
private configuration validation and supported component/preflight exports.
Relay, browser start and full-chain admission use the supported composed host.
AIT-351 includes this package in the release closure at the exact existing
`release/version.json` coordinate, with exact core/server dependencies and the
server's coordinator, accounting, relay, browser helpers and capture worklet.
Inclusion does not publish it. See
[installed imports and host setup](../../docs/embedding.md#grok-voice-host-setup-and-release-imports-ait-351).

Markus approved xAI as a direct recipient (AIT-317, Desk dc3ec428). Use `voice-xai`
v1 with the manifest's exact DE/EN text and separate reasoning consent. The
recipient is SpaceXAI LLC (“SpaceXSI”), US seat; processing is international with
no guaranteed region, as the Settings detail states.

Owner use requires an xAI account with voice access and **Zero Data Retention
switched on**, plus a server-side secret reference in the private binding.
**Never ask for a key.** The host privately resolves the reference only after
current account evidence, consent, ownership and budget admission. Public policy
does not establish the owner's account configuration.

## Public evidence

Read **2026-10-18**. These are public contract facts, not evidence about a
particular account or live acoustic quality. All fixtures are synthetic; no xAI
API calls, credentials, real recordings or agent live runs were used.

| Subject | Dated evidence and limits |
| --- | --- |
| STT endpoints | [STT guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text): REST `POST https://api.x.ai/v1/stt`, WebSocket `wss://api.x.ai/v1/stt`; model `grok-voice-transcribe-2.0`. REST multipart options precede `file`. |
| STT formats | Same guide: containers WAV, MP3, OGG, Opus, FLAC, AAC, MP4, M4A, MKV; raw PCM signed 16-bit LE, μ-law, A-law. Raw rates: 8000/16000/22050/24000/44100/48000 Hz. Streaming also supports raw Opus packets. This adapter admits only mono PCM16 at 16000 Hz and DE/EN. |
| STT finality | [Streaming contract](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text#streaming): wait for `transcript.created`, send binary audio, end with `audio.done`. Partial events can revise text or finalize chunks/stitched utterances. Only `transcript.done` after Aithema's input ends is its single final; closure alone fails. The adapter checks the already received event batch for a duplicate terminal, then closes from our side without waiting for another frame or provider closure. Terminal `duration` supplies seconds. |
| TTS endpoints and formats | [TTS guide](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech): REST `POST https://api.x.ai/v1/tts`, WebSocket `wss://api.x.ai/v1/tts`; codecs MP3/WAV/PCM/μ-law/A-law, rates 8000/16000/22050/24000/44100/48000 Hz. Streaming ends with `audio.done` and a trace ID; this is not a billed-cost or playback receipt. Configuration reserves mono PCM16 at 24000 Hz, voices `ara`/`eve`/`rex`, speed 0.7–1.5, DE/EN. The adapter explicitly requests `codec=pcm`, `sample_rate=24000`; no MP3 default is inherited. |
| Prices | [Pricing](https://docs.x.ai/developers/pricing): REST STT **$0.10/hour**, streaming STT **$0.20/hour**, TTS **$15/1M characters**. Whole USD micro-dollar estimates round up once per child invocation. STT uses provider duration, never inferred input length as completed usage. No billed-cost receipt is documented here. |
| Contracting entity | [Enterprise terms](https://x.ai/legal/terms-of-service-enterprise) state **SpaceXAI LLC (“SpaceXSI”)** in the opening paragraph (published wording verified 2026-10-18). [Corporate terms](https://x.ai/legal/terms-of-service) describe Nevada incorporation and Austin, Texas principal place of business. Recipient seat: **US**; verify the actual private account contract before activation. |
| Processing geography | [Regions](https://docs.x.ai/developers/advanced-api-usage/regions): global processing has no region guarantee; voice is outside the US regional endpoint's support. International processing; neither EU-only nor US-only is claimed. |
| Retention and training | [Security/ZDR FAQ](https://docs.x.ai/developers/faq/security): default encrypted API auditing retention is 30 days, no training without explicit permission. ZDR is team-wide; voice history is not persisted under ZDR. Public policy does not prove that a particular team has ZDR. |
| DPA and transfers | [DPA §§2.1, 8](https://x.ai/legal/data-processing-addendum): personal data must use ZDR-enabled APIs; international transfers can include the US and other countries, with applicable SCC/UK provisions. Owner-approved private references must establish DPA acceptance, ZDR, retention and transfer conditions before real speech. |

## Private configuration contract

`validateGrokConfiguration(raw)` is pure and returns an immutable snapshot. All component
factories call it before accepting any ports and revalidate evidence expiry
before resolving a secret. Invalid configuration throws a generic `TypeError`
without echoing supplied values. It does not dereference evidence, provide legal
approval, or replace current host consent/ownership/budget checks at `consume`.

Required fields:

- `secretRef`, `accountRef`: opaque references matching `private:<identifier>`;
  actual keys, tokens, free-form documents and URLs are rejected.
- `accountEvidence`: `zdrEnabled: true`, `dpaAccepted: true`,
  `recipient: 'SpaceXAI LLC'`, `recipientCountry: 'US'`,
  `processing: 'international-no-guaranteed-region'`; dated `reviewedAt` and
  future `expiresAt` (ISO dates); `zdrRef`, `dpaRef`, `retentionRef`, `transferRef`,
  `approvalRef`, `contractRef` using the same opaque private-reference syntax.
  References bind owner-held records to the selected account. There are no
  approved real account records or secrets in this package.

Optional values are validated even when only STT is constructed. Unknown fields
fail closed. Defaults and allowed scope:

| Field | Default / accepted values |
| --- | --- |
| `endpoint`, `model` | `https://api.x.ai`, `grok-voice-transcribe-2.0` only |
| `sttFormat` | `{ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }` only |
| `ttsFormat` | `{ encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 }` only |
| `languages` | `['de', 'en']`; nonempty unique subset |
| `voice`, `speed` | `eve`; allow `ara`, `eve`, `rex`; speed 1, range 0.7–1.5 |
| `endpointingMs` | 400; integer 0–5000; provider endpointing never establishes coordinator finality |
| `streamingMicroPerHour`, `restMicroPerHour` | 200000 / 100000; safe integers at least the dated public rates |
| `ttsMicroPerMillionCharacters` | 15000000; safe integer at least the dated public rate |
| Rate ceiling | 1000000000 for each rate; configured rates remain estimates |
| `maxInputChunkBytes`, `maxInputBytes` | 64000 / 1920000; positive even integers, chunk ≤ total, defaults are hard ceilings |
| `maxTranscriptCharacters` | 32768 UTF-16 code units, including accumulated replacement text |
| `maxWireCharacters`, `maxEvents` | 256000 / 1024; positive integers, defaults are hard ceilings |

## Component ports and accounting

`createGrokSTT` (alias `createGrokStreamingSTT`) has `stream` and a convenience
`transcribe` which sends one audio chunk over the same WebSocket contract.
`createGrokBatchSTT` implements REST `transcribe`, admitting a whole file up to
`maxInputBytes`. Both expose explicit capabilities, DE/EN language subset,
`formats`, and cancellation/deadline-aware negotiation for AIT-328 preflight.
REST declares streaming/partials false; the streaming component declares both
true. German quality and live-use qualification remain unverified in metadata.

Construction requires the private configuration. Work additionally requires
`enabled: true`, an injected `resolveSecret` and either `connect` or `fetchImpl`.
There are no environment, network or secret defaults. Imports, construction,
health and negotiation do no provider work. A socket port supplies
`{ send(Uint8Array|string), events: AsyncIterable<string>, close() }`; close must
be idempotent. The audio source supplies bounded, capture-paced PCM chunks
(backpressure is awaited). No extra wall-clock pacing is added. The adapter
copies each chunk and bounds total input, event count, wire and transcript size.

Each invocation requires `options.attempt` with a fresh child `attemptId`,
`claimId`, `maxMicro`, and awaited `consume()`, plus `report(terminal)`.
The host must freshly admit the account, consent, endpoint, ownership and budget;
this component does not make the full composition legally or financially usable.
A consume refusal performs no secret resolution or transport work.

Usage is provider-reported duration × the configured hourly price, rounded up
to whole USD micro-dollars, with dated provenance and `estimated: true`.
No actual billed-cost receipt has been observed. Missing/malformed terminal
usage, transport errors, cancellation, timeout and iterator abandonment retain
at least the child reservation as `uncertain`. REST HTTP 408/499 retain it too;
other transport-observed HTTP 4xx without usage may release it through the core
accounting helper. Settlement is once-only and host report failures propagate.
A final transcript is exposed only after successful settlement.

## Offline fixture evidence

`test/fixtures.js` attaches source URLs; fixture quantities and text are invented.
`test/configuration.test.js` proves invalid values cannot resolve secrets or open
either transport, using counters that would fire. `test/stt.test.js` exercises:

| Fixtures | Source |
| --- | --- |
| Readiness, binary audio, `audio.done`, corrected hypotheses, finalized segments/stitched utterance, duplicate terminal, premature terminal, missing terminal | [STT streaming events](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text#streaming) |
| REST multipart ordering, raw format/rate, transcript and provider duration | [STT request/response](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) |
| Malformed JSON, missing/invalid duration, oversize wire/text/input, cancellation, deadlines, late socket, refusal, report rejection and held reservation | Same contracts above, with deliberately invalid/stalled/oversized variants; local accounting expectations follow AIT-317 and core componentInvocation/AIT-340 |
| Unsupported voices/formats/rates/languages and incomplete/expired account evidence | [TTS formats/voices](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech), [STT formats](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text), [DPA](https://x.ai/legal/data-processing-addendum), [ZDR](https://docs.x.ai/developers/faq/security) |

The additive `sttConformance` run in
`test/speech-provider-conformance.test.js` exercises the actual streaming factory
and its convenience transcription path (including bounded input, active
cancellation/deadline, iterator return and fresh retries). The kit currently
requires dispatch on oversized input, so REST's stricter complete-file preflight
is tested directly without altering any shared-kit assertions.

## TTS and supported exports (AIT-345)

`createGrokTTS` uses the same immutable validator and separately consumed child
claim as STT. Each `speak` opens one injected socket, sends the exact text in a
`text.delta`, then `text.done`. Retries and fragments need new host admissions;
there is no internal retry. Voice is the configured `ara`/`eve`/`rex`, speed is
configured within 0.7–1.5, and language must belong to the configured DE/EN set.
Malformed Unicode is rejected. The text bound is `maxTranscriptCharacters`
(UTF-16 code units); accounting counts Unicode code points, including spaces,
speech tags, multi-byte letters and every constituent of an emoji sequence.
The configured micro-dollar tariff is rounded up once per invocation.

The eager reader drains independently of playback into a byte-bounded queue.
Wire messages are bounded by the shared TTS wire ceiling; strict canonical
base64 decoding admits only nonempty, even-length PCM16. Provider chunks are
at most 1 MiB, generated audio at most 16 MB per fragment, events at most
`maxEvents`, and yielded playback frames at most 64,000 bytes. All reads,
sends, opens and secret resolution obey cancellation/deadlines; cleanup has
a separate one-second lease and late-open sockets are closed. A slow playback
consumer cannot leave an open provider socket unread. Iterator abandonment
cancels unfinished generation and retains its reservation.

`audio.done` requires nonempty audio and a bounded trace identifier. It ends the
utterance without waiting for WebSocket closure (xAI keeps TTS sessions open).
Its trace is completion/debug evidence, **not a cost receipt**. Completed usage
remains `estimated: true`; errors, interruption (`audio.clear`), missing terminal,
cancellation and timeout retain at least the child reservation as `uncertain`.
The component never exposes a playback cursor: `heardPrefix: unavailable`.

| Export | Purpose |
| --- | --- |
| `@inspr/aithema-plugin-grok-voice` and `/server` | `createGrokVoiceProvider`, component factories and `createGrokComponents`, a guarded STT/TTS pair with offline `preflight` |
| `/components` | `createGrokSTT`, `createGrokStreamingSTT`, `createGrokBatchSTT`, `createGrokTTS`, validator, PCM constants and manifest |
| `/client` | `createGrokVoiceClient` and browser-safe manifest; host control/network/media ports, no credential path |
| `/manifest` | Public STT/TTS metadata; empty, closed public config schema because private account configuration belongs in the host binding |
| `@inspr/aithema-server/composed-voice` | Reusable coordinator and `callDurationSeconds`, with a core-only helper closure and bounded mono PCM playback |
| `@inspr/aithema-server/composed-voice/accounting` | `createComposedComponentAccounting`: durable host admission, observation and terminal ports for individual speech children |

The coordinator implementation lives in `voice-coordinator.js`; the old source
path forwards to it. Existing prototype release guards remain intact. Grok
imports use public core subpaths. Neither the coordinator nor the package imports
prototype component configuration, and server never depends on the Grok plugin.
Existing core `/voice-components` supplies `componentInvocation`, `boundedEvents`,
`audioQueue`, assertions and AIT-328 `preflightVoiceComposition`.

In the source-hosted demo, Grok's browser modules and the composed client helpers
load natively through relative public source URLs without an import map under
`script-src 'self'`, with external same-origin startup modules. Release packing
rewrites cross-package source URLs to declared package subpaths. A host consuming
installed package subpaths needs a bundler or an import map when unbundled, as for
the UI; an inline import map needs its exact hash allowed by the host CSP. Serve
the shipped `pcm-capture-worklet.js` beside the server's browser-audio module.

Await `createGrokComponents(...).preflight` before admitting any claims. Guarded
methods also await it before entering a component. It binds negotiation to actual
16 kHz PCM16 capture and 24 kHz PCM16 playback, checks languages/voice/capability
ceilings, and propagates `composition-*` errors before secrets or claims. This is
technical compatibility, not full-chain consent, account, reasoning or budget
admission. The existing reasoning-binding rule is unchanged.

### TTS offline fixtures

Every wire fixture is synthetic and cites the public contract in
`test/tts-fixtures.js`; no provider API calls or keys are used.

| Fixture group | Documentation |
| --- | --- |
| Exact `text.delta`/`text.done`, explicit PCM connection, `audio.delta` and `audio.done` with trace; missing trace/final | [TTS streaming contract](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#streaming-tts-websocket) |
| Malformed JSON/base64, noncanonical base64, odd PCM, oversized message/total, stalled reads, late open, eager drain and cancellation | [TTS streaming contract](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#streaming-tts-websocket), intentionally invalid/stalled synthetic variants bounded by core kit limits |
| Interrupted generation (`audio.clear`), uncertainty with reservation retained | [TTS interruption](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#interruption), plus AIT-317 accounting policy |
| Unicode code points (`Grüße 世界 😀 👩‍🚀`), fresh fragment/retry claims, estimated cost | [Pricing](https://docs.x.ai/developers/pricing), exact characters-sent/code-point policy from AIT-317 |
| Grok STT+TTS successful preflight, incompatible capture/playback and zero claims/transports on failure | [STT formats](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text), [TTS formats](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech), AIT-328 composition contract |

`test/speech-provider-conformance.test.js` adds `ttsConformance` for the real
Grok factory and synthetic ports. Existing provider assertions remain unchanged.
### Durable host accounting (package 4)

The ordinary Grok mount uses the runtime's owner-wallet and SQLite budget ports
for every speech admission. Hosts supplying their own `admitComponent` use
`createComposedComponentAccounting({ storage, budget, reserve, assertCurrent })`;
`reserve(session, admission)` must use the host's normal owner-wallet gate.
Its `admit` takes the call/provider/epoch identity, role, exact request, private
component binding and `maxMicro`. Mounted calls locate their persisted parent;
synthetic hosts may supply `parentAttemptId` explicitly. The reservation and
component scope share one budget row. Only request/binding digests and bounded
scope/cost metadata persist, without speech or text.

Every STT utterance, TTS fragment and retry receives a fresh child claim. Its
consume commits before provider dispatch. Synchronous `observe` persists the
largest observed cost before a terminal report can fail. Exact terminal retries
are idempotent; conflicting reports fail. Cancel, timeout, abandonment and crash
recovery retain at least the larger of the consumed reservation and observed
cost. Undispatched claims recover at zero. Completed speech estimates remain
estimated in the ledger and visitor cost display until receipt evidence exists.

The parent binding requires `maxMicro: 0` and `upstreamMicroPerMinute: 0`.
Its independent `visitorMicroPerMinute` still reserves and charges the ordinary
visitor tariff: elapsed active duration, with acknowledged pause intervals
excluded, rounded up once per segment. Parent closure or reconciliation never
settles or releases speech children. Reasoning keeps its existing admission and
accounting. Typed turns and lifecycle transitions carry call/provider/epoch identity, request
fresh claims for retries and leave unresolved children available to recovery after
logical-call closure. The visitor tariff is server-side **measured by Aithema**,
excludes acknowledged pauses and is confirmed at close. Upstream costs remain
estimated until a billed-cost receipt.


### Typed turns and call lifecycle (package 5, AIT-348)

`sendText(text, options)` now uses the supported authenticated network relay.
Text must be nonblank and at most 16,384 UTF-16 code units, matching ElevenLabs.
The browser supplies a fresh `deliveryId` for each submission; an explicit retry
may reuse that id within the same admitted segment. The shared composer forwards
its persisted `clientEventId`, so a retry after a lost response keeps that same
delivery identity. Repeated delivery returns
the same server turn id. Reusing an id with different text is refused; identical
text with distinct ids creates distinct turns. Provider session/epoch checks,
current consent/ownership authorization and pause holds fence every delivery.
The delivery id never becomes a reasoning operation key. Server-owned sequences
and immutable history envelopes share the spoken-turn commit chain and the
trusted admitted reply executor. Typing dispatches no STT child.

Physical capture exposes RMS from actual PCM16 samples, with a 150 ms stale
sample cutoff. Playback exposes an AnalyserNode measurement on the output graph.
`session.audioLevels()` reports independent input/output levels and zero during
holds or for disabled channels. Pause stops media synchronously, then requires
a durable `{ acknowledged: true, paused: true }` receipt. Resume cannot restart
capture before its matching acknowledgement. Recovery retains channel choices,
uses fresh bounded control/connect operations and the existing three-attempt
lifecycle policy. Hidden pages stay held on return; visible window blur keeps
running (AIT-116 D7).

Blocked playback calls the existing `onPlaybackBlocked` host callback. Only the
existing explicit playback retry invokes `session.retryPlayback()` to resume
the audio context; it does not dispatch STT, reasoning or another speech claim.
The bounded failed frame may play after unlock; interruption, output-off,
pause and replacement discard it. No playback-position or heard claim is made.

All presentation stays in the existing provider-neutral composer/audio rail:

| Fixture condition | Existing state / copy key |
| --- | --- |
| Listening / speaking / paused / recovering | Same-named `voiceStates` entries |
| Microphone permission denied / missing at start | `failed`: `voiceMicDenied` / `voiceMicMissing` |
| Admission refused at start | `failed`: `voiceAdmissionDenied` |
| Start deadline / transport failure | `failed`: `voiceDeadline` / `voiceConnectionFailed` |
| Three failed recoveries | Existing `waiting` state, reason `recovery-failed`; `voiceStates.waiting` |
| Auth lost after connection | Existing terminal `call-authorization-lost`; `voiceConnectionFailed` |
| Rate limit during transport recovery | Existing bounded recovery, then `waiting` / `recovery-failed` |
| Browser blocks playback | Existing `voicePlaybackBlocked` and `voicePlaybackRetry` action |

There is **no dedicated provider-authentication or rate-limit UI copy** in the
ElevenLabs reference. This gap is reported for the coordinator/Tick; package 5
adds no state, wording or provider-specific UI for it. Microphone errors retain
their DOM exception identity for the existing rail mapping.

Offline regressions live in `plugins/grok-voice/test/turns-lifecycle.test.js`.
`test/browser/composed-media.test.js` retains the physical fake-device journey
and adds the Grok light/DE 1440/390 viewport matrix, exact 0 px control geometry,
composer focus, typed-send and D7 visibility checks. With `AITHEMA_EVIDENCE_DIR`
it emits `ait348-<width>-light-de-<state>.png`, the 390 typed-send viewport and
`ait348-checks.json`. These are synthetic fixture results, **not yet qualified
in live use**. Tick's morning QA and the coordinator's review gate precede merge.

Package 6 adds the durable interruption marker and joined offline conformance
below, retaining the full answer and interrupted identity through recovery/reload
and duplicate events. ElevenLabs remains unchanged.

### Truthful interruption and joined conformance (package 6, AIT-349)

Grok reports no heard position. Barge-in stops the physical browser player
before relay acknowledgement, stops/fences server playback and aborts pending
speech synthesis. Admitted reasoning can finish; its **complete generated text**
remains the transcript record. A deduplicated `voice.interrupted` session event
binds the reply identity to `{ heardLength: 'unknown' }`, including interruption
before final publication. The event and transcript annotation survive replay,
reload and recovery. Subsequent reasoning receives that interruption fact and
explicit unknown-length guidance. It never receives a fabricated `heard` prefix.
ElevenLabs keeps its existing heard-prefix correction path.

The existing bubble metadata line renders a small cut/pause SVG and
**Unterbrochen** (DE) / **Interrupted** (EN), in the muted ink colour. Its
accessible description and tooltip are exactly:

- DE: “Die Wiedergabe wurde unterbrochen. Wie viel davon zu hören war, meldet dieser Anbieter nicht.”
- EN: “Playback was interrupted. This provider doesn't report how much was heard.”

`test/speech-provider-conformance.test.js` runs the STT/TTS kits against the
actual Grok factories. `test/joined-conformance.test.js` assembles the supported
public server/browser session with those factories, durable SQLite storage and
component accounting. The live kit's additive `parentMaxMicro: 0` fixture option
keeps the existing 1,000,000 default and all assertions. DE/EN exchanges observe
media effects, relay closure, persisted transcript and independently settled
TTS child costs; existing production-chain fixtures also exercise PCM/STT,
reasoning admission and recovery. The live kit covers rejected admission,
preflight cancellation/deadline, active cancellation, spend expiry and browser
lease expiry. Qualification remains **not yet qualified in live use**.

`test/browser/composed-media.test.js` captures eight settled, blurred viewport
shots named `ait349-<1440|390>-<light|dark>-<de|en>-interrupted.png`, with one
tooltip open. `ait349-checks.json` records metadata, bubble, text and control
rectangles before/after interruption: **0 px** movement. Baseline font stack and
reduced-motion settings are retained. Tick's morning UI QA and the coordinator's
review gate still precede merge.

AIT-350 adds the Settings switch; AIT-351 adds documentation and installed-artifact
verification. The isolated consumer installs shipped tarballs offline, imports
all exports and runs a joined synthetic STT → admitted reasoning → TTS call with
durable child accounting. Missing helpers/worklets, source-tree escapes and
excluded prototype dependencies fail the consumer gates. These fixtures do not
qualify German speech quality or a private xAI account.

Keep **not yet qualified in live use** in the manifest and notes until Markus has
used it; fixture qualification never changes the label. Tick's morning QA of
packages 5–7 and LEAD's RC decision gate merge. The next RC builder uses
`release/next-notes.md`; publication needs a later Markus Desk go. No tag, release,
live xAI call or publication is authorized by this package.
