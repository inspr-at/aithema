import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { IncompleteMediaEvidence } from '../src/live-qualification.js';
import { installBaselineProbe } from './qualification-baseline-probe.js';

export function baselineOrigin(value) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '[::]' ||
      host.startsWith('[::ffff:') || /^(?:127\.|0\.)/u.test(host)) throw new Error();
    return value;
  } catch { throw new TypeError('Explicit HTTPS non-loopback baselineOrigin required'); }
}

/** One reservation covers the production conversation AND its facade reasoning.
 * OPS supplies/attests both ceilings; no default reasoning allowance. */
export function baselineAttemptCeiling(binding) {
  const reasoning = binding?.baselineReasoningCeilingMicro, rate = binding?.baseline?.microPerMinute, seconds = binding?.maxDurationSeconds;
  if (!Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(seconds) || seconds < 1) {
    throw new TypeError('Explicit baseline conversation tariff and duration required');
  }
  const conversation = Math.ceil(rate * seconds / 60);
  const total = conversation + reasoning;
  if (!Number.isSafeInteger(reasoning) || reasoning < 0 || !Number.isSafeInteger(conversation) || conversation < 0 ||
    !Number.isSafeInteger(total)) throw new TypeError('Explicit safe baseline reasoning and conversation ceiling required');
  return total;
}

/** File format: JSON { username, password }. Running user is mba on OPS's host.
 * Same inode/owner/mode/NOFOLLOW/NONBLOCK checks as loadQualificationKeys. */
export async function loadBaselineAuth(path, { uid = process.getuid() } = {}) {
  let file;
  try {
    if (!isAbsolute(path ?? '')) throw new Error();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== uid ||
      (stat.mode & 0o7777) !== 0o600 || stat.size > 16_384) throw new Error();
    const auth = JSON.parse(await file.readFile('utf8'));
    if (!auth || Object.keys(auth).length !== 2 || !['username', 'password'].every(key =>
      typeof auth[key] === 'string' && auth[key].trim() && !/[\r\n\0]/u.test(auth[key]))) throw new Error();
    return Object.freeze({ username: auth.username, password: auth.password });
  } catch { throw new Error('Baseline auth requires valid JSON in a user-owned regular non-symlink 0600 file (maximum 16 KiB)'); }
  finally { await file?.close().catch(() => {}); }
}

/** No page.authenticate: Chromium may reuse its credentials for other hosts.
 * CDP's challenge response sends secrets only to this exact server origin. */
export async function installBaselineAuth(cdp, origin, auth, allowRequest = () => true) {
  cdp.on('Fetch.requestPaused', event => {
    const allowed = allowRequest(event);
    void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId,
      ...(!allowed ? { errorReason: 'Aborted' } : {}) }).catch(() => {});
  });
  cdp.on('Fetch.authRequired', async event => {
    const challenge = event.authChallenge;
    const allowed = challenge?.origin === origin && challenge.source === 'Server' && challenge.scheme?.toLowerCase() === 'basic';
    await cdp.send('Fetch.continueWithAuth', { requestId: event.requestId,
      authChallengeResponse: allowed ? { response: 'ProvideCredentials', ...auth } : { response: 'CancelAuth' } }).catch(() => {});
  });
  await cdp.send('Fetch.enable', { handleAuthRequests: true });
}

export async function prepareBaselinePage(page, origin, auth, allowRequest) {
  const cdp = await page.createCDPSession();
  await installBaselineAuth(cdp, origin, auth, allowRequest);
  await page.evaluateOnNewDocument(installBaselineProbe);
}

/** Use only production's normal visitor UI and response identities. No control
 * mount, owner headers, provider secret, mint, SDK option or agent write. */
export async function runProductionBaseline({ page, binding, item, runId, admit, onTiming, consentDecision,
  bounded, abort, recordIdentity, recordEvidence = async () => {}, auth, preflight, boundConversation }) {
  const origin = baselineOrigin(binding.baselineOrigin), base = binding.baseline;
  const maxMicro = baselineAttemptCeiling(binding);
  const identity = { lane: 'baseline', runId, sampleId: item.sampleId ?? item.id };
  const jobs = new Set(); let admission, admitting = false, consumed = false, voiceStartId, durationTimer, closeTimer, stopping, responseFailure, durationBoundReached = false, phase = 'setup';
  const track = promise => { jobs.add(promise); promise.finally(() => jobs.delete(promise)).catch(() => {}); return promise; };
  const labels = () => Object.fromEntries(['lane', 'runId', 'sampleId', 'visitorSessionId', 'providerSessionId', 'attemptId', 'callId']
    .filter(key => identity[key] !== undefined).map(key => [key, identity[key]]));
  const save = () => recordIdentity(labels());
  const response = value => {
    const url = new URL(value.url());
    if (url.origin !== origin || value.request().method() !== 'POST' || !value.ok()) return;
    if (url.pathname === '/api/sessions' || /^\/api\/sessions\/[^/]+\/voice$/u.test(url.pathname)) {
      track((async () => {
        const body = await value.json();
        if (url.pathname === '/api/sessions') identity.visitorSessionId = body.id;
        else {
          identity.providerSessionId = body.providerSessionId;
          identity.callId = body.callId;
          identity.epoch = body.epoch;
          identity.tabId = body.controllingTabId;
        }
        await save();
      })()).catch(() => { responseFailure = true; });
    }
  };
  const stop = () => stopping ??= (async () => {
    // The visitor's normal stop command drains production persistence. When a
    // startup stalls, also send its ordinary owner-authenticated close request.
    await page.evaluate(async identity => {
      const root = document.querySelector('aithema-session')?.shadowRoot;
      const close = root?.querySelector('.voice-close');
      if (close && !close.disabled) close.click();
      if (identity.visitorSessionId && identity.callId) {
        await fetch(`/api/sessions/${identity.visitorSessionId}/voice/${identity.callId}/close`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ callId: identity.callId, providerSessionId: identity.providerSessionId, tabId: identity.tabId, ...(identity.epoch !== undefined ? { epoch: identity.epoch } : {}),
            reason: 'closed', background: true }),
        });
      }
    }, identity);
  })();
  page.on('response', response);
  // A browser recovery or duplicate start would require a new paid attempt.
  // Refuse it: this corpus sample admits exactly one production conversation.
  await prepareBaselinePage(page, origin, auth, event => {
    const value = event.request, url = new URL(value.url);
    if (url.origin !== origin) return true;
    if (/\/voice\/[^/]+\/(?:recover|resume|takeover|replay)$/u.test(url.pathname)) return false;
    if (value.method === 'POST' && /\/voice$/u.test(url.pathname)) {
      const requestId = event.networkId ?? event.requestId;
      if (!consumed || voiceStartId && voiceStartId !== requestId) return false;
      voiceStartId = requestId;
      try { const body = JSON.parse(value.postData); identity.callId = body.callId; identity.tabId = body.tabId; } catch { /* response still records identity */ }
    }
    return true;
  });
  try {
    const navigated = await bounded(page.goto(`${origin}/`, { waitUntil: 'networkidle0' }));
    if (!navigated?.ok() || new URL(page.url()).origin !== origin) throw new Error();
    const physicalBrowserMedia = await bounded(preflight());
    await bounded(page.waitForSelector('aithema-session >>> .chooser__continue'));
    await bounded(page.click('aithema-session >>> .chooser__continue'));
    await bounded(page.waitForSelector('#consent-status[data-state="ready"]'));
    // Select only OPS's authorized purposes from the document presented by
    // production. Its contract is submitted by production's own consent page.
    for (const id of consentDecision.items) {
      const selector = `input[name="item"][value="${id}"]`;
      if (await page.$(selector)) {
        if (!await page.$eval(selector, element => element.checked)) await bounded(page.click(selector));
      } else if (['voice-elevenlabs', 'models-international'].includes(id)) throw new Error();
    }
    await bounded(page.click('[data-grant]'));
    await bounded(page.waitForSelector('aithema-session >>> .ready__start'));
    await bounded(Promise.all([...jobs]));
    if (responseFailure || !/^[a-zA-Z0-9_-]{1,128}$/u.test(identity.visitorSessionId ?? '')) throw new Error();
    const spec = { attemptId: `qualification-${randomUUID()}`, lane: 'baseline', role: 'reasoning',
      provider: base.plugin, model: base.model, operation: 'start', accountRef: base.accountRef, endpoint: base.endpoint,
      maxMicro,
      request: { baselineOrigin: origin, agentId: base.agentId, visitorSessionId: identity.visitorSessionId,
        maxDurationSeconds: binding.maxDurationSeconds, baselineReasoningCeilingMicro: binding.baselineReasoningCeilingMicro } };
    admitting = true;
    admission = await bounded(admit(spec)); identity.attemptId = spec.attemptId; await save();
    const conversationDeadlineAt = Date.now() + binding.maxDurationSeconds * 1000;
    await bounded(boundConversation(conversationDeadlineAt));
    await bounded(admission.attempt.consume()); consumed = true;
    // Binding's paid duration, measured from dispatch permission (earlier than
    // connection). Node's independent process watchdog also survives CLI death.
    // Begin the normal close 250 ms before the hard kill. This is a shutdown
    // allowance (two watchdog ticks plus CDP delivery), never added paid time.
    closeTimer = setTimeout(() => { void stop().catch(() => {}); }, Math.max(0, conversationDeadlineAt - Date.now() - 250));
    durationTimer = setTimeout(() => {
      durationBoundReached = true;
      void stop().catch(() => {});
      abort(new Error('Baseline conversation duration bound reached'));
    }, Math.max(0, conversationDeadlineAt - Date.now()));
    await bounded(page.evaluate(() => window.qualificationBaselineProbe.arm()));
    await bounded(page.click('aithema-session >>> .ready__mode[data-mode="voice"]'));
    await bounded(page.click('aithema-session >>> .ready__start'));
    phase = 'observe';
    // Leave time for classification and ordinary close BEFORE the independent
    // paid-duration watchdog. Only an actual polling timeout is a timing miss.
    const evidenceTimeoutMs = Math.max(1, Math.min(50_000, conversationDeadlineAt - Date.now() - 500));
    await bounded(page.waitForFunction(() => window.qualificationBaselineProbe.complete(), { timeout: evidenceTimeoutMs, polling: 25 }));
    phase = 'result';
    const diagnostics = await bounded(page.evaluate(() => window.qualificationBaselineProbe.diagnostics()));
    if (!diagnostics || !diagnostics.source) throw new Error('Missing baseline capture diagnostics');
    if (diagnostics.failure || diagnostics.source.failure) throw new Error('Invalid baseline capture evidence');
    const result = await bounded(page.evaluate(() => window.qualificationBaselineProbe.result()));
    phase = 'finalize';
    await bounded(stop());
    await bounded(Promise.all([...jobs]));
    if (responseFailure || !/^[a-zA-Z0-9_-]{1,128}$/u.test(identity.providerSessionId ?? '')) throw new Error();
    await save();
    for (const event of result.trace) onTiming(event);
    if (result.refusal) { phase = 'refused'; throw new IncompleteMediaEvidence(result.refusal); }
    return { ...result, physicalBrowserMedia, ttsPCM: new Uint8Array(Buffer.from(result.ttsPCM, 'base64')),
      ttsConfig: binding.baseline.tts, baselineSession: labels() };
  } catch (error) {
    // Never infer a timing miss from an arbitrary exception or missing fields.
    // In particular, result/close/persistence failures retain their abort path.
    const status = consumed ? 'invalid' : admitting ? 'not-admitted' : 'setup-failed';
    const diagnostics = consumed ? await bounded(page.evaluate(() => window.qualificationBaselineProbe?.diagnostics())).catch(() => undefined) : undefined;
    let reason = !consumed ? status : durationBoundReached ? 'duration-bound' :
      diagnostics?.failure || diagnostics?.source?.failure ||
      (!diagnostics || !diagnostics.source ? 'missing-diagnostics' : 'exception');
    let timingRefusal = phase === 'refused' && error instanceof IncompleteMediaEvidence &&
      !!diagnostics?.source && !diagnostics.failure && !diagnostics.source.failure && !durationBoundReached;
    if (timingRefusal) reason = error.reason;
    else if (phase === 'observe' && error.name === 'TimeoutError' && diagnostics?.source?.started === true &&
      !diagnostics.failure && !diagnostics.source.failure && !durationBoundReached) {
      if (diagnostics.refusal === 'late-first-audio' || diagnostics.source.refusal === 'late-first-audio' ||
        diagnostics.hasHypothesis === true && !Number.isFinite(diagnostics.firstAudioAt) && Number.isFinite(diagnostics.speechEndAt)) {
        reason = 'late-first-audio'; timingRefusal = true;
      } else if (diagnostics.hasHypothesis === true && Number.isFinite(diagnostics.firstAudioAt) &&
        Number.isFinite(diagnostics.bargeInAt) && !Number.isFinite(diagnostics.stoppedAt)) {
        reason = 'missing-playback-stop'; timingRefusal = true;
      }
    }
    await recordEvidence({ ...labels(), status, reason, ...(diagnostics ? { diagnostics } : {}) });
    if (timingRefusal) {
      // Reading evidence is part of the protocol: a CDP/probe error here aborts.
      if (!(error instanceof IncompleteMediaEvidence)) {
        const trace = await bounded(page.evaluate(() => window.qualificationBaselineProbe.trace()));
        for (const event of trace) onTiming(event);
        await bounded(stop());
        await bounded(Promise.all([...jobs]));
        if (responseFailure) throw new Error('Baseline response protocol failed');
        await save();
      }
      throw new IncompleteMediaEvidence(reason);
    }
    throw new Error(`Production baseline failed; ${consumed ? 'invalid evidence' : status} (${reason}); ${consumed ? 'retain uncertain exposure and inspect private session receipts' : 'no conversation dispatched'}`);
  }
  finally {
    clearTimeout(durationTimer); clearTimeout(closeTimer);
    try { await bounded(stop()).catch(() => {}); await Promise.allSettled([...jobs]); await save(); }
    finally {
      page.off('response', response);
      if (admission) await admission.report({ attemptId: identity.attemptId, outcome: consumed ? 'uncertain' : 'cancelled' });
    }
  }
}
