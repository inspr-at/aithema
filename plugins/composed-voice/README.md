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
Snapshots retain attempt identities and overrun blocks across restart. The later
live runner must persist this shared snapshot atomically before dispatch, enforce
verified pricing ceilings for every provider attempt, and collect actual media
timestamps and Markus's blind preference. That runner and keys belong to OPS.

No live calls, account provisioning, deployment, or qualification is part of this
slice. Later AssemblyAI/Azure support can implement the same component ports;
neither adapter is present here.
