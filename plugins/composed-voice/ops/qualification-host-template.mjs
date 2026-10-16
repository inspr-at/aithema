import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loopbackOrigin } from './qualification-server.mjs';

/** Inert browser-side factory. OPS ports are mandatory and remain authoritative;
 * their account operations run on the remote provider host, never in Chrome. */
export function createQualificationHost(options = {}) {
  const hostOrigin = loopbackOrigin(options.hostOrigin);
  for (const port of ['verifyCeiling', 'verifyReceipt', 'reconcile']) {
    if (typeof options[port] !== 'function') throw new TypeError(`OPS ${port} port required`);
  }
  if (!isAbsolute(options.runDirectory ?? '')) throw new TypeError('Absolute OPS runDirectory required');
  if (!options.ownerHeaders || !Object.keys(options.ownerHeaders).length) throw new TypeError('Existing owner authentication headers required');
  const browsers = new Set(); let closed = false, running = false;
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
      ready.promise.catch(() => {}); result.promise.catch(() => {});
      const admissions = new Map();
      try {
        await access(item.wavPath);
        const run = join(options.runDirectory, createHash('sha256').update(runId).digest('hex').slice(0, 24));
        await mkdir(run, { recursive: true });
        const profile = await mkdtemp(join(run, `${lane}-chrome-`));
        const launch = options.launchBrowser ?? ((await import('puppeteer-core')).default.launch.bind((await import('puppeteer-core')).default));
        browser = await launch({ executablePath: options.executablePath ?? process.env.CHROME_PATH, headless: true,
          userDataDir: profile, ignoreDefaultArgs: ['--mute-audio'],
          env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR },
          args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${item.wavPath}`,
            '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...launchArgs] });
        browsers.add(browser);
        await browser.defaultBrowserContext().overridePermissions(hostOrigin, ['microphone']);
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders(headers);
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (request.url().startsWith('data:') || new URL(request.url()).origin === hostOrigin) void request.continue();
          else void request.abort();
        });
        const response = await page.goto(`${hostOrigin}/composed/qualification`, { waitUntil: 'networkidle0' });
        if (response.status() !== 200) throw new Error('Qualification page refused');
        await page.waitForFunction(() => window.composedQualification);
        // Corpus reference/expected text stays in the CLI; only capture metadata
        // crosses to the server. The provider transcript is server-authoritative.
        ({ sampleId } = await post({ action: 'start', lane, runId, item: { id: item.id, sampleId: item.sampleId } }));
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
        const grant = await ready.promise;
        const [trace, answer] = await Promise.all([
          page.evaluate(input => window.composedQualification.run(input), { grant, headers }), result.promise,
        ]);
        // No wall-clock remapping, fixture offset or reconstructed timestamp.
        for (const event of trace) onTiming(event);
        return { hypothesis: answer.hypothesis, entities: answer.entities,
          ttsPCM: new Uint8Array(Buffer.from(answer.ttsPCM, 'base64')), ttsFormat: answer.ttsFormat };
      } finally {
        lifetime.abort(); await polling?.catch(() => {});
        try {
          if (sampleId) {
            // Acknowledgement means OPS close() has stopped the dispatcher.
            // If it cannot be confirmed, retain exposure for explicit orphan recovery.
            await post({ action: 'close', sampleId });
            for (const [attemptId, row] of admissions) if (!row.reported) await row.admission.report({
              attemptId, outcome: row.consumed ? 'uncertain' : 'cancelled',
            });
          }
        }
        finally { try { await browser?.close(); } finally { browsers.delete(browser); running = false; } }
      }
    },
    async close() { closed = true; await Promise.all([...browsers].map(browser => browser.close())); browsers.clear(); },
  });
}
