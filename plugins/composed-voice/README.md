# Composed voice — AIT-160 (opt-in, unqualified)

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

### AIT-258: eager provider reader and bounded reply playback

The server drains each `tts.speak()` eagerly into one owned queue per reply.
A separate pacer alone waits for playback time. Its cursor spans fragments;
the first audio is immediate, and provider gaps earn no catch-up credit.
At 24 kHz mono, lead L = 1 s is 48,000 B PCM16 or 96,000 B float32.
Including a whole unfinished 64,000 B player frame gives at most 160,000 B,
below each 256,000 B relay/player bound, with 96,000 B left for polling/startup
and control frames. Higher rates cap lead bytes at 96,000 B as before.

At most **two fragments** are retained: the one being paced and one lookahead.
N+1 opens at N's provider terminal, after its accounting finishes. N+2 waits
until N's **last frame has been relayed**, including completion of `relay.audio`.
A FIFO drain marker per fragment enforces this even for an empty provider output.
Only one TTS stream per reply is open at a time. An open stream is always drained
eagerly; the wait happens before the next component admission. All fragments use
the same pacing cursor, so the lookahead hides synthesis latency at boundaries.

The enforced per-fragment duration allowance is `fragmentCharacters / 4` seconds.
The source for the conservative rate is [W3C CSS Speech 1, voice-rate](https://www.w3.org/TR/css-speech-1/#voice-rate),
which gives an illustrative English “x-slow” rate of 80 words/minute. Our explicit
planning conversion of five characters/word gives 6.67 characters/second;
**4 characters/second** allows a further 40% slowdown (48 words/minute). This is a
memory policy, not a guarantee for every language, number expansion or provider.
Slower or excessive output fails closed with `limit`; a fragment's generated PCM
is capped even when its earlier bytes have already been relayed.

For output byte rate `R = sampleRateHz × sampleBytes` (mono), a fragment's bound
`F = ceil(fragmentCharacters / 4 × sampleRateHz) × sampleBytes` rounds up to a
whole sample. The reply queue bound is **`2 × F + 64,000 B`**: two worst-case
fragments plus a maximum pacer-held provider chunk. The byte counter includes
that held chunk until all of its frames finish relaying, making the extra chunk
reserve conservative. At the default 240 characters and 24 kHz, F = 60 seconds:
2,880,000 B PCM16 or 5,760,000 B float32, with queue bounds **5,824,000 B PCM16**
and **11,584,000 B float32**. At the validated maximum 1,000 characters, the
24 kHz bounds are 24,064,000 B PCM16 and 48,064,000 B float32. Provider per-speak
limits still apply independently. A **1,024-chunk ceiling**, including the held
chunk, bounds tiny-chunk metadata. Either byte or chunk overflow is `limit`.

The fake-clock regression streams **30,000 characters at 10× real-time TTS**,
using 12 spoken characters/second, in both default formats and with 1,000-character
float32 fragments. Every N+2 dispatch observes N fully relayed, the retained PCM
never exceeds two fragments or reaches the derived ceiling, all audio arrives in
order, and each speak is accounted once. The existing end-to-end three-sentence
tests still assert a continuous player timeline with 1.5 s synthesis latency.
Queue memory is bounded per call by the pending-turn ceiling (four by default,
sixteen maximum), independent of reply length.

Silence first fences the revision and drops all playback queues synchronously,
aborting pacers and in-flight TTS. The pacer checks the revision again immediately
before `relay.audio`. Abort/end clears the queue waiter and playback timer; reply
cleanup joins the pacer. Interruption leaves admitted reasoning publication and
once-only per-speak terminal accounting under their existing contracts. The
`isFinal` / `speech.audio.done` paths still record usage once per completed speak;
an interrupted dispatched component still finishes as uncertain.

Transport inventory (all repo TTS transport implementations and injections):

| TTS host / injection | Per-message bound | Unread backlog bound | Eager reader behavior |
| --- | --- | --- | --- |
| ElevenLabs `ops/qualification-live-transport.mjs:connectQualificationSocket` | `ws maxPayload` 256,000 B wire | 256,000 B wire, then `provider`; outbound bufferedAmount also 256,000 B | Every arriving wire message is consumed without playback waits; independently arriving 136,748 B test messages leave zero backlog between arrivals. Already-coalesced bursts exceeding the transport limit still fail closed. |
| ElevenLabs server/demo qualification host (`ops/qualification-live-server.mjs`, loaded by `demo/server.js`) | Same 256,000 B | Same 256,000 B | Authorization wrapper delegates to the same socket; no separate server/demo WebSocket implementation. |
| Generic ElevenLabs host (`src/configuration.js` → injected `componentOptions.elevenlabs.tts.connect`) | Host-defined; component additionally caps 1 MiB decoded / 1,414,488 wire characters | Host-defined; no default connect installed | Every yielded PCM piece is enqueued without awaiting relay or pacing. Queue overflow aborts instead of leaving a reader stalled. |
| ElevenLabs `test/component-fixtures.js:fixtureSocket`, used by `components-wire.test.js`, `live-protocol.test.js`, composed `configuration.test.js` and `qualification-live-server.test.js` | No transport cap; synthetic fixed messages, component limits apply | Pull iterator, no independently arriving backlog | Eager iterator reads through `isFinal` before playback drains. Stall/error/late-connect overrides intentionally exercise cancellation. |
| ElevenLabs composed `test/egress.test.js` and `components-wire.test.js:burstTTS` | No transport cap; includes up to 1 MiB decoded fixtures | Pull iterator, no independently arriving backlog | Same eager drain; these support the generic connect contract rather than simulate the qualification socket. |
| ElevenLabs composed `test/provider-pacing.test.js:boundedSocket` | 256,000 B wire | 256,000 B wire, then `provider` | Independently delivered ~137 KB messages, including final, drain while the pacer waits; a negative control proves two unread messages fail. |
| Voxtral generic host (`src/configuration.js` → injected `fetchImpl`); qualification transport bundle offers `globalThis.fetch` but its candidate currently instantiates ElevenLabs | HTTP/SSE, **no TTS connect**; component caps 1 MiB decoded / 1,414,488 SSE-message characters | Fetch implementation controls network buffering; component SSE pending text capped at 1,414,488 characters; no repo fetch backlog ceiling | Reads and parses HTTP chunks/events without playback waits, including coalesced events, until done or server limit/abort. Voxtral `connect` is STT only. |
| Voxtral `test/wire.test.js` and composed `test/egress.test.js` injected Response/ReadableStream | No transport cap; component limits apply | Finite synthetic pre-enqueued SSE; no configured byte cap | Eagerly drains the response body through `speech.audio.done`, independently of playback. |

The 1 MiB decoded component allowance is a ceiling for generic injected connect
and HTTP/SSE transports, not a claim about the qualification WebSocket. That
socket's 256,000 B wire limit fits **less than 192,000 B decoded**, or roughly
191 KB after JSON metadata (base64 uses 4 wire characters per 3 PCM bytes).
Its tighter limit applies first. The 102,540 B observed chunk fits both. Keeping
the larger component ceiling preserves the round-1 generic-transport fixtures;
it cannot raise the qualification socket's payload or backlog allowance.

`test/provider-pacing.test.js` covers bounded arrival, ordering and L, eager final
accounting, dispatch before the preceding fragment's last paced frame, byte/chunk
overflow, and two buffered fragments interrupted by barge-in,
explicit interruption, output-off, pause, close, lease expiry and spend expiry.
The round-1 `egress.test.js` continues to cover both formats, sentence ordering,
provider gaps, HTTP relay/player traversal and stale-frame fencing. Three-sentence
tests add 1.5 s provider latency per fragment in both formats and verify that only
the first fragment delays playback, with no gaps at subsequent sentence boundaries.

`src/client.js` accepts host `capture`, `player`, and `openRelay` ports. `player.play`
must schedule audio in order and support synchronous `player.stop`. The player
receives an explicit encoding; Voxtral output is float32 PCM, not PCM16. The media
port bounds pending playback and prevents predecessor cleanup from stopping a
successor. Recovery uses AIT-138's three-attempt policy with an admitted fresh
server segment, new grant/generation, preserved channel choices and holds, and
no synthetic continuation greeting. The host supplies `control.recover`.

The relay retains its in-process transport port with expiring, scoped, single-use
grants. PR 4b-2 adds the explicitly mounted authenticated HTTP bridge and physical
browser ports described below. No production route or provider key is installed.
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
The offline PR 4a cap is in memory and uses configured tariffs; the separate
PR 4b-2 durable ledger below is mandatory for the OPS run. Snapshots can retain attempt identities
and overrun blocks across restart only when a host persists and restores them.
Before any live run, OPS must wire the PR 4b-2 persisted snapshot and verified
ceiling/receipt ports below across candidate, baseline, components and retries.
The live runner must also collect actual media timestamps and Markus's blind
preference. Runner execution, account integration and keys belong to OPS.

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

Protocol sources (checked 2026-10-16):

| Messages | Official URL and section |
| --- | --- |
| STT handshake, `session_started`, `input_audio_chunk`, `partial_transcript`, `committed_transcript`, auth/rate errors | https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime — Handshake; AsyncAPI schemas SessionStarted, MessagesSessionStartedConfig, InputAudioChunk, PartialTranscript, CommittedTranscript, ScribeAuthError, ScribeRateLimitedError |
| TTS handshake, initial space, text/flush, empty text end, audio and final | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input — Handshake; Send InitializeConnection/SendText/CloseConnection; Receive AudioOutput/FinalOutput and Messages examples |

OPS live evidence (mbp2606, 2026-10-16, code `7613fb5`), copied from
`/private/tmp/ait160-probes-1/probes-1/` into non-secret repository summaries:

- [TTS probe](../elevenlabs/test/fixtures/ait-250/tts-final-flag.json):
  `eleven_flash_v2_5`, voice `MGG5Irb57ATHvyIeTEYo`, `pcm_24000` returned
  `alignment`, `audio`, `isFinal`, `normalizedAlignment`; only `isFinal` was final,
  and no upgrade `request-id` was present. The adapter and plan require `isFinal`.
  We choose the live/AsyncAPI spelling only; the conflicting `is_final` page
  example is not evidence that the deployed provider supports both.
- [STT probe](../elevenlabs/test/fixtures/ait-250/stt-empty-commit.json):
  `scribe_v2_realtime` at 16 kHz, corpus 01.wav (35.413625 s), session at 262 ms,
  partials at 21575/22500/23515/32119 ms, then an accepted empty commit and a
  zero-character final at 35984 ms. This demonstrates loss, not successful commit.
  The [realtime API Messages example](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
  attaches `commit: true` to audio. We retain one owned chunk (at most 64,000
  bytes), send it exactly once with that flag when the coordinator ends its queue,
  and never send an empty commit. No partial is promoted to a final.
- The [manual commit guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)
  says processing starts after the first two seconds of audio. As a conservative
  processing guard, inputs shorter than two seconds receive trailing zero PCM up
  to two seconds. This adds no wall-clock wait to the coordinator's 500 ms
  endpoint; padding counts in the estimate, reservation check and reported audio
  usage. Empty input fails without a commit. This is not a claim about a verified
  account billing minimum; OPS's single long probe cannot establish that.

Synthetic wire responses follow these observed shapes and the documented
nonempty commit protocol. The corrected STT commit still requires OPS live
qualification. Unverified offline: account/model availability, configured tariffs,
whitespace billing/rounding/minimums, authenticated usage/receipt fields, latency,
quality, retention and residency. OPS must resolve them before the authorized
live run. PR 4b-2 owns network relay routes, physical capture/playback and full
format propagation; PR 4b-2 supplies the durable ledger, timestamp probes and guarded runner below;
OPS owns their account-specific integration, receipt authentication and execution
under Markus's separate live-run authorization.

## PR 4b-2 — offline live-run prerequisites

Production presets and the default factories are unchanged. Importing these
modules installs no route, opens no provider transport and requests no permission.
A trusted, explicitly enabled host now mounts its composed factory's
`networkRelay.handle(request)` at **POST /composed/relay** before its normal 404
handler. Pass `authenticateRelay(request)` returning the existing authenticated
owner token, and `relayOrigin` equal to the public host origin (the HTTP adapter's
internal URL is not the public origin). The factory checks the stored session
owner plus authoritative authorization before consuming the existing scoped,
expiring, single-use grant. No owner claim in a request body grants access.

The HTTP protocol uses `x-composed-action: open|frame|audio|command|disconnect`;
`open` posts the complete grant and returns a connection capability. Subsequent
POSTs include `x-composed-connection` and the host's existing authentication
headers. Grants/capabilities never enter URLs. `frame` is one outstanding long
poll; audio frames carry base64 PCM and explicit encoding, sample rate, channels,
reply ID and playback revision. `audio` carries binary PCM16 mono 16 kHz. The
relay bounds PCM requests to 16,000 bytes, ingress to 64,000 bytes/second,
requests to 80/second, connections to 64, and queued playback to 256,000 bytes.
Cross-origin browser requests are rejected; the host must retain its normal
request timeouts and TLS. Pause terminates this media grant immediately while
persisting the acknowledged hold. Resume requires `control.recover` to admit a
fresh segment, grant and generation through the existing AIT-138 path. Revoke
with `networkRelay.revoke(providerSessionId)`; expiry and authorization loss also
close media. The host must propagate consent/ownership withdrawal to that revoke
hook immediately, as well as its existing session/lifecycle controls.

Browser wiring (serve these modules from the host's own origin):

```js
const player = createPCMPlayer({ onTiming }); // browser-audio.js
const capture = createPCMCapture({ onTiming });
const media = createComposedBrowserMedia({ capture, player, control: existingVoiceControl,
  openRelay: createNetworkRelayClient({ url: '/composed/relay', headers: ownerHeaders }) });
const session = await media.connect(admittedGrant);
```

Capture requests microphone permission, resamples the AudioWorklet's native
clock to PCM16 LE mono 16 kHz, and transfers 40 ms/1280-byte packets with device
frame timestamps. Denial is surfaced; abort stops tracks even if permission
completes late. Capture failure uses the existing three-attempt AIT-138 recovery.
The player requires explicit `format`, `sampleRateHz`, `channels`, schedules both
signed-16 and float32 PCM in order, bounds queued duration, and synchronously
stops every active/future source on barge-in. Device output timestamps, rather
than callback arrival or fixture delays, establish first audio. Close the player
when the owning host is disposed. Local channel choices and holds survive
recovery; no synthetic greeting is generated.

### Shared durable $25 ledger

`persisted-budget.js` stores the entire qualification snapshot in a dedicated
SQLite database using `BEGIN IMMEDIATE`, WAL and `synchronous=FULL`. OPS explicitly
initializes it once. Reinitialization fails; the runner never creates a missing
snapshot or silently resets an interrupted run. All candidate, baseline, STT,
TTS, existing Rule C reasoning and retry attempts must use **this same file**.
Multiple processes serialize admission against the same snapshot. Reservation
and the dispatched state commit before `attempt.consume()` resolves, so a
provider transport cannot start first. Process death releases SQLite locks and
restores the full outstanding reservation. Attempt IDs cannot be reused, and a
persisted run identity rejects a silent re-run (AIT-212).

`openPersistedQualificationBudget({ path, verifyCeiling, verifyReceipt })` exposes
`admit(spec) -> { attempt, report, dispatch }`. Use `attempt` and `report` as the
existing component admission ports; wrap the existing Rule C reasoning admission
at its actual provider-dispatch boundary too, preserving its operation and
settlement ledger. `dispatch(action)` is an optional transport wrapper that
consumes first and reports uncertainty when the action fails to report. Do not
call consume twice. The trusted OPS integration must cover every attempt,
including baseline and retries; the zero-cost composed parent is not a substitute.

Each spec includes `attemptId`, `lane` (candidate/baseline), `role`
(stt/tts/reasoning), `provider`, `model`, `operation`, non-secret `accountRef`, `endpoint`, `maxMicro`, exact `request`,
and optionally `retryOf`. `verifyCeiling` is invoked both on admission and just
before dispatch. It must return account-verified `verified: true`, an evidence
`reference`, future `expiresAt`, and matching `provider`, `model`, `operation`,
`accountRef`, `endpoint`, `maxMicro`, `requestDigest` (SHA-256 of the JSON request). A configured tariff
alone is not verification. The proof must bound all billable request bytes,
initialization/whitespace, rounding, minimums, retries and maximum duration.

Reports are exactly once. Estimated charges, missing usage and uncertainty retain
the maximum. After dispatch and terminal settlement, only `reconcile(receipt)` with a trusted
`verifyReceipt(receipt, storedAttempt) === true` can release exposure. Receipts
must include matching `attemptId`, `provider`, `model`, `operation`, `accountRef`, `endpoint`, unique
`receiptId`, integer `chargedMicro`, and `estimated: false`. OPS authenticates
these server-observed receipts and also applies them through the existing AIT-198
reconciliation ledger, without a second terminal report. Identical receipts are
idempotent; conflicting receipts fail. An observed charge exceeding the attempt
ceiling or shared cap persists a sticky block before reporting the overrun.
Neither restart nor a later lower receipt reopens dispatch.

### OPS entry point and pre-live checklist

This PR executes **no live qualification**. Markus's 2026-10-15 Desk approval
allows the prepared live run up to $25; OPS owns execution, its account keys,
receipt authentication and account-specific host. No keys or environment files
belong in the repository. On OPS's designated run machine, initialize once:

```sh
node scripts/composed-qualification.js --operator-approved --initialize --budget /ops/run/qualification.sqlite
node scripts/composed-qualification.js --operator-approved --budget /ops/run/qualification.sqlite --plan /ops/run/plan.json --host /ops/run/host.mjs --out /ops/run/evidence --keys-file /ops/run/provider.keys
```

The plan is non-secret JSON: `runId` (unique explicit operator identity), `corpus`
(entries with `reference` and expected entities), `ceilingChecks` (complete pricing
specs), and `checks`. Every named check below needs `{ verified: true, reference:
"OPS evidence reference" }`; `ttsFinalFlag` also needs `spelling: "isFinal"`.
Missing checklist, persisted budget, verified ceilings or operator flag refuses
before any sample can dispatch. A crashed/failed run requires an explicit new
operator-approved plan; retain the original shared budget and attempt history.

OPS must resolve these PR 4b-1 unknowns **before** the run, with account/provider
evidence rather than trusting fixtures:

- `authenticatedRelay`, `physicalBrowserMedia`: mounted authenticated same-origin
  route, loopback secure context (TLS N/A locally), owner/consent revoke propagation, permission/physical device clocks.
- `consentAndHolds`: exact processing scope, Rule C, AIT-138 recovery and AIT-145/146
  holds remain authoritative; `ruleCAndNoSilentRerun`: preserve AIT-212.
- `verifiedTariffsAndRounding`: every provider/account/model ceiling, whitespace
  and initialization billing, rounding and minimum duration.
- `authenticatedReceipts`: actual usage/receipt fields and authenticated
  server-observed charges covering both lanes, components, reasoning and retries.
- `sttEmptyCommitAndMinimumDuration`: keep this existing checklist key, but
  verify the corrected nonempty final-audio commit delivers spoken text, the
  two-second processing guard and account billing minimums. An accepted empty
  commit with zero final text does not satisfy this check.
- `ttsFinalFlag`: use `spelling: "isFinal"` with the 2026-10-16 OPS probe above.
  The adapter and harness require this observed spelling; `is_final` is refused.
- `pcmOutputAndAccountModels`: real signed-16 LE mono output, sampling metadata,
  selected voices/models and account availability; Voxtral float32 remains distinct.
- `retentionAndResidency`: verify actual account policy and processing location.

The external host module exports `createQualificationHost({ keysFile, sampleTimeoutMs, controlFile, controlCapability })`.
The CLI forwards the operator's absolute `--keys-file` path without reading it;
an OPS factory that starts the server passes it as `AITHEMA_COMPOSED_KEYS_FILE`.
For a separately started server, OPS must use the same path in its launch instructions. Its factory must be
inert: transports dispatch only through admitted attempts during `runSample`.
The CLI checks the plan and reads the durable snapshot before loading this module. Its trusted server
ports are `verifyCeiling`, `verifyReceipt`, `reconcile({ snapshot, reconcile })`
and `runSample({ item, lane, runId, admit, onTiming })`, plus optional `close`.
`runSample` drives the mounted relay and **physical** capture/player, forwards
both ports' `onTiming` observations unchanged from the same browser clock, routes
every actual component/reasoning/retry dispatch through `admit`, and returns the
server-authoritative `hypothesis`, entity observations `[{expected,actual}]`, and
captured TTS `ttsPCM` plus `ttsFormat`. The existing reasoning executor retains
Rule C; this is no new reasoning implementation. `reconcile` authenticates and
persists provider evidence via the supplied shared-ledger reconciliation port
and the existing settlement ledger. Pending receipts retain full exposure.

The media probe measures the last physically captured voiced packet before
playback, first device-observed output, the next physical barge-in and synchronous
playback stop. It refuses incomplete capture/device evidence. Its 40 ms packet
resolution and output device timestamp resolution must accompany reported
metrics; server/browser wall clocks are never subtracted. `report.json` includes
WER, entity accuracy, first-audio p50/p95, maximum barge-in stop time and the shared
budget. `observations.json` preserves the real timing trace and each sample's `physicalBrowserMedia` output-device probe; `budget-final.json`
retains the final checkpoint even on failure when the output directory exists.
`blind.json` plus randomized per-utterance A/B `.wav` files and explicit formats
are Markus's listening material. Both lanes are normalized to PCM16 mono 24 kHz
so format metadata cannot reveal the provider; source formats remain in the OPS
answer key. Keep `ops-answer-key.json` and the provider-labeled
report private to OPS until Markus records his blind preference. `qualified`
remains false while that separate human decision is pending.

Offline checks live in `network-relay.test.js`, `persisted-budget.test.js`,
`live-qualification.test.js`, `media.test.js` and the fake-device Chrome test
`test/browser/composed-media.test.js`. The browser proof uses no provider/network
outside its local fixture, includes permission denial, ordered PCM16/float32
playback, synchronous barge-in/hold stop and fresh-generation recovery. Device
proof is not vendor latency, billing, quality or production qualification.

After a restart, OPS must confirm the previous dispatcher has stopped and explicitly
call `settleOrphan(attemptId)` for its dispatched attempts. This marks them settled
and uncertain while keeping their full reservation. Receipts for in-flight attempts
are refused; only settled attempts can be reconciled.

## Live qualification host — PR 4d

The OPS directory is **source-only** and excluded in full from release packages. Run this tooling from the repo checkout; the demo imports it only when qualification is explicitly enabled.

The provider-key-free `ops/qualification-host-template.mjs` exports the **inert**
`createQualificationHost(options)`. It launches Chrome locally by default; OPS can supply `launchBrowser` for a
browser under the same mba user on mbp2606.
It never starts, stops, probes for, or assumes a local host process. `hostOrigin`
is required: the browser-facing loopback http(s) origin, for example
`http://127.0.0.1:43101`. Bind address and port are separate settings. Literal
`127.0.0.1` and `::1` are accepted; DNS names, wildcard binds, credentials, paths,
queries and trailing slashes in origins are refused.

The primary topology is **local on mbp2606**, per Markus's 2026-10-16 Desk
7e722a84 decision: the flagged candidate host binds loopback, and candidate Chrome opens that same
`hostOrigin` on the same machine. Baseline Chrome opens the explicit production
`binding.baselineOrigin` over HTTPS in its own fresh profile. OPS supplies the agreed existing ElevenLabs and
OpenRouter keys in a short-lived keys file. The host starts as **mba**, with an
mba-owned 0600 file. TLS is N/A for this loopback secure context. No tunnel is
needed. The baseline always uses production, including in an alternative
candidate tunnel/container topology.

### Keys file

Set `AITHEMA_COMPOSED_KEYS_FILE` to an **absolute** operator-selected path. Only
when `AITHEMA_COMPOSED_QUALIFICATION=1`, the server reads this file before normal
provider setup, database startup or listening. There is **no environment-key or
default-path fallback**. It accepts only these literal `KEY=VALUE` entries
(values below are placeholders, never usable keys), ignoring blank lines and
lines whose first non-space character is `#`:

```text
# OPS supplies values privately for this run window only
ELEVENLABS_API_KEY=<OPS-provided-value>
OPENROUTER_API_KEY=<OPS-provided-value>
```

The path must identify a regular file, not a symlink, owned by the running user,
with mode **exactly 0600** (including no special, group or other bits). The loader
checks the opened inode with `O_NOFOLLOW`, bounds the file to 16 KiB, and refuses
unknown/duplicate keys, malformed lines, and missing/empty required keys. Values
are literal, not shell-expanded or unquoted. Refusals never include values,
input lines or filesystem error details. The reference server module receives the
frozen `keys` object; only server provider resolvers may use it. Never log it.
The template/CLI forwards the path and never reads the values. The file exists
for **the run window only**; OPS stops the host, then **trashes it afterwards**.
It never belongs in this repository, a plan JSON, browser options or evidence.
OPS supplies an **mba-owned** 0600 file; the CLI, host and Chrome all run as mba on mbp2606.

The demo mounts qualification only with `AITHEMA_COMPOSED_QUALIFICATION=1`:

| Setting | Contract |
| --- | --- |
| `AITHEMA_LISTEN_HOST` | Must be literal `127.0.0.1` or `::1`; checked before normal host initialization or listening. |
| `PORT` | Local host bind port, normally the same port in `hostOrigin`; independent only in the alternative tunnel topology. |
| `AITHEMA_COMPOSED_RELAY_ORIGIN` | Required explicit loopback http(s) **browser** origin. It controls Host and Origin checks and must also be passed to the composed factory's `relayOrigin`. |
| `AITHEMA_COMPOSED_KEYS_FILE` | Absolute run-window keys file; regular, non-symlink, running-user-owned, exactly 0600. Required under the flag. |
| `AITHEMA_COMPOSED_CONTROL_FILE` | Absolute path to the CLI-created per-run 0600 control file; server-only capability, run ID and shared durable budget path. Required under the flag. |
| `AITHEMA_COMPOSED_QUALIFICATION_MODULE` | Path to the repository's `ops/qualification-live-server.mjs`, exporting `createQualificationServer({ relayOrigin, authenticateRelay, storage, handlers, keys, binding })`. Loaded only with the flag. |
| `AITHEMA_COMPOSED_BINDING_FILE` | Absolute non-secret JSON binding file, required by the reference module; validated before provider setup or storage. The launcher generates it from OPS's explicit `binding`. |

The mount precedes the demo's JSON-only mutations and 404 so binary PCM reaches
`networkRelay.handle` at **POST /composed/relay**. It uses the existing visitor
owner cookie (`authenticateRelay`), and the composed factory still verifies the
stored owner, consent, authorization and single-use grant. OPS must retain immediate
revoke propagation. `/composed/qualification` is an authenticated minimal harness
page; its hook and the capture/player, network client, worklet and client module
dependencies are served from that same origin. The authenticated control endpoint
is `/composed/qualification/control`. Every call (start, poll, acknowledgement and close) requires the CLI's `x-aithema-qualification-control` capability header, compared through fixed-size SHA-256 digests with `timingSafeEqual`. The CLI creates a random 256-bit capability in a private temporary directory and an exactly 0600 file before loading OPS's factory. It hands that file to the host at startup via `AITHEMA_COMPOSED_CONTROL_FILE`; it removes the file after factory shutdown, including failures. The browser never receives the capability or file. Sample identities and acknowledgements travel in POST bodies, never URLs. Host/Origin mismatches and cross-site requests
are refused. Without the flag the page, control, relay and composed browser assets
return 404, and the OPS module is never imported. start2's normal preset is unchanged.

### Exact ports

OPS's account wrapper `host.mjs` exports `createQualificationHost({ keysFile, sampleTimeoutMs, controlFile, controlCapability })` and delegates to
the template with these options. There are **no successful accounting defaults**:

| Option or method | Required contract |
| --- | --- |
| `hostOrigin` | Browser-facing loopback origin; never inferred from a local process or bind port. |
| `runDirectory` | Absolute run root on mbp2606; default is the running user's `~/ci.noindex/aithema-runs/`. The template creates a hashed run directory and separate candidate/baseline Chrome profiles beneath it, retained as OPS evidence. No hard-coded mba paths. |
| `controlCapability` | CLI-generated per-run capability; only Node control requests receive it. Supplying it in browser `ownerHeaders` is refused. OPS passes `controlFile` to the server as `AITHEMA_COMPOSED_CONTROL_FILE` before host startup. |
| `ownerHeaders` | Candidate loopback owner cookie. Used only by candidate Chrome and Node control requests. Baseline never receives it. |
| `executablePath` | OPS's installed Chrome path (or explicit `CHROME_PATH`). No browser discovery or installation in the template. The default launcher arms the process-group watchdog before CDP setup. |
| `launchBrowser(launchOptions, lifetime)` | Optional launcher returning a Puppeteer `Browser`, including one connected over a DevTools websocket. Must register an independent browser-user watchdog and process-group kill port before returning. Baseline also requires `group.limitDeadline(deadlineAt)`, which acknowledges the shortened paid deadline before consume; see lifetime contract below. |
| `sampleTimeoutMs` | Hard wall-clock deadline for launch plus each sample, default and maximum 1,200,000 ms (20 min). CLI `--sample-timeout-ms` forwards this option to the OPS factory. |
| `verifyCeiling(spec)` | OPS account operation on the flagged host. Return the matching verified ceiling proof described above, including request digest, evidence reference and future expiry. Called at preflight, admission and consume. Missing port throws at factory construction. |
| `verifyReceipt(receipt, storedAttempt)` | OPS authenticates the server-observed receipt on the flagged host; return exactly `true` only for a matching trusted receipt. Missing port throws. |
| `reconcile({ snapshot, reconcile, baselineSessions })` | OPS fetches/authenticates/persists receipts, including ElevenLabs conversation GET and every OpenRouter generation of each labelled start2 baseline session; calls supplied `reconcile(receipt)`. `baselineSessions` includes attempt, visitor and provider conversation identities, also persisted privately on failures. Pending receipts retain exposure. Missing port throws. |
| `runSample({ item, lane, runId, admit, onTiming })` | `item.utterancePath` and `item.bargeInPath` are absolute PCM16 mono WAVs on mbp2606; `item.id`/`sampleId` identify the server sample. Launch a fresh profile; candidate opens `hostOrigin`, baseline opens `binding.baselineOrigin`. Admit every dispatch, then return `{ physicalBrowserMedia, hypothesis, entities, ttsPCM: Uint8Array, ttsFormat: { encoding, sampleRateHz, channels } }`. Candidate hypothesis/PCM come from the server; baseline hypothesis comes from production's final-user callback and PCM from the injected Web Audio tap. Baseline adds `baselineSession` with production visitor/conversation IDs. References stay in the CLI. `onTiming(event)` receives the browser's event values unchanged. |
| `close()` | Abort active samples and kill owned browser process groups; it has no host-process lifecycle authority. |

AIT's **reference server** `ops/qualification-live-server.mjs` returns `{ networkRelay, createSample }`. Construct the
composed factory with the supplied `authenticateRelay` and `relayOrigin`; expose
its `networkRelay` (including revoke/close). `createSample({ item, lane, runId,
owner, signal, admit })` must verify the stored session owner and exact consent/holds,
then return `{ grant, result, close }`. `result` is a promise for the authoritative
sample result above, with at most 16 MB of PCM, after all sample attempts report. This server accepts only `lane: candidate`; a loopback baseline refuses before admission.
Honor `signal` during setup; `close()` must stop this sample's media and work and
persist its terminal state. A close acknowledgement waits for setup and stop,
and another sample cannot start until stop is confirmed.
The generic mount allows one active sample and expires it after two minutes;
the browser requires complete physical evidence within one minute.

The server's `admit(spec)` is a remote port to the CLI's **same durable budget**.
It returns `{ attempt: { attemptId, claimId, maxMicro, consume, report }, report,
dispatch }`. Every STT, TTS, existing Rule C reasoning dispatch and retry must
use it; retries include `retryOf`. Await `attempt.consume()` before transport,
then report exactly once, or use `dispatch(async ({ attempt, report }) => ...)`
which consumes first and reports uncertainty if the action has no terminal.
Admission, consume and report each await the CLI's acknowledgement; failure or timeout blocks work. Each acknowledgement is independently checked against the shared ledger: admission must match the exact reserved attempt, run ID, lane, request digest, provider/pricing identity and server-derived claim ID; consume requires the committed dispatched state; report requires the committed terminal. Unknown, forged and other-run identities are refused, even with the capability. The mount resolves the identity from the ledger rather than trusting client fields. The mount drains reports before publishing the result.
The reference module places OpenRouter admission at its actual dispatch boundary
inside the existing Rule C operation store. The parent remains zero-cost. Provider
adapters and product wiring belong to AIT in this repository. Server-side receipt
verification/reconciliation, tariff ceiling proofs and keys remain solely with
OPS's account-specific ops-qa module. Estimated component usage and stream cost
never release reservations: every dispatched terminal retains uncertainty until
OPS supplies an authenticated receipt.

### Browser lifetime and output-device contracts

The template passes `launchBrowser(launchOptions, lifetime)` the same fake-capture,
unmuted-output and fresh-profile options as the default launcher. It awaits a
Puppeteer `Browser`. This port supports **same-host, same-user launchers only**:
Chrome and the probe/CLI run as **mba on mbp2606**. Cross-user launchers are
unsupported. It never forwards provider keys or the host's environment.

`lifetime` contains `signal`, `deadlineAt`, `timeoutMs`, `controllerPid` (the CLI
PID), and `registerProcessGroup({ kill, watchdogArmed: true })`. The launcher must
arm its watchdog **as the browser's OS user immediately when the detached Chrome
process group starts**, including while CDP connection is pending. It registers a
synchronous, bounded `kill()` port that kills that entire group under that user.
An unguarded returned Browser is refused before any sample.

`qualification-browser-watchdog.mjs` exports
`guardBrowserProcessGroup(chromePid, { deadlineAt, controllerPid })` for the
browser-user launcher. It returns that registration object and starts an
independent watchdog which kills the group at the deadline or when the CLI PID
vanishes, including SIGKILL/SSH loss. The default launcher registers this before
CDP setup. A same-user connected Browser's `process()` may be null; OPS retains
its original Chrome group ID for supervision. The output gate obtains that
Browser's PID **always** from CDP `SystemInfo.getProcessInfo`. If a local launcher
process exists, its `browser.process().pid` must equal that CDP PID. The process
must exist on this host and its full executable path from `ps -ww -o comm=`
(Linux: `/proc/<pid>/exe`) must exactly match CDP `Browser.getBrowserCommandLine`
`arguments[0]`. Only then does local `ps` read its UID, which must equal the
probe's own UID (`process.getuid()`), or the sample is refused. Missing/ambiguous
PIDs, executable mismatches and unknown process identity or UIDs also refuse.
Runner SIGINT/SIGTERM,
normal exit, host `close()` and sample cleanup also invoke the kill port. The
per-sample wall-clock abort races launch/page/control/media waits; the independent
watchdog is the final process-group deadline even if a port hangs.

Before **every sample**, after opening the authenticated page and before the
control `start` request/admission, `probePhysicalOutput()` requires **all**:

- Web Audio rendering on the default `sinkId` (`''` or `'default'`, recorded):
  both `getOutputTimestamp()` clocks (`contextTime` and `performanceTime`)
  advance across at least 500 ms, with finite `outputLatency > 0`.
- An OS record from `system_profiler SPAudioDataType -json` run as the browser/CLI
  user: exactly one default output, filtered to its name, transport and built-in
  status, plus the probe UID. No OS default output, or an unavailable record,
  refuses the run.
- Chrome's actual arguments from CDP `Browser.getBrowserCommandLine` (requires
  `--enable-automation`), and a verified same-user PID/UID check as above.
  Unavailable command-line evidence refuses; requested `launchArgs` and local
  `spawnargs` never substitute for Chrome's reply.

A silent oscillator drives the output clock without changing corpus audio.
A null/unverified device refuses the run **before any dispatch**. The template
records the result as `physicalBrowserMedia` in
`<runDirectory>/<hashed-runId>/<lane>-physical-browser-media.json`, including
failures; successful results also enter `observations.json`. Evidence retains
labelled/real/fake counts and separate label lists for diagnosis; device IDs are
not retained. **These labels/counts do not decide**: Chrome's
`--use-fake-device-for-media-stream` replaces enumerated outputs as well as
inputs, including default-output aliases, even when Web Audio renders to real
hardware. Zero latency or either stalled clock refuses a null output path.
**Positive latency and advancing clocks alone cannot exclude forced fake
streams**: Chrome's `--disable-audio-output` can synthesize both (its
[fake stream supplies synthetic delay](https://github.com/chromium/chromium/blob/main/media/audio/fake_audio_output_stream.cc)).
The gate also refuses explicit muted/fake/missing/alternate-output switches,
service wrappers and service/sandbox overrides in Chrome's actual arguments,
independently of the measurements. Both `--switch` and `-switch` forms are
checked. The single refusal policy and its Chromium sources live in
`qualification-output-probe.mjs` (`findRefusedOutputFlags`); it covers
`mute-audio`, `disable-audio-output`, `fail-audio-stream-creation`,
`alsa-output-device`, `use-cras`, `force-wave-audio`, utility/child executable
wrappers, service sandbox/type overrides, `audio-service-*` switches and
`AudioService*` feature overrides. The measured `--disable-features=AudioServiceSandbox`
capture setting is allowed. The normal runner applies the same policy before launch. The plan's existing checklist
cannot bypass this probe.

### Reference binding and launcher

Use `ops/qualification-live-server.mjs` with your non-secret `binding`; OPS no
longer implements a server module or provider adapter. Its constructor is inert:
no sockets, provider requests or credentials are resolved until `createSample`.
`handlers.consent` is the host's authoritative exact-scope consent port. The demo
loads the binding before normal initialization, includes its four processing
bindings in the normal consent document, and passes that same ledger to the
module. Missing or malformed money settings refuse construction.

| Binding field | Required value / source |
| --- | --- |
| `stt` | Processing binding for ElevenLabs `scribe_v2_realtime`, plus explicit integer `microPerSecond >= 0`. |
| `tts` | Processing binding for fixed ElevenLabs `eleven_flash_v2_5`, plus saved `voiceId`, required `voiceSettings` (below), and explicit integer `microPerCharacter >= 0`. |
| `tts.voiceSettings` | Required complete object `{ stability, similarity_boost, style, use_speaker_boost, speed }`. Stability and similarity boost are finite numbers in `[0, 1]`; style is `null` or a finite number in `[0, 1]`; speaker boost is `null` or boolean; speed is a finite number in `[0.7, 1.2]`. All five fields remain required. Missing, extra, or invalid fields refuse before provider setup. Copy the saved start2 values, including explicit nulls. |
| `reasoning` | Existing OpenRouter private binding: `plugin`, `model`, `effort`, `endpoint`, `accountRef`, `secretRef`, `maxMicro`, `maxTokens`, `maxInputTokens`, `rates: { inputMicro, outputMicro }` and `legal`; optional `routing`. Rates are integer micro-USD per token. No model/routing fallback. |
| `baselineOrigin` | Required canonical HTTPS production origin, without path, credentials, query or trailing slash. Loopback/localhost refuse; no default. Chrome runs production's normal visitor/consent/voice flow there. |
| `baselineAuthFile` | Optional binding field, but required to run the baseline behind start2's basic-auth gate; missing refuses before admission. Absolute mba-owned 0600 regular non-symlink file containing JSON `{ "username": "...", "password": "..." }`. Inode, owner, mode and 16 KiB bound use the same checks as `loadQualificationKeys`. |
| `baseline` | ElevenLabs processing binding whose `model` equals its existing `agentId`, plus explicit integer `microPerMinute >= 0`; proof must cover the whole agent conversation, including its provider-managed reasoning/STT/TTS. |
| `baseline.tts` | Required saved-agent snapshot `{ model, voiceId, voiceSettings }` from the same GET. `model` is the agent TTS `model_id`, separate from the processing binding's agent ID. Voice ID and all five settings must match candidate `tts`; the TTS model may differ. |
| `baselineReasoningCeilingMicro` | Required explicit nonnegative safe integer micro-USD ceiling for **all start2 facade OpenRouter reasoning** in one baseline conversation, including opener, replies, interruptions and retries. No default; OPS attests it together with the ElevenLabs ceiling. |
| `maxDurationSeconds` | Explicit positive integer, at most 120 (`MAX_SAMPLE_SECONDS`); no default. Determines the paid baseline ceiling and sample deadline. The relay's 60-second connection grant is separate from the paid lifetime. |
| `reasoningAttempts` | Defaults to 1; optional explicit 2 (`MAX_REASONING_ATTEMPTS`). The bound covers all reasoning dispatches, including transport and guarded-output retries. Each retry needs a new admission with `retryOf`, within the same Rule C operation. Transport retry requires failure before any text. Effort must stay `none`, matching production's voice reaction binding. |

Before the paid run, OPS reads **GET `/v1/convai/agents/<start2 agent>`** and
retains its non-secret `conversation_config.tts` snapshot with the run evidence.
Copy `voice_id` to `tts.voiceId` and `baseline.tts.voiceId`, and `model_id` to
`baseline.tts.model`. Copy the five settings from `conversation_config.tts` to
both `tts.voiceSettings` and `baseline.tts.voiceSettings`; if the saved agent
returns them under `conversation_config.tts.voice_settings`, use those values
for the corresponding keys (nested values take precedence). Do not invent
missing settings or copy other agent configuration into the binding.
The candidate model remains `eleven_flash_v2_5`; each synthesis connection sends
the non-null validated settings as `voice_settings` in its initialization message.
The [stream-input AsyncAPI schema](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
defines `RealtimeVoiceSettings.style` and `.use_speaker_boost` as optional number
and boolean fields, without nullable types. Therefore saved nulls are omitted
on the wire. Effectively, null means the voice's own default, the same thing the
saved agent gets; it must never be replaced with an invented `0` or `false`.
ElevenLabs also describes [request voice settings](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
as overrides of the voice's stored settings. For start2's saved
`{ stability: 0.5, similarity_boost: 0.8, style: null, use_speaker_boost: null, speed: 1 }`,
the request sends `{ stability: 0.5, similarity_boost: 0.8, speed: 1 }`.

The candidate uses the same exported `buildVoiceReplyRequest` as production's
voice reply lane, bound by the host handlers to their purpose policy, host
prompt and safeguard state. Canonical session history, withdrawals, current
understanding/focus and the latest person input receive the same shaping.
The purpose-policy JSON is buffered and decoded by the production guard before
TTS; the default single reasoning attempt cannot hide extra paid retries.
The reference launcher starts each corpus sample with a fresh consented candidate
session, matching the baseline's fresh production visitor session. Canonical
person and assistant history is retained within that sample.

`observations.json` records `ttsConfig: { model, voiceId, voiceSettings }` per
sample. `report.json.tts.candidate` and `.baseline` list those same configurations
in corpus order, including both TTS model IDs and all settings with nulls
preserved exactly. `report.json.ttsNullSemantics` states the effective default
behavior and wire omission. The private
`ops-answer-key.json` also associates each audio file with its source TTS
configuration. These OPS files disclose the fixed-model difference; `blind.json`
and the A/B WAV labels retain no lane or settings information. Keep the report
and answer key private until the blind preference is recorded.

Each processing binding supplies `plugin`, `model`, `endpoint`, `accountRef`,
`secretRef`, optional `routing` and `legal: { purpose, consentVersion: 1,
recipient, processors, dataCategories }`. The legal purpose is
`voice-elevenlabs` for STT/TTS/baseline and `models-international` for reasoning.
Endpoint origins are the existing `https://api.elevenlabs.io` and
`https://openrouter.ai/api/v1/chat/completions`. Secret references are exactly
`ELEVENLABS_API_KEY` and `OPENROUTER_API_KEY`; values belong only in the keys file.
Tariffs must come from OPS proofs, including any billable whitespace or rounding.
There are no example tariff values that could accidentally authorize a paid run.

The candidate uses the composed coordinator, real ElevenLabs component parsers,
OpenRouter adapter and existing Rule C executor/store. The baseline opens the
**real production path on its own origin (start2)**, unchanged, with the identical
fake-capture corpus WAV and output flags in a separate fresh profile. It creates
its own production visitor session, confirms the consent purposes authorized by
OPS through the consent page production presents, and starts voice through the
normal readiness control. There are no agent settings writes or SDK/prompt/model/
voice/opener overrides from the harness.

A production agent cannot answer through the loopback host: its custom LLM is
bound to the production facade URL (`plugins/elevenlabs/src/ensure-agent.js:198`).
That facade requires `elevenlabs_extra_body.aithema_call`
(`plugins/elevenlabs/src/facade.js:86`–87), supplied by production's normal client
(`plugins/elevenlabs/src/client.js:468`). The removed loopback bridge omitted that
identity. The isolated loopback host runs voice off and serves no facade
(`plugins/composed-voice/ops/qualification-live-host.mjs:47`), and ElevenLabs cloud
cannot reach loopback without a tunnel. Markus's topology has no tunnel. The old
`ops/qualification-live-baseline.mjs` now hard-refuses all calls; it never mints a
credential or opens a paid conversation.

`ops/qualification-baseline-probe.js` is injected with `evaluateOnNewDocument`
before production scripts. It observes the unchanged microphone stream and Web
Audio output, including the SDK's WebRTC media element through a silent parallel
Web Audio tap. Device frames/output timestamps supply the same capture,
playback-start and playback-stop event contract as the candidate, including the
WAV speech-end and barge-in timeline. The ScriptProcessor observation block is
1024 frames; capture RMS 0.015, trace 100,000 events and PCM 16 MB use the existing
candidate/evaluator limits. Output has its own level criterion and sustained
stop window below. No fixture timing offset reconstructs evidence.
Production's first final user callback (ordinal 1) supplies the hypothesis and
anchors reply attribution. Capture silence is never a committed utterance end:
internal pauses cannot release reply evidence. Rendered output is buffered
(up to 16 MB) until that final, then attributed using the last voiced capture
end and the original output-device timestamps. Reply PCM that preceded the
user final is retained; late/missing **reply** assistant finals do not move onset.
The opener is identified separately by the first assistant final and production's
SDK speaking-to-listening transition (`.audio-rail[data-state]`), followed by an
observed silent rendered block on the graph that played it. Its sentence gaps
cannot complete it. These signals and output drain must precede the first voiced
user capture. If they do not, the sample terminates as `opener-overlap`, with
no retry inside that attempt and no PCM/metric result. The private
`baseline-invalid-<sample-hash>.json` records the refusal and session labels;
the consumed attempt remains uncertain until authenticated combined receipts.
If speech resumes over a buffered reply before ordinal-1 final arrives, the
sample is refused as `barge-in-before-user-final`; it cannot fold that speech
into corpus speech end. The same value-free refusal record is written once,
without transcript or PCM and without a retry. A final can still arrive after
reply onset when no barge-in has begun. The candidate commits its user transcript
before executing the reply, so this ordering cannot occur in that lane.
Trace and pending-output limits report `trace-bound` and `output-queue-bound`.
Failures before dispatch use `setup-failed` or `not-admitted`, rather than
claiming that admitted media was invalid.
Missing ordinal-1 final cannot release buffered output: the existing duration,
wall-clock, trace and PCM bounds stop it and retain uncertain exposure.
Barge-in remains the next voiced capture at or after the original reply onset.

### Sustained rendered-output stop

Both lanes call the same `installQualificationOutputProbe().stop()` implementation
in `ops/qualification-output-timing.js`. `stoppedAt` is the start of the first
**1000 ms continuous silent run after barge-in**, confirmed only after its entire
last PCM block has rendered according to `getOutputTimestamp()`. The confirmation
window is evidence collection; the 300 ms interruption pass bar still measures
from barge-in to the run's **start**. Speech resuming within the window resets
the run. Missing blocks, invalid levels/durations, and blocks crossing barge-in
or teardown cannot fill a run. Chromium stamps ScriptProcessor buffers with the
context frame at main-thread dispatch (`ScriptProcessorHandler::FireProcessEvent`),
so adjacent timestamps can shift in phase. Continuity allows up to half a block
of dispatch jitter; a whole missing block breaks the run. Only delivered PCM
counts toward its duration, and the rendered-clock interval must independently
reach 1000 ms: faster or duplicate callback delivery cannot shorten the window.
No sustained run before the
existing observation deadline is `missing-playback-stop`; there is no extension
of the paid duration. Stop requests alone cannot establish this evidence.

The 1000 ms minimum is a conservative engineering choice informed by
[Heldner & Edlund (2010), *Pauses, gaps and overlaps in conversations*, Table 2](https://staff.fnwi.uva.nl/r.fernandezrovira/teaching/cosp/cosp2016/docs/HeldnerEdlund2010.pdf)
(DOI `10.1016/j.wocn.2010.08.002`): their literature compilation reports
within-utterance pauses with mean 300 ms, median 280 ms and SD 210 ms. One second
is more than three times that mean and rejects word gaps of 120/250 ms as well
as longer 600/980 ms gaps in the regressions. This is a finite observation policy,
not a claim that all human speech pauses are shorter than a second. The existing
offline reply fixtures are continuous synthetic tones
(`test/fixtures/composed-qualification-provider.mjs` and
`test/fixtures/qualification-production-origin.mjs`), not recordings of TTS speech;
they cannot establish a real-speech intra-utterance p99. The literature supplies
the duration rationale rather than inventing a speech percentile from those tones.

Output silence uses **RMS < 0.01 × peak pre-barge-in rendered reply-block RMS**
(-40 dB relative amplitude, `20 × log10(0.01)`). This ratio is the single
output-level constant shared by both lanes, separate from capture's absolute
0.015 VAD threshold. It is an explicit relative attenuation criterion derived
from each sample's own reply level, not a microphone noise assumption. The
reference is frozen to pre-barge-in reply blocks, excluding the baseline opener;
neither a fading tail nor resumed output can move it. An above-threshold fade
tail remains output; a sub-threshold tail can begin the quiet run. A missing or
zero reference cannot prove a stop. The trace records `outputRmsThreshold`,
`silenceDurationMs`, `confirmedAt`, and both output timestamps so the decision
can be inspected. Blind reply PCM is still cut at `stoppedAt`, not confirmation.

Before voice start, Node admits exactly one baseline attempt and awaits its
consume acknowledgment. Its ceiling is
`ceil(binding.baseline.microPerMinute * binding.maxDurationSeconds / 60) + binding.baselineReasoningCeilingMicro`,
covering the whole ElevenLabs conversation **and start2 facade OpenRouter reasoning**
inside the same persisted **$25 shared cap**. The spec uses `lane: baseline`, `role: reasoning`,
`provider: elevenlabs`, `operation: start`; its request includes the production
visitor ID, hard duration and explicit reasoning ceiling. Duplicate start, recovery, resume/takeover and
replay requests refuse. The browser process watchdog acknowledges a shortened
absolute deadline before consume, so a stalled Node/CDP operation cannot extend
paid media. Normal visitor close starts 250 ms before that deadline; the browser
group is killed at the bound. This is a shutdown allowance inside the bound.
Dispatched attempts report **uncertain**, with no invented zero charge. Only
OPS's authenticated **combined** receipt through `verifyReceipt` / `reconcile`
releases exposure: it must reconcile the ElevenLabs conversation GET **plus all
OpenRouter generation receipts of the labelled start2 visitor/call session**,
including any opener, reply, interruption and retry reasoning. An ElevenLabs-only
receipt is incomplete and must not pass `verifyReceipt`; until both sides are
complete, the terminal stays uncertain and the full combined ceiling stays
reserved. OPS supplies the aggregate actual `chargedMicro` under the baseline
attempt's identity. The generic ledger delegates receipt completeness and
provider authentication to OPS's required `verifyReceipt` port.

OPS's additional inputs for this baseline are the account-verified
`binding.baselineReasoningCeilingMicro`, its combined ceiling proof, the labelled
start2 session-to-OpenRouter-generation mapping, and authenticated receipts for
both billing sides. Coordinator constraint for OPS: cap **all OpenRouter spending
across the whole plan at ≤ $8** (candidate plus baseline, including retries),
within Markus's $25 total. OPS sizes the plan/reservations and account controls to
that constraint; it is an operator input, not a hard-coded code allowance.

Basic-auth values are opened only for the baseline. A CDP `Fetch.authRequired`
handler provides them only for a Basic **server** challenge whose origin exactly
matches `baselineOrigin`; other origin/proxy/scheme challenges are cancelled.
Credentials never enter a URL, page evaluation, header override, log, error or
evidence. The candidate/loopback host never receives them; the generated child
binding omits `baselineAuthFile`. Baseline Chrome receives no loopback
`ownerHeaders`, control capability or provider keys. Its visitor cookie comes
only from production. The existing actual-command-line / same-user CDP process
binding and output-device gate apply to both lanes.

Each baseline's `baselineSession` records `visitorSessionId`, `providerSessionId`
(the ElevenLabs conversation ID), `attemptId`, `runId` and corpus sample ID in
`observations.json` and `baseline-session-<hashed-identity>.json` under the private
run directory. Available identities are saved even on media failure and forwarded
to OPS as `baselineSessions` on reconciliation. These labels distinguish the run
from real visitors without any product change on start2. An unavailable provider
ID retains uncertain exposure for OPS orphan handling.

Candidate `createSample` requires `item: { id, sessionId, expectedEntities: string[] }`,
`lane: candidate`, run ID, authenticated owner, signal and admission port. Expected
entities travel only over Node's capability-authenticated control port; references
stay in the CLI. Matching uses the evaluator's NFC, de-AT case and whitespace
normalization with letter/number boundaries. Candidate revocation waits for
pending setup, media/work stop and terminal reports before acknowledging consent,
pause, settings, withdrawal, session erasure **or visitor-wide erasure**. The
qualification operations mapping preserves HTML's `generate` / `edit` scopes.

OPS receives these provider-observed accounting identities; local attempt IDs,
claim IDs, voice IDs and trace IDs never substitute for a provider billing identity:

| Attempt | Terminal / persisted attempt fields available to OPS | Wire evidence and receipt lookup |
| --- | --- | --- |
| Candidate reasoning (each retry separately) | `generationId` and `identity: { generationId }` when present; otherwise `identity: null`, `identityReason: 'provider-identity-not-observed'` | OpenRouter response `id`, accepted only by core `generationId` (`gen-` plus 1–124 ASCII alphanumerics/hyphens). Shared `chat-completions.js` parses SSE events and non-streamed JSON, including error responses. OPS authenticates the matching OpenRouter generation receipt. |
| Candidate STT (each utterance attempt) | `identity: { sessionId, requestId? }`; a returned request ID alone may survive a missing/invalid session message. If neither is observed: `identity: null`, `identityReason: 'stt-provider-identity-not-observed'` | ElevenLabs realtime `session_started.session_id`; optional upgrade response `request-id`. IDs are bounded to 1–128 ASCII alphanumerics/underscore/hyphen. OPS must authenticate attempt-bound STT billing evidence; a session ID itself is no cost receipt. |
| Candidate TTS (each fragment attempt) | `identity: { requestId }` only if actually returned; otherwise `identity: null`, `identityReason: 'no-request-id'` (OPS observed no header). Every dispatched terminal also carries `matchingKey: { voiceId, modelId, characterCount, textSha256, startedAt, endedAt }`. | OPS searches authenticated ElevenLabs TTS history using the matching key, then authenticates an attempt-bound charge. `textSha256` is lowercase SHA-256 of UTF-8 concatenated nonempty wire text (initialization space + fragment including trailing space); `characterCount` counts Unicode code points in those same characters. UTC ISO timestamps bound dispatch through terminal reporting, including failure/cancellation. Raw text is never retained in this key. A matching key is not a provider ID or receipt; ambiguous/no matches keep uncertainty. |
| Baseline (one combined attempt) | `baselineSessions` / private baseline-session file: `attemptId`, `visitorSessionId`, `providerSessionId` (ElevenLabs conversation ID), `callId`, run/sample labels | Existing production visitor-to-conversation mapping plus OPS's start2 session-to-OpenRouter-generation mapping; both billing sides must be complete. Baseline IDs stay in `baselineSessions`, not candidate terminal `identity`. |

Candidate terminals pass through the acknowledged control port; the durable ledger
retains only `generationId`, `identity`, `identityReason`, validated `servedModel`
and the bounded six-field `matchingKey` (extra fields including text are dropped)
as accounting metadata. These fields survive restart in `snapshot.records` passed
to `reconcile` and in `storedAttempt` passed to `verifyReceipt`. Missing terminal
evidence on early shutdown also yields explicit null/reason. Every consumed
candidate terminal remains **uncertain**, even with an ID or streamed usage;
only an authenticated matching receipt releases its reserved ceiling. OPS must
retain uncertain exposure/orphan handling when no lookup identity is available.

Sources: the synthetic [component wire fixtures](../elevenlabs/test/component-fixtures.js)
(`sttWire.session`, `ttsWire.audio`, `ttsWire.done`), ElevenLabs
[realtime STT SessionStarted](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime),
[TTS WebSocket AudioOutput/FinalOutput](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input),
and [Tracking generation costs](https://elevenlabs.io/docs/api-reference/introduction/)
(`request-id` response header). The last source demonstrates HTTP metadata;
it does **not** guarantee that a WebSocket upgrade returns that header. The
transport records it only if actually present; the existing no-header TTS fixture
therefore records null with `no-request-id`. OPS live evidence above confirms
that absence for the probed account. These sources establish identity shape, not a verified
STT/TTS billing API or guaranteed receipt availability.

`ops/qualification-live-host.mjs` exports `launchQualificationHost(options)` and
`createQualificationHost(options)`. The former starts the flagged demo on the
explicit loopback origin, creates a visitor through `/api/sessions`, retains its
owner cookie, checks the current consent contract and records OPS's explicit
`consentDecision`. It returns `{ hostOrigin, sessionId, ownerHeaders, close }`.
The latter wraps that result in the existing browser template and closes both
browser groups and the owned host. Ordinary demo voice/image/HTML initialization
is off in this isolated host, so startup never ensures or modifies an agent.
The launcher forwards keys/control paths without opening either file, filters the
child environment, and never records child output or owner headers as evidence.
The generated binding file is removed at shutdown; database and run evidence stay
in `runDirectory`. All processes run as mba on mbp2606, in the same user/session.

OPS still supplies exactly:

- `verifyCeiling(spec)` with enforceable tariff proofs for every attempt and retry;
- `verifyReceipt(receipt, storedAttempt)` and `reconcile({ snapshot, reconcile, baselineSessions })`
  using authenticated receipts matched to the per-attempt identities above (baseline
  requires ElevenLabs conversation GET plus all facade OpenRouter generation receipts);
- the short-lived, mba-owned 0600 provider keys file;
- `binding.baselineOrigin` (the real HTTPS start2 origin) and
  `binding.baselineAuthFile` (absolute mba-owned 0600 basic-auth JSON for this gate);
- a fresh GET `/v1/convai/agents/<start2 agent>` → `conversation_config.tts`
  snapshot: saved `voice_id`, `model_id`, and all five voice settings; supply
  `binding.tts.voiceSettings` and `binding.baseline.tts: { model, voiceId,
  voiceSettings }` with matching voice/settings, keeping candidate
  `binding.tts.model: "eleven_flash_v2_5"`;
- production's OpenRouter speech binding with `reasoning.effort: "none"` and
  `reasoningAttempts: 1` by default (an explicit 2 remains separately admitted);
- the verified whole-conversation `binding.baseline.microPerMinute` tariff and
  explicit `binding.maxDurationSeconds` hard bound of 1–120 seconds, with account-specific rounding;
- separate corpus inputs generated by the coordinator: each `plan.corpus` item
  supplies absolute `utterancePath` and `bargeInPath`, plus its existing `id`,
  `reference` and `expected`. Emit one `utterance.wav` per item containing ONLY
  that utterance, and a shared `barge-in.wav` containing ONLY the interruption
  phrase (the same path can be reused by every item). Both inputs are RIFF WAV,
  PCM16 little endian, mono, 8–96 kHz, nonempty, at most 16 MB each. Trim leading
  and trailing silence from the two clips; do not concatenate the phrase, add a
  20 s prefix, or encode a reply/barge-in offset. Internal speech pauses stay.
  The harness validates both inputs before either dispatch and feeds identical
  bytes to both lanes. `leadingSilenceMs` is optional, ignored and unnecessary;
- the explicit non-secret binding, current consent decision, and plan (corpus WAVs,
  reference sentences, `expected` string or string array, checklist and ceilings);
- the installed Chrome path and required output-device/protocol probes;
- execution on mbp2606 as mba, private evidence retention, orphan handling,
  reconciliation, host shutdown and keys-file disposal.

Example OPS account wrapper (paths only; import binding/decision from OPS's
non-secret run configuration):

```js
import { createQualificationHost as reference } from '/path/to/aithema/plugins/composed-voice/ops/qualification-live-host.mjs';
import { verifyCeiling, verifyReceipt, reconcile } from './ops-qa-ports.mjs';
import { binding, consentDecision } from './run-binding.mjs';
export function createQualificationHost(cli) {
  return reference({ ...cli, binding, consentDecision,
    hostOrigin: 'http://127.0.0.1:43101', executablePath: '/ops/chrome',
    verifyCeiling, verifyReceipt, reconcile });
}
```

### OPS runbook (same-user local topology)

1. On mbp2606 as **mba over SSH**, run the key-free output-device probe with the
   intended headless Chrome **with and without both fake-capture flags**, saving
   the full JSON for each run. The probe and Chrome must both run as **mba**:

   ```sh
   node plugins/composed-voice/ops/qualification-output-probe.mjs \
     --executable-path /absolute/path/to/chrome-headless-shell \
     --fake-capture-wav /absolute/run/corpus.wav \
     --report /absolute/run/output-with-fake-capture.json
   node plugins/composed-voice/ops/qualification-output-probe.mjs \
     --executable-path /absolute/path/to/chrome-headless-shell \
     --report /absolute/run/output-without-fake-capture.json
   ```

   Reports must be new files; exit 0 means verified and exit 1 means device
   refusal. The first command adds `--use-fake-device-for-media-stream` and
   `--use-file-for-fake-audio-capture`; the second omits both. The report records
   launch flags, browser version, WAV hash (when used), OS record and timestamps.
   This preflight uses no keys and makes no provider calls.
2. **Use host mba + Chrome mba on mbp2606.** This is the decided topology.
   Retain both reports with command-line source, actual arguments, Chrome PID,
   Chrome/probe UIDs and the OS record. If either probe refuses, stop and resolve
   the output evidence before dispatch.
3. Prove refusal using the same first command plus `--force-missing-output` and
   a fresh report path. This adds Chrome's `--fail-audio-stream-creation` to
   deliberately prevent an output stream. Record exit 1 plus measured zero
   latency or stalled timestamps, even with an OS default output present.
   Separately repeat with `--force-fake-output` (`--disable-audio-output`): retain
   its actual latency/clocks and exit 1 from the explicit fake-output guard;
   do not assume this fake stream has zero latency. Rerun the normal probe
   before dispatch.
4. **The CLI, host, Chrome and budget DB must belong to mba on mbp2606**: the server accepts only a control file owned by its own user and must read the budget DB.
   OPS places the keys file privately for the run window. Its CLI-loaded account wrapper delegates host startup to the reference launcher as mba using the supplied `controlFile`. This command names paths only; no key values
   belong on the command line. Use the reference module with the OPS binding (the launcher sets these fields):

   ```sh
   AITHEMA_COMPOSED_QUALIFICATION=1 AITHEMA_LISTEN_HOST=127.0.0.1 \
     PORT=43101 AITHEMA_COMPOSED_RELAY_ORIGIN=http://127.0.0.1:43101 \
     AITHEMA_COMPOSED_KEYS_FILE=/absolute/run/provider.keys \
     AITHEMA_COMPOSED_CONTROL_FILE="$controlFile" \
     AITHEMA_COMPOSED_BINDING_FILE=/absolute/run/binding.json \
     AITHEMA_COMPOSED_QUALIFICATION_MODULE="$PWD/plugins/composed-voice/ops/qualification-live-server.mjs" \
     node demo/server.js
   ```

5. Corpus clips live on mbp2606, accessible to mba. Before either navigation,
   CDP `Page.addScriptToEvaluateOnNewDocument` (via `evaluateOnNewDocument`, the
   baseline instrumentation mechanism) installs the same `getUserMedia` override
   in both lanes. It returns an AudioContext MediaStreamAudioDestinationNode
   stream. The utterance starts after candidate `media.connect()` is ready, or
   after baseline's existing opener final + speaking/listening edge + observed
   output drain. The source schedules the barge-in phrase **800 ms after the
   observed first reply audio**, using exactly the `playback-start` timestamp
   forwarded to the probe. One source constant documents this delay. Silence
   follows each clip until the sample ends. A late observation that cannot meet
   that delay refuses capture; it never starts a blind second user turn.

   Capture RMS/frame observations use the injected source's AudioContext clock:
   `captureAt = performance.now() + (captureFrame / sampleRate - currentTime) * 1000`,
   sampled together at callback delivery. This is the existing probe mapping to
   monotonic performance time, with source frames rather than a WAV start offset.
   Speech end and barge-in still come from voiced capture blocks; first audio and
   stop still come from the existing device/output probe. Scheduled source times
   never substitute for observed evidence. Source capture resolution is 1024 /
   16000 = 64 ms; output observations retain their existing device resolution.

   The runner no longer uses `--use-fake-device-for-media-stream`,
   `--use-file-for-fake-audio-capture` or `--use-fake-ui-for-media-stream`.
   It retains `--autoplay-policy=no-user-gesture-required`,
   `--disable-features=AudioServiceSandbox`, microphone origin permission, and
   removal of Puppeteer's default `--mute-audio`. The 4c physical output gate,
   actual command-line/process/user binding and output-substituting flag refusals
   remain mandatory. The standalone key-free output probe still supports its
   legacy fake-capture option for 4c comparison/negative-control evidence above;
   run its no-fake-capture mode for the current runner topology.
6. From an OPS checkout of the PR 4d head named in the coordinator handoff
   (record its full SHA with the run evidence), run:

   ```sh
   git checkout --detach "${AIT160_QUALIFICATION_HEAD:?Set to the full SHA from the coordinator handoff}"
   node scripts/composed-qualification.js --operator-approved --initialize \
     --budget /absolute/run/budget.sqlite
   node scripts/composed-qualification.js --operator-approved \
     --budget /absolute/run/budget.sqlite --plan /absolute/run/plan.json \
     --host /absolute/ops-qa/host.mjs --keys-file /absolute/run/provider.keys \
     --out /absolute/run/evidence --sample-timeout-ms 1200000
   ```

   Initialize the shared persisted budget **once**, then run the CLI commands in
   the pre-live section with `--keys-file /absolute/run/provider.keys` and,
   optionally, `--sample-timeout-ms 1200000`. Use a run directory under the
   running user's `~/ci.noindex/aithema-runs/`. The CLI checks the plan/budget
   before importing OPS code; the factory forwards the path to any server it
   starts, together with the per-run control file. Retain ledger, profiles, probe/observations and blind listening files.
   Stop the host and browser groups, then **trash the keys file immediately**.
   A failure retains reservations; confirm the old dispatcher stopped before
   explicit orphan settlement/reconciliation. Never silently rerun the same ID.

   After an abort, look in `--out` for `failure.json` (0600, exclusive creation;
   `failure-<uuid>.json` if a prior record exists or this run has not claimed its
   ID). Pre-claim errors retain their phase (`validate`, `budget`, `verifyPricing`
   or `claim`) and preserve earlier run files, including `budget-final.json`.
   The diagnostic records the failing phase,
   1-based sample index and lane (`null` outside a sample/lane), a redacted error,
   and only event kinds, numeric device timings, voiced flags and counts. Known
   harness messages use a fixed allowlist; all other errors become their class
   plus a SHA-256 hash. It contains no audio, text, URLs, paths or credentials;
   the original exception is rethrown. If evidence storage itself is unavailable,
   the durable ledger is still authoritative.

   `Qualification media waiting: limit` refuses the sample with fixed reason
   `media-wait-limit`, including when returned from the browser evaluation.
   Incomplete media (missing first audio, pre-reply voiced capture, voiced
   barge-in capture, or playback-stop at/after barge-in) refuses that lane's sample
   without retrying. The run aborts immediately with phase `refusal-limit` when
   one lane has two consecutive refusals for the same reason, or its refusals
   exceed 25% of the full corpus. A valid sample or a different refusal reason
   resets that lane's same-reason streak; the other lane does not affect it.
   `refusals.json` is written once on completion or abort (0600, exclusive creation),
   with each refusal's sample, lane, fixed reason and value-free trace. Refused
   samples skip the blind pair. `report.json` includes the refusals and, alongside
   each lane's metrics, `samples`/`validSamples`, `corpusSamples`, `attemptedSamples`,
   `refusedSamples` and `refusalsByReason`. Automated passage requires at least 75%
   of the corpus valid and at least six valid samples, as well as passing metrics;
   otherwise `automatedPass` is false with reason `insufficient-valid-samples`.
   These limits are the coordinator decision for AIT-160, 2026-10-16.
   Refusal never zeroes or releases an attempt;
   dispatched attempts retain uncertainty until authenticated reconciliation.

Round 4 builder evidence (mbp2606, **mba over SSH**, Chrome headless shell
155.0.8059.39, commit `66c2af53cc`, 2026-10-16 07:27:59–07:28:03 UTC):

| Capture / output mode | Labelled real / fake outputs | Output latency | Timestamp clocks | Result |
| --- | --- | --- | --- | --- |
| Fake device + corpus WAV / default output | 0 / 3 | 27 ms | Both advancing over 560.4 ms | Verified, exit 0 |
| Neither fake-capture flag / default output | 0 / 0 | 27 ms | Both advancing over 560.3 ms | Verified, exit 0 |
| Fake device + WAV / forced fake output | 0 / 3 | 16 ms | Both advancing over 560.3 ms | Refused by explicit output-flag guard, exit 1 |
| Fake device + WAV / failed output-stream creation | 0 / 3 | 0 ms | Both remain zero over 560.5 ms | Refused by rendering and output-flag gates, exit 1 |

All four OS records name `MacBook Pro-Lautsprecher`, transport
`coreaudio_device_type_builtin`, built-in `true`, default output for mba.
The decided topology is **host mba + Chrome mba on mbp2606**; both probe rows
are required under that same user.
The first committed negative control (`eeefadde`) failed because forced fake
output passed the clock/latency checks; `66c2af53cc` adds the explicit flag guard
and passes the four measurements plus the fake-provider CLI/tunnel proof.

### Alternative: tunnel/container

Only when OPS deliberately chooses the remote variant, run the flagged host in
its reviewed container with host networking, loopback bind `PORT=43100`, and a
read-only mount of its run-window 0600, container-user-owned keys file. Set
`AITHEMA_COMPOSED_KEYS_FILE` to that absolute in-container path; environment-key
fallback is still forbidden. Keep the account data mounts OPS-owned; use the repository reference server module.
From mbp2606 keep this forward alive:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43101:127.0.0.1:43100 agm1
```

Both `hostOrigin` and `AITHEMA_COMPOSED_RELAY_ORIGIN` remain
`http://127.0.0.1:43101`, distinct from the host bind port. SSH authenticates and
encrypts the inter-machine transport; TLS remains N/A for loopback. The same
output-device gate, browser-user watchdog, keys-file checks and disposal apply.
Stop container and tunnel explicitly after collecting evidence.

The nine operational evidence areas below cover **all ten existing checklist
keys** (Rule C shares the consent/holds row). The automated output probe supplements OPS attestation; the other areas remain OPS-owned:

| Checklist key(s) | OPS evidence required from this topology |
| --- | --- |
| `authenticatedRelay` | Flagged loopback bind; authenticated same-origin POST; wrong owner/origin and revoked grants denied. For the alternative, record tunnel ports and SSH protection; **TLS N/A: loopback by design**. |
| `physicalBrowserMedia` | Both clip identities/hashes and scripted-source mode; recorded `physicalBrowserMedia` with default sink, positive latency, both advancing clocks and the running user's OS default-output record; diagnostic real/fake labels/counts; both mba with/without-capture reports with actual CDP command line and verified Chrome/probe UIDs, plus measured fake-output refusal; unchanged capture frame/sample-rate and output timestamps, 64 ms source capture resolution and device output resolution; permission, stop and failure evidence. |
| `consentAndHolds`, `ruleCAndNoSilentRerun` | Exact stored owner/processing scopes; Rule C envelope/store; immediate revoke, holds and AIT-138 fresh generation recovery; persisted run identity refusing rerun; every reasoning/retry routed through the shared admit. |
| `verifiedTariffsAndRounding` | Host account proofs matching each exact request/digest, lane, component/model and retry ceiling; whitespace, initialization, rounding, minimums and duration coverage; one persisted $25 cap. |
| `authenticatedReceipts` | Authenticated host usage/receipts for both lanes, components, reasoning and retries; matching attempt/receipt identities and existing settlement reconciliation; pending exposure retained. |
| `sttEmptyCommitAndMinimumDuration` | Corrected endpoint commit on the last nonempty audio chunk yields spoken final text; short-input processing guard and account billing minimums verified using corpus capture. The existing key name is retained for plan compatibility. |
| `ttsFinalFlag` | OPS 2026-10-16 provider evidence for `isFinal`, preserved as plan `spelling: "isFinal"`; `is_final` is refused. |
| `pcmOutputAndAccountModels` | Available account models/voices and observed output encoding, mono channels and rate; PCM16 versus float32 kept explicit through relay/player and blind normalization. |
| `retentionAndResidency` | Actual account retention and processing-location evidence for the selected account; secure evidence access and later disposal under OPS policy. |

`startLocalQualificationHost()` in `ops/qualification-server.mjs` is **tests only**.
The fake CLI proof uses that helper behind a TCP forwarder on a different port,
the pre-dispatch real Chrome output probe (refusal with zero dispatch on a null device), and, when the device passes, capture/playback clocks, a fake provider pair, the actual coordinator
and Rule C store, and admitted reasoning retries. It performs no provider calls
and does not establish vendor quality, billing or live qualification.
