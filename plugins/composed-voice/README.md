# Composed voice — AIT-160 PR 4a

This opt-in offline pipeline uses the AIT-102 server, browser-media, reply-executor,
and component ports. Import `src/server.js` directly; it adds no dependencies and
does not change the default ElevenLabs or fake-voice factories.

The trusted host injects `storage`, `authorize`, `commitUtterance`, the existing
Rule C `replyExecutor`, `admitComponent`, `stt`, and `tts`, then explicitly sets
`enabled: true`. A parent duration claim must have `maxMicro: 0`. Each component
gets a separate admission; the reasoning executor retains its existing durable
operation admission, publication, replay, and settlement. `commitUtterance` must
persist the frozen envelope atomically under its generation/utterance ID before
returning. Retries must reuse that exact envelope. Browser finals are never an
input to this coordinator.

PCM16 mono at 16 kHz enters a byte-bounded server relay. Server energy detection
and 500 ms silence endpoint the utterance, with a 30-second utterance ceiling.
STT must emit its final after endpointing. Capture order determines history even
when STT finalizers finish out of order. Exact text, history, context, generation,
epoch, and utterance sequence enter the immutable Rule C envelope. Text fragments
are limited to 240 characters and synthesized sequentially. Interruption flushes
playback synchronously and cancels TTS while admitted reasoning remains intact.
Pause revokes current media/work until authorization and acknowledgement permit
resume. Lease expiry waits; the independent spend deadline remains absolute.

`src/client.js` accepts host `capture`, `player`, and `openRelay` ports. `player.play`
must schedule audio in order and support synchronous `player.stop`. The player
receives an explicit encoding; Voxtral output is float32 PCM, not PCM16. The media
port bounds pending playback and prevents predecessor cleanup from stopping a
successor. Recovery uses AIT-138's three-attempt policy with an admitted fresh
server segment, new grant/generation, preserved channel choices and holds, and
no synthetic continuation greeting. The host supplies `control.recover`.

The relay is an in-process transport port with expiring, scoped, single-use
grants. PR 4b mounts authenticated network transport and physical browser media;
PR 4a installs no public relay route and loads no browser SDK or provider key.
Factories default to 900-second calls; `host: 'start2'` retains 3600 seconds.

`runOfflineQualification()` runs synthetic Austrian-German corpus observations
through the actual coordinator for candidate and baseline. It reports WER,
entity accuracy, speech-end to first audio p50/p95, and maximum barge-in stop time.
These deterministic fixture timings establish harness behavior only. Thresholds
are fixed at WER ≤8%, entities ≥95%, p95 ≤1500 ms, and stop ≤300 ms. Blind TTS
preference remains pending, so offline results never qualify a vendor.

`createQualificationBudget()` shares one $25 ceiling across candidate, ElevenLabs
baseline, all component/reasoning attempts, and retries. Reserve the maximum
before dispatch and settle once; uncertainty retains the entire reservation.
Estimated vendor cost also retains the full reservation rather than freeing spend.
The PR 4a cap is in memory and uses configured tariffs; it does not persist spend
or verify server-observed provider charges. Snapshots can retain attempt identities
and overrun blocks across restart only when a host persists and restores them.
Before any live run, PR 4b must persist this shared snapshot atomically before
dispatch, enforce verified pricing ceilings for every provider attempt, and
reconcile server-observed spend across candidate, baseline, components and retries.
The live runner must also collect actual media timestamps and Markus's blind
preference. That runner and keys belong to OPS.

No live calls, account provisioning, deployment, or qualification is part of this
slice. Later AssemblyAI/Azure support can implement the same component ports;
neither adapter is present here.

## ElevenLabs components — PR 4b-1 (offline)

The existing ElevenLabs agent remains the production default. No production preset
selects this factory. A trusted host can select the composed path without changing
code (substitute `voxtral` for either component to select that implementation):

```js
createComposedVoice({
  enabled: true,
  config: { stt: 'elevenlabs', tts: 'elevenlabs', host: 'new-host' },
  componentOptions: {
    elevenlabs: {
      stt: { binding: sttBinding, config: { secretRef: 'fixture-only', sttMicroPerSecond },
        resolveSecret: fixtureSecret, connect: fixtureSTTSocket },
      tts: { binding: ttsBinding, config: { secretRef: 'fixture-only', voiceId, ttsMicroPerCharacter },
        resolveSecret: fixtureSecret, connect: fixtureTTSSocket },
    },
  },
  consent: { port: authoritativeConsentPort, session },
  reasoningBinding: existingOpenRouterBinding,
  storage, authorize, commitUtterance, admitComponent,
  replyExecutor: existingRuleCExecutor,
});
```

This host defaults to 900 seconds; `host: 'start2'` retains 3600 seconds. Explicit
`maxDurationSeconds` remains supported. Components have no default transport or
secret resolver and default to disabled. Import ElevenLabs components directly
from `plugins/elevenlabs/src/components.js`; the agent manifest stays unchanged.
STT uses PCM16 LE mono 16 kHz, manual server endpoint commit, partial snapshots and
one committed final per utterance/socket. Independent sockets permit finalizers
to finish out of order; the coordinator preserves capture order. TTS receives
sequential fragments of at most 240 text characters, appends the protocol-required
space when absent, and requests `pcm_24000`. The player receives `pcm_s16le`;
Voxtral continues to receive `pcm_f32le`. Sampling metadata is available through
component `format`/`negotiateAudioFormat`; PR 4b-2 must carry that full format through
its authenticated media transport to the physical player. Abort closes the active
socket synchronously; missing finality, cancellation and disconnect retain cost
uncertainty. A transport ignoring abort cannot defer terminal reporting.

Each configured component binding supplies the actual account, endpoint, model,
purpose, recipient chain, categories and item version. ElevenLabs STT (`stream`)
and TTS (`speak`) use `voice-elevenlabs` version 1, whose existing copy covers
speech input, transcription and spoken answers. Existing OpenRouter reasoning
(`stream`) uses `models-international` version 1 with its actual selected model
processor and text/history categories. The selector checks all three exact scopes
through existing `consentCoverage` before admitting work, and each ElevenLabs
adapter rechecks its voice scope immediately before transport dispatch. Missing,
expired, withdrawn, wrong-version or wrong-scope grants block dispatch. The host
must include these exact scopes in its authoritative consent ledger; UI item
selection alone is insufficient. No new reasoning implementation is installed.

`estimateCost(request)`, `usageCost(usage)` and `reconcileCost(record, options)` use
the existing plugin hook names. STT reserves `ceil(maxDurationMs / 1000 * tariff)`;
TTS reserves the character tariff times the exact text including a trailing space
and the initialization space.
Tariffs in micro-USD are mandatory configuration, with no public-price default.
Usage reports audio seconds or wire-text characters (including initialization) and marks tariff costs as
estimated. These are not authoritative billable units or receipts. Reserve each
maximum before dispatch, then report once to the shared qualification budget.
Estimated success and uncertainty retain that maximum. A transport-observed 4xx
connection rejection with no usage settles at zero, except 408 and 499 (AIT-198).
Those timeouts leave provider state unknown and retain the reservation as uncertain;
protocol errors without transport rejection evidence also remain uncertain. `reconcileCost` returns
null unless an injected `reconcileReceipt` supplies matching `attemptId`, integer
`chargedMicro` and `estimated: false`. OPS must authenticate and persist that
receipt and apply it via the existing reconciliation ledger, without reporting
another terminal. No receipt lookup network code is included here.

`runOfflineQualification({ candidateComponents: item => ({ stt, tts }) })` runs
real component adapters against the unchanged synthetic baseline through the
coordinator. `item.reference` drives only the deterministic wire fixture, never a
quality claim. The harness reserves each component's configured ceiling in its
shared $25 budget; reasoning remains the zero-cost executor fixture. It reports
the existing metrics with synthetic 900 ms first-audio latency and 0 ms barge-in
stop time, blind preference pending, and `qualified: false`. Fixtures and source
sections are in `plugins/elevenlabs/test/component-fixtures.js`.

Protocol sources (checked 2026-10-15):

| Messages | Official URL and section |
| --- | --- |
| STT handshake, `session_started`, `input_audio_chunk`, `partial_transcript`, `committed_transcript`, auth/rate errors | https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime — Handshake; AsyncAPI schemas SessionStarted, MessagesSessionStartedConfig, InputAudioChunk, PartialTranscript, CommittedTranscript, ScribeAuthError, ScribeRateLimitedError |
| TTS handshake, initial space, text/flush, empty text end, audio and final | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input — Handshake; Send InitializeConnection/SendText/CloseConnection; Receive AudioOutput/FinalOutput and Messages examples |

Unverified offline: the TTS page examples spell finality `is_final`, whereas its
AsyncAPI spells it `isFinal` (this adapter uses the page example and rejects the
ambiguous alternative); acceptance of an empty STT commit chunk and provider
minimum duration; actual signed-16 LE mono output/account/model availability;
configured tariffs, whitespace billing and rounding; server usage/receipt fields;
latency, quality, retention and residency. Fixtures name these explicitly rather
than inventing provider usage. OPS must resolve them before a separately authorized
live run. PR 4b-2 owns network relay routes, physical capture/playback and full
format propagation; OPS owns atomic persisted budget snapshots, authenticated
receipts, measured timestamps, the live runner and Markus's separate go.
