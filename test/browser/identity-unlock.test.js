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
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function fixture(t, variant) {
  const directory = await mkdtemp(join(tmpdir(), 'ait470-')), messages = [], log = [];
  const smtp = createSmtpServer(socket => {
    let buffer = '', data = false, content = '';
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', bytes => {
      buffer += bytes.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(content); content = ''; data = false; socket.write('250 accepted\r\n'); }
          else content += line + '\r\n';
        } else if (line.startsWith('EHLO')) socket.write('250-sink\r\n250 PIPELINING\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 send message\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  const smtpPort = await listen(smtp); t.after(() => smtp.close());
  let upstream, hold = false, frozen = false, liveStream, holdBarrier;
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
        const stream = { frozen: false }; liveStream = stream;
        res.writeHead(response.statusCode, response.headers);
        response.on('data', bytes => { if (!stream.frozen) res.write(bytes); });
        response.on('end', () => res.end());
      } else if (snapshot || path.endsWith('/concepts/eligibility') || path === '/packages/ui/src/session-element.js') {
        const chunks = []; response.on('data', bytes => chunks.push(bytes));
        response.on('end', async () => {
          let body = Buffer.concat(chunks);
          if (path === '/packages/ui/src/session-element.js') {
            // Read-only fixture instrumentation of the private consent window. No production changes.
            const source = body.toString(), needle = '  receive(event) { this.#anchored';
            assert.ok(source.includes(needle), 'consent trace hook still matches the component');
            body = Buffer.from(source.replace(needle, `  get ait470Consent() {
              const p = this.#consentRefresh;
              return p ? { failed: !!p.failed, exhausted: !!p.exhausted, retries: p.retries,
                attempt: !!p.attempt, scopedGrant: p.scopedGrant,
                windowId: window.__ait470Id(p), attemptId: p.attempt ? window.__ait470Id(p.attempt) : null } : null;
            }\n  get ait470Options() { return this.#options; }\n  get ait470Fence() { return { invalidatedAt: this.#invalidatedAt, cursor: this.#cursor, generation: this.#rail?.generation }; }\n${needle}`));
            body = Buffer.from(body.toString().replace('  #receive(event) {', `  #receive(event) {
              window.__ait470?.arrivals.push({ t: performance.now(), event, fence: this.ait470Fence,
                duplicate: !!event.seq && event.seq <= this.#cursor });`));
            // Source length changed; let HTTP chunk it.
            delete response.headers['content-length'];
          }
          try { const s = JSON.parse(body); entry.seq = s.seq; entry.locked = s.identity?.assessmentUnlocked !== true; } catch { /* error response */ }
          entry.forwarded = Date.now();
          try { entry.eventSeq = JSON.parse(body).event?.seq; } catch { /* no event */ }
          if (entry.held) { await holdBarrier?.promise; await delay(3000); }
          if (!res.destroyed) { res.writeHead(response.statusCode, response.headers); res.end(body); }
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
  return { url, directory, messages, log, hold(barrier = false) {
    hold = true; if (barrier) holdBarrier = Promise.withResolvers();
  }, release() { holdBarrier?.resolve(); }, freeze() {
    assert.ok(liveStream); liveStream.frozen = true; frozen = true; return Date.now();
  }, get frozen() { return frozen; } };
}

const variants = full ? ['V-inplace-false', 'V-inplace', 'V-reconfigure', 'P-page', 'P-token', 'P-continue-slow', 'P-stalled', 'V-outbox', 'P-page-slow', 'V-outbox-slow', 'control'] : ['V-inplace', 'P-stalled', 'P-continue-slow'];
for (const variant of variants) for (const locale of ['en', 'de']) for (const width of [390, 1440]) {
  if (!full && variant === 'P-continue-slow' && width === 390) continue;
  test(`AIT-470 ${variant} ${locale} ${width}: confirmation clears every lock indicator`, { timeout: 130_000 }, async t => {
    const copy = locale === 'de' ? de : en, reason = copy.reasons['verification required'];
    const f = await fixture(t, variant), browser = await puppeteer.launch({ headless: true, userDataDir: join(f.directory, 'browser') });
    let collectEvidence = async () => {};
    t.after(async () => { try { await collectEvidence(); } finally { await browser.close(); } });
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width, height: width === 390 ? 844 : 900, isMobile: width === 390, hasTouch: width === 390 });
    await page.evaluateOnNewDocument(locale => {
      localStorage.setItem('aithema-demo-locale', locale);
      window.__ait470Hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__ait470Hidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.__ait470Hidden ? 'hidden' : 'visible' });
      window.__ait470 = { reads: [], events: [], features: [], streams: [], consent: [], toasts: [], arrivals: [] };
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
    const samples = [], evidence = { variant, locale, width, generationFence: 'n/a: no call', samples };
    const evidenceDir = process.env.AITHEMA_EVIDENCE_DIR;
    collectEvidence = async () => {
      evidence.proxy = f.log;
      evidence.browser = await page.evaluate(() => window.__ait470).catch(() => null);
      if (evidence.grant) evidence.grantArrivals = evidence.browser?.arrivals.filter(a =>
        a.event.seq === evidence.grant.seq && a.event.type === 'consent.revised');
      if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, `ait470-${variant}-${locale}-${width}.json`), JSON.stringify(evidence, null, 2)); }
      console.log(`AIT-470 evidence ${JSON.stringify(evidence)}`);
    };
    await page.goto(f.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.chooser__continue'));
    await mockConsent(page);
    if (variant.startsWith('V-inplace') || variant === 'V-reconfigure') {
      evidence.grant = await page.evaluate(() => window.__ait470.consent.find(e => e.event)?.event);
      assert.equal(evidence.grant?.type, 'consent.revised');
      assert.equal(evidence.grant?.data.conversationUnchanged, variant !== 'V-inplace-false', 'host grant event is received unchanged');
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
    await until(page, () => document.querySelector('aithema-session').session.identity?.status === 'verification-pending');
    // Settle request-time credit reads before arming faults.
    await delay(700);
    const before = await page.evaluate(() => window.__ait470.reads.length);
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
      assert.equal(f.log.filter(e => e.t0 > freezeAt && e.t0 < unlockedAt && (e.kind === 'restore' || e.path.endsWith('/events'))).length, 0,
        'P-stalled: no restore GET or stream reconnection between freeze and unlock');
    }
    if (variant === 'P-continue-slow' || variant === 'V-outbox-slow') {
      // Wait until all natural reads have reached upstream; no arbitrary +0.2s race.
      await waitFor(() => {
        const snapshots = f.log.filter(e => e.held && e.locked === false);
        if (!snapshots.length || snapshots.some(e => !e.forwarded)) return false;
        if (variant === 'P-continue-slow') {
          // Confirmation raises the credit tier on P: include that last natural read.
          const credit = f.log.findLast(e => e.path.endsWith('/credits') && e.t0 >= unlockedAt && e.forwarded);
          return credit && snapshots.some(e => e.t0 >= credit.forwarded);
        }
        // Both V identity triggers must have their post-unlock snapshots upstream.
        return snapshots.length >= 2;
      });
      const forwarded = f.log.filter(e => e.held && e.forwarded).at(-1);
      assert.ok(forwarded && Date.now() - forwarded.forwarded < 3000, 'journal advance precedes delivery of last natural snapshot');
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
    const reads = await page.evaluate(before => window.__ait470.reads.slice(before), before);
    evidence.redPrecondition = variant === 'P-stalled' && reads.length === 0 ? 'never-started' : reads.some(r => r.outcome === 'behind') ? 'behind' : null;
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
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `ait470-${variant}-${locale}-${width}-confirmed.png`), fullPage: false });
  });
}
