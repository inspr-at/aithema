import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertMeasuredWeight } from './browser-timings.js';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Each browser test owns its sibling rolling per-test p95 CI measurements.
// A 25% margin protects workloads with fewer than five CI samples.
export function readBrowserTestWeights(files = discoverBrowserTests(), root = repositoryRoot) {
  const tests = new Set(files);
  for (const entry of readdirSync(resolve(root, 'test/browser'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.weight.json')) continue;
    const file = `test/browser/${entry.name.replace(/\.weight\.json$/u, '.test.js')}`;
    if (!tests.has(file)) {
      throw new Error(`Stale browser test weight: test/browser/${entry.name}; no matching test: ${file}`);
    }
  }
  const weights = {};
  for (const file of files) {
    const weightPath = file.replace(/\.test\.js$/u, '.weight.json');
    let measurement;
    try {
      measurement = JSON.parse(readFileSync(resolve(root, weightPath), 'utf8'));
    } catch (error) {
      throw new Error(`Missing or unreadable browser test weight: ${file}; add ${weightPath} (seconds and evidence). ${error.message}`);
    }
    if (!Number.isFinite(measurement?.seconds) || measurement.seconds <= 0 ||
        typeof measurement.evidence !== 'string' || !measurement.evidence.trim()) {
      throw new Error(`Invalid browser test weight: ${weightPath}; seconds must be positive finite seconds and evidence must describe the measurement`);
    }
    try { assertMeasuredWeight(measurement); }
    catch (error) { throw new Error(`Invalid browser test weight: ${weightPath}; ${error.message}`); }
    weights[file] = measurement.seconds;
  }
  return weights;
}

export const browserTestWeights = readBrowserTestWeights();
// AIT-314: main-only re-derivation; per-file evidence is in the CI guide.
// Mature rolling-main series replace the old ticket floors. Geometry's fresh
// two-sample weight (216.968s, including 25%) already exceeds its old 196s floor.
// Keep the conservative PR floors for these changed workloads until at least
// five matching main samples confirm them; older workload hashes do not count.
// Footer: two main samples, p95 work 36.447s, warmup weight 45.559s.
browserTestWeights['test/browser/footer-width-sweep.test.js'] = Math.max(
  browserTestWeights['test/browser/footer-width-sweep.test.js'], 46);
// Voice: three main samples, p95 work 138.653s, warmup weight 173.317s.
browserTestWeights['test/browser/voice-presentation.test.js'] = Math.max(
  browserTestWeights['test/browser/voice-presentation.test.js'], 174.746);

// AIT-304: successful PR #284 CI 39120863347, head bb069809, shard 4/7:
// complete footer file with viewport evidence: 16.313871563s + 12.941360072s
// + 22.817818013s = 52.073049648s. ceil(observed * 1.25) = 66s, superseding
// the 63s provisional remote floor. PR CI 39120378507 at c12e5bbb, shard
// 1/7, passed all 19 display tests: 205.342187533s; ceil(*1.25) = 257s.
// Retain that display floor (39120863347 remeasured 197.598731313s) for
// the unchanged full-wording assertions' accessible-name extraction.
// PR/remote samples remain diagnostic, outside trusted rolling-main history.
for (const [file, seconds] of Object.entries({
  'test/browser/footer-width-sweep.test.js': 66,
  'test/browser/start2-display.test.js': 257,
})) browserTestWeights[file] = Math.max(browserTestWeights[file], seconds);

// AIT-359: green PR #306 CI 39154313634, head a399824e, shard 6/7:
// footer file 4/4 PASS, including the complete 120-case credits receipt matrix.
// Summed top-level work: 37.672258359s + 16.615807028s + 10.907506750s
// + 19.796119968s = 84.991692105s; ceil(observed * 1.25) = 107s.
// Source: browser-timings-6-of-7/batch-0.jsonl (successful file summary).
// Supersedes the 110s floor derived from failed CI 39153739923. Keep this
// diagnostic floor outside trusted rolling-main history until matching
// successful main samples can replace it. No bin limits change.
browserTestWeights['test/browser/footer-width-sweep.test.js'] = Math.max(
  browserTestWeights['test/browser/footer-width-sweep.test.js'], 107);

// AIT-327: all 34 tests passed in PR CI 39139806265, head d9161661,
// shard 5/7: summed top-level work 133.288818152s.
// ceil(observed * 1.25) = 167s; supersedes AIT-321's 158s floor.
// Keep this diagnostic floor until matching rolling-main samples mature;
// PR observations do not enter trusted main timing history.
browserTestWeights['test/browser/consent-lines.test.js'] = Math.max(
  browserTestWeights['test/browser/consent-lines.test.js'], 167);

// AIT-341 P1: mbp2606 committed-head run b7727c6d05-67262, 2026-10-18:
// 6.228956916s isolation + 19.702862417s backdrop + 5.178417708s strict-host
// = 31.110237041s top-level work (5 pass, 2 executing todos, zero skips).
// PR #300 CI 39142459751, head ba53e5ee, shard 1/7: 7.923580988s isolation
// + 19.621596825s backdrop + 5.233819894s strict-host = 32.778997707s.
// ceil(CI observed * 1.25) = 41s, superseding the 39s remote floor. Keep
// this diagnostic floor outside trusted rolling-main history until matching
// successful main samples can replace it.
// AIT-353: PR #307 CI 39150584262, head b2c8ff3a, shard 2/7 passed
// all ten preview tests with no todos/skips: 8.001041562s isolation +
// 19.367865619s backdrop + 9.704025264s strict host/evidence = 37.072932445s.
// ceil(observed * 1.25) = 47s, superseding the 41s AIT-341 floor.
// PR diagnostics stay outside trusted rolling-main timing history.
// Round 2: PR #307 CI 39153830260 at 0388f17f, shard 1/7, passed
// all 12 preview tests: 15.749681849 + 20.370036503 + 10.638330447
// = 46.758048799s. ceil(observed * 1.25) = 59s; reserve 60s, rounding
// up to the next 5s for warmup variation. This supersedes the mixed
// CI/remote 56s forecast; rolling-main timing history stays unchanged.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 60);
// AIT-364: green PR #318 CI 39213995186, head 984e56be, shard 7/7:
// all 21 preview tests passed, including the six-case cross-tab matrix and
// full withdrawal: 15.887813567 + 20.502053037 + 9.993410194
// + 12.660817253 = 59.044094051s; ceil(observed * 1.25) = 74s.
// Supersedes the failed diagnostic run's 73s floor. PR observations remain
// outside trusted rolling-main timing history; no bin limits change.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 74);
// AIT-364 v1.1: mbp2606 run 142aa936c7-79959 passed all 23 preview
// tests, including the fail-closed HTTP/stalled-document viewports/recovery.
// Full file top-level work: 15.340172292 + 49.269363583 + 6.804462292
// + 10.460890042 = 81.874888209s; ceil(observed * 1.25) = 103s.
// Keep this conservative diagnostic floor outside rolling-main history;
// CI 39219688045 at 373cd96a, shard 7/7, passed all 23 preview tests:
// 15.483274293 + 19.378860230 + 9.488300485 + 12.037914010
// = 56.388349018s (ceil(*1.25) = 71s). Retain the slower remote floor;
// shard counts, ceilings and check names stay unchanged.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 103);
// AIT-364 round 3: mbp2606 b2f860fa66-74632 passed all 23 preview
// tests, including automatic recovery and the recovered viewport shot.
// Top-level work: 15.532410625 + 50.059817916 + 6.721846709
// + 14.264702958 = 86.578778208s; ceil(*1.25) = 109s.
// Preserve the measured remote floor outside rolling-main history.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 109);
// AIT-369: mbp2606 full-file 51234eeb8e-75668 passed existing top-level
// workloads in 15.654300667 + 51.071809500 + 6.774166208 + 14.132236208s.
// c70aaac7fc-48960 then passed the complete new ten-state matrix in
// 2.660573167s. Combined observed work 90.293085750s; ceil(*1.25)=113s.
// Reserve that measured diagnostic floor outside rolling-main history.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 113);
// AIT-364 v1.1 final product head 03f5b0bb, CI 39221011068:
// preview shard 7/7 passed 23/23 in 57.604659634s (ceil(*1.25)=73s);
// retain the slower 103s remote reservation. Consent-lines shard 5/7
// passed 34/34 in 136.474920947s; ceil(*1.25)=171s supersedes 167s.
// The snapshot fixture now advances its revision with consent saves.
// Both PR observations remain outside trusted rolling-main history.
browserTestWeights['test/browser/consent-lines.test.js'] = Math.max(
  browserTestWeights['test/browser/consent-lines.test.js'], 171);
// The same CI run, shard 5/7, passed all ten demo top-level tests in
// 56.218506283s; ceil(*1.25) = 71s for the changed served-frame workload.
// Shard 1/7 display work was 204.323290747s; its existing 257s floor remains.
browserTestWeights['test/browser/demo.test.js'] = Math.max(
  browserTestWeights['test/browser/demo.test.js'], 71);

// AIT-350 round 5: PR #315 CI 39198540390, 1caf98ee, shard 2/7:
// physical media/lifecycle/Settings file 3/3 PASS, including dark DE
// and 1024 evidence. Top-level work: 1.249225096s + 3.238451189s
// + 13.683266318s = 18.170942603s; ceil(*1.25) = 23s. This slower
// confirmation supersedes the initial 20s round-5 floor (15.796394502s).
// Source: browser-timings-2-of-7/batch-0.jsonl.
// Keep this diagnostic floor outside trusted rolling-main history;
// no shard count, ceiling, workflow or check-name changes.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 23);

// AIT-350 -fix1: passing CI 39204030409, 81364ab1, shard 2/7.
// 1440x900, 1280x800, content-sized popover and single-column confirmation:
// 1.134289473s + 2.968562343s + 14.438096212s = 18.540948028s.
// ceil(observed * 1.25) = 24s, superseding the round-5 23s floor.
// Source: browser-timings-2-of-7/batch-0.jsonl. No capacity policy changes.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 24);

// AIT-350 round 7: PR #315 CI 39206999982, 895129ae, shard 5/7 PASS.
// Three settled open-menu captures and box checks: 1.151249632s +
// 3.085387965s + 15.562711664s = 19.799349261s; ceil(*1.25) = 25s.
// Confirmation CI 39207582259, c43fade9, shard 5/7 PASS was slower:
// 2.408554753s + 3.692719086s + 15.640518542s = 21.741792381s.
// ceil(*1.25) = 28s supersedes the initial 25s and round-6 24s floors.
// Source for both samples: browser-timings-5-of-7/batch-0.jsonl.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 28);

// AIT-349: mbp2606 run 01b1dfa8e0-87584 passed 3/3 in 5.277133585s.
// Successful PR #314 CI shard 2/7 measured 7.092059901s at 41ca2db7
// (39170857897), then 9.630547362s at 82b2c542 (39171331075): physical
// 2.869790298s + lifecycle 4.058311407s + interruption 2.702445657s.
// ceil(max observed *1.25) = 13s, superseding the 9s diagnostic floor.
// Source: browser-timings-2-of-7/batch-0.jsonl. Keep this diagnostic
// floor outside trusted rolling-main history; capacity is unchanged.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 13);

// AIT-350 round 8: combined AIT-349/AIT-350 file, committed-head
// mbp2606 run 1de9553a45-66313: all 4 top-level tests PASS with evidence.
// 2.072055459s + 1.871234s + 10.523680s + 1.545596917s
// = 16.012566376s; ceil(observed * 1.25) = 21s. Retain the slower
// prior CI floor of 28s until the combined file is re-measured in CI.
// Both complete tests remain in this file; no capacity policy changes.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 21);

// AIT-350 round 8: successful PR #315 CI 39210100075, 87b6ae8e,
// shard 5/7 re-measured the complete four-test AIT-349/AIT-350 file:
// 1.165677031s + 3.866580148s + 15.690250939s + 2.674151171s
// = 23.396659289s; ceil(observed * 1.25) = 30s, superseding the
// previous 28s CI floor and the 21s combined remote measurement.
// Source: browser-timings-5-of-7/batch-0.jsonl. Keep PR diagnostics
// outside trusted rolling-main history; no shard or workflow changes.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 30);

// AIT-362: PR #320 CI 39215911919, head 1b2be006, shard 5/7
// measured all four composed-media tests: 1.213731427 + 3.200874379
// + 19.466447911 + 2.751333913 = 26.632387630s.
// ceil(observed * 1.25) = 34s. The Settings test completed its full matrix
// and failed only the documented fit-state assertions; retain this diagnostic
// floor outside trusted rolling-main history. No capacity policy changes.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 34);

// AIT-362 round 2: PR #320 CI 39222882719, head 44bb330a, shard 4/7.
// All four composed-media tests passed: 1.213878431 + 3.106116869
// + 21.247878435 + 2.718222266 = 28.286096001s; ceil(* 1.25) = 36s.
// The v1.1 mask/margins/menu-opacity checks reuse the existing page/matrix.
browserTestWeights['test/browser/composed-media.test.js'] = Math.max(
  browserTestWeights['test/browser/composed-media.test.js'], 36);

// AIT-361: successful PR #321 CI 39221656013 at b82a0166, shard 4/7:
// complete voice file 5/5 PASS, including both-provider failure evidence.
// 51.184620521 + 18.207498239 + 51.977345350 + 16.106548610
// + 7.695658067 = 145.171670787s; ceil(observed * 1.25) = 182s.
// Source: browser-timings-4-of-7/batch-0.jsonl. Preserve trusted rolling-main
// history; this diagnostic floor supersedes the earlier 174.746s floor.
// Shard count, ceiling, workflow and check names remain unchanged.
// AIT-377 round 2: PR #335 CI 39278021621, head 93af88fe, shard 3/7:
// six voice tests PASS, including real-current-client viewport evidence.
// Complete file 169.072317337s; ceil(observed * 1.25) = 212s.
// The expanded AIT-377 matrix alone is 20.913732296s; whole bin 329.831597003s.
// Source: browser-timings-3-of-7/batch-0.jsonl. Supersedes the 206s round-1
// floor; rolling-main history, shard count, ceiling and check names stay intact.
browserTestWeights['test/browser/voice-presentation.test.js'] = Math.max(
  browserTestWeights['test/browser/voice-presentation.test.js'], 212);

// AIT-395: green PR #348 CI 39326464995 at 5c95a38e, shard 6/7:
// complete host-surface file 6/6 PASS, including 20 settled Tick captures,
// frame-sampled sibling loading, and exact 0px geometry assertions.
// Summed top-level work: 9.080507531 + 6.791323145 + 72.640099242
// + 11.190102439 + 3.810468169 + 16.943752928 = 120.456253454s.
// ceil(observed * 1.25)=151s supersedes the 122s remote-derived floor.
// Source: browser-timings-6-of-7/batch-0.jsonl. PR diagnostics remain
// outside trusted rolling-main history; no shard/count/limit changes.
browserTestWeights['test/browser/host-surface.test.js'] = Math.max(
  browserTestWeights['test/browser/host-surface.test.js'], 151);

// AIT-411: PR #365 CI 39468957734, head aca252f4, shard 4/7:
// complete host-surface file 7/7 PASS, including all 180 exact-zero cases
// and the 20 requested viewport shots. Top-level work 163.714101536s;
// ceil(*1.25) = 205s; round this temporary floor up to 210s for CI variance.
// Optimized matrix work: 47.519304536s (before batching: 52.789977227s).
// PR diagnostic floor only; keep trusted main history and all capacity settings.
browserTestWeights['test/browser/host-surface.test.js'] = Math.max(
  browserTestWeights['test/browser/host-surface.test.js'], 210);

// AIT-404: green PR #357 CI 39430635672, head e1756456, shard 3/7:
// complete continuity file 3/3 PASS, including all eight touch/fine-pointer
// takeback cases with exact-zero whole-click geometry and failed GET recovery.
// CI job log top-level work: 36.486251292 + 3.550244393 + 34.645645869
// = 74.682141554s; ceil(*1.25)=94s replaces the partial 89s diagnostic floor.
// Preserve trusted rolling-main history; shard counts, limits and names stay put.
browserTestWeights['test/browser/start2-display-continuity.test.js'] = Math.max(
  browserTestWeights['test/browser/start2-display-continuity.test.js'], 94);

// AIT-410 round 3: PR #356 CI 39460524265, head 7c339a18, shard 6/7:
// complete visitor file 6/6 PASS (four top-level workloads), including all
// 48 v1, 48 v2, 60 v3 and 60 v4 samples plus the unchanged visitor matrix.
// 16.929841537 + 19.046584278 + 77.811351389 + 13.379499805
// = 127.167277009s; ceil(observed * 1.25) = 159s, superseding 155s.
// Source: browser-timings-6-of-7/batch-0.jsonl. Keep this diagnostic floor
// outside trusted rolling-main history. AIT-419 supplies the 405s target;
// this recalibration changes no capacity setting, method, margin or name.
browserTestWeights['test/browser/visitor-credit-tiers.test.js'] = Math.max(
  browserTestWeights['test/browser/visitor-credit-tiers.test.js'], 159);

// AIT-411 combined-head CI 39492236313, e791da30, shard 7/8:
// visitor file 6/6 PASS; top-level work 128.294181508s, ceil(*1.25)=161s.
// Host file 7/7 PASS on shard 4/8: 163.000446575s, ceil(*1.25)=204s;
// retain its conservative 210s floor. The unrelated frozen-email comparison
// failed because its approved grid overlay lacked the new measurement peers.
// Successful file diagnostics only; trusted rolling-main history is unchanged.
browserTestWeights['test/browser/visitor-credit-tiers.test.js'] = Math.max(
  browserTestWeights['test/browser/visitor-credit-tiers.test.js'], 161);

// AIT-411 final-main integration (AIT-418): green browser shard 7/8 in
// PR CI 39493499517 at 3f7e68e1 measures the expanded email-space file at
// 69.358467245s; ceil(*1.25)=87s. Retain the mature main series unchanged
// and add this diagnostic floor for the newly merged stream-wait coverage.
browserTestWeights['test/browser/email-mail-space.test.js'] = Math.max(
  browserTestWeights['test/browser/email-mail-space.test.js'], 87);

// The same CI's green shard 5/8 measures AIT-425's expanded pause-phone
// workload at 170.669575097s; ceil(*1.25)=214s. This is also a diagnostic
// floor, without rewriting the trusted main samples or changing capacity.
browserTestWeights['test/browser/pause-phone.test.js'] = Math.max(
  browserTestWeights['test/browser/pause-phone.test.js'], 214);

// AIT-423: LEAD's AIT-410 standing decision adds an eighth bin after AIT-411's
// measured workload exceeded 7 × 405s; target, ceiling and weights stay unchanged.
export const browserShardCount = 8;
export const browserShardBudget = 420;
// AIT-419: LEAD decision on AIT-410 (2026-10-20), one raise only; next overshoot gets an eighth shard, not 410s.
export const browserShardHeadroomTarget = 405;

export function packBrowserTests(files, weights = browserTestWeights, shardCount = browserShardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('Invalid browser shard count');
  const measuredWeights = Object.values(weights);
  if (measuredWeights.some(weight => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('Browser test weights must be positive finite seconds');
  }
  // Unknown files still get conservative placement; the coverage guard below
  // requires an explicit measurement before they can run in CI. Use at least
  // 225s, rounded up from the slowest initial observation, even for empty tables.
  const defaultWeight = Math.max(225, ...measuredWeights);
  const weightOf = file => Object.hasOwn(weights, file) ? weights[file] : defaultWeight;
  const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const sortedFiles = [...files].sort((a, b) => weightOf(b) - weightOf(a) || comparePaths(a, b));
  const shards = Array.from({ length: shardCount }, () => []);
  const totals = Array(shardCount).fill(0);
  for (const file of sortedFiles) {
    // Equal-load bins keep their index, so all ties are deterministic.
    const index = totals.indexOf(Math.min(...totals));
    shards[index].push(file);
    totals[index] += weightOf(file);
  }
  // AIT-312: refine LPT with deterministic whole-file moves/swaps. Minimize
  // makespan first, then squared load; never worsen LPT's makespan bound.
  // Strict improvement and stable iteration order make the result repeatable.
  const score = loads => [Math.max(...loads), loads.reduce((sum, load) => sum + load * load, 0)];
  const better = (a, b) => a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] < b[1] - 1e-9);
  for (;;) {
    let best = score(totals), change;
    for (let from = 0; from < shardCount; from++) {
      for (let to = from + 1; to < shardCount; to++) {
        for (let left = -1; left < shards[from].length; left++) {
          for (let right = -1; right < shards[to].length; right++) {
            if (left === -1 && right === -1) continue;
            if (left === -1 && shards[to].length <= 1 || right === -1 && shards[from].length <= 1) continue;
            const delta = (left === -1 ? 0 : weightOf(shards[from][left])) -
              (right === -1 ? 0 : weightOf(shards[to][right]));
            const candidate = [...totals];
            candidate[from] -= delta;
            candidate[to] += delta;
            const next = score(candidate);
            if (better(next, best)) {
              best = next;
              change = { from, to, left, right, candidate };
            }
          }
        }
      }
    }
    if (!change) break;
    const { from, to, left, right, candidate } = change;
    const a = left === -1 ? [] : shards[from].splice(left, 1);
    const b = right === -1 ? [] : shards[to].splice(right, 1);
    shards[from].push(...b);
    shards[to].push(...a);
    totals.splice(0, totals.length, ...candidate);
  }
  // A local optimum can still miss the planning target. Try a bounded,
  // deterministic whole-file placement before asking for capacity changes.
  // If it cannot find a fit, retain the plan so the guard reports its files.
  if (Math.max(...totals) > browserShardHeadroomTarget &&
      totals.reduce((sum, total) => sum + total, 0) <= shardCount * browserShardHeadroomTarget) {
    const fitted = Array.from({ length: shardCount }, () => []);
    const loads = Array(shardCount).fill(0);
    const milliseconds = file => Math.ceil(weightOf(file) * 1000 - 1e-9);
    let remainingNodes = 100_000;
    function place(index) {
      if (--remainingNodes < 0) return false;
      if (index === sortedFiles.length) return true;
      const file = sortedFiles[index], seenLoads = new Set();
      const bins = loads.map((_, bin) => bin).sort((a, b) => loads[a] - loads[b] || a - b);
      for (const bin of bins) {
        if (seenLoads.has(loads[bin]) || loads[bin] + milliseconds(file) > browserShardHeadroomTarget * 1000) continue;
        seenLoads.add(loads[bin]);
        loads[bin] += milliseconds(file);
        fitted[bin].push(file);
        if (place(index + 1)) return true;
        fitted[bin].pop();
        loads[bin] -= milliseconds(file);
        if (remainingNodes < 0) return false;
      }
      return false;
    }
    if (place(0)) return { shards: fitted, totals: loads.map(load => load / 1000) };
  }
  return { shards, totals };
}

const browserPacking = packBrowserTests(discoverBrowserTests());
export const browserShards = browserPacking.shards;
export const browserShardTotals = browserPacking.totals;

export function discoverBrowserTests() {
  return readdirSync(new URL('../test/browser/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => `test/browser/${entry.name}`).sort();
}

export function assertBrowserShardCoverage(files = discoverBrowserTests(), shards = browserShards, weights = browserTestWeights) {
  const counts = new Map();
  for (const file of shards.flat()) counts.set(file, (counts.get(file) ?? 0) + 1);
  const errors = [];
  if (shards.length === 0 || shards.some(shard => shard.length === 0)) errors.push('Empty browser shard');
  for (const file of files) {
    if (!counts.has(file)) errors.push(`Unassigned browser test: ${file}`);
    if (!Object.hasOwn(weights, file)) errors.push(`Missing browser test weight: ${file}`);
  }
  for (const [file, count] of counts) {
    if (count !== 1) errors.push(`Browser test assigned ${count} times: ${file}`);
    if (!files.includes(file)) errors.push(`Unknown browser test: ${file}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

export function assertBrowserShardBudget(totals = browserShardTotals) {
  if (totals.some(total => !Number.isFinite(total) || total < 0 || total > browserShardBudget)) {
    throw new Error(`Planned browser shard exceeds ${browserShardBudget}s: ${totals.join(' / ')}`);
  }
}

// Separate planning guard: report the overloaded bins and their measured files
// so capacity/workload changes can be reviewed without weakening the hard cap.
export function assertBrowserShardHeadroom(packing = browserPacking, weights = browserTestWeights) {
  const overloaded = packing.totals.flatMap((total, index) => total > browserShardHeadroomTarget
    ? [`Shard ${index + 1}/${packing.shards.length}: ${total.toFixed(3)}s; files: ${packing.shards[index]
      .map(file => `${file} (${weights[file].toFixed(3)}s)`).join(', ')}`] : []);
  if (overloaded.length) {
    throw new Error(`Browser shard headroom target exceeded (${browserShardHeadroomTarget}s; hard ceiling remains ${browserShardBudget}s). Review measured workloads and repack; do not lower weights without evidence.\n${overloaded.join('\n')}`);
  }
}

export function selectBrowserTests(args = []) {
  assertBrowserShardCoverage();
  assertBrowserShardBudget();
  const nodeArgs = [], selections = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shard') selections.push(args[++i]);
    else if (args[i].startsWith('--shard=')) selections.push(args[i].slice('--shard='.length));
    else nodeArgs.push(args[i]);
  }
  if (selections.length === 0) return { files: discoverBrowserTests(), nodeArgs };
  const match = selections.length === 1 && /^(\d+)\/(\d+)$/u.exec(selections[0] ?? '');
  if (!match || Number(match[2]) !== browserShards.length || Number(match[1]) < 1 || Number(match[1]) > browserShards.length) {
    throw new Error(`Use --shard N/${browserShards.length}, where N is 1 through ${browserShards.length}`);
  }
  return { files: [...browserShards[Number(match[1]) - 1]], nodeArgs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBrowserShardCoverage();
  assertBrowserShardBudget();
  assertBrowserShardHeadroom();
  browserShardTotals.forEach((total, index) => {
    console.log(`Browser shard ${index + 1}/${browserShards.length}: projected file work ${total.toFixed(3)}s (${browserShards[index].length} files).`);
  });
  console.log(`Browser shard coverage: ${discoverBrowserTests().length} files, exactly once across ${browserShards.length} shards.`);
}
