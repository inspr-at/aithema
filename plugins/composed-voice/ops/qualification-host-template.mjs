import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loopbackOrigin } from './qualification-server.mjs';
import { probeOutputDevice } from './qualification-output-probe.mjs';
import { launchLocalBrowser } from './qualification-browser.mjs';

/** Inert browser-side factory. OPS ports are mandatory and remain authoritative;
 * their account operations run on the flagged server, never in Chrome. */
export function createQualificationHost(options = {}) {
  const hostOrigin = loopbackOrigin(options.hostOrigin);
  for (const port of ['verifyCeiling', 'verifyReceipt', 'reconcile']) {
    if (typeof options[port] !== 'function') throw new TypeError(`OPS ${port} port required`);
  }
  const runDirectory = options.runDirectory ?? join(homedir(), 'ci.noindex', 'aithema-runs');
  if (!isAbsolute(runDirectory)) throw new TypeError('Absolute OPS runDirectory required');
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 20 * 60_000;
  if (!Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs < 1 || sampleTimeoutMs > 20 * 60_000) throw new TypeError('sampleTimeoutMs must be 1..1200000');
  if (options.launchBrowser !== undefined && typeof options.launchBrowser !== 'function') throw new TypeError('launchBrowser must be a function');
  if (!options.ownerHeaders || !Object.keys(options.ownerHeaders).length) throw new TypeError('Existing owner authentication headers required');
  const lifetimes = new Set(); let closed = false, running = false;
  const headers = { ...options.ownerHeaders };
  const post = async (input, signal) => {
    const response = await fetch(`${hostOrigin}/composed/qualification/control`, { method: 'POST', redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000), headers: { ...headers, origin: hostOrigin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`Qualification control refused (${response.status})`);
    return response.json();
  };
  return Object.freeze({
    verifyCeiling: options.verifyCeiling,
    verifyReceipt: options.verifyReceipt,
    reconcile: options.reconcile,
    async runSample({ item, lane, runId, admit, onTiming }) {
      if (closed || running) throw new Error('Qualification host closed or already running');
      if (![admit, onTiming].every(fn => typeof fn === 'function')) throw new TypeError('admit and onTiming required');
      if (!['candidate', 'baseline'].includes(lane) || typeof runId !== 'string' || !isAbsolute(item?.wavPath ?? '')) throw new TypeError('Sample identity and absolute corpus wavPath required');
      const launchArgs = options.launchArgs ?? [];
      if (launchArgs.some(arg => /mute-audio|disable-audio-output|fake-audio|user-data-dir|use-fake-device/u.test(arg))) throw new TypeError('Qualification capture/output flags cannot be overridden');
      running = true;
      let browser, sampleId, polling;
      const lifetime = new AbortController(), ready = Promise.withResolvers(), result = Promise.withResolvers();
      const processGroups = new Set(), deadlineAt = Date.now() + sampleTimeoutMs;
      const kill = () => { for (const group of processGroups) group.kill(); };
      const abort = reason => { lifetime.abort(reason); kill(); };
      const lease = { abort };
      lifetimes.add(lease);
      const timer = setTimeout(() => abort(new Error('Qualification sample wall-clock timeout')), sampleTimeoutMs);
      const onExit = () => kill();
      const onTerm = () => { kill(); process.exit(143); };
      const onInterrupt = () => { kill(); process.exit(130); };
      process.once('exit', onExit); process.once('SIGTERM', onTerm); process.once('SIGINT', onInterrupt);
      const expired = new Promise((_, reject) => lifetime.signal.addEventListener('abort', () => reject(lifetime.signal.reason), { once: true }));
      expired.catch(() => {});
      const bounded = action => Promise.race([action, expired]);
      const launchLifetime = { signal: lifetime.signal, deadlineAt, timeoutMs: sampleTimeoutMs, controllerPid: process.pid,
        registerProcessGroup(group) {
          if (typeof group?.kill !== 'function' || group.watchdogArmed !== true) throw new Error('Launcher must register a browser-user process-group kill port and independent watchdog');
          processGroups.add(group);
          if (lifetime.signal.aborted) group.kill();
        } };
      ready.promise.catch(() => {}); result.promise.catch(() => {});
      const admissions = new Map();
      try {
        await bounded(access(item.wavPath));
        const run = join(runDirectory, createHash('sha256').update(runId).digest('hex').slice(0, 24));
        await bounded(mkdir(run, { recursive: true }));
        const profile = await bounded(mkdtemp(join(run, `${lane}-chrome-`)));
        const launch = options.launchBrowser ?? launchLocalBrowser;
        browser = await bounded(Promise.resolve().then(() => launch({ executablePath: options.executablePath ?? process.env.CHROME_PATH, headless: true,
          userDataDir: profile, ignoreDefaultArgs: ['--mute-audio'],
          signal: lifetime.signal, timeout: Math.min(60_000, sampleTimeoutMs),
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
          env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR },
          args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${item.wavPath}`,
            '--use-fake-ui-for-media-stream', '--disable-features=AudioServiceSandbox',
            '--autoplay-policy=no-user-gesture-required', ...launchArgs] }, launchLifetime)));
        if (!processGroups.size || [...processGroups].some(group => group.failed)) throw new Error('Launcher returned without an armed process-group watchdog');
        await bounded(browser.defaultBrowserContext().overridePermissions(hostOrigin, ['microphone']));
        const page = await bounded(browser.newPage());
        await bounded(page.setExtraHTTPHeaders(headers));
        await bounded(page.setRequestInterception(true));
        page.on('request', request => {
          if (request.url().startsWith('data:') || new URL(request.url()).origin === hostOrigin) void request.continue();
          else void request.abort();
        });
        const response = await bounded(page.goto(`${hostOrigin}/composed/qualification`, { waitUntil: 'networkidle0' }));
        if (response.status() !== 200) throw new Error('Qualification page refused');
        await bounded(page.waitForFunction(() => window.composedQualification));
        const physicalBrowserMedia = await bounded(page.evaluate(probeOutputDevice));
        await bounded(writeFile(join(run, `${lane}-physical-browser-media.json`), JSON.stringify({ physicalBrowserMedia }, null, 2), { mode: 0o600 }));
        if (physicalBrowserMedia?.verified !== true) {
          const error = new Error('Qualification refused: null or unverified audio output device');
          error.physicalBrowserMedia = physicalBrowserMedia; throw error;
        }
        // Corpus reference/expected text stays in the CLI; only capture metadata
        // crosses to the server. The provider transcript is server-authoritative.
        ({ sampleId } = await bounded(post({ action: 'start', lane, runId, item: { id: item.id, sampleId: item.sampleId } }, lifetime.signal)));
        polling = (async () => {
          try {
            while (!lifetime.signal.aborted) {
              const { event } = await post({ action: 'poll', sampleId }, lifetime.signal); if (!event) continue;
              if (event.type === 'ready') { ready.resolve(event.grant); continue; }
              if (event.type === 'failure') throw new Error(event.error);
              if (event.type === 'result') { result.resolve(event.result); continue; }
              let value, error;
              try {
                if (event.type === 'admit') {
                  if (admissions.has(event.spec.attemptId)) throw new Error('Duplicate remote attempt');
                  const admission = await admit({ ...event.spec, lane });
                  admissions.set(event.spec.attemptId, { admission, consumed: false, reported: false });
                  const { attemptId, claimId, maxMicro } = admission.attempt; value = { attemptId, claimId, maxMicro };
                } else {
                  const row = admissions.get(event.attemptId); if (!row) throw new Error('Unknown remote attempt');
                  if (event.type === 'consume') { await row.admission.attempt.consume(); row.consumed = true; }
                  else if (event.type === 'report') { await row.admission.report(event.terminal); row.reported = true; }
                  else throw new Error('Unknown remote admission operation');
                }
              } catch { error = true; }
              await post({ action: 'ack', sampleId, id: event.id, value, error }, lifetime.signal);
              if (error) throw new Error('Remote provider admission refused');
            }
          } catch (error) { ready.reject(error); result.reject(error); throw error; }
        })();
        polling.catch(() => {});
        const grant = await bounded(ready.promise);
        const [trace, answer] = await bounded(Promise.all([
          page.evaluate(input => window.composedQualification.run(input), { grant, headers }), result.promise,
        ]));
        // No wall-clock remapping, fixture offset or reconstructed timestamp.
        for (const event of trace) onTiming(event);
        return { physicalBrowserMedia, hypothesis: answer.hypothesis, entities: answer.entities,
          ttsPCM: new Uint8Array(Buffer.from(answer.ttsPCM, 'base64')), ttsFormat: answer.ttsFormat };
      } finally {
        lifetime.abort(new Error('Qualification sample ended'));
        try {
          kill(); await polling?.catch(() => {});
          if (sampleId) {
            // Acknowledgement means OPS close() has stopped the dispatcher.
            // If it cannot be confirmed, retain exposure for explicit orphan recovery.
            await post({ action: 'close', sampleId });
            for (const [attemptId, row] of admissions) if (!row.reported) await row.admission.report({
              attemptId, outcome: row.consumed ? 'uncertain' : 'cancelled',
            });
          }
        }
        finally {
          try { await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => { const closing = setTimeout(resolve, 1000); closing.unref(); })]); }
          finally {
            clearTimeout(timer); process.removeListener('exit', onExit); process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInterrupt);
            lifetimes.delete(lease); running = false;
          }
        }
      }
    },
    async close() { closed = true; for (const lease of lifetimes) lease.abort(new Error('Qualification host closed')); },
  });
}
