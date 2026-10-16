import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loopbackOrigin } from './qualification-server.mjs';
import { probePhysicalOutput, findRefusedOutputFlags } from './qualification-output-probe.mjs';
import { baselineOrigin, baselineAttemptCeiling, loadBaselineAuth, runProductionBaseline } from './qualification-production-baseline.mjs';
import { matchQualificationEntities } from './qualification-live-server.mjs';
import { readQualificationCorpus } from '../src/qualification-corpus.js';
import { IncompleteMediaEvidence } from '../src/live-qualification.js';
import { QualificationSampleFailure, QUALIFICATION_SAMPLE_FAILURES } from '../src/qualification-failure.js';
import { installScriptedCapture } from './qualification-scripted-capture.mjs';
import { launchLocalBrowser } from './qualification-browser.mjs';

/** Inert browser-side factory. OPS ports are mandatory and remain authoritative;
 * their account operations run on the flagged server, never in Chrome. */
export function createQualificationHost(options = {}) {
  if (options.baselineSetupOnly !== undefined && typeof options.baselineSetupOnly !== 'boolean') throw new TypeError('baselineSetupOnly must be boolean');
  const setupOnly = options.baselineSetupOnly === true;
  const hostOrigin = setupOnly ? undefined : loopbackOrigin(options.hostOrigin);
  for (const port of setupOnly ? [] : ['verifyCeiling', 'verifyReceipt', 'reconcile']) {
    if (typeof options[port] !== 'function') throw new TypeError(`OPS ${port} port required`);
  }
  const runDirectory = options.runDirectory ?? join(homedir(), 'ci.noindex', 'aithema-runs');
  if (!isAbsolute(runDirectory)) throw new TypeError('Absolute OPS runDirectory required');
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 20 * 60_000;
  if (!Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs < 1 || sampleTimeoutMs > 20 * 60_000) throw new TypeError('sampleTimeoutMs must be 1..1200000');
  if (options.launchBrowser !== undefined && typeof options.launchBrowser !== 'function') throw new TypeError('launchBrowser must be a function');
  if (options.prepareCandidateSession !== undefined && typeof options.prepareCandidateSession !== 'function') throw new TypeError('prepareCandidateSession must be a function');
  if (!setupOnly && (!options.ownerHeaders || !Object.keys(options.ownerHeaders).length)) throw new TypeError('Existing owner authentication headers required');
  if (!setupOnly && !/^[a-f0-9]{64}$/u.test(options.controlCapability ?? '')) throw new TypeError('CLI controlCapability required');
  if (Object.keys(options.ownerHeaders ?? {}).some(name => name.toLowerCase() === 'x-aithema-qualification-control')) throw new TypeError('Control capability must stay out of browser ownerHeaders');
  const baselineSessions = new Map(); let identityWrites = Promise.resolve();
  const lifetimes = new Set(); let closed = false, running = false;
  const headers = { ...options.ownerHeaders };
  const post = async (input, signal) => {
    const response = await fetch(`${hostOrigin}/composed/qualification/control`, { method: 'POST', redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000), headers: { ...headers, origin: hostOrigin, 'content-type': 'application/json',
        'x-aithema-qualification-control': options.controlCapability }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`Qualification control refused (${response.status})`);
    return response.json();
  };
  const run = async ({ item, lane, runId, admit, onTiming }) => {
      if (closed || running) throw new Error('Qualification host closed or already running');
      if (![admit, onTiming].every(fn => typeof fn === 'function')) throw new TypeError('admit and onTiming required');
      if (!['candidate', 'baseline'].includes(lane) || typeof runId !== 'string' || !runId ||
        !setupOnly && !['utterancePath', 'bargeInPath'].every(key => isAbsolute(item?.[key] ?? ''))) throw new TypeError('Sample identity and absolute corpus utterancePath and bargeInPath required');
      const launchArgs = options.launchArgs ?? [];
      if (findRefusedOutputFlags(launchArgs).length || launchArgs.some(arg => /fake-audio|user-data-dir|use-fake-device/u.test(arg))) throw new TypeError('Qualification capture/output flags cannot be overridden');
      if (lane === 'baseline') baselineAttemptCeiling(options.binding);
      const targetOrigin = lane === 'baseline' ? baselineOrigin(options.binding?.baselineOrigin) : hostOrigin;
      // Authentication is mandatory for the internal production gate. Refuse
      // before launch/admission; candidate never opens or receives this file.
      const baselineAuth = lane === 'baseline' ? await loadBaselineAuth(options.binding?.baselineAuthFile) : undefined;
      running = true;
      let browser, sampleId, polling, terminalRefusal, sampleFailure, measured = false;
      let evidenceRun, postMeasurementCount = 0;
      const recordTiming = event => {
        if (event.kind === 'post-measurement') postMeasurementCount++;
        onTiming(event);
      };
      const recordPostMeasurement = () => recordTiming({ kind: 'post-measurement' });
      const lifetime = new AbortController(), ready = Promise.withResolvers(), result = Promise.withResolvers();
      const processGroups = new Set(), deadlineAt = Date.now() + sampleTimeoutMs;
      const kill = () => { for (const group of processGroups) group.kill(); };
      // Kill the group before Puppeteer's abort handler tears down/reaps its
      // leader; otherwise macOS can report EPERM for the dying process group.
      const abort = reason => { try { kill(); } finally { lifetime.abort(reason); } };
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
        const clips = setupOnly ? undefined : await bounded(readQualificationCorpus(item));
        const run = join(runDirectory, createHash('sha256').update(runId).digest('hex').slice(0, 24));
        await bounded(mkdir(run, { recursive: true })); evidenceRun = run;
        const profile = await bounded(mkdtemp(join(run, `${lane}-chrome-`)));
        const launch = options.launchBrowser ?? launchLocalBrowser;
        browser = await bounded(Promise.resolve().then(() => launch({ executablePath: options.executablePath ?? process.env.CHROME_PATH, headless: true,
          userDataDir: profile, ignoreDefaultArgs: ['--mute-audio'],
          signal: lifetime.signal, timeout: Math.min(60_000, sampleTimeoutMs),
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
          env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR },
          args: ['--disable-features=AudioServiceSandbox',
            '--autoplay-policy=no-user-gesture-required', ...launchArgs] }, launchLifetime)));
        if (!processGroups.size || [...processGroups].some(group => group.failed)) throw new Error('Launcher returned without an armed process-group watchdog');
        await bounded(browser.defaultBrowserContext().overridePermissions(targetOrigin, ['microphone']));
        const page = await bounded(browser.newPage());
        // Puppeteer uses CDP Page.addScriptToEvaluateOnNewDocument, just as the
        // baseline probe does. Install the same capture before either navigation.
        if (!setupOnly) await bounded(page.evaluateOnNewDocument(installScriptedCapture, clips));
        const preflight = async () => {
          const physicalBrowserMedia = await bounded(probePhysicalOutput(page, browser));
          await bounded(writeFile(join(run, `${lane}-physical-browser-media.json`), JSON.stringify({ physicalBrowserMedia }, null, 2), { mode: 0o600 }));
          if (physicalBrowserMedia?.verified !== true) {
            const error = new Error('Qualification refused: null or unverified audio output device');
            error.physicalBrowserMedia = physicalBrowserMedia; throw error;
          }
          return physicalBrowserMedia;
        };
        if (lane === 'baseline') {
          const answer = await runProductionBaseline({ page, binding: options.binding, item, runId, admit, onTiming: recordTiming,
            auth: baselineAuth, setupOnly,
            async boundConversation(deadlineAt) {
              for (const group of processGroups) {
                if (typeof group.limitDeadline !== 'function') throw new Error('Baseline requires a duration watchdog');
                await bounded(group.limitDeadline(deadlineAt));
              }
            }, consentDecision: options.consentDecision, bounded, abort, preflight,
            async recordEvidence(evidence) {
              const file = createHash('sha256').update(`${runId}:${item.sampleId ?? item.id}`).digest('hex').slice(0, 24);
              await writeFile(join(run, `baseline-invalid-${file}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
              if (evidence.status === 'setup-failed') {
                // The baseline owns these fixed labels. Keep visitor/run IDs
                // in the existing private identity evidence, never this summary.
                const diagnostic = { reason: evidence.reason, setup: evidence.setup };
                try { await writeFile(join(run, 'failure.json'), JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: 'wx' }); }
                catch (error) {
                  if (error.code !== 'EEXIST') throw error;
                  await writeFile(join(run, `failure-${randomUUID()}.json`), JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: 'wx' });
                }
              }
            },
            async recordIdentity(identity) {
              const key = `${runId}:${item.sampleId ?? item.id}`;
              baselineSessions.set(key, identity);
              // Persist identities even when media fails, for OPS's receipt GET.
              const file = createHash('sha256').update(key).digest('hex').slice(0, 24);
              identityWrites = identityWrites.then(() => writeFile(join(run, `baseline-session-${file}.json`), JSON.stringify(identity, null, 2), { mode: 0o600 }));
              await identityWrites;
            } });
          if (setupOnly) {
            await writeFile(join(run, 'baseline-setup.json'), JSON.stringify(answer, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            return answer;
          }
          return { ...answer, entities: matchQualificationEntities(answer.hypothesis,
            item.expected === undefined ? [] : Array.isArray(item.expected) ? item.expected : [item.expected]) };
        }
        await bounded(page.setExtraHTTPHeaders(headers));
        await bounded(page.setRequestInterception(true));
        page.on('request', request => {
          if (request.url().startsWith('data:') || new URL(request.url()).origin === hostOrigin) void request.continue();
          else void request.abort();
        });
        const response = await bounded(page.goto(`${hostOrigin}/composed/qualification`, { waitUntil: 'networkidle0' }));
        if (response.status() !== 200) throw new Error('Qualification page refused');
        await bounded(page.waitForFunction(() => window.composedQualification));
        const physicalBrowserMedia = await preflight();
        const sessionId = options.prepareCandidateSession ? await bounded(options.prepareCandidateSession()) : options.sessionId;
        // Reference sentences stay in the CLI. Expected entities travel only
        // on Node control requests; providers and Chrome receive neither.
        ({ sampleId } = await bounded(post({ action: 'start', lane, runId, item: { id: item.id, sampleId: item.sampleId, ...(sessionId ? { sessionId,
          expectedEntities: Array.isArray(item.expected) ? item.expected : [item.expected] } : {}) } }, lifetime.signal)));
        await bounded(page.exposeFunction('qualificationMeasurementTerminal', async (outcome = {}) => {
          terminalRefusal = outcome.refusal === undefined ? undefined : new IncompleteMediaEvidence(outcome.refusal);
          measured = true;
          await post({ action: 'measurement-terminal', sampleId }, lifetime.signal);
        }));
        polling = (async () => {
          try {
            while (!lifetime.signal.aborted) {
              const { event } = await post({ action: 'poll', sampleId }, lifetime.signal); if (!event) continue;
              if (event.type === 'post-measurement') { recordPostMeasurement(); continue; }
              if (event.type === 'ready') { ready.resolve(event.grant); continue; }
              if (event.type === 'failure') {
                const failure = new QualificationSampleFailure(Object.hasOwn(QUALIFICATION_SAMPLE_FAILURES, event.reason) ? event.reason : 'sample-failed');
                // Closing before first audio can leave a transcript but no PCM
                // (qualification-live-server.mjs close()). Only that settlement
                // is expected for these typed early refusals. A measured sample,
                // missing transcript, stop/report failure or PCM bound must abort.
                if (failure.reason === 'missing-audio' && terminalRefusal &&
                  ['late-first-audio', 'barge-in-before-first-audio'].includes(terminalRefusal.reason)) {
                  result.resolve(); return;
                }
                throw failure;
              }
              if (event.type === 'result') { result.resolve(event.result); continue; }
              let value, error, refused;
              try {
                if (event.type === 'admit') {
                  if (admissions.has(event.spec.attemptId)) throw new Error('Duplicate remote attempt');
                  if (measured) {
                    recordPostMeasurement();
                    await post({ action: 'ack', sampleId, id: event.id, refused: 'sample-complete' }, lifetime.signal);
                    continue;
                  }
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
              if (error && measured && event.type === 'admit') { refused = 'sample-complete'; recordPostMeasurement(); }
              await post({ action: 'ack', sampleId, id: event.id, value, error, refused }, lifetime.signal);
              if (error && !refused) {
                if (event.type === 'report') throw new QualificationSampleFailure('report-rejected');
                throw new Error('Remote provider admission refused');
              }
            }
          } catch (error) { ready.reject(error); result.reject(error); throw error; }
        })();
        polling.catch(() => {});
        const grant = await bounded(ready.promise);
        // A failed server settlement also aborts a still-pending browser close.
        const serverFailure = result.promise.then(() => new Promise(() => {}));
        const media = await bounded(Promise.race([
          page.evaluate(input => window.composedQualification.run(input), { grant, headers }), serverFailure,
        ]));
        for (const event of media.trace) recordTiming(event);
        const answer = await bounded(result.promise);
        if (media.refusal) throw new IncompleteMediaEvidence(media.refusal);
        // Keep observed source/device timestamps unchanged in the probe.
        return { physicalBrowserMedia, hypothesis: answer.hypothesis, entities: answer.entities,
          ttsPCM: new Uint8Array(Buffer.from(answer.ttsPCM, 'base64')), ttsFormat: answer.ttsFormat, ttsConfig: answer.ttsConfig };
      } catch (error) {
        sampleFailure = error; throw error;
      } finally {
        try {
          try { kill(); } finally { lifetime.abort(new Error('Qualification sample ended')); }
          await polling?.catch(() => {});
          if (sampleId) {
            // Acknowledgement means OPS close() has stopped the dispatcher.
            // If it cannot be confirmed, retain exposure for explicit orphan recovery.
            try { await post({ action: 'close', sampleId }); }
            catch { throw new QualificationSampleFailure('stop-failed'); }
            for (const [attemptId, row] of admissions) if (!row.reported && (row.consumed || !measured)) await row.admission.report({
              attemptId, outcome: row.consumed ? 'uncertain' : 'cancelled',
            });
          }
        } catch (error) {
          // A failed stop/report acknowledgement cannot hide the server's
          // already observed settlement. Successful samples still require close.
          if (!sampleFailure || sampleFailure instanceof IncompleteMediaEvidence) throw error;
        } finally {
          try {
            // Refused-sample summaries have a closed event-kind allowlist.
            // Retain this numeric count independently for both lanes.
            if (evidenceRun) {
              const sample = createHash('sha256').update(`${runId}:${item.sampleId ?? item.id}`).digest('hex').slice(0, 24);
              await writeFile(join(evidenceRun, `${lane}-post-measurement-${sample}.json`),
                JSON.stringify({ counts: { 'post-measurement': postMeasurementCount } }), { mode: 0o600 });
            }
          } catch {
            // Diagnostic I/O must never replace the sample result or exception.
            try { process.emitWarning('Qualification post-measurement count write failed', { code: 'QUALIFICATION_COUNT_WRITE_FAILED' }); }
            catch { /* Even a diagnostic sink failure cannot replace settlement. */ }
          } finally {
            try { await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => { const closing = setTimeout(resolve, 1000); closing.unref(); })]); }
            finally {
              clearTimeout(timer); process.removeListener('exit', onExit); process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInterrupt);
              lifetimes.delete(lease); running = false;
            }
          }
        }
      }
    };
  return Object.freeze({
    verifyCeiling: options.verifyCeiling,
    verifyReceipt: options.verifyReceipt,
    reconcile: input => options.reconcile({ ...input, baselineSessions: [...baselineSessions.values()] }),
    async runSample(input) {
      if (setupOnly) throw new Error('baselineSetupOnly refuses the paid sample loop');
      return run(input);
    },
    async runBaselineSetup(input) {
      if (!setupOnly) throw new Error('Explicit baselineSetupOnly host required');
      if (!input || Object.keys(input).some(key => key !== 'runId')) throw new TypeError('Baseline setup accepts runId only; no lanes or samples');
      return run({ item: { id: 'baseline-setup' }, lane: 'baseline', runId: input.runId,
        admit() { throw new Error('Baseline setup cannot admit'); }, onTiming() {} });
    },
    async close() { closed = true; for (const lease of lifetimes) lease.abort(new Error('Qualification host closed')); },
  });
}

// Separate free CLI: it cannot enter the paid coordinator or load an OPS host
// module. Unknown options (including plans, samples, lanes and keys) refuse.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'baseline-setup-only': { type: 'boolean', default: false },
    config: { type: 'string' }, out: { type: 'string' }, 'run-id': { type: 'string' } } });
  if (values['baseline-setup-only'] !== true || !isAbsolute(values.config ?? '') || !isAbsolute(values.out ?? '') || !values['run-id']) {
    throw new Error('Explicit --baseline-setup-only, absolute --config and --out, and --run-id required');
  }
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  if (!config || Object.keys(config).some(key => !['binding', 'consentDecision', 'executablePath', 'runDirectory', 'sampleTimeoutMs'].includes(key))) {
    throw new Error('Baseline setup config accepts binding, consentDecision, executablePath, runDirectory and sampleTimeoutMs only');
  }
  const host = createQualificationHost({ ...config, baselineSetupOnly: true });
  try {
    const result = await host.runBaselineSetup({ runId: values['run-id'] });
    await writeFile(values.out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (!result.ok) process.exitCode = 1;
  } finally { await host.close(); }
}
