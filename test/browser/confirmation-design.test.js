// AIT-135 C2: production templates/store/page, an in-memory mail delivery sink,
// viewport evidence and exact geometry. No relay, provider or external resource.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserForFile } from './shared-browser.js';
import { fullMatrix, matrixWidths } from './matrix-coverage.js';
import { createIdentity, reduceIdentity } from '@inspr/aithema-core';
import { SQLiteStorage } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { createConfirmationPage, confirmationCopy } from '../../demo/confirmation-page.js';
import { confirmationMessage } from '../../plugins/mail-smtp/src/templates.js';
import { formatCredits } from '../../packages/ui/src/display.js';
import { assertConfirmationMail } from '../fixtures/confirmation-mail.js';


async function fixture() {
  const storage = new SQLiteStorage(), messages = [];
  let time = 1_000, counter = 0, page, posts = 0, postGate, lastPost;
  const host = createDemoHost({ storage, demo: false, now: () => time, privacyDocumentConfigured: () => true,
    mailPlugin: { id: 'smtp', deliversVerification: true, async requestVerification(effect) { messages.push(effect); return { status: 'sent' }; } } });
  host.visitorCredits.saveSettings({ baseRevision: 1, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' }, confirmationEnabled: true }, { actor: 'ops-cli:test', source: 'ops-cli' });
  const assets = new Map(await Promise.all(['host.css', 'theme-init.js', 'confirm-email.js'].map(async file =>
    ['/demo/' + file, await readFile(new URL('../../demo/' + file, import.meta.url), 'utf8')])));
  const server = await listen(async request => {
    const u = new URL(request.url);
    if (assets.has(u.pathname)) return new Response(assets.get(u.pathname), { headers: { 'content-type': u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    if (u.pathname === '/mail') {
      const locale = u.searchParams.get('lang') === 'de' ? 'de' : 'en';
      return new Response(mail(locale).html, { headers: { 'content-type': 'text/html' } });
    }
    if (request.method === 'POST') {
      posts++;
      lastPost = { origin: request.headers.get('origin'), referer: request.headers.get('referer') };
      if (postGate) { const held = postGate; postGate = undefined; held.arrive(); await held.pending; }
    }
    return await page.handle(request) ?? new Response(null, { status: 404 });
  });
  page = createConfirmationPage({ host, publicOrigin: server.url, now: () => time });
  const mailExamples = new Map();
  const mail = locale => mailExamples.get(locale).message;
  async function prepare(state, locale) {
    const owner = 'c2-owner-' + ++counter, address = `visitor-${counter}@example.test`, s = storage.create({ ownerToken: owner, locale });
    host.saveEmail(owner, { address, noticeVersion: 'ait-135-v1' });
    const result = reduceIdentity(host.identity.project({ session: s }, createIdentity()), { type: 'request-verification', address, now: time });
    host.identity.persist({ session: s }, result.state);
    await host.identity.requestVerification({ sessionId: s.id, ownerToken: owner, ...result.events.find(e => e.type === 'verification.requested').data });
    const token = messages.at(-1).token;
    if (['confirmed', 'used-confirmed', 'used-link'].includes(state)) assert.equal(host.confirmation.redeem(token).state, 'confirmed');
    if (state === 'used-link') storage.db.prepare("UPDATE visitor_identities SET confirmed_at=NULL,identity_json=json_set(identity_json,'$.status','pending') WHERE owner_hash=?")
      .run(s.ownerHash);
    if (state === 'expired') time += 1_800_000;
    if (['too-many', 'too-many-now'].includes(state)) {
      for (let i = 0; i < 5; i++) host.confirmation.redeem(token.split('.')[0] + '.wrong');
      if (state === 'too-many-now') time += 60_000;
    }
    return { url: server.url + '/confirm-email?token=' + (state === 'invalid' ? 'invalid' : token) + '&lang=' + locale, token, owner, address };
  }
  for (const locale of ['de', 'en']) {
    await prepare('ready', locale);
    const effect = messages.at(-1), link = server.url + '/confirm-email?token=' + effect.token + '&lang=' + locale;
    const privacyUrl = server.url + '/privacy?locale=' + locale;
    mailExamples.set(locale, { link, privacyUrl, message: confirmationMessage({ locale, link, privacyUrl,
      host: new URL(server.url).host, expiresAt: effect.expiresAt, now: time,
      tierAfter: formatCredits(effect.confirmedAllowanceMicro, locale) }) });
  }
  return { url: server.url, host, mail, mailParams: locale => mailExamples.get(locale), prepare, posts: () => posts, lastPost: () => lastPost,
    holdNextPost() {
      let arrive, release;
      const arrived = new Promise(resolve => { arrive = resolve; }), pending = new Promise(resolve => { release = resolve; });
      postGate = { arrive, pending };
      return { arrived, release };
    },
    async close() { await new Promise(resolve => { server.server.close(resolve); server.server.closeAllConnections(); }); storage.close(); } };
}

const geometry = page => page.evaluate(() => {
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { card: rect(document.querySelector('.confirm-card')), button: rect(document.querySelector('.confirm-view:not([aria-hidden]) .confirm-button')) };
});
const variants = [['used-confirmed', 'usedConfirmed'], ['used-link', 'usedLink'], ['expired', 'expired'], ['invalid', 'invalid'], ['too-many', 'tooMany'], ['too-many-now', 'tooManyNow']];

test('C2 viewport evidence: DE/EN mail and every landing state, light/dark, zero shift and progressive form', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-confirm-c2-')), f = await fixture();
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await f.close(); await rm(directory, { recursive: true, force: true }); } });
  browser = await browserForFile();
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  let resolveSubmission;
  await page.exposeFunction('recordConfirmationSubmit', result => resolveSubmission(result));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, pass = [], shots = [], errors = [], external = [];
  const head = process.env.GITHUB_SHA ?? basename(dirname(process.cwd())).match(/^[a-f0-9]{10}(?=-)/u)?.[0] ?? 'working-tree';
  if (evidence) await mkdir(evidence, { recursive: true });
  const shot = async name => {
    shots.push(name + '.png');
    if (evidence) await page.screenshot({ path: join(evidence, name + '.png'), fullPage: false });
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(f.url) && !request.url().startsWith('data:')) external.push(request.url()); });
  for (const locale of ['de', 'en']) {
    const { link, privacyUrl } = f.mailParams(locale);
    assert.match(new URL(link).searchParams.get('token'), /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u);
    pass.push(`PASS head=${head} mail ${locale}: ${assertConfirmationMail(f.mail(locale), { locale, link, privacyUrl })}`);
    for (const theme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      for (const width of matrixWidths([600, 375], theme, 0)) {
        await page.setViewport({ width, height: 1100 });
        await page.goto(f.url + '/mail?lang=' + locale, { waitUntil: 'networkidle0' });
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
          button: document.querySelector('.ai-btn-a').getBoundingClientRect().height }));
        assert.equal(dimensions.scroll, dimensions.viewport); assert.equal(dimensions.button, 48);
        assert.equal(await page.$eval('.ai-page', el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(11, 26, 38)' : 'rgb(251, 247, 239)');
        await shot(`c2-mail-${locale}-${theme}-${width}`);
      }
      // Clients that discard the single progressive style block must still fit 320 px.
      await page.setViewport({ width: 320, height: 1100 });
      await page.evaluate(() => document.querySelector('style').remove());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
      for (const width of matrixWidths([390, 1440], theme, 1)) {
        await page.setViewport({ width, height: width === 390 ? 844 : 900 });
        const ready = await f.prepare('ready', locale);
        await page.goto(ready.url, { waitUntil: 'networkidle0' });
        assert.equal(await page.$eval('h1', el => el.textContent), confirmationCopy[locale].ready.h1);
        assert.equal(await page.$eval('.confirm-address', el => el.textContent), ready.address);
        assert.equal(f.host.confirmation.inspect(ready.token).state, 'valid', 'GET leaves the token unredeemed');
        assert.equal(await page.$eval('body', el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(11, 26, 38)' : 'rgb(251, 247, 239)');
        const before = await geometry(page);
        assert.equal(before.button.height, 48);
        await shot(`c2-landing-ready-${locale}-${theme}-${width}`);
        // Exercise the actual host-served handler and its BFCache restoration without navigating.
        assert.deepEqual(await page.evaluate(() => {
          const form = document.querySelector('form'); form.addEventListener('submit', event => event.preventDefault(), { once: true });
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          const duplicateBlocked = !form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          return [duplicateBlocked, !document.querySelector('.confirm-card').hasAttribute('data-busy'), !form.querySelector('button').hasAttribute('aria-disabled'), document.querySelector('[role=status]').textContent];
        }), [true, true, true, '']);
        // Hold the server response while the genuine POST is pending.
        const held = f.holdNextPost();
        const submission = new Promise(resolve => { resolveSubmission = resolve; });
        await page.$eval('form', form => form.addEventListener('submit', () => {
          // The product handler ran first. Measure its pending state before the
          // browser discards this document for the form navigation.
          const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const card = form.closest('.confirm-card'), button = form.querySelector('button');
          void window.recordConfirmationSubmit({ geometry: { card: rect(card), button: rect(button) }, busy: card.dataset.busy,
            disabled: button.getAttribute('aria-disabled'), status: card.querySelector('[role=status]').textContent,
            duplicateBlocked: !form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) });
        }, { once: true }));
        const postCount = f.posts();
        await page.click('button[type=submit]');
        await held.arrived;
        const submitted = await submission, during = submitted.geometry;
        assert.equal(submitted.busy, 'true'); assert.equal(submitted.disabled, 'true');
        assert.equal(submitted.status, confirmationCopy[locale].ready.busy); assert.equal(submitted.duplicateBlocked, true);
        await shot(`c2-landing-confirming-${locale}-${theme}-${width}`);
        // The server cannot respond while held. Start its timeout after busy-state
        // evidence, so screenshot time is not charged to the POST response.
        const postResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/confirm-email');
        const navigation = page.waitForNavigation({ waitUntil: 'networkidle0' });
        held.release(); const [response] = await Promise.all([postResponse, navigation]);
        await page.waitForSelector('[data-confirmation-state=confirmed]');
        assert.equal(f.lastPost().origin, f.url, 'the native form carries the configured Origin');
        assert.equal(f.lastPost().referer, f.url + '/', 'the bearer token never enters the Referer');
        assert.equal(response.status(), 200, 'the real form POST succeeds');
        assert.equal(f.posts(), postCount + 1);
        assert.equal(f.host.visitor(ready.owner).tier, 'emailConfirmed');
        assert.equal(await page.$eval('h1', el => el.textContent), confirmationCopy[locale].confirmed.h1);
        assert.equal(await page.$eval('.confirm-icon--done path', el => el.getAttribute('d')), 'M5.75 12.5l4.1 4.1 8.4-8.6', 'the approved confirmation check is shown');
        const after = await geometry(page);
        assert.deepEqual(during, before, 'confirming retains exact geometry'); assert.deepEqual(after, before, 'confirmed retains exact geometry');
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.confirm-icon--draw path')).strokeDashoffset === '0px');
        await shot(`c2-landing-confirmed-${locale}-${theme}-${width}`);
        pass.push(`PASS head=${head} landing ${locale} ${theme} ${width}: ready → confirming → confirmed card/button layout shift 0.00 px`);
        for (const [state, key] of variants) {
          const prepared = await f.prepare(state, locale);
          await page.goto(prepared.url, { waitUntil: 'networkidle0' });
          assert.equal(await page.$eval('h1', el => el.textContent), confirmationCopy[locale][key].h1);
          assert.equal(await page.$eval('.confirm-view:not([aria-hidden]) .confirm-label', el => el.textContent), confirmationCopy[locale][key].button);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          assert.equal(await page.$$eval('[style], script:not([src])', nodes => nodes.length), 0);
          await shot(`c2-landing-${state}-${locale}-${theme}-${width}`);
        }
      }
    }
  }
  // Reduced motion disables both the spinner and one-time check animation.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const reduced = await f.prepare('ready', 'en'); await page.goto(reduced.url, { waitUntil: 'networkidle0' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type=submit]')]);
  await page.waitForSelector('[data-confirmation-state=confirmed]');
  assert.equal(await page.$eval('.confirm-icon--draw path', el => getComputedStyle(el).animationName), 'none');
  assert.equal(await page.$eval('.confirm-icon--draw path', el => getComputedStyle(el).strokeDashoffset), '0px');
  // Without JavaScript, the original form still sends a real CSRF-safe POST.
  await page.setJavaScriptEnabled(false);
  const plain = await f.prepare('ready', 'en'); await page.goto(plain.url, { waitUntil: 'networkidle0' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type=submit]')]);
  assert.equal(f.host.confirmation.inspect(plain.token).state, 'alreadyUsed');
  assert.equal(f.host.visitor(plain.owner).tier, 'emailConfirmed');
  assert.equal(f.lastPost().origin, f.url); assert.equal(f.lastPost().referer, f.url + '/');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(shots.length, fullMatrix ? 80 : 40);
  pass.push(`PASS head=${head} ${shots.length} viewport shots; all 9 landing states; CSP; GET never redeems; one POST; BFCache reset; reduced motion; no-script confirmation; no remote requests`);
  if (evidence) {
    await writeFile(join(evidence, 'c2-pass-lines.txt'), pass.join('\n') + '\n');
    await writeFile(join(evidence, 'c2-evidence.json'), JSON.stringify({ head, shots, pass }, null, 2) + '\n');
  }
  for (const line of pass) t.diagnostic(line);
});
