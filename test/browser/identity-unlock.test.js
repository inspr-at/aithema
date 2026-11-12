// AIT-470: real demo, local SMTP only. The proxy delays snapshots, never credits/consent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createServer as createSmtpServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from './launch.js';
import { mockConsent } from './consent-helpers.js';
import { adminRequest } from '../../demo/admin-socket.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const full = process.env.AITHEMA_AIT470_REPRO === '1';
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 45_000, polling: 25 }, ...args);
async function waitFor(fn) {
  for (let i = 0; i < 900; i++) { if (fn()) return; await delay(50); }
  throw new Error('Timed out waiting for proxy/SMTP evidence');
}
// Every source hook must fail closed when production source moves.
function rewrite(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `unique fixture hook: ${needle}`);
  return source.replace(needle, () => replacement);
}
async function settle(page, f) {
  const started = performance.now();
  let previous;
  for (;;) {
    // Cursor, blockers and the read boundary belong to this one page task.
    const sample = await shadow(page, c => {
      const host = c.ait483Host, busy = c.ait483Busy, unmet = [];
      if (typeof busy !== 'number' || !Number.isSafeInteger(busy) || busy < 0) throw new Error('Missing ait483Busy hook');
      if (c.ait470Options.host && (!host || typeof host.timer !== 'boolean' || !Number.isSafeInteger(host.reads) || host.reads < 0)) {
        throw new Error('Missing ait483Host credit hook');
      }
      const cursor = c.ait470Fence.cursor, consent = c.ait470Consent, repeatAt = c.ait470Fence.repeatAt;
      if (host?.timer) unmet.push('credit-timer');
      if (host?.reads !== undefined && host.reads !== 0) unmet.push('credit-read');
      if (busy !== 0) unmet.push('feature-read');
      if (consent !== null && !consent.exhausted) unmet.push('consent-window');
      if (repeatAt !== undefined && repeatAt > cursor) unmet.push('feature-repeat');
      if (!c.shadowRoot.querySelector('.verify-lock .verify-send[aria-disabled="false"]')) unmet.push('verify-send');
      if (c.session.identity.delivery === 'requested') unmet.push('delivery-final');
      for (const path of window.__ait483Inflight.values()) unmet.push(`fetch:${path}`);
      return { unmet, cursor, readsLength: window.__ait470.reads.length, t: performance.now(),
        creditState: { reconciling: host?.reconciling ?? null, usedUp: host?.usedUp ?? null, admissionDenied: host?.admissionDenied ?? null } };
    });
    if (!f.streamOpen) sample.unmet.push('stream-closed');
    if (f.sseHead > sample.cursor) sample.unmet.push('stream');
    sample.unmet = [...new Set(sample.unmet)].sort();
    sample.duration = performance.now() - started;
    const key = JSON.stringify(sample.unmet);
    if (key !== previous) { f.settleBlockers.push(sample); previous = key; }
    f.settleProbe?.(sample);
    if (!sample.unmet.length) {
      f.settleRelease = { ...sample, release: true };
      return sample;
    }
    if (sample.duration >= 45_000) throw new Error(`Settle barrier timed out: ${key}`);
    await delay(25);
  }
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function fixture(t, variant, lateDelivery) {
  const directory = await mkdtemp(join(tmpdir(), 'ait470-')), messages = [], log = [];
  let releaseDelivery = () => false, deliveryGuard;
  const deliveryFailure = Promise.withResolvers(), settleBlockers = [];
  deliveryFailure.promise.catch(() => {});
  t.after(() => clearTimeout(deliveryGuard));
  t.after(() => releaseDelivery());
  const smtp = createSmtpServer(socket => {
    let buffer = '', data = false, content = '', holding = false;
    socket.write('220 sink ESMTP\r\n');
    const processLines = () => {
      while (!holding && buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push(content); content = ''; data = false;
            if (lateDelivery || variant === 'AIT497') {
              holding = true;
              deliveryGuard = setTimeout(() => deliveryFailure.reject(new Error(
                `SMTP acknowledgement held for 10 s; blockers: ${JSON.stringify(settleBlockers.at(-1)?.unmet ?? ['barrier-not-started'])}`)), 10_000);
              releaseDelivery = () => {
                if (!holding) return false;
                clearTimeout(deliveryGuard); holding = false;
                socket.write(variant === 'AIT497' && messages.length === 1 ? '550 fixture refusal\r\n' : '250 accepted\r\n');
                processLines(); return true;
              };
            } else socket.write('250 accepted\r\n');
          }
          else content += line + '\r\n';
        } else if (line.startsWith('EHLO')) socket.write('250-sink\r\n250 PIPELINING\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 send message\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    };
    socket.on('data', bytes => { buffer += bytes.toString(); processLines(); });
    socket.on('error', () => {});
  });
  const smtpPort = await listen(smtp); t.after(() => smtp.close());
  let upstream, hold = false, frozen = false, liveStream, sseHead = 0, holdBarrier, grantStreamHeld = false;
  const grantChunks = [];
  t.after(() => holdBarrier?.resolve());
  const proxy = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (req.method === 'GET' && path === '/fixture-confirm-email') {
      const query = new URL(req.url, 'http://fixture').searchParams;
      const id = query.get('sessionId'), token = query.get('token');
      assert.match(id, /^[a-zA-Z0-9_-]+$/u); assert.match(token, /^[a-zA-Z0-9_-]+$/u);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<form method="POST"><input type="hidden" name="sessionId" value="${id}"><input type="hidden" name="token" value="${token}"><button>Confirm</button></form>`);
      return;
    }
    const snapshot = req.method === 'GET' && /^\/api\/sessions\/[^/]+$/u.test(path);
    const entry = { method: req.method, path, t0: Date.now(), snapshot, held: snapshot && hold,
      kind: req.headers['x-ait470-read'] };
    log.push(entry);
    // Preserve Host: the demo validates the canonical proxy origin.
    const forward = request(new URL(req.url, upstream), { method: req.method, headers: req.headers }, response => {
      entry.upstream = Date.now(); entry.status = response.statusCode;
      if (path.endsWith('/events')) {
        const stream = { frozen: false, open: response.statusCode === 200, buffer: '' }; liveStream = stream;
        const close = () => { stream.open = false; };
        response.on('close', close); response.on('error', close); res.on('close', close);
        res.writeHead(response.statusCode, response.headers);
        response.on('data', bytes => {
          stream.buffer += bytes.toString();
          while (stream.buffer.includes('\n')) {
            const end = stream.buffer.indexOf('\n'), line = stream.buffer.slice(0, end); stream.buffer = stream.buffer.slice(end + 1);
            const id = /^id:\s*(\d+)\s*$/u.exec(line);
            if (id) sseHead = Math.max(sseHead, Number(id[1]));
          }
          if (grantStreamHeld) grantChunks.push(() => { if (!res.destroyed) res.write(bytes); });
          else if (!stream.frozen) res.write(bytes);
        });
        response.on('end', () => { close(); res.end(); });
      } else if (snapshot || path.endsWith('/concepts/eligibility') || ['/packages/ui/src/session-element.js', '/packages/ui/src/host-surface.js'].includes(path)) {
        const chunks = []; response.on('data', bytes => chunks.push(bytes));
        response.on('end', async () => {
          let body = Buffer.concat(chunks);
          if (path === '/packages/ui/src/session-element.js' || path === '/packages/ui/src/host-surface.js') {
            try {
              let source = body.toString();
              if (path.endsWith('/host-surface.js')) {
                source = rewrite(source, 'setTimeout(() => void this.#loadCredits(), 300);',
                  'setTimeout(() => { this.#creditsTimer = null; void this.#loadCredits(); }, 300);');
                // The extra receipt flags are diagnostic, never release conditions.
                const needle = '  get creditScope() {';
                source = rewrite(source, needle, `  get ait483Credits() {
                  return { timer: this.#creditsTimer !== null, reads: this.#creditsReads,
                    reconciling: this.#credits?.reconciling ?? false, usedUp: this.usedUp, admissionDenied: !!this.#admissionDenied?.() };
                }\n${needle}`);
              } else {
                source = rewrite(source, '  #featureRead = null;', '  #featureRead = null;\n  #ait483Busy = 0;');
                const refresh = '  async #refreshFeatures(consentRetry = false, { unlockEdge = false, chain = 0 } = {}) {';
                source = rewrite(source, refresh, `${refresh}\n    this.#ait483Busy++; try {`);
                source = rewrite(source, '    } catch { fail(); }\n  }\n  async #restore() {',
                  '    } catch { fail(); }\n    } finally { this.#ait483Busy--; }\n  }\n  async #restore() {');
                const restore = '  async #restore() {';
                source = rewrite(source, restore, `${restore}\n    this.#ait483Busy++; try {`);
                source = rewrite(source, '  }\n  #connect() {', '    } finally { this.#ait483Busy--; }\n  }\n  #connect() {');
                const needle = '  receive(event) { this.#anchored';
                source = rewrite(source, needle, `  get ait483Busy() { return this.#ait483Busy; }
                  get ait494Host() { return this.#host; }
                  get ait483Host() { return this.#host?.ait483Credits ?? null; }
                  get ait470Consent() {
                    const p = this.#consentRefresh;
                    return p ? { failed: !!p.failed, exhausted: !!p.exhausted, retries: p.retries,
                      attempt: !!p.attempt, scopedGrant: p.scopedGrant,
                      windowId: window.__ait470Id(p), attemptId: p.attempt ? window.__ait470Id(p.attempt) : null } : null;
                  }
                  get ait470Options() { return this.#options; }
                  get ait470Fence() { const read = this.#featureRead; return { invalidatedAt: this.#invalidatedAt, cursor: this.#cursor, generation: this.#rail?.generation, chain: read?.chain, repeatAt: read?.repeatAt }; }
${needle}`);
                source = rewrite(source, '  #receive(event) {', `  #receive(event) {
                  window.__ait470?.arrivals.push({ t: performance.now(), event, fence: this.ait470Fence,
                    source: new Error().stack.includes('#events') ? 'stream' : 'host',
                    duplicate: !!event.seq && event.seq <= this.#cursor });`);
                source = rewrite(source, '        onEnd: () => {', `        onEnd: () => {
                  window.__ait470?.closes.push({ t: performance.now(), fence: this.ait470Fence,
                    refreshAllowed: this.isConnected && !this.#rail?.unloading && this.#invalidatedAt <= this.#cursor });`);
              }
              body = Buffer.from(source);
              delete response.headers['content-length'];
            } catch (error) {
              entry.rewriteError = error.message;
              res.writeHead(500, { 'content-type': 'text/plain' }); res.end(error.stack); return;
            }
          }
          try { const s = JSON.parse(body); entry.seq = s.seq; entry.locked = s.identity?.assessmentUnlocked !== true; } catch { /* error response */ }
          entry.forwarded = Date.now();
          try { entry.eventSeq = JSON.parse(body).event?.seq; } catch { /* no event */ }
          if (entry.held) {
            // Expose no-store before holding the body, so identical browser GETs
            // do not queue behind the first response's cache lock.
            if (!res.destroyed) { res.writeHead(response.statusCode, response.headers); res.flushHeaders(); entry.headersForwarded = Date.now(); }
            await holdBarrier?.promise; await delay(3000);
          }
          if (!res.destroyed) { if (!res.headersSent) res.writeHead(response.statusCode, response.headers); entry.bodyForwarded = Date.now(); res.end(body); }
        });
      } else {
        response.on('end', () => { entry.forwarded = Date.now(); });
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      }
    });
    forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => forward.destroy()); req.pipe(forward);
  });
  const proxyPort = await listen(proxy), url = `http://127.0.0.1:${proxyPort}`;
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const socketPath = join(directory, 'ops.sock');
  const child = fork(new URL('../fixtures/identity-unlock-host.mjs', import.meta.url), [], { silent: true, env: {
    PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite'), AITHEMA_DEMO_VERIFY: '1',
    AITHEMA_ADMIN_SOCKET: socketPath, AITHEMA_PUBLIC_ORIGIN: url,
    ...(lateDelivery || variant === 'AIT497' ? { AIT483_SYNC_DELIVERY: '1' } : {}),
    ...(['AIT494', 'AIT497'].includes(variant) ? { AIT494_FIXTURE: '1' } : {}),
    ...(variant === 'AIT497' ? { AIT497_FIXTURE: '1' } : {}),
    ...(variant === 'P-continue-slow' ? { AIT470_STABLE_TIER: '1' } : {}),
    ...(variant.startsWith('V-inplace') || variant === 'V-reconfigure' ? { AIT470_INPLACE: variant === 'V-inplace-false' ? 'false' : '1', AITHEMA_HTML_MODE: 'off' } : {}),
    ...(variant === 'control' ? { AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' } : {}),
    ...(!variant.startsWith('V-') ? { SMTP_HOST: '127.0.0.1', SMTP_PORT: '25', AIT470_SMTP_PORT: String(smtpPort),
      SMTP_FROM: 'sender@example.test', SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'true' } : {}),
  } });
  child.stdout.resume(); let errors = ''; child.stderr.on('data', bytes => { errors += bytes.toString(); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer);
  });
  const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Demo failed: ${errors}`); })]);
  upstream = ready.url;
  if (!variant.startsWith('V-')) {
    const settings = (await adminRequest(socketPath, 'settings')).body;
    assert.equal((await adminRequest(socketPath, 'set-confirmation', { baseRevision: settings.revision, confirmationEnabled: true })).status, 200);

  }
  return { url, directory, messages, log, settleBlockers,
    guard(promise) { return Promise.race([promise, deliveryFailure.promise]); },
    get streamOpen() { return liveStream?.open === true; }, get sseHead() { return sseHead; },
    releaseDelivery() { return releaseDelivery(); }, holdGrantStream() { grantStreamHeld = true; },
    releaseGrantStream() { grantStreamHeld = false; for (const send of grantChunks.splice(0)) send(); }, hold(barrier = false) {
    hold = true; if (barrier) holdBarrier = Promise.withResolvers();
  }, release() { holdBarrier?.resolve(); }, freeze() {
    assert.ok(liveStream); liveStream.frozen = true; frozen = true; return Date.now();
  }, get frozen() { return frozen; } };
}

const variants = full ? ['V-inplace-false', 'V-inplace', 'V-reconfigure', 'P-page', 'P-token', 'P-continue-slow', 'P-stalled', 'V-outbox', 'P-page-slow', 'V-outbox-slow', 'control'] : ['V-inplace', 'P-stalled', 'P-continue-slow'];
for (const variant of variants) for (const locale of ['en', 'de']) for (const width of [390, 1440]) for (const lateDelivery of variant === 'P-stalled' && (full || (locale === 'en' && width === 1440)) ? [false, true] : [false]) {
  if (!full && variant === 'P-continue-slow' && width === 390) continue;
  const suffix = lateDelivery ? '-late-delivery' : '';
  test(`AIT-470 ${variant} ${locale} ${width}${suffix}: confirmation clears every lock indicator`, { timeout: 130_000 }, async t => {
    const copy = locale === 'de' ? de : en, reason = copy.reasons['verification required'];
    const f = await fixture(t, variant, lateDelivery), browser = await puppeteer.launch({ headless: true, userDataDir: join(f.directory, 'browser') });
    let collectEvidence = async () => {};
    t.after(async () => { try { await collectEvidence(); } finally { await browser.close(); } });
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width, height: width === 390 ? 844 : 900, isMobile: width === 390, hasTouch: width === 390 });
    await page.evaluateOnNewDocument(locale => {
      localStorage.setItem('aithema-demo-locale', locale);
      window.__ait470Hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__ait470Hidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.__ait470Hidden ? 'hidden' : 'visible' });
      window.__ait470 = { reads: [], events: [], features: [], streams: [], consent: [], toasts: [], arrivals: [], closes: [], unlocks: [], credits: [] };
      const ids = new WeakMap(); let nextId = 0;
      window.__ait470Id = object => {
        if (!ids.has(object)) ids.set(object, ++nextId);
        return ids.get(object);
      };
      const original = window.fetch;
      window.fetch = async function (url, options = {}) {
        const path = new URL(url, location.href).pathname, evidence = window.__ait470;
        const component = () => document.querySelector('aithema-session');
        if (path.endsWith('/events')) evidence.streams.push(performance.now());
        if (path.endsWith('/consent')) {
          const read = { t0: performance.now(), method: options.method ?? 'GET', window: component()?.ait470Consent };
          evidence.consent.push(read);
          const response = await original.call(this, url, options);
          const body = await response.clone().json();
          Object.assign(read, { t1: performance.now(), status: response.status, revision: body.consentRevision, event: body.event });
          return response;
        }
        if (path.endsWith('/credits')) {
          const response = await original.call(this, url, options), body = await response.clone().json();
          evidence.credits.push({ t: performance.now(), wall: Date.now(), tiers: body.tiers, limitMicro: body.balance?.owner?.limitMicro });
          return response;
        }
        if (path.endsWith('/identity/unlock')) {
          const response = await original.call(this, url, options), body = await response.clone().json();
          evidence.unlocks.push({ t: performance.now(), wall: Date.now(),
            unlocked: body.identity?.assessmentUnlocked === true,
            journalLocked: component()?.session?.identity?.assessmentUnlocked !== true,
            readCount: evidence.reads.length, fence: component()?.ait470Fence });
          return response;
        }
        if ((options.method ?? 'GET') !== 'GET' || !/^\/api\/sessions\/[^/]+$/u.test(path)) return original.call(this, url, options);
        const read = { t0: performance.now(), startCursor: component()?.session?.seq,
          journalLocked: component()?.session?.identity?.assessmentUnlocked !== true, fenceAtStart: component()?.ait470Fence, consentAtStart: component()?.ait470Consent };
        evidence.reads.push(read);
        try {
          const kind = new Error().stack.includes('#restore') ? 'restore' : 'features';
          read.kind = kind;
          const headers = new Headers(options.headers); headers.set('x-ait470-read', kind);
          const response = await original.call(this, url, { ...options, headers }), body = await response.clone().json();
          Object.assign(read, { t1: performance.now(), status: response.status, snapshotSeq: body.seq,
            cursorAtResponse: component()?.session?.seq, fenceAtResponse: component()?.ait470Fence, consentAtResponse: component()?.ait470Consent });
          read.outcome = response.status === 409 ? '409' : body.seq > read.cursorAtResponse ? 'ahead' : body.seq < read.cursorAtResponse ? 'behind' : 'equal';
          if (read.consentAtStart?.windowId !== read.consentAtResponse?.windowId ||
            read.consentAtStart?.attemptId !== read.consentAtResponse?.attemptId) {
            read.consentDrop = read.consentAtResponse?.failed && !read.consentAtResponse.attempt
              ? 'watchdog-or-failure' : 'superseded-consent-attempt';
          }
          read.dropReason = !response.ok ? 'http-' + response.status : read.consentDrop ??
            (read.fenceAtStart?.generation !== read.fenceAtResponse?.generation ? 'generation' :
              read.outcome === 'equal' ? null : read.outcome);
          return response;
        } catch (error) { read.outcome = 'error'; throw error; }
      };
      const observedFetch = window.fetch;
      window.__ait483Inflight = new Map(); let fetchId = 0;
      window.fetch = async function (url, options) {
        const path = new URL(url instanceof Request ? url.url : url, location.href).pathname;
        if (!path.startsWith('/api/') || path.endsWith('/events')) return observedFetch.call(this, url, options);
        const id = ++fetchId, inflight = window.__ait483Inflight;
        inflight.set(id, path);
        try {
          const response = await observedFetch.call(this, url, options);
          void response.clone().arrayBuffer().then(() => inflight.delete(id), () => inflight.delete(id));
          return response;
        } catch (error) { inflight.delete(id); throw error; }
      };
      document.addEventListener('aithema-event', e => {
        window.__ait470.events.push({ t: performance.now(), ...e.detail });
        if (e.detail.type === 'identity.unlocked') window.__ait470.toasts.push({ t: performance.now(), wall: Date.now(),
          label: document.querySelector('aithema-session').shadowRoot.querySelector('.composer-dock > .status__label')?.textContent });
      });
      document.addEventListener('aithema-features', () => {
        const seq = document.querySelector('aithema-session').session.seq;
        window.__ait470.features.push({ t: performance.now(), seq });
        const read = window.__ait470.reads.findLast(read => read.snapshotSeq === seq && read.outcome === 'equal');
        if (read) read.outcome = 'applied';
      });
    }, locale);
    const samples = [], evidence = { variant, locale, width, lateDelivery, generationFence: 'n/a: no call', samples };
    const evidenceDir = process.env.AITHEMA_EVIDENCE_DIR;
    collectEvidence = async () => {
      evidence.proxy = f.log; evidence.settleBlockers = f.settleBlockers; evidence.settleRelease = f.settleRelease;
      evidence.browser = await page.evaluate(() => window.__ait470).catch(() => null);
      if (evidence.grant) evidence.grantArrivals = evidence.browser?.arrivals.filter(a =>
        a.event.seq === evidence.grant.seq && a.event.type === 'consent.revised');
      if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, `ait470-${variant}-${locale}-${width}${suffix}.json`), JSON.stringify(evidence, null, 2)); }
      console.log(`AIT-470 evidence ${JSON.stringify(evidence)}`);
    };
    await page.goto(f.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.chooser__continue'));
    // The primary host consumes the ack first; then let the identical stream copy replay.
    if (variant === 'V-inplace-false') f.holdGrantStream();
    await mockConsent(page);
    if (variant === 'V-inplace-false') f.releaseGrantStream();
    if (variant.startsWith('V-inplace') || variant === 'V-reconfigure') {
      evidence.grant = await page.evaluate(() => window.__ait470.consent.find(e => e.event)?.event);
      assert.equal(evidence.grant?.type, 'consent.revised');
      assert.equal((evidence.grant?.data.conversationUnchanged ?? false), variant !== 'V-inplace-false', 'host grant event is received unchanged');
    }
    await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
    if (variant.startsWith('V-inplace') || variant === 'V-reconfigure') {
      await until(page, () => document.querySelector('aithema-session').session.conceptVisualKind === 'images');
      evidence.visualKind = await shadow(page, c => c.session.conceptVisualKind);
    }
    if (variant === 'V-reconfigure') {
      await shadow(page, async c => {
        const session = await fetch(`/api/sessions/${c.session.id}`).then(r => r.json());
        c.configure({ ...c.ait470Options, session });
      });
    }
    const send = content => shadow(page, (c, content) => { c.shadowRoot.querySelector('textarea').value = content; c.shadowRoot.querySelector('form.composer').requestSubmit(); }, content);
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').disabled);
    await send('We need a preorder app for a bakery.');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('ol li.turn').length >= 2);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock')?.hidden === false);
    if (variant !== 'control') await until(page, reason => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-activity-text').textContent.includes(reason), reason);
    await shadow(page, c => { c.shadowRoot.querySelector('#verify-lock-email').value = 'visitor@example.test'; c.shadowRoot.querySelector('.verify-lock .verify-send').click(); });
    await f.guard(until(page, () => document.querySelector('aithema-session').session.identity?.status === 'verification-pending'));
    // Settle request-time credit reads before arming faults.
    let deliveryReleasedByProbe = false;
    if (lateDelivery) f.settleProbe = ({ unmet }) => {
      if (unmet.includes('delivery-final') && unmet.every(blocker => blocker === 'delivery-final' || blocker === 'verify-send' ||
          blocker.startsWith('fetch:') && blocker.endsWith('/identity/request'))) {
        if (f.releaseDelivery()) deliveryReleasedByProbe = true;
      }
    };
    const settled = await f.guard(settle(page, f)), before = settled.readsLength;
    if (lateDelivery) {
      assert.equal(await shadow(page, c => c.session.identity.delivery), 'sent', 'late delivery succeeded before release');
      assert.equal(deliveryReleasedByProbe, true, 'the barrier probe released the SMTP acknowledgement');
      const proof = await page.evaluate(() => {
        const { arrivals, reads } = window.__ait470;
        const s3 = arrivals.find(a => !a.duplicate && a.event.type === 'identity.state' && a.event.data.delivery === 'sent');
        return { s3, readIndex: s3 ? reads.findIndex(r => r.t0 >= s3.t && r.startCursor >= s3.event.seq) : -1 };
      });
      evidence.lateDeliveryProof = proof;
      assert.ok(proof.s3 && f.settleBlockers.some(s => s.t >= proof.s3.t &&
        s.unmet.some(b => b === 'credit-timer' || b === 'feature-read')), 'a post-S3 barrier sample observed timer or busy work');
      assert.ok(proof.readIndex >= 0 && proof.readIndex < before, 'the S3-triggered read is below the atomic read boundary');
    }
    let freezeAt;
    if (variant.startsWith('V-inplace') || variant === 'V-reconfigure') {
      const link = await shadow(page, async c => {
        const { messages } = await fetch(`/api/sessions/${c.session.id}/demo/outbox`).then(r => r.json());
        return `/fixture-confirm-email?${new URLSearchParams({ sessionId: c.session.id, token: messages.at(-1).token })}`;
      });
      const eligibilityCount = f.log.filter(e => e.path.endsWith('/concepts/eligibility')).length;
      await page.evaluate(() => { window.__ait470Hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => f.log.filter(e => e.path.endsWith('/concepts/eligibility') && e.eventSeq).length > eligibilityCount);
      evidence.hideEligibility = f.log.filter(e => e.path.endsWith('/concepts/eligibility')).at(-1);
      await until(page, seq => document.querySelector('aithema-session').session.seq >= seq, evidence.hideEligibility.eventSeq);
      const mail = await context.newPage(); await mail.bringToFront(); await mail.goto(new URL(link, f.url).href);
      await Promise.all([mail.waitForNavigation(), mail.click('form button')]);
      assert.equal(await mail.$eval('h1', h => h.textContent), 'Confirmed');
      await page.bringToFront();
      await page.evaluate(() => { window.__ait470Hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
      evidence.unlockSource = 'second-tab evidence, conversation poll reducer';
    } else if (variant.startsWith('V-')) {
      await page.$eval('#outbox-open', button => button.click()); await page.waitForSelector('#outbox-list li button');
      if (variant.endsWith('-slow')) f.hold(variant === 'V-outbox-slow');
      await page.$eval('#outbox-list li button', button => button.click()); await page.$eval('#outbox-close', button => button.click());
    } else {
      await waitFor(() => f.messages.length > 0);
      const decoded = f.messages.at(-1).replace(/=\r\n/gu, '').replace(/=([A-F0-9]{2})/gu, (_, x) => String.fromCharCode(parseInt(x, 16)));
      const link = /http:\/\/[^\s<>"']+\/confirm-email\?token=[^\s<>"']+/u.exec(decoded)?.[0].replaceAll('&amp;', '&');
      assert.ok(link, 'local plaintext relay delivered a confirmation link');
      if (variant === 'P-token') {
        const token = new URL(link).searchParams.get('token');
        await shadow(page, async (c, token) => { await fetch(`/api/sessions/${c.session.id}/identity/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); }, token);
      } else {
        const eligibilityCount = f.log.filter(e => e.path.endsWith('/concepts/eligibility')).length;
        await page.evaluate(() => { window.__ait470Hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
        if (variant !== 'control') {
          await waitFor(() => f.log.filter(e => e.path.endsWith('/concepts/eligibility') && e.eventSeq).length > eligibilityCount);
          // The response event must be reduced before we freeze the stream.
          const eventSeq = f.log.filter(e => e.path.endsWith('/concepts/eligibility')).at(-1).eventSeq;
          await until(page, seq => document.querySelector('aithema-session').session.seq >= seq, eventSeq);
          evidence.hideEligibility = f.log.filter(e => e.path.endsWith('/concepts/eligibility')).at(-1);
          evidence.hideCursor = await shadow(page, c => c.session.seq);
        }
        if (variant === 'P-stalled') freezeAt = f.freeze();
        if (variant.endsWith('-slow')) f.hold(variant === 'P-continue-slow');
        const mail = await context.newPage(); await mail.bringToFront(); await mail.goto(link);
        await mail.click('form[data-confirm] button');
        await mail.waitForFunction(() => !document.querySelector('form[data-confirm]'));
        await page.bringToFront();
        await page.evaluate(() => { window.__ait470Hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
      }
    }
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock').hidden);
    let unlockedAt = Date.now();
    if (variant.startsWith('V-')) {
      await until(page, () => window.__ait470.events.some(e => e.type === 'identity.unlocked'));
      unlockedAt = await page.evaluate(() => window.__ait470.toasts.at(-1).wall);
      evidence.unlockToast = await shadow(page, c => c.shadowRoot.querySelector('.composer-dock > .status__label')?.textContent);
      if (variant.startsWith('V-inplace') || variant === 'V-reconfigure') {
        const confirmation = f.log.find(e => e.method === 'POST' && e.path === '/fixture-confirm-email');
        assert.ok(confirmation && f.log.some(e => e.path.endsWith('/identity/unlock') && e.t0 >= confirmation.t0), 'the conversation poll reduces the confirmed proof');
        assert.equal(f.log.some(e => e.path.endsWith('/identity/confirm')), false, 'no direct reducer confirmation route');
      }
    }
    evidence.unlockedAt = unlockedAt;
    if (freezeAt) {
      evidence.freezeAt = freezeAt;
      evidence.pollUnlock = await page.evaluate(freezeAt => window.__ait470.unlocks.find(u => u.unlocked && u.wall >= freezeAt), freezeAt);
      assert.ok(evidence.pollUnlock?.journalLocked, 'the frozen original stream misses the unlock before its HTTP response');
      assert.equal(evidence.pollUnlock.readCount, before, 'no feature read starts for the missed stream unlock before the poll edge');
      assert.equal(f.log.filter(e => e.t0 > freezeAt && e.t0 < evidence.pollUnlock.wall && (e.kind === 'restore' || e.path.endsWith('/events'))).length, 0,
        'P-stalled: no restore GET or stream reconnection between freeze and unlock');
    }
    if (variant === 'P-continue-slow' || variant === 'V-outbox-slow') {
      // Wait until all natural reads have reached upstream; no arbitrary +0.2s race.
      await waitFor(() => {
        const snapshots = f.log.filter(e => e.held && e.locked === false);
        if (!snapshots.length || snapshots.some(e => !e.forwarded)) return false;
        // This reviewed alternative keeps P's credit tier unchanged, so its
        // identity-triggered snapshot is the last natural unlock read.
        if (variant === 'P-continue-slow') return true;
        // Both V identity triggers must have their post-unlock snapshots upstream.
        return snapshots.length >= 2;
      });
      const forwarded = f.log.filter(e => e.held && e.forwarded).at(-1);
      evidence.extraTurnAfterSnapshot = forwarded;
      await send('It also needs a collection time selector.');
      await until(page, () => document.querySelector('aithema-session').session.transcript.filter(t => t.role === 'user').length >= 2);
      evidence.extraTurnCursor = await shadow(page, c => c.session.seq);
      assert.ok(evidence.extraTurnCursor > forwarded.seq, 'the durable person turn overtakes every held natural snapshot');
      f.release();
    }
    for (const seconds of full ? [0.1, 0.5, 3, 20, 60] : variant.endsWith('-slow') || variant === 'V-inplace' ? [0.1, 0.5, 3, 20] : [0.1, 0.5, 3]) {
      await delay(Math.max(0, unlockedAt + seconds * 1000 - Date.now()));
      samples.push(await shadow(page, (c, seconds) => {
        const r = c.shadowRoot, q = s => r.querySelector(s);
        return { seconds, sampledAt: Date.now(), cursor: c.session.seq, notice: q('.notice-text')?.textContent, concept: q('.concept-activity-text')?.textContent,
          conceptHidden: q('.concept-activity')?.hidden, attachDisabled: q('.attach')?.getAttribute('aria-disabled'),
          attachTitle: q('.attach')?.title, attachLimits: q('#attach-limits')?.textContent,
          consentWindow: c.ait470Consent, fence: c.ait470Fence, readiness: q('.readiness')?.style.visibility, lockHidden: q('.verify-lock')?.hidden,
          verifiedHidden: q('.host-verify .verify-done')?.hidden, connection: q('.status__label')?.textContent };
      }, seconds));
    }
    if (variant === 'P-continue-slow') {
      evidence.creditReceipts = await page.evaluate(() => window.__ait470.credits);
      const before = evidence.creditReceipts.findLast(r => r.wall < unlockedAt);
      const after = evidence.creditReceipts.find(r => r.wall >= unlockedAt);
      assert.ok(before && after, 'credit receipts bracket the unlock');
      assert.deepEqual(after.tiers, before.tiers, 'confirmation leaves the fixture tier unchanged');
      assert.equal(after.limitMicro, before.limitMicro, 'confirmation leaves the fixture allowance unchanged');
    }
    const reads = await page.evaluate(before => window.__ait470.reads.slice(before), before);
    evidence.redPrecondition = variant === 'P-stalled' && evidence.pollUnlock?.journalLocked && evidence.pollUnlock.readCount === before ? 'never-started' : reads.some(r => r.outcome === 'behind') ? 'behind' : null;
    if (['P-stalled', 'P-continue-slow', 'V-outbox-slow'].includes(variant)) {
      // A healed run can be green, but must still prove that the injected fault occurred.
      assert.ok(evidence.redPrecondition, 'red mechanism (never-started or behind) must be proven before checking wording');
    }
    if (variant === 'V-inplace' && samples.at(-1).concept?.includes(reason)) {
      assert.ok(evidence.redPrecondition || reads.some(r => r.consentAtResponse?.exhausted), 'primary stale line must have a traced drop');
    }
    for (const sample of samples.filter(s => s.seconds >= (variant.endsWith('-slow') ? 20 : 3))) {
      assert.equal(sample.lockHidden, true);
      for (const key of ['notice', 'concept', 'attachTitle', 'attachLimits']) assert.ok(!sample[key]?.includes(reason), `${key} stays locked: ${sample[key]}`);
    }
    if (evidenceDir) {
      const capture = async surface => {
        const name = `ait470-${variant}-${locale}-${width}${suffix}-${surface}.png`;
        const png = await page.screenshot({ path: join(evidenceDir, name), fullPage: false });
        // Preserve fixture evidence in the runner log as well: artifact fetches
        // can be capacity-refused after a successful remote run.
        if (['P-continue-slow', 'P-stalled'].includes(variant)) console.log(`AIT-470 screenshot ${JSON.stringify({ name, base64: Buffer.from(png).toString('base64') })}`);
      };
      await capture('confirmed');
      // Phone layouts stack the overview below the conversation. Keep viewport
      // captures of both surfaces after the same settled unlock observation.
      for (const [surface, selector] of [['concept', '.concept-bar'], ['concept-attach', '.composer-dock'], ['overview', '.understanding']]) {
        await shadow(page, (c, selector) => {
          c.shadowRoot.querySelector(selector).scrollIntoView({ block: 'center', behavior: 'instant' });
          if (selector === '.understanding') c.shadowRoot.querySelector('.analysis-content').scrollTop = 0;
        }, selector);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await capture(surface);
      }
    }
  });
}


for (const width of [390, 1440]) test(`AIT-494 real routes and failed Settings row geometry ${width}`, { timeout: 90_000 }, async t => {
  const f = await fixture(t, 'AIT494', false), browser = await puppeteer.launch({ headless: true, userDataDir: join(f.directory, 'browser-494') });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('aithema-demo-locale', 'en'));
  await page.goto(f.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.chooser__continue'));
  await mockConsent(page);
  await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
  await until(page, () => document.querySelector('aithema-session')?.ait494Host?.verification?.email?.notice?.version);
  // Open the actual conversation ask without replacing fetch or any host port.
  await shadow(page, c => {
    const ask = c.ait494Host.emailAsk; ask.manual = true; ask.open = true; ask.paint();
    const form = ask.gate.querySelector('form'); ask.input.value = 'a(b)@example.com'; form.requestSubmit();
  });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email-ask-input').getAttribute('aria-invalid') === 'true');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-ask-message').textContent), en.hostSurface.verify.invalid);
  assert.equal(await shadow(page, c => c.ait494Host.emailAsk.step), 'idle');
  await shadow(page, c => c.ait494Host.emailAsk.dismiss(false));
  // The verification dialog retains its browser-side validation.
  await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
  await shadow(page, c => c.shadowRoot.querySelector('.host-verify .verify-entry').click());
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
  await shadow(page, c => {
    const form = c.shadowRoot.querySelector('dialog.verify-dialog .verify-form');
    form.querySelector('input').value = 'a(b)@example.com'; form.requestSubmit();
  });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.verify-dialog input').checkValidity()), false);
  assert.equal(await shadow(page, c => c.ait494Host.verification.identity.address), null);
  await shadow(page, c => c.shadowRoot.querySelector('dialog.verify-dialog').close());
  // Use the real VisitorEmail save form in its existing save-only UI mode.
  await shadow(page, c => {
    const dialog = c.shadowRoot.querySelector('dialog.settings'); if (dialog.open) dialog.close();
    c.ait494Host.verification.email.endSettings(); c.ait494Host.verification.email.delivery = false;
    c.openSettings(undefined, { tab: 'general', anchor: '#email' });
    const input = c.shadowRoot.querySelector('#email-input'); input.value = 'a(b)@example.com';
    c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit();
  });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email-input').getAttribute('aria-invalid') === 'true');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify .m-msg-text').textContent), en.hostSurface.verify.invalid);
  assert.equal(f.messages.length, 0);
  await shadow(page, async c => {
    c.shadowRoot.querySelector('dialog.settings').close(); c.ait494Host.verification.email.endSettings();
    const response = await fetch('/fixture-494-address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: c.session.id }) });
    if (!response.ok) throw new Error('Legacy seed failed');
    await c.ait494Host.verification.load();
    c.openSettings(undefined, { tab: 'general', anchor: '#email' });
  });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.m-sent-prefix').textContent.includes('Link sent to'));
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const sample = () => shadow(page, c => Object.fromEntries(['.verify-entry-state', '.verify-entry'].map(selector => {
    const box = c.shadowRoot.querySelector('.host-verify ' + selector).getBoundingClientRect();
    return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }];
  })));
  const before = await sample();
  for (const box of Object.values(before)) { assert.ok(box.width > 0); assert.ok(box.height > 0); }
  await shadow(page, async c => {
    const response = await fetch(`/api/sessions/${c.session.id}/identity/resend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok || (await response.json()).identity.delivery !== 'failed') throw new Error('Refused resend did not fail');
    await c.ait494Host.verification.load();
  });
  await delay(350);
  const after = await sample();
  for (const [selector, box] of Object.entries(after)) {
    assert.ok(box.width > 0); assert.ok(box.height > 0);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - before[selector][key]) <= .5,
      `${selector} ${key}: ${before[selector][key]} -> ${box[key]}`);
  }
  const evidence = { width, before, after };
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-494-geometry-${width}.json`), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait-494-settings-${width}.png`) });
  }
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.m-sent-prefix').textContent), '');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.verify-entry-status').textContent), en.hostSurface.verify.unverified);
  assert.equal(f.messages.length, 0);
});

// AIT-497: measure the real Settings row before considering any production hold.
for (const width of [390, 1440]) test(`AIT-497 wrapping Settings row sent to failed to sent ${width}`, { timeout: 150_000 }, async t => {
  const f = await fixture(t, 'AIT497', false), browser = await puppeteer.launch({ headless: true, userDataDir: join(f.directory, 'browser-497') });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Select the same address using the actual phone row, including in the desktop case.
  await page.setViewport({ width: 390, height: 900 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('aithema-demo-locale', 'en'));
  await page.goto(f.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.chooser__continue'));
  await mockConsent(page);
  await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
  await until(page, () => document.querySelector('aithema-session')?.ait494Host?.verification?.email?.notice?.version);
  const seed = address => shadow(page, async (c, address) => {
    const response = await fetch('/fixture-494-address', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: c.session.id, address }) });
    if (!response.ok) throw new Error('Address seed failed');
    await c.ait494Host.verification.load();
  }, address);
  await seed('wrap@example.com');
  await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await delay(350);
  const wrap = await shadow(page, c => {
    const row = c.shadowRoot.querySelector('.host-verify .verify-entry-state'), rowWidth = row.getBoundingClientRect().width;
    const probe = row.cloneNode(true);
    Object.assign(probe.style, { position: 'absolute', left: '-10000px', width: `${rowWidth}px`, minHeight: '0', maxHeight: 'none', overflow: 'visible' });
    row.parentElement.append(probe);
    const lines = () => {
      const range = document.createRange(); range.selectNodeContents(probe);
      return new Set([...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => r.y)).size;
    };
    const prefix = probe.querySelector('.m-sent-prefix'), address = probe.querySelector('.verify-entry-address');
    try {
      for (let length = 1; length <= 64; length++) {
        address.textContent = 'w'.repeat(length) + '@example.com'; prefix.textContent = '';
        const withoutPrefix = lines(); prefix.textContent = 'Link sent to ';
        const withPrefix = lines();
        if (withoutPrefix === 1 && withPrefix === 2) return { address: address.textContent, rowWidth, withoutPrefix, withPrefix };
      }
      throw new Error('No address fits one phone line without the prefix and two with it');
    } finally { probe.remove(); }
  });
  assert.ok(wrap.rowWidth > 0);
  assert.equal(wrap.withoutPrefix, 1); assert.equal(wrap.withPrefix, 2);
  await seed(wrap.address);
  await page.setViewport({ width, height: 900 });
  await page.mouse.move(0, 0);
  await delay(350);
  const evidence = { width, wrap, samples: [] };
  t.after(async () => {
    if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-497-geometry-${width}.json`), JSON.stringify(evidence, null, 2));
  });
  const sample = async state => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await shadow(page, c => {
      const q = selector => c.shadowRoot.querySelector('.host-verify ' + selector), row = q('.verify-entry-state');
      const range = document.createRange(); range.selectNodeContents(row);
      const textRects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      const bounds = row.getBoundingClientRect();
      return { identity: c.ait494Host.verification.identity, text: row.textContent,
        prefix: q('.m-sent-prefix').textContent, address: q('.verify-entry-address').textContent,
        rects: Object.fromEntries(['.verify-entry-state', '.verify-entry', '.m-delete-mail'].map(selector => {
          const box = q(selector).getBoundingClientRect();
          return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }];
        })), readability: { clientHeight: row.clientHeight, scrollHeight: row.scrollHeight, clientWidth: row.clientWidth,
          scrollWidth: row.scrollWidth, overflowY: getComputedStyle(row).overflowY,
          lineCount: new Set(textRects.map(r => r.y)).size,
          textWithinBox: textRects.every(r => r.top >= bounds.top - .5 && r.bottom <= bounds.bottom + .5 && r.left >= bounds.left - .5 && r.right <= bounds.right + .5) } };
    });
    evidence.samples.push({ state, ...result });
    assert.equal(result.identity.status, 'verification-pending');
    assert.equal(result.identity.delivery, state);
    assert.equal(result.address, wrap.address);
    assert.equal(result.prefix, state === 'failed' ? '' : 'Link sent to ');
    for (const [selector, box] of Object.entries(result.rects)) {
      assert.ok(box.width > 0, `${state} ${selector} has positive width`);
      assert.ok(box.height > 0, `${state} ${selector} has positive height`);
      const before = (evidence.samples.at(-2) ?? evidence.samples[0]).rects[selector];
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - before[key]) <= .5,
        `${state} ${selector} ${key}: ${before[key]} -> ${box[key]}`);
    }
    if (width === 390) assert.equal(result.readability.lineCount, state === 'failed' ? 1 : 2);
    // Report vertical scrolling rather than changing the existing overflow rule.
    assert.ok(result.readability.scrollWidth <= result.readability.clientWidth, 'the address needs no horizontal scrolling');
    return result;
  };
  await sample('sent');
  for (const state of ['failed', 'sent']) {
    const resend = shadow(page, async c => {
      const response = await fetch(`/api/sessions/${c.session.id}/identity/resend`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(`Resend failed: ${response.status}`);
      const body = await response.json(); await c.ait494Host.verification.load(); return body.identity;
    });
    await f.guard(waitFor(() => f.messages.length === (state === 'failed' ? 1 : 2)));
    await shadow(page, c => c.ait494Host.verification.load());
    await sample('requested');
    assert.equal(f.releaseDelivery(), true, 'release the local SMTP result after measuring pending');
    const identity = await f.guard(resend);
    assert.equal(identity.delivery, state, 'real resend uses the local SMTP refusal, then acceptance');
    await sample(state);
    if (state === 'failed') await delay(identity.resendAfterMs + 100);
  }
  assert.equal(f.messages.length, 2, 'both resends reached only the local SMTP sink');
  t.diagnostic('AIT-497 geometry ' + JSON.stringify(evidence));
  if (process.env.AITHEMA_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait-497-settings-${width}.png`) });
});
