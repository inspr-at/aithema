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
node scripts/composed-qualification.js --operator-approved --budget /ops/run/qualification.sqlite --plan /ops/run/plan.json --host /ops/run/host.mjs --out /ops/run/evidence
```

The plan is non-secret JSON: `runId` (unique explicit operator identity), `corpus`
(entries with `reference` and expected entities), `ceilingChecks` (complete pricing
specs), and `checks`. Every named check below needs `{ verified: true, reference:
"OPS evidence reference" }`; `ttsFinalFlag` also needs `spelling: "is_final"`.
Missing checklist, persisted budget, verified ceilings or operator flag refuses
before any sample can dispatch. A crashed/failed run requires an explicit new
operator-approved plan; retain the original shared budget and attempt history.

OPS must resolve these PR 4b-1 unknowns **before** the run, with account/provider
evidence rather than trusting fixtures:

- `authenticatedRelay`, `physicalBrowserMedia`: mounted authenticated same-origin
  route, TLS, owner/consent revoke propagation, permission/physical device clocks.
- `consentAndHolds`: exact processing scope, Rule C, AIT-138 recovery and AIT-145/146
  holds remain authoritative; `ruleCAndNoSilentRerun`: preserve AIT-212.
- `verifiedTariffsAndRounding`: every provider/account/model ceiling, whitespace
  and initialization billing, rounding and minimum duration.
- `authenticatedReceipts`: actual usage/receipt fields and authenticated
  server-observed charges covering both lanes, components, reasoning and retries.
- `sttEmptyCommitAndMinimumDuration`: acceptance of empty STT commit chunks and
  provider minimum audio duration.
- `ttsFinalFlag`: resolve `is_final` in examples versus `isFinal` in AsyncAPI.
  This adapter accepts `is_final`; the harness refuses `isFinal` until the adapter
  is deliberately updated and tested. Do not silently accept both.
- `pcmOutputAndAccountModels`: real signed-16 LE mono output, sampling metadata,
  selected voices/models and account availability; Voxtral float32 remains distinct.
- `retentionAndResidency`: verify actual account policy and processing location.

The external host module exports `createQualificationHost()`. Its factory must be
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
budget. `observations.json` preserves the real timing trace; `budget-final.json`
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

## OPS host template — PR 4c

The key-free `ops/qualification-host-template.mjs` exports the **inert**
`createQualificationHost(options)`. It owns Chrome on the machine running the CLI.
It never starts, stops, probes for, or assumes a local host process. `hostOrigin`
is required: the browser-facing loopback http(s) origin, for example
`http://127.0.0.1:43101`. Bind address and port are separate settings. Literal
`127.0.0.1` and `::1` are accepted; DNS names, wildcard binds, credentials, paths,
queries and trailing slashes in origins are refused.

Provider keys stay exclusively in start2's environment on **agm1**. OPS runs the
short-lived qualification host there from the aithema image, with host networking
and `AITHEMA_LISTEN_HOST=127.0.0.1`. Chrome and the CLI run on **mbp2606**. An ssh
tunnel joins them. The browser origin is loopback and a secure context;
**TLS is N/A for this loopback topology by design**. The tunnel authenticates and
encrypts transport between machines. No provider key, secret resolver or account
credential is supplied to the browser template or copied to mbp2606.

The demo mounts qualification only with `AITHEMA_COMPOSED_QUALIFICATION=1`:

| Setting | Contract |
| --- | --- |
| `AITHEMA_LISTEN_HOST` | Must be literal `127.0.0.1` or `::1`; checked before normal host initialization or listening. |
| `PORT` | Host bind port on agm1, independent of the browser-facing tunnel port. |
| `AITHEMA_COMPOSED_RELAY_ORIGIN` | Required explicit loopback http(s) **browser** origin. It controls Host and Origin checks and must also be passed to the composed factory's `relayOrigin`. |
| `AITHEMA_COMPOSED_QUALIFICATION_MODULE` | Required path to OPS's server module, exporting `createQualificationServer({ relayOrigin, authenticateRelay, storage, handlers })`. Loaded only with the flag. |

The mount precedes the demo's JSON-only mutations and 404 so binary PCM reaches
`networkRelay.handle` at **POST /composed/relay**. It uses the existing visitor
owner cookie (`authenticateRelay`), and the composed factory still verifies the
stored owner, consent, authorization and single-use grant. OPS must retain immediate
revoke propagation. `/composed/qualification` is an authenticated minimal harness
page; its hook and the capture/player, network client, worklet and client module
dependencies are served from that same origin. The authenticated control endpoint
is `/composed/qualification/control`; sample capabilities and acknowledgements
travel in POST bodies, never URLs. Host/Origin mismatches and cross-site requests
are refused. Without the flag the page, control, relay and composed browser assets
return 404, and the OPS module is never imported. start2's normal preset is unchanged.

### Exact ports

OPS's browser-side `host.mjs` exports `createQualificationHost()` and delegates to
the template with these options. There are **no successful accounting defaults**:

| Option or method | Required contract |
| --- | --- |
| `hostOrigin` | Browser-facing loopback origin; never inferred from a local process or bind port. |
| `runDirectory` | Absolute existing run root on mbp2606. The template creates a hashed run directory and separate candidate/baseline Chrome profiles beneath it, retained as OPS evidence. |
| `ownerHeaders` | Existing owner authentication, e.g. the visitor cookie obtained by OPS's session setup. Never provider authentication; never log it. Node control requests and same-origin Chrome requests use the same owner. |
| `executablePath` | OPS's installed Chrome path (or explicit `CHROME_PATH`). No browser discovery or installation in the template. `launchBrowser` may inject the repository's guarded launcher in tests. |
| `verifyCeiling(spec)` | OPS account operation on agm1. Return the matching verified ceiling proof described above, including request digest, evidence reference and future expiry. Called at preflight, admission and consume. Missing port throws at factory construction. |
| `verifyReceipt(receipt, storedAttempt)` | OPS authenticates the server-observed receipt on agm1; return exactly `true` only for a matching trusted receipt. Missing port throws. |
| `reconcile({ snapshot, reconcile })` | OPS fetches/authenticates/persists receipts on agm1, calls supplied `reconcile(receipt)` for each settled attempt and applies the existing settlement ledger without a second terminal. Pending receipts retain exposure. Missing port throws. |
| `runSample({ item, lane, runId, admit, onTiming })` | `item.wavPath` is an absolute corpus WAV on mbp2606; `item.id`/`sampleId` identify the server sample. Launch a fresh profile, open the remote page through `hostOrigin`, admit every dispatch, then return `{ hypothesis, entities, ttsPCM: Uint8Array, ttsFormat: { encoding, sampleRateHz, channels } }`. Hypothesis/entities/PCM come from the server; corpus references stay in the CLI. `onTiming(event)` receives the browser's event values unchanged. |
| `close()` | Close owned Chrome instances; it has no host-process lifecycle authority. |

OPS's **server** module returns `{ networkRelay, createSample }`. Construct the
composed factory with the supplied `authenticateRelay` and `relayOrigin`; expose
its `networkRelay` (including revoke/close). `createSample({ item, lane, runId,
owner, admit })` must verify the stored session owner and exact consent/holds,
then return `{ grant, result, close }`. `result` is a promise for the authoritative
sample result above, with at most 16 MB of PCM, after all sample attempts report.
`close()` must stop this sample's media and work and persist its terminal state.
The generic mount allows one active sample and expires it after two minutes;
the browser requires complete physical evidence within one minute.

The server's `admit(spec)` is a remote port to the CLI's **same durable budget**.
It returns `{ attempt: { attemptId, claimId, maxMicro, consume, report }, report,
dispatch }`. Every STT, TTS, existing Rule C reasoning dispatch and retry must
use it; retries include `retryOf`. Await `attempt.consume()` before transport,
then report exactly once, or use `dispatch(async ({ attempt, report }) => ...)`
which consumes first and reports uncertainty if the action has no terminal.
Admission, consume and report each await the CLI's acknowledgement; failure or
timeout blocks work. The mount drains reports before publishing the result.
OPS must place reasoning admission at its actual dispatch boundary while keeping
the existing Rule C operation store. The parent remains zero-cost. Server-side
receipt implementations and provider adapters belong solely to OPS's ops-qa module.

Example browser module (port implementations live in OPS, not this repository):

```js
import { createQualificationHost as template } from '/path/to/aithema/plugins/composed-voice/ops/qualification-host-template.mjs';
import { verifyCeiling, verifyReceipt, reconcile, ownerHeaders } from './ops-qa-ports.mjs';
export function createQualificationHost() {
  return template({ hostOrigin: 'http://127.0.0.1:43101', runDirectory: '/ops/run',
    executablePath: '/ops/chrome', ownerHeaders, verifyCeiling, verifyReceipt, reconcile });
}
```

### OPS runbook and evidence

1. On agm1, OPS uses its ops-qa launcher to supply the existing start2 server-only
   bindings inside the short-lived container. The following is the key-free launch
   shape; OPS supplies its reviewed image, directories and server module. It is
   not live-ready until those account ports and existing bindings are wired:

   ```sh
   docker run --rm --network host --read-only --tmpfs /tmp \
     --mount type=bind,src=<ops-qa-dir>,dst=/ops,readonly \
     --mount type=bind,src=<qualification-data-dir>,dst=/data \
     -e AITHEMA_COMPOSED_QUALIFICATION=1 -e AITHEMA_LISTEN_HOST=127.0.0.1 \
     -e PORT=43100 -e AITHEMA_COMPOSED_RELAY_ORIGIN=http://127.0.0.1:43101 \
     -e AITHEMA_COMPOSED_QUALIFICATION_MODULE=/ops/server.mjs \
     <reviewed-aithema-image> node demo/server.js
   ```

2. On mbp2606, establish the tunnel and keep it alive for the whole run:

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43101:127.0.0.1:43100 agm1
   ```

   Set the browser module's `hostOrigin` to `http://127.0.0.1:43101`, matching
   `AITHEMA_COMPOSED_RELAY_ORIGIN`, **not** the host bind port 43100. Confirm that
   the cookie belongs to this qualification session; do not copy start2 secrets.

3. Corpus WAVs live on mbp2606. The template launches Puppeteer with
   `--use-fake-device-for-media-stream`,
   `--use-file-for-fake-audio-capture=<item.wavPath>`,
   `--use-fake-ui-for-media-stream` and
   `--autoplay-policy=no-user-gesture-required`. It removes Puppeteer's default
   `--mute-audio`: output uses mbp2606's real output device. Select/verify that
   device before running. It records actual capture frames and output device
   timestamps. The next voiced corpus segment triggers synchronous barge-in
   stop and ends sample capture; include utterance, endpoint silence and a
   later voiced segment in each WAV. No timing event is synthesized or shifted.

4. OPS supplies its browser module and plan, initializes the shared persisted
   budget once, and runs the CLI commands in the pre-live section on mbp2606.
   The CLI enforces all checklist entries before importing the OPS module.
   Ceiling/receipt account calls from the ports execute on agm1. Retain the
   SQLite ledger, browser profiles, observations, blind files and OPS answer key.
   Stop the container and tunnel explicitly after collecting evidence. A network
   failure retains reservations; confirm the old dispatcher stopped before the
   existing explicit orphan settlement/reconciliation procedure.

The nine operational evidence areas below cover **all ten existing checklist
keys** (Rule C shares the consent/holds row). None is auto-attested by the template:

| Checklist key(s) | OPS evidence required from this topology |
| --- | --- |
| `authenticatedRelay` | Flagged loopback bind; distinct bind/tunnel ports; authenticated same-origin POST; wrong owner/origin and revoked grants denied. Record ssh protection; **TLS N/A: loopback by design**. |
| `physicalBrowserMedia` | WAV identity/hash and capture flags; actual mbp2606 output device; unchanged capture frame/sample-rate and output timestamps, 40 ms capture resolution and device output resolution; permission, stop and failure evidence. |
| `consentAndHolds`, `ruleCAndNoSilentRerun` | Exact stored owner/processing scopes; Rule C envelope/store; immediate revoke, holds and AIT-138 fresh generation recovery; persisted run identity refusing rerun; every reasoning/retry routed through the shared admit. |
| `verifiedTariffsAndRounding` | agm1 account proofs matching each exact request/digest, lane, component/model and retry ceiling; whitespace, initialization, rounding, minimums and duration coverage; one persisted $25 cap. |
| `authenticatedReceipts` | Authenticated agm1 usage/receipts for both lanes, components, reasoning and retries; matching attempt/receipt identities and existing settlement reconciliation; pending exposure retained. |
| `sttEmptyCommitAndMinimumDuration` | Account/provider observation of endpoint commit with an empty chunk and actual minimum duration using corpus capture. |
| `ttsFinalFlag` | Provider evidence for `is_final`, preserved in plan `spelling`; adapter still refuses unresolved `isFinal`. |
| `pcmOutputAndAccountModels` | Available account models/voices and observed output encoding, mono channels and rate; PCM16 versus float32 kept explicit through relay/player and blind normalization. |
| `retentionAndResidency` | Actual account retention and processing-location evidence on agm1; secure evidence access and later disposal under OPS policy. |

`startLocalQualificationHost()` in `ops/qualification-server.mjs` is **tests only**.
The fake CLI proof uses that helper behind a TCP forwarder on a different port,
real Chrome capture/playback clocks, a fake provider pair, the actual coordinator
and Rule C store, and admitted reasoning retries. It performs no provider calls
and does not establish vendor quality, billing or live qualification.
