// AIT-199 evidence batch, explicitly invoked through remote-browser.sh only.
// This is outside test/browser so CI's full-suite shard manifest is unchanged.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { browserPath, browserBuild } from '../../scripts/install-test-browser.js';
import { pixels } from '../browser/png-pixels.js';

const batch = [
  ['test/browser/start2-display.test.js', 'AIT-192|AIT-155:'],
  ['test/browser/admin-pages.test.js', 'AIT-169'],
  ['test/browser/visitor-credit-tiers.test.js', 'AIT-135 A2'],
  ['test/browser/start-journey.test.js', 'contract consent stays stable'],
  ['test/browser/pause-phone.test.js', 'AIT-188 L1:'],
  ['test/browser/start2-display-continuity.test.js', '.*'],
];
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const localDate = () => run('date', ['+%Y-%m-%d %H:%M:%S']).trim();
const free = () => Number(/free percentage: (\d+)%/u.exec(run('memory_pressure', ['-Q']))?.[1]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function measure(output, variant, executable, files) {
  const dir = join(output, variant); await mkdir(dir, { recursive: true });
  const stats = { variant, executable, browserVersion: run(executable, ['--version']).trim(), pinnedShellBuild: browserBuild, peakChromeTreeRssKiB: 0,
    freeBeforePct: free(), minFreePct: 100, freeAfterPct: null, samples: [], files: [] };
  for (const [file, pattern] of files) {
    const started = performance.now();
    const baseline = variant === 'old-full-chrome' ? ['--import', './test/measurements/full-chrome-baseline.js'] : [];
    const childEnv = { ...process.env, CI: '1', CHROME_PATH: executable, AITHEMA_EVIDENCE_DIR: dir };
    // A nested `node --test` otherwise sees itself as an existing test worker
    // and silently skips every requested file (Node's recursive-run guard).
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [...baseline, '--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, file], {
      env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const sample = () => {
      try {
        // mbp2606's Nix ps cannot query RSS without an entitlement; native ps can.
        const rows = run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command=']).trim().split('\n').map(line => {
          const [, pid, parent, rss, command] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
          return { pid: +pid, parent: +parent, rss: +rss, command };
        });
        const descendants = new Set([child.pid]);
        let count;
        do { count = descendants.size; for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid); }
        while (count !== descendants.size);
        const browsers = rows.filter(row => descendants.has(row.pid) && !/^(?:\S*\/)?node /u.test(row.command)
          && /Google Chrome|chrome-headless-shell/u.test(row.command));
        const rss = browsers.reduce((sum, row) => sum + row.rss, 0), freePct = free();
        stats.samples.push({ file, elapsedMs: Math.round(performance.now() - started), rssKiB: rss, freePct, pids: browsers.map(row => row.pid) });
        stats.peakChromeTreeRssKiB = Math.max(stats.peakChromeTreeRssKiB, rss);
        stats.minFreePct = Math.min(stats.minFreePct, freePct);
      } catch (error) { stats.sampleError = error.message; }
    };
    const timer = setInterval(sample, 1000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearInterval(timer);
    await writeFile(join(dir, file.split('/').at(-1) + '.log'), log);
    stats.files.push({ file, pattern, code, seconds: (performance.now() - started) / 1000 });
    console.log(`${variant}: ${file}: exit=${code}`);
    assert.equal(code, 0, log.slice(-6000));
  }
  stats.freeAfterPct = free();
  await writeFile(join(dir, 'memory.json'), JSON.stringify(stats, null, 2));
  assert.ok(stats.peakChromeTreeRssKiB > 0, 'observed browser tree RSS');
  assert.equal(stats.sampleError, undefined);
  return stats;
}

export async function compareBrowsers(t, files = batch) {
  assert.match(hostname(), /mbp2606/iu);
  const output = process.env.AITHEMA_EVIDENCE_DIR; assert.ok(output);
  await mkdir(output, { recursive: true });
  // Full Chrome is used ONLY as the measured old baseline, never a suite exception.
  const old = await measure(output, 'old-full-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', files);
  const shell = await browserPath();
  const start = localDate();
  const current = await measure(output, 'headless-shell', shell, files);
  await pause(10_000); // Give macOS's asynchronous crash service time to record a kill.
  const end = localDate();
  const reportLog = run('log', ['show', '--style', 'compact', '--start', start, '--end', end, '--predicate', 'process == "ReportCrash"']);
  await writeFile(join(output, 'ReportCrash.log'), reportLog);
  const reportLines = reportLog.split('\n').filter(line => /ReportCrash\[/u.test(line));
  const correlatedLines = reportLines.filter(line => /chrome-headless|headless_shell/iu.test(line));
  const comparisons = [];
  for (const file of (await readdir(join(output, 'headless-shell'), { recursive: true })).filter(name => name.endsWith('.png')).sort()) {
    let before;
    try { before = pixels(await readFile(join(output, 'old-full-chrome', file))); } catch { continue; }
    const after = pixels(await readFile(join(output, 'headless-shell', file)));
    const sameSize = before.width === after.width && before.height === after.height;
    const row = { file, width: before.width, height: before.height, newWidth: after.width, newHeight: after.height, sameSize };
    if (sameSize) {
      let changed = 0, above8 = 0, sum = 0, max = 0;
      const total = before.width * before.height;
      for (let i = 0; i < total; i++) {
        let delta = 0;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(before.result[i * before.channels + c] - after.result[i * after.channels + c]);
          sum += d; delta = Math.max(delta, d); max = Math.max(max, d);
        }
        if (delta) changed++; if (delta > 8) above8++;
      }
      Object.assign(row, { changedPixels: changed, changedPct: 100 * changed / total, above8Pct: 100 * above8 / total,
        meanAbsoluteChannelDelta: sum / (total * 3), maxChannelDelta: max });
    }
    comparisons.push(row);
  }
  const summary = { old, current, ReportCrash: { start, end, totalLines: reportLines.length, correlatedLines }, comparisons };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(summary, null, 2));
  t.diagnostic(JSON.stringify({ oldPeakMiB: old.peakChromeTreeRssKiB / 1024, newPeakMiB: current.peakChromeTreeRssKiB / 1024,
    oldMinFree: old.minFreePct, newMinFree: current.minFreePct, screenshots: comparisons.length,
    ReportCrashLines: reportLines.length, correlatedLines: correlatedLines.length }));
  assert.equal(correlatedLines.length, 0, 'no ReportCrash activity for the headless shell');
  const families = files.length === 1 ? [/^ait155-/u] : [/^ait155-/u, /^ait-169-/u, /^a2-/u, /^ait-129-consent-/u, /^L1\//u];
  for (const pattern of families) {
    assert.ok(comparisons.some(row => pattern.test(row.file)), `comparison sample includes ${pattern}`);
  }
  // A missing masked transcript is a rendering failure, not gradient dithering.
  // Keep the raw metrics and fail the measured comparison for that regression.
  for (const row of comparisons.filter(row => row.file.startsWith('ait155-band-'))) {
    assert.ok(row.sameSize && row.above8Pct < 1, `${row.file}: ${row.above8Pct}% of pixels differ by >8`);
  }
}
