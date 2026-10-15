// AIT-199 evidence batch, explicitly invoked through remote-browser.sh only.
// This is outside test/browser so CI's full-suite shard manifest is unchanged.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
const free = () => Number(/free percentage: (\d+)%/u.exec(run('memory_pressure', ['-Q']))?.[1]);

async function measure(output, variant, executable, files) {
  const dir = join(output, variant); await mkdir(dir, { recursive: true });
  const stats = { variant, executable, browserVersion: run(executable, ['--version']).trim(), pinnedShellBuild: browserBuild, peakChromeTreeRssKiB: 0,
    freeBeforePct: free(), minFreePct: 100, freeAfterPct: null, samples: [], files: [] };
  for (const [file, pattern] of files) {
    const started = performance.now();
    const baseline = variant.startsWith('old-full-chrome') ? ['--import', './test/measurements/full-chrome-baseline.js'] : [];
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
        stats.samples.push({ file, elapsedMs: Math.round(performance.now() - started), rssKiB: rss, freePct, pids: browsers.map(row => row.pid), mainCommands: browsers.filter(row => !row.command.includes('--type=')).map(row => row.command) });
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

function difference(before, after, file) {
  const sameSize = before.width === after.width && before.height === after.height;
  const row = { file, width: before.width, height: before.height, newWidth: after.width, newHeight: after.height, sameSize };
  if (!sameSize) return row;
  let changed = 0, above8 = 0, sum = 0, max = 0;
  const histogram = Array(256).fill(0), total = before.width * before.height;
  for (let i = 0; i < total; i++) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(before.result[i * before.channels + c] - after.result[i * after.channels + c]);
      sum += d; delta = Math.max(delta, d); max = Math.max(max, d);
    }
    histogram[delta]++; if (delta) changed++; if (delta > 8) above8++;
  }
  return Object.assign(row, { changedPixels: changed, changedPct: 100 * changed / total, above8Pct: 100 * above8 / total,
    meanAbsoluteChannelDelta: sum / (total * 3), maxChannelDelta: max, pixelMaxDeltaHistogram: histogram });
}

// A standalone RGB PNG encoder keeps review artifacts independent of browsers.
function png(width, height, rgb) {
  const chunk = (kind, data) => {
    const name = Buffer.from(kind), body = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scan = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) rgb.copy(scan, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
async function reviewPng(path, old, current) {
  const width = Math.max(old.width, current.width), height = Math.max(old.height, current.height);
  const rgb = Buffer.alloc(width * 3 * height * 3, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    const a = x < old.width && y < old.height ? old.result[(y * old.width + x) * old.channels + c] : 255;
    const b = x < current.width && y < current.height ? current.result[(y * current.width + x) * current.channels + c] : 255;
    rgb[(y * width * 3 + x) * 3 + c] = a;
    rgb[(y * width * 3 + width + x) * 3 + c] = b;
    rgb[(y * width * 3 + width * 2 + x) * 3 + c] = Math.abs(a - b);
  }
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, png(width * 3, height, rgb));
}

export async function compareBrowsers(t, files = batch) {
  assert.match(hostname(), /mbp2606/iu);
  const output = process.env.AITHEMA_EVIDENCE_DIR; assert.ok(output);
  await mkdir(output, { recursive: true });
  const shell = await browserPath(), chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const old = await measure(output, 'old-full-chrome', chrome, files);
  const oldRepeat = await measure(output, 'old-full-chrome-repeat', chrome, files);
  const current = await measure(output, 'headless-shell', shell, files);
  const currentRepeat = await measure(output, 'headless-shell-repeat', shell, files);
  const variants = [old, oldRepeat, current, currentRepeat];
  const lists = await Promise.all(variants.map(async v => (await readdir(join(output, v.variant), { recursive: true })).filter(n => n.endsWith('.png')).sort()));
  for (const list of lists.slice(1)) assert.deepEqual(list, lists[0], 'every capture must include exactly the same sample');
  const comparisons = [], chromeNoise = [], shellNoise = [], review = [];
  for (const file of lists[0]) {
    const [a, ar, b, br] = await Promise.all(variants.map(async v => pixels(await readFile(join(output, v.variant, file)))));
    const row = difference(a, b, file), cn = difference(a, ar, file), sn = difference(b, br, file);
    chromeNoise.push(cn); shellNoise.push(sn);
    row.noiseFloor = { above8Pct: Math.max(cn.above8Pct ?? Infinity, sn.above8Pct ?? Infinity),
      meanAbsoluteChannelDelta: Math.max(cn.meanAbsoluteChannelDelta ?? Infinity, sn.meanAbsoluteChannelDelta ?? Infinity) };
    row.aboveNoiseFloor = !row.sameSize || row.above8Pct > row.noiseFloor.above8Pct || row.meanAbsoluteChannelDelta > row.noiseFloor.meanAbsoluteChannelDelta;
    if (row.aboveNoiseFloor) {
      const path = join('review', file); await reviewPng(join(output, path), a, b); row.review = path; review.push(path);
    }
    comparisons.push(row);
  }
  const summarize = rows => ({ pairs: rows.length, maxAbove8Pct: Math.max(...rows.map(r => r.above8Pct ?? Infinity)),
    maxChangedPct: Math.max(...rows.map(r => r.changedPct ?? Infinity)), maxMeanAbsoluteChannelDelta: Math.max(...rows.map(r => r.meanAbsoluteChannelDelta ?? Infinity)),
    dimensionMismatches: rows.filter(r => !r.sameSize).map(r => r.file) });
  const head = /aithema-runs\/([a-f0-9]{10})-/u.exec(process.cwd())?.[1];
  const rootDiagnostics = [];
  for (const device of (files === batch ? ['desktop', 'phone'] : [])) for (const theme of ['light', 'dark']) {
    const name = `ait-129-root-${device}-${theme}`;
    const states = await Promise.all(variants.map(v => readFile(join(output, 'diagnostics', v.variant, `${name}.json`), 'utf8').then(JSON.parse)));
    const ablations = {};
    for (const suffix of ['unsettled', 'no-backdrop']) {
      const [a, ar, b, br] = await Promise.all(variants.map(async v => pixels(await readFile(join(output, 'diagnostics', v.variant, `${name}-${suffix}.png`)))));
      ablations[suffix] = { crossBrowser: difference(a, b, `${name}-${suffix}.png`),
        fullChromeNoise: difference(a, ar, `${name}-${suffix}.png`), headlessShellNoise: difference(b, br, `${name}-${suffix}.png`) };
      await reviewPng(join(output, 'review', 'diagnostics', `${name}-${suffix}.png`), a, b);
    }
    rootDiagnostics.push({ file: `${name}.png`, states, ablations });
  }
  const summary = { head, rootDiagnostics, assessment: review.length ? 'visual review required for every pair above its measured same-browser noise floor' : 'no cross-browser pair above measured noise',
    allPairs: comparisons.length, excludedPairs: [], fullPairSummary: summarize(comparisons),
    noiseBaselines: { fullChrome: summarize(chromeNoise), headlessShell: summarize(shellNoise), fullChromePairs: chromeNoise, headlessShellPairs: shellNoise },
    thresholds: { diagnosticChannelDelta: 8, acceptanceLimitPct: null,
      rationale: '>8 is retained only as a historical diagnostic, with raw changed pixels, mean error and the complete delta histogram alongside it. The unsupported 1% acceptance limit is removed. Every pair exceeding either same-browser repeat in >8 pixel fraction OR mean channel error requires review; these two repeats estimate noise and do not establish a statistical confidence bound.' },
    ReportCrash: { claim: 'withdrawn', reason: 'macOS does not report SIGKILL; Puppeteer already passes --disable-breakpad; the prior Chrome run had no comparable capture window. No crash-service suppression conclusion is supported.' },
    old, oldRepeat, current, currentRepeat, review, comparisons };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(output, 'assessment.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(output, 'full-pair-table.csv'), ['file,changedPct,above8Pct,noiseAbove8Pct,meanError,noiseMeanError,aboveNoiseFloor,review', ...comparisons.map(r =>
    [r.file, r.changedPct, r.above8Pct, r.noiseFloor.above8Pct, r.meanAbsoluteChannelDelta, r.noiseFloor.meanAbsoluteChannelDelta, r.aboveNoiseFloor, r.review ?? ''].join(','))].join('\n') + '\n');
  t.diagnostic(JSON.stringify({ head, fullPairSummary: summary.fullPairSummary, noise: { chrome: summarize(chromeNoise), shell: summarize(shellNoise) }, review: review.length }));
  const families = files.length === 1 ? [/^ait155-/u] : [/^ait155-/u, /^ait-169-/u, /^a2-/u, /^ait-129-root-/u, /^ait-129-consent-/u, /^L1\//u, /^ait-138-/u];
  for (const pattern of families) assert.ok(comparisons.some(row => pattern.test(row.file)), `comparison sample includes ${pattern}`);
  if (files === batch) assert.equal(comparisons.length, 346, 'complete requested sample, without exclusions');
  assert.deepEqual(summary.fullPairSummary.dimensionMismatches, []);
}
