# AIT-139 voice soak

Builder scope is fake only. A live run is a separate OPS action after the
coordinator's review gate. Only one 60-minute German run is authorized; English
requires later review. Never target or modify START's ElevenLabs agent.

No dependencies were added. `npm run test:voice-soak -- ...` uses the existing
Puppeteer Core installation. All execution, including offline audio generation,
is restricted to mbp2606. There is no local fallback. CI runs only the fast model
tests in `test/soak-harness.test.js`; the five-minute soak is deliberately outside
both the unit glob and the eight browser shards.

## Fake run on mbp2606

Commit the worktree first; the remote wrapper transfers committed HEAD only:

```sh
EVIDENCE_OUT="/absolute/path/to/ait139-handoff" FULL_LOG=1 \
  /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
  "$PWD" unit test/live/soak-dry-run.test.js
```

Run one test command at a time. On exit 3/7, wait five minutes before retrying,
up to twelve attempts; never use mbp2607. A `LOCAL-FALLBACK` means tests pending
for the coordinator. Do not add this soak to a browser shard: it would consume
most of that job's 480-second whole-job budget.

The fake server is bootstrapped through `no-provider-server.js`, which refuses
every server-side provider fetch and receives an explicit credential-free
environment. Chrome refuses requests outside that loopback origin. macOS `say`
uses its **already installed** Anna/Samantha voices to generate PCM speech WAVs
offline; missing voices fail setup (do not download them). Chrome opens the WAV
with `--use-file-for-fake-audio-capture`, captures it through `getUserMedia`, and
uses it for the capture preflight. Each scripted utterance then starts at sample
zero as a one-shot Web Audio buffer feeding the same fake capture stream that
the provider acquires through `getUserMedia`. Trailing PCM silence is trimmed;
buffer duration and its scheduled start provide a known speech-end timestamp.
A meter proves non-silent input and speech overlap.

This dedicated test browser disables **only AudioServiceSandbox** so the macOS
audio utility can read the generated WAV; renderer/browser sandboxing stays on.
Chromium documents the [macOS fake-audio file access restriction](https://chromium.googlesource.com/chromium/src.git/+/167f34ae932ed8f702d9127339acbff246b4eb47)
and the separate [audio-service sandbox feature](https://chromium.googlesource.com/chromium/src/+/9cab8b5d5e4ad574122eb8f78b98c02fccc9ee99/content/public/common/content_features.cc).
Use only the isolated test origin/profile. A non-silent capture preflight must
pass before the harness starts any call. A device-free audio sink keeps the
meter running without a physical output device.

Fake voice has no ASR, TTS or reasoning callbacks: the script also presses its
existing Speak control after the scheduled utterance ends, and Barge-in after
300 ms of actual input overlap. Its client timings and recovery/receipt counts
are real simulator observations; server token metrics remain unavailable. This
dry run validates harness plumbing, not live voice quality or provider latency.

Retained mbp2606 evidence at `c5a490dd7d`: [JSON report](evidence/soak-report.json)
and [short summary](evidence/soak-summary.md). The DE call ran for 300,190 ms,
with 14 turns, five barge-in receipts, one recovery, both network windows,
1,514 non-silent meter samples and 969 speech-overlap samples. Wallet confirmed,
uncertain and reserved costs all ended at zero. The unit red-before record and
initial silent-capture failure are retained in the coordinator handoff folder,
outside the repository.

## OPS: isolated wallet and live preflight

1. Wait for the coordinator's required review/merge/release decisions. Pin the
   reviewed commit. Reserve mbp2606 through OPS; run no other suite concurrently.
2. Prepare a **separate test host and database**, using OPS-managed credentials
   and the approved Aithema-owned agent. Preserve START as read-only. Do not
   point the commands below at the production admin socket. Use a fresh test
   visitor with no confirmed spend, uncertain liabilities or reservations.
   Disable mail/images/HTML for this host and allow only the approved providers.
   The harness does not load env files, provision agents or change host settings.
3. Confirm upstream price/account evidence, legal consent and model deadlines.
   OPS must establish a conservative **combined voice + reasoning** USD/minute
   upper bound including retries; the example below uses $0.12/min only if OPS
   has verified that bound. Live rates below $0.12/min are rejected; this floor
   does not replace verification of a higher bound when needed. Keep the
   existing server voice duration, spend,
   reservation and provider controls enabled. Set the test host's technical voice
   duration to 3600 seconds through its normal OPS configuration, without changing
   production defaults. Ensure the provider account has an independently enforced
   test spending limit: a browser cannot guarantee a supplier's eventual invoice.
4. On that running test host, use AIT-169's authoritative CLI. These are the exact
   commands; substitute the isolated socket path. The amounts are USD, not display
   Credits. `set-allowances` updates the whole host's three tiers, **not one
   visitor**, hence the isolated host. The revision check prevents stale writes.

   ```sh
   SOAK_SOCKET=/absolute/path/to/isolated/ops/admin
   node demo/admin-cli.js --socket "$SOAK_SOCKET" settings
   ```

   Record the returned revision and previous three allowances. Replace `N` with
   that revision; then verify the new revision and append-only audit:

   ```sh
   node demo/admin-cli.js --socket "$SOAK_SOCKET" set-allowances \
     --base-revision N --anonymous 8 --email-given 8 --email-confirmed 8
   node demo/admin-cli.js --socket "$SOAK_SOCKET" settings
   node demo/admin-cli.js --socket "$SOAK_SOCKET" audit --limit 20
   node demo/admin-cli.js --socket "$SOAK_SOCKET" provider-cap
   ```

   The harness requires the fresh live wallet's allowance to equal its cap
   (8,000,000 micro-USD), with zero prior spend/holds. Do not clear ledger history
   or relax admission controls to obtain this state.
5. On mbp2606, prepare a dedicated Chrome profile on the isolated HTTPS origin.
   Complete any operator-managed access, select a German conversation, choose
   voice and grant the normal processing consent through the page. **Do not start
   a call.** Close Chrome before the harness uses that profile. Keep this profile
   local/private; never attach it to the ticket. Record only value-free evidence.
6. At startup of that isolated host, set these non-secret configuration values
   through its normal OPS launcher (do not source or copy env files):

   ```text
   AITHEMA_VOICE_HOST_MODULE=/absolute/pinned/checkout/test/live/diagnostic-host.js
   AITHEMA_SOAK_DIAGNOSTICS=/absolute/private/ait139-voice-diagnostics.jsonl
   ```

   Create the parent directory privately for the service account first. The
   wrapper delegates to the existing owned-agent host and appends **only** the
   part-1 closed-schema records, converting both JSON strings and legacy object
   logs to JSONL. It does no provider work on import. Do not reuse a previous
   run's export or rotate it during this run. OPS forwards this file to mbp2606
   continuously if the host is elsewhere, using its existing private log
   transport. Keep raw application/provider logs out. The harness filters by its
   own call hash and retains attempts across generations. The complete append-only
   export must remain present through final reconciliation.

## OPS: the single capped DE run (not executed by the builder)

On mbp2606, in the pinned checkout, after every preflight above:

```sh
npm run test:voice-soak -- \
  --mode live --ops --isolated --locale de \
  --minutes 60 --max-duration 60 --cap-usd 8 \
  --rate-usd-per-minute 0.12 --stop-reserve-usd 0.25 \
  --url https://ISOLATED-TEST-ORIGIN/ \
  --profile /absolute/private/ait139-chrome-profile \
  --diagnostics /absolute/private/ait139-voice-diagnostics.jsonl \
  --output /absolute/path/to/ait139-live-report
```

Do not run this command against production. `--ops` is an explicit execution
gate, not an approval receipt. `--max-duration` is minutes and can only shorten
`--minutes`; both are bounded at 60. The cap cannot exceed $8. At least $0.10 is
reserved for polling/hangup; default is $0.25. Abort compares confirmed + uncertain
+ reserved wallet liability against a conservative elapsed-time rate bound, and
stops at the greater bound plus shutdown reserve. Unknown/stale wallet costs
stop the call. An independent timer stops input and closes the session even if
the wallet/CDP loop stalls; browser termination backs up a stalled close. This
is a hard harness abort threshold with conservative headroom, not a claim that
provider billing cannot overrun. Unconfirmed settlement never becomes a pass.

There is one scripted input every 20 seconds, with every third designated for
barge-in while speaking. One-shot WAV input feeds the fake capture stream at a
known phase; client events verify the receipt. Offline (one second, at 30% of
duration) and latency (400 ms for five seconds, at 60%) windows use CDP; an actual request must fail offline.
After connectivity returns the harness explicitly exercises the client's normal
recovery lifecycle. Recovery is therefore induced, not proof of SDK autonomous
outage detection. The logical call and spend clock continue across replacements.

## Report, reconciliation and cleanup

`soak-report.json` and `soak-summary.md` contain source HEAD, elapsed time, stop
reason, plan/applied disruptions, hashed correlation records, per-attempt server
first-token/total p50/p95 and deadline misses, separate client response/final
timings, retries/recoveries, barge-in receipts, capture meter counts, and wallet
confirmed/uncertain/reserved amounts. Quantiles use nearest rank; missing or late
observations with a measurable speech end count as deadline misses. Client
latency p50/p95 and the hard five-second deadline start at the scripted WAV
speech end, not gate-open. Unmeasurable speech ends are counted separately;
gate-open timing is reported as an observation and cannot fail live acceptance.
Fake mode requires a measurable speech end for every turn. A failed completion
misses the total deadline without changing an on-time first token. Client first
response is not a token metric, and assistant final transcript time is not audible playback completion.

At shutdown the harness restores connectivity, silences capture, closes the
call, and waits up to 15 seconds for wallet liabilities to settle. Pending or
estimated usage fails acceptance; OPS must continue authenticated reconciliation
outside the harness and attach an updated report/evidence. Do not treat reserved
funds as final cost. A pass also requires observed speech, barge-in receipts,
recovery, both disruptions, responses within deadlines and final cost <= $8.
No transcripts, cookies, raw exceptions, provider credentials or profile paths
are written into the reports. Reports feed AIT-105; attach both files to AIT-139.

If settlement is pending, OPS uses the same isolated socket to inspect repairs,
then applies only the reviewed repair set through the existing CLI:

```sh
node demo/admin-cli.js --socket "$SOAK_SOCKET" reconcile-uncertain --dry-run --limit 10
node demo/admin-cli.js --socket "$SOAK_SOCKET" reconcile-uncertain --apply --limit 10
node demo/admin-cli.js --socket "$SOAK_SOCKET" provider-cap
```

Attach the resulting value-free repair receipt, final wallet view and diagnostic
export as a supplement to the failed/pending report. Do not relabel the original
report as passed or start another live call to obtain reconciliation evidence.

OPS then confirms the owned provider segments have ended, checks the test host's
wallet and provider cap, captures final part-1 reconciliation evidence, and stops
the isolated host. If it must stay running, restore its previously recorded tier
amounts with `set-allowances --base-revision NEW_REVISION ...` and inspect settings
and audit again. Retain cost journals and the reports; remove only the isolated
browser/test artifacts under the normal OPS retention process. Production tier
defaults, START's agent, and production wallet histories are untouched.
