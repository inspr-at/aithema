import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname, homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath } from '../browser/start2-display-helpers.js';
import { offlineAudio } from './offline-audio.js';
import { installProbe } from './browser-probe.js';
import { diagnosticRecords, disruptionAt, markdown, percentile, schedule, spendGuard, summarize, validateOptions } from './soak-model.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalNetwork = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const digest = text => createHash('sha256').update(text).digest('hex');
const numeric = n => Number.isSafeInteger(n) && n >= 0;
export function walletCosts(body) {
  const owner = body?.balance?.owner;
  if (!owner || !['limitMicro', 'confirmedSpendMicro', 'uncertainSpendMicro', 'reservedMicro'].every(key => numeric(owner[key]))) throw new Error('Wallet cost breakdown unavailable');
  return { limitMicro: owner.limitMicro, confirmedMicro: owner.confirmedSpendMicro,
    uncertainMicro: owner.uncertainSpendMicro, reservedMicro: owner.reservedMicro };
}

async function readWallet(page) {
  return walletCosts(await page.evaluate(async () => {
    const id = document.querySelector('aithema-session').session.id;
    const response = await fetch(`/api/sessions/${id}/credits`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error('Wallet read failed');
    return response.json();
  }));
}

export async function runSoak(input = {}) {
  const config = validateOptions(input);
  if (/mbp2607/iu.test(hostname()) || !/mbp2606/iu.test(hostname())) throw new Error('Voice soak runs only on mbp2606');
  if (config.mode === 'live' && (!config.profile || !config.isolated)) throw new Error('OPS must supply a prepared profile and assert --isolated');
  const directory = await mkdtemp(join(tmpdir(), 'ait139-'));
  const output = resolve(config.output ?? join(directory, 'report'));
  await mkdir(output, { recursive: true });
  const report = { format: 'aithema-voice-soak', version: 1, ticket: 'AIT-139', mode: config.mode, locale: config.locale,
    head: process.env.GITHUB_SHA ?? process.env.AITHEMA_COMMIT
      ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1]
      ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    host: 'mbp2606', startedAt: new Date().toISOString(), status: 'failed', stopReason: 'setup-failed', elapsedMs: 0,
    config: { maxDurationMs: config.maxDurationMs, capMicro: config.capMicro, rateMicroPerMinute: config.rateMicroPerMinute,
      stopReserveMicro: config.stopReserveMicro, firstTokenDeadlineMs: config.firstTokenMs, totalDeadlineMs: config.totalMs },
    disruptions: [], records: [], client: {}, cost: { confirmedMicro: 0, uncertainMicro: 0, reservedMicro: 0, reconciled: false } };
  let browser, demo, page, cdp, start, guard, killTimer, lastWalletAt = 0, network = null, nextTurn = 0, callHash, requestedStop;
  const signals = ['SIGINT', 'SIGTERM'];
  const abort = () => { requestedStop ??= 'operator-signal'; };
  signals.forEach(signal => process.once(signal, abort));
  try {
    report.phase = 'offline-audio';
    const wav = await offlineAudio(directory, config.locale);
    report.phase = 'server-start';
    if (config.mode === 'fake') demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_VOICE_MODE: 'fake', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
      AITHEMA_ADMIN_SOCKET: join(directory, 'ops', 'admin'),
    });
    const url = demo?.url ?? config.url;
    report.phase = 'browser-start';
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, protocolTimeout: 5000,
      userDataDir: config.mode === 'live' ? config.profile : join(directory, 'chrome'),
      env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: directory },
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
        '--disable-features=AudioServiceSandbox',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--mute-audio'] });
    page = await browser.newPage(); page.setDefaultTimeout(15_000);
    if (config.mode === 'fake') {
      const origin = new URL(url).origin;
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (!['http:', 'https:'].includes(new URL(request.url()).protocol) || new URL(request.url()).origin === origin) void request.continue();
        else { report.externalRequestsBlocked = (report.externalRequestsBlocked ?? 0) + 1; void request.abort(); }
      });
    }
    await page.evaluateOnNewDocument(locale => {
      localStorage.setItem('aithema-demo-locale', locale);
      Object.defineProperty(navigator, 'languages', { get: () => [locale] });
    }, config.locale);
    report.phase = 'page-ready';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
    const hostConfig = await page.evaluate(() => fetch('/demo/config').then(r => r.json()).then(c => ({ voiceMode: c.voiceMode })));
    if (hostConfig.voiceMode !== (config.mode === 'fake' ? 'fake' : 'elevenlabs')) throw new Error('Host voice mode differs from requested mode');
    if (config.mode === 'live' && await page.$eval('aithema-session', c => c.session.locale) !== 'de') throw new Error('OPS profile must contain a DE conversation');
    const initial = await readWallet(page);
    if (initial.confirmedMicro || initial.uncertainMicro || initial.reservedMicro) throw new Error('Use a fresh isolated test wallet');
    if (config.mode === 'live' && initial.limitMicro !== config.capMicro) throw new Error('OPS test allowance must equal the harness cap');
    report.cost.initial = initial;
    report.phase = 'capture-probe';
    await page.evaluate(installProbe, { mode: config.mode, locale: config.locale });
    await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.chooser__continue')?.click());
    await page.waitForFunction(() => {
      const button = document.querySelector('aithema-session').shadowRoot.querySelector('.voice-start');
      return button && !button.disabled;
    });
    if (requestedStop) throw new Error('Operator stopped setup');
    // The duration and cost clock includes connection setup, recovery and outages.
    report.phase = 'call-start';
    start = performance.now(); lastWalletAt = start;
    guard = spendGuard(config, { abort: reason => {
      requestedStop ??= reason;
      // This runs even if a CDP call or wallet request stalls the main loop.
      void page.evaluate(() => globalThis.soak?.stop()).catch(() => {});
      killTimer = setTimeout(() => { void browser.close().catch(() => {}); }, 10_000);
    } });
    report.stopReason = 'running';
    await page.$eval('aithema-session', c => {
      const root = c.shadowRoot;
      if (root.querySelector('.workspace').dataset.stage === 'ready') {
        root.querySelector('.ready__mode[data-mode="voice"]').click(); root.querySelector('.ready__start').click();
      } else root.querySelector('.voice-start').click();
    });
    await page.waitForFunction(() => globalThis.soak?.session);
    callHash = digest(await page.evaluate(() => globalThis.soak.session.callId));
    report.callHash = callHash;
    const plan = schedule(config.maxDurationMs);
    report.phase = 'running';
    report.plan = plan;
    cdp = await page.createCDPSession();
    let costs = initial;
    while (true) {
      const now = performance.now(), elapsedMs = now - start;
      report.elapsedMs = Math.round(elapsedMs);
      guard.check({ ...costs, elapsedMs });
      if (requestedStop) { report.stopReason = requestedStop; break; }
      if (now - lastWalletAt > 8000) { report.stopReason = 'wallet-stale'; break; }
      const window = disruptionAt(plan.disruptions, elapsedMs);
      if (window !== network) {
        const previous = network; network = window;
        await cdp.send('Network.emulateNetworkConditions', window ? { ...normalNetwork, offline: window.offline, latency: window.latencyMs } : normalNetwork);
        report.disruptions.push({ elapsedMs: Math.round(elapsedMs), offline: window?.offline ?? false, latencyMs: window?.latencyMs ?? 0 });
        if (window?.offline) {
          const failed = await page.evaluate(async () => {
            try { await fetch(`/healthz?soak=${performance.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) }); return false; }
            catch { return true; }
          });
          report.offlineRequestFailed = failed;
        }
        if (previous?.offline && !window) await page.evaluate(() => { void globalThis.soak.recover(); });
      }
      if (!window?.offline && now - lastWalletAt > 1000) {
        try { costs = await readWallet(page); lastWalletAt = performance.now(); report.cost = { ...report.cost, ...costs }; }
        catch { /* A bounded stale-wallet guard stops the call above. */ }
      }
      if (plan.turns[nextTurn] && elapsedMs >= plan.turns[nextTurn].atMs && !window?.offline) {
        await page.evaluate(turn => globalThis.soak.turn(turn), plan.turns[nextTurn++]);
      }
      await page.evaluate(() => globalThis.soak.barge());
      if (await page.evaluate(() => globalThis.soak.closed)) { report.stopReason = 'call-ended-early'; break; }
      await delay(200);
    }
  } catch {
    // Error messages from a browser/provider can contain private payloads.
    report.stopReason = requestedStop ?? (start ? 'harness-error' : 'setup-failed');
  } finally {
    guard?.dispose();
    if (start) report.elapsedMs = Math.round(performance.now() - start);
    try { await cdp?.send('Network.emulateNetworkConditions', normalNetwork); } catch { /* Browser may have exited. */ }
    try { await page?.evaluate(() => globalThis.soak?.stop()); } catch { report.closeFailed = true; }
    try {
      // Do not declare final spend while closure or wallet liabilities are pending.
      for (let attempt = 0; attempt < 15; attempt++) {
        const final = await readWallet(page); report.cost = { ...report.cost, ...final };
        if (!final.reservedMicro && !final.uncertainMicro) { report.cost.reconciled = !report.closeFailed; break; }
        await delay(1000);
      }
    } catch { report.cost.reconciled = false; }
    try { report.client = await page.evaluate(() => globalThis.soak.snapshot()); } catch { /* setup failure */ }
    if (callHash && config.diagnostics) {
      try { report.records = diagnosticRecords(await readFile(config.diagnostics, 'utf8'), callHash); }
      catch { report.diagnosticsUnavailable = true; }
    }
    const events = report.client.events ?? [], turns = report.client.turns ?? [];
    report.server = summarize({ records: report.records, events, ...config });
    const first = turns.map(t => t.firstResponseMs).filter(Number.isFinite);
    report.client = { ...report.client, turns: turns.length, turnTimings: turns,
      firstResponse: { p50Ms: percentile(first, .5), p95Ms: percentile(first, .95) },
      missingResponses: turns.filter(t => !Number.isFinite(t.firstResponseMs) || t.firstResponseMs > config.firstTokenMs).length,
      bargeIns: events.filter(e => e.type === 'heard').length,
      bargeAttempts: turns.filter(t => t.bargeAttempted).length };
    report.status = report.stopReason === 'max-duration' && report.cost.reconciled && report.client.speechSamples > 0
      && report.client.bargeIns > 0 && report.server.recoveries > 0 && report.offlineRequestFailed
      && report.disruptions.some(d => d.latencyMs > 0)
      && !report.externalRequestsBlocked && !report.client.missingResponses
      && report.cost.confirmedMicro + report.cost.uncertainMicro + report.cost.reservedMicro <= config.capMicro
      && (config.mode === 'fake' || report.server.attempts > 0 && !report.server.failed && !report.server.firstToken.missed && !report.server.total.missed)
      ? 'passed' : 'failed';
    await browser?.close().catch(() => {});
    clearTimeout(killTimer);
    await demo?.kill();
    signals.forEach(signal => process.removeListener(signal, abort));
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'soak-report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(output, 'soak-summary.md'), markdown(report));
  }
  return { report, output };
}
