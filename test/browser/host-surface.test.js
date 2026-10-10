// AIT-104 B2: the host surface in a real browser against the default mock demo with its labelled
// demo host: the verification lock through the fake mail outbox (AITHEMA_DEMO_VERIFY=1), the
// conversation library (create, rename, sort, open, delete), handover with one failed delivery
// (AITHEMA_DEMO_HANDOVER_FAIL=1) and Retry, and the start card's Continue at 1440 × 1000 and
// 400 × 800; English and German, light and dark; nothing moves under the pointer.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const waitTimeout = 45_000;
async function browserPath() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => join(dir, name)))
      .filter(path => path !== '/snap/bin/chromium'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  for (const path of new Set(candidates)) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('No Chrome or Chromium found. Install a system browser or set CHROME_PATH to its executable.');
}
// The default demo (no AITHEMA_PROVIDER): mock reasoning with the labelled demo host ports.
async function startDemo(directory, env = {}) {
  const child = fork(new URL('../../demo/server.js', import.meta.url), [], {
    env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite'), ...env }, silent: true,
  });
  child.stdout.resume(); child.stderr.resume();
  const [message] = await Promise.race([once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Demo host exited before ready (code ${code})`); })]);
  return { child, url: message.url };
}
async function stopDemo(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
}
async function preparePage(page, languages, problems, allowed = () => false) {
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(waitTimeout);
  await page.evaluateOnNewDocument(languages => {
    Object.defineProperty(navigator, 'languages', { get: () => languages });
    Object.defineProperty(navigator, 'language', { get: () => languages[0] });
    document.addEventListener('DOMContentLoaded', () => {
      const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,'; document.head.append(icon);
    }, { once: true });
  }, languages);
  page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/^Framing ''|Failed to load resource/u.test(message.text())) problems.push(`console ${message.text()}`); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && !allowed(response.status(), url.pathname)) problems.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
  });
}
const inShadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: waitTimeout }, arg);
const shadow = (page, selector) => until(page, selector => document.querySelector('aithema-session')?.shadowRoot?.querySelector(selector), selector);
const visible = (page, selector) => until(page, selector => {
  const node = document.querySelector('aithema-session')?.shadowRoot?.querySelector(selector);
  return node && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible' && !node.closest('[hidden]');
}, selector);
const text = (page, selector) => inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector)?.textContent ?? null, selector);
const box = (page, selector) => inShadow(page, (c, selector) => {
  const rect = c.shadowRoot.querySelector(selector).getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}, selector);
function sameBox(before, after, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(before[key] - after[key]) <= .5, `${label} moved: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
}
// Rest the pointer on an element (scrolled into view as a visitor would) and leave it there.
async function rest(page, selector) {
  await inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).scrollIntoView({ block: 'nearest' }), selector);
  const target = await box(page, selector);
  await page.mouse.move(target.x + Math.min(target.width / 2, 30), target.y + Math.min(target.height / 2, 12));
  return target;
}
const click = (page, selector) => inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// One browser per language, each with its own profile: separate owner cookies and storage.
async function launch(directory, profile) {
  return puppeteer.launch({ executablePath: await browserPath(), headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
    userDataDir: join(directory, profile), timeout: waitTimeout, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
}
// The start card (preset chooser) at a size: Continue whole and inside the card, nothing scrolled inside it where it fits.
async function chooserFits(page, width, height, label) {
  await page.setViewport({ width, height });
  await inShadow(page, c => c.shadowRoot.querySelector('.chooser__continue').scrollIntoView({ block: 'nearest' }));
  const view = await inShadow(page, c => {
    const r = c.shadowRoot, intro = r.querySelector('.intro'), go = r.querySelector('.chooser__continue').getBoundingClientRect(), pane = intro.getBoundingClientRect();
    return { inCard: go.top >= pane.top - .5 && go.bottom <= pane.bottom + .5, inView: go.top >= -.5 && go.bottom <= innerHeight + .5 && go.height > 40,
      scrolls: intro.scrollHeight > intro.clientHeight + 1, hit: intro.contains(r.elementFromPoint(go.x + go.width / 2, go.y + go.height / 2)) &&
        r.elementFromPoint(go.x + go.width / 2, go.y + go.height / 2).closest('.chooser__continue') !== null };
  });
  assert.deepEqual([view.inCard, view.inView, view.hit], [true, true, true], `${label}: Continue fully visible and on top`);
  return view;
}

test('host surface: verification lock through the fake outbox keeps a manual pause, conversation library, handover retry, chooser Continue; en and de, light and dark, 1440 and 400 px (AIT-104 B2)',
  { timeout: 300_000 }, async t => {
    const evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-host-'));
    const demo = await startDemo(directory, { AITHEMA_DEMO_VERIFY: '1', AITHEMA_DEMO_HANDOVER_FAIL: '1' }); let browser, deBrowser;
    t.after(async () => {
      try { await browser?.close(); await deBrowser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async (page, name, selector) => {
      if (!evidence) return;
      if (selector) await inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).scrollIntoView({ block: 'center' }), selector);
      await page.screenshot({ path: join(evidence, `host-${name}.png`) });
    };
    browser = await launch(directory, 'chrome-en');
    const tally = [];

    // English, 1440 × 1000, light.
    const problems = [], page = await browser.newPage();
    await preparePage(page, ['en-GB', 'en'], problems, (status, path) => status === 404 && path.startsWith('/api/library/'));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    const v = en.hostSurface.verify, l = en.hostSurface.library, h = en.hostSurface.handover;

    // The start card: Continue whole at both sizes, nothing scrolled inside the card at 1440 px.
    await visible(page, '.chooser__continue');
    assert.equal((await chooserFits(page, 1440, 1000, 'en 1440')).scrolls, false, 'en 1440: the start card needs no scrolling');
    await chooserFits(page, 400, 800, 'en 400');
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'en-light-1440-start');
    const goBefore = await rest(page, '.chooser-option[data-preset="device"]');
    sameBox(goBefore, await box(page, '.chooser-option[data-preset="device"]'), 'hovered option');
    tally.push('chooser Continue at 1440 × 1000 and 400 × 800');

    // Locked by host policy: the understanding pane shows the email form in place of the assessment.
    await visible(page, '.verify-lock');
    assert.equal(await text(page, '.verify-lock__title'), v.lockTitle);
    assert.equal(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.analysis-content > section')].every(s => s.hidden)), true);
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.readiness').style.visibility), 'hidden');
    assert.equal(await text(page, '.host-verify .verify-entry'), v.entry, 'the bar offers the same verification');
    assert.deepEqual(await inShadow(page, c => c.shadowRoot.querySelector('.verify-lock .verify-send').getAttribute('aria-describedby').split(' ')), ['verify-lock-message', 'ai-notice']);
    // Consent, the ready card and a first statement.
    await page.evaluate(() => document.querySelector('#grant').click());
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').disabled);
    await click(page, '.chooser__continue'); await shadow(page, '.ready__change');
    await inShadow(page, c => { c.shadowRoot.querySelector('textarea').value = 'We need a preorder app for our bakery.'; c.shadowRoot.querySelector('form.composer').requestSubmit(); });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('ol li.turn').length >= 2);
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.verify-lock').hidden), false, 'the assessment stays locked after a turn');
    await shot(page, 'en-light-1440-locked', '.understanding');

    // An invalid address is refused in plain words without a request.
    await inShadow(page, c => { c.shadowRoot.querySelector('#verify-lock-email').value = 'not-an-address'; });
    await click(page, '.verify-lock .verify-send');
    assert.equal(await text(page, '#verify-lock-message'), v.invalid);
    // Send: the pointer rests on Send; the pending state puts Send link again in its place.
    await inShadow(page, c => { c.shadowRoot.querySelector('#verify-lock-email').value = 'visitor@example.com'; });
    const lockBefore = await box(page, '.verify-lock'), sendBox = await rest(page, '.verify-lock .verify-send');
    await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock form').dataset.mode === 'pending');
    sameBox(sendBox, await box(page, '.verify-lock .verify-resend'), 'Send link again takes the place of Send');
    sameBox(lockBefore, await box(page, '.verify-lock'), 'the lock pane');
    assert.equal(await text(page, '.verify-lock .verify__address'), 'visitor@example.com');
    assert.match(await text(page, '#verify-lock-note'), /^You can send it again in \d+ s\.$/u);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'verify-resend', 'focus stays in place');
    assert.equal(await text(page, '.host-verify .verify-entry'), v.pending);
    // Resend during the cooldown says so and sends nothing.
    await click(page, '.verify-lock .verify-resend');
    assert.equal(await text(page, '#verify-lock-message'), v.rateLimited);
    await shot(page, 'en-light-1440-pending', '.understanding');
    tally.push('verification: invalid refused, sent, cooldown, resend blocked in place');

    // A manual pause before confirming: unlocking keeps it (START v2-verification-recovery).
    await click(page, '.pause');
    await until(page, () => document.querySelector('aithema-session').session.paused === true);
    // The fake mail outbox (demo only) stands in for the inbox.
    assert.equal(await page.$eval('#outbox-open', b => [b.hidden, b.textContent]).then(([hidden, label]) => !hidden && label), en.host.outbox.open);
    await page.click('#outbox-open');
    await page.waitForSelector('#outbox-list li button');
    assert.match(await page.$eval('#outbox-list li span', n => n.textContent), /visitor@example\.com/u);
    if (evidence) await page.screenshot({ path: join(evidence, 'host-en-light-1440-outbox.png') });
    await page.click('#outbox-list li button');
    await page.waitForFunction(text => document.querySelector('#outbox-status').textContent === text, {}, en.host.outbox.confirmed);
    await page.click('#outbox-close');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock').hidden);
    assert.equal(await text(page, '.host-verify .verify-done'), v.verified);
    assert.equal(await inShadow(page, c => c.session.paused), true, 'the manual pause is kept');
    assert.equal(await text(page, '.pause'), en.resume);
    assert.equal(await text(page, '.status'), v.unlockedPaused);
    await click(page, '.pause'); await until(page, () => document.querySelector('aithema-session').session.paused === false);
    await shot(page, 'en-light-1440-verified', '.understanding');
    tally.push('outbox confirmation unlocks the assessment, manual pause kept');

    // Handover: the first delivery fails (demo flag), Retry delivers; the button never moves.
    await visible(page, '.handover-request');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('slot[name="handover-offer"]').assignedElements().map(n => n.textContent).join('')),
      en.host.slots.handoverOffer, 'the host fills the offer slot');
    const requestBox = await rest(page, '.handover-request');
    await page.mouse.down(); await page.mouse.up();
    await until(page, failed => document.querySelector('aithema-session').shadowRoot.querySelector('.handover__state').textContent === failed, h.failed);
    sameBox(requestBox, await box(page, '.handover-request'), 'handover action after a failed delivery');
    assert.equal(await text(page, '.handover__label'), h.retry);
    await shot(page, 'en-light-1440-handover-failed', '.handover');
    await page.mouse.down(); await page.mouse.up();
    await until(page, sent => document.querySelector('aithema-session').shadowRoot.querySelector('.handover__state').textContent === sent, h.sent);
    sameBox(requestBox, await box(page, '.handover-request'), 'handover action after Retry');
    assert.equal(await inShadow(page, c => c.session.handover.status), 'sent');
    await shot(page, 'en-light-1440-handover-sent', '.handover');
    tally.push('handover failed then Retry sent');

    // Credits: the owner balance from the server, in the host bar.
    assert.match(await text(page, '.host-credits__text'), /^Credits: [\d.,]+ of [\d.,]+/u);

    // The library: the current conversation, New, rename, sort, open, delete.
    const first = await inShadow(page, c => c.session.id);
    await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 1);
    assert.equal(await text(page, 'dialog.library tbody tr .library__current'), l.current);
    assert.equal(await text(page, 'dialog.library tbody tr .library__name'), l.untitled);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.id), 'library-search', 'focus moves into the dialog');
    await shot(page, 'en-light-1440-library');
    await click(page, '.library-new');
    await until(page, first => document.querySelector('aithema-session').session.id !== first, first);
    const second = await inShadow(page, c => c.session.id);
    assert.equal(await page.evaluate(() => localStorage.getItem('aithema-reset-slice-1-session')), second, 'the host adopted the new conversation');
    await shadow(page, '.chooser__continue');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('library-open-dialog'));
    await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 2);
    // Rename the first conversation in place: its row keeps its box while the name is edited.
    const row = `dialog.library tbody tr[data-key="${first}"]`;
    const rowBefore = await box(page, row);
    await click(page, `${row} .library-rename`);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.id), `library-rename-${first}`);
    sameBox(rowBefore, await box(page, row), 'the renamed row');
    await page.keyboard.type('Bakery preorders'); await page.keyboard.press('Enter');
    await until(page, row => document.querySelector('aithema-session').shadowRoot.querySelector(`${row} .library__name`).textContent === 'Bakery preorders', row);
    assert.equal(await text(page, 'dialog.library .library__message'), l.renamed);
    // Sort by title: ascending, the untitled one after "Bakery …"; the header says so.
    await click(page, 'dialog.library [data-sort="title"]');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.library__col-title').getAttribute('aria-sort')), 'ascending');
    assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('dialog.library tbody tr')].map(r => r.dataset.key)), [first, second]);
    await shot(page, 'en-light-1440-library-renamed');
    // Open the first one.
    await click(page, `${row} .library-open`);
    await until(page, first => document.querySelector('aithema-session').session.id === first, first);
    assert.equal(await inShadow(page, c => c.session.library?.title), 'Bakery preorders');
    // Delete the empty one: the confirmation takes the footer's place, the list does not move.
    await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 2);
    const footBefore = await box(page, 'dialog.library .library__foot'), listBefore = await box(page, 'dialog.library tbody');
    await click(page, `dialog.library tbody tr[data-key="${second}"] .library-delete`);
    assert.equal(await text(page, '#library-confirm-warning'), l.deleteWarning);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'library-confirm-cancel');
    sameBox(footBefore, await box(page, 'dialog.library .library__foot'), 'the library footer with a confirmation');
    sameBox(listBefore, await box(page, 'dialog.library tbody'), 'the list while confirming');
    await shot(page, 'en-light-1440-library-delete');
    await click(page, 'dialog.library .library-confirm');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 1);
    assert.equal(await text(page, 'dialog.library .library__message'), l.deleted);
    const gone = await page.evaluate(async id => (await fetch(`/api/library/${id}`)).status, second);
    assert.equal(gone, 404, 'the deleted conversation is erased on the server');
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.library').open);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'library-open-dialog', 'Escape returns focus to the opener');
    tally.push('library: new, rename in place, sort, open, delete with erasure wording');

    // Dark, 400 px: the bar, the library and the verified pane fit without sideways scrolling.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 400, height: 800 });
    assert.equal(await overflow(page), 0);
    await shot(page, 'en-dark-400-bar', '.host-bar');
    await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 1);
    const dialog = await box(page, 'dialog.library');
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 400 && dialog.y >= 0 && dialog.y + dialog.height <= 800, 'the library sheet fits the phone');
    await shot(page, 'en-dark-400-library');
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1440, height: 1000 });
    await shot(page, 'en-dark-1440-handover', '.understanding');
    assert.deepEqual(problems, []);
    await browser.close(); browser = null;

    // German, 400 × 800, dark: one language on the page, the lock and the dialogs in German.
    deBrowser = await launch(directory, 'chrome-de');
    const german = [], dePage = await deBrowser.newPage();
    await preparePage(dePage, ['de-AT', 'de'], german);
    await dePage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await dePage.setViewport({ width: 400, height: 800 });
    await dePage.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await visible(dePage, '.chooser__continue');
    assert.equal(await dePage.evaluate(() => document.documentElement.lang), 'de');
    await chooserFits(dePage, 400, 800, 'de 400');
    assert.equal((await chooserFits(dePage, 1440, 1000, 'de 1440')).scrolls, false, 'de 1440: the start card needs no scrolling');
    await dePage.setViewport({ width: 400, height: 800 });
    await visible(dePage, '.verify-lock');
    assert.equal(await text(dePage, '.verify-lock__title'), de.hostSurface.verify.lockTitle);
    assert.equal(await text(dePage, '.library-open-dialog'), de.hostSurface.library.open);
    assert.equal(await text(dePage, '.host-verify .verify-entry'), de.hostSurface.verify.entry);
    await shot(dePage, 'de-dark-400-locked', '.verify-lock');
    await inShadow(dePage, c => c.shadowRoot.querySelector('.verify-entry').click());
    await until(dePage, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
    assert.equal(await inShadow(dePage, c => c.shadowRoot.activeElement?.id), 'verify-dialog-email');
    await shot(dePage, 'de-dark-400-verify-dialog');
    await dePage.keyboard.press('Escape');
    await until(dePage, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('verify-entry'));
    await click(dePage, '.library-open-dialog');
    await until(dePage, () => document.querySelectorAll('aithema-session')[0].shadowRoot.querySelectorAll('dialog.library tbody tr').length === 1);
    assert.equal(await text(dePage, 'dialog.library #library-title'), de.hostSurface.library.title);
    await shot(dePage, 'de-dark-400-library');
    await dePage.keyboard.press('Escape');
    await dePage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await dePage.setViewport({ width: 1440, height: 1000 });
    await shot(dePage, 'de-light-1440-locked', '.understanding');
    // Nothing English on the German page's host surface (product names aside).
    const words = await inShadow(dePage, c => [...c.shadowRoot.querySelectorAll('.host-bar, .verify-lock, dialog.library, dialog.verify-dialog')]
      .map(n => n.textContent).join(' '));
    for (const english of ['Conversations', 'Verify your email', 'Send confirmation link', 'Your conversations', 'Search conversations']) {
      assert.ok(!words.includes(english), `English on the German page: ${english}`);
    }
    assert.equal(await overflow(dePage), 0);
    assert.deepEqual(german, []);
    t.diagnostic(`Host surface: ${tally.join('; ')}; German dark 400 px lock, verify dialog and library; no sideways overflow.`);
  });
