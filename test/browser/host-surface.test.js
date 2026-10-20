import { evidenceCommit, settleEvidenceFrame } from './start2-display-helpers.js';
import { normalComposerEvidence } from './normal-composer-evidence.js';
import { createRequire } from 'node:module';
import { a11yEvidenceMode } from './matrix-coverage.js';
import { mockConsent } from './consent-helpers.js';
import { fixture as creditFixture } from './visitor-credit-tiers-helpers.js';
// AIT-104 B2: the host surface in a real browser against the default mock demo with its labelled
// demo host: the verification lock through the fake mail outbox (AITHEMA_DEMO_VERIFY=1), the
// conversation library (create, rename, sort, open, delete), handover with one failed delivery
// (AITHEMA_DEMO_HANDOVER_FAIL=1) and Retry, and the start card's Continue at 1440 × 1000 and
// 400 × 800; English and German, light and dark; nothing moves under the pointer.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import puppeteer from './launch.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { AI_NOTICE } from '../../packages/core/src/ai-notice.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../demo/processing-consent.js';
import { manifest as consentVoiceManifest } from '../../plugins/elevenlabs/src/manifest.js';

const waitTimeout = 45_000;
import { browserPath } from '../../scripts/install-test-browser.js';
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
    if (window !== window.top) return;
    Object.defineProperty(navigator, 'languages', { get: () => languages });
    Object.defineProperty(navigator, 'language', { get: () => languages[0] });
    try { localStorage.setItem('aithema-demo-locale', languages[0].startsWith('de') ? 'de' : 'en'); } catch { /* Storage can be denied. */ }
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
    // The demo handover reaches a local fake recipient: its success line promises no contact.
    const demoSent = en.host.handover.sent;

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
    assert.equal(await text(page, '.host-verify .verify-entry'), v.entry, 'Settings offers the same verification');
    assert.deepEqual(await inShadow(page, c => c.shadowRoot.querySelector('.verify-lock .verify-send').getAttribute('aria-describedby').split(' ')), ['verify-lock-message', 'ai-notice']);
    // Consent, the ready card and a first statement.
    await mockConsent(page);
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
    await page.bringToFront();
    await until(page, () => document.hasFocus());
    const lockBefore = await box(page, '.verify-lock'), sendBox = await rest(page, '.verify-lock .verify-send');
    await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock form').dataset.mode === 'pending');
    // identity.state can paint pending before saveAndConfirm's credit refreshes
    // finish and #send restores focus. Await that outcome, not just the mode.
    await until(page, () => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return document.hasFocus() && root.activeElement === root.querySelector('.verify-lock .verify-resend');
    });
    sameBox(sendBox, await box(page, '.verify-lock .verify-resend'), 'Send link again takes the place of Send');
    sameBox(lockBefore, await box(page, '.verify-lock'), 'the lock pane');
    assert.equal(await text(page, '.verify-lock .verify__address'), 'visitor@example.com');
    assert.match(await text(page, '#verify-lock-note'), /^You can send it again in \d+ s\.$/u);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'verify-resend', 'focus stays in place');
    assert.equal(await text(page, '.host-verify .verify-entry'), v.resendOrChange);
    // Resend during the cooldown says so and sends nothing.
    await click(page, '.verify-lock .verify-resend');
    assert.equal(await text(page, '#verify-lock-message'), v.rateLimited);
    await shot(page, 'en-light-1440-pending', '.understanding');
    tally.push('verification: invalid refused, sent, cooldown, resend blocked in place');

    // A manual pause before confirming: unlocking keeps it (START v2-verification-recovery).
    await click(page, '.pause');
    await until(page, () => document.querySelector('aithema-session').session.paused === true);
    // AIT-135: START keeps the monetary wallet and manual pause without an owner clock.
    await until(page, () => {
      const deadline = document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__deadline');
      return deadline.hidden && deadline.textContent === '';
    });
    // The fake mail outbox (demo only) stands in for the inbox.
    assert.equal(await page.$eval('#outbox-open', b => [b.hidden, b.textContent]).then(([hidden, label]) => !hidden && label), en.host.outbox.open);
    await page.click('#outbox-open');
    await page.waitForSelector('#outbox-list li button');
    assert.match(await page.$eval('#outbox-list li span', n => n.textContent), /visitor@example\.com/u);
    // Confirming unlocks the AI assessment: the modal outbox shows the AI notice and the link is described by it.
    assert.deepEqual(await page.$eval('#outbox-list li button', b => {
      const notice = document.getElementById('ai-notice'), rect = notice.getBoundingClientRect();
      return [b.getAttribute('aria-describedby'), notice.textContent, document.querySelector('#outbox').contains(notice) && rect.height > 0];
    }), ['ai-notice', AI_NOTICE.en.text, true]);
    if (evidence) await page.screenshot({ path: join(evidence, 'host-en-light-1440-outbox.png') });
    await page.click('#outbox-list li button');
    await page.waitForFunction(text => document.querySelector('#outbox-status').textContent === text, {}, en.host.outbox.confirmed);
    await page.click('#outbox-close');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.verify-lock').hidden);
    assert.equal(await text(page, '.host-verify .verify-done'), en.hostSurface.email.confirmedLabel);
    assert.equal(await inShadow(page, c => c.session.paused), true, 'the manual pause is kept');
    assert.equal(await text(page, '.pause'), en.resume);
    assert.equal(await text(page, '.status__label'), v.unlockedPaused);
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
    // The evidence shot may scroll the page; the pointer rests on Retry again before pressing it (AIT-128).
    const retryBox = await rest(page, '.handover-request');
    await page.mouse.down(); await page.mouse.up();
    await until(page, sent => document.querySelector('aithema-session').shadowRoot.querySelector('.handover__state').textContent === sent, demoSent);
    sameBox(retryBox, await box(page, '.handover-request'), 'handover action after Retry');
    assert.equal(await inShadow(page, c => c.session.handover.status), 'sent');
    await shot(page, 'en-light-1440-handover-sent', '.handover');
    tally.push('handover failed then Retry sent');

    // Credits: the owner balance from the server, in the host bar.
    assert.match(await text(page, '.host-credits__text'), /^[\d.,]+ of [\d.,]+ Credits$/u);

    // The library: the current conversation, New, rename, sort, open, delete.
    const first = await inShadow(page, c => c.session.id);
    await click(page, '.conversations-toggle'); await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 1);
    assert.equal(await text(page, 'dialog.library tbody tr .library__current'), l.current);
    assert.equal(await text(page, 'dialog.library tbody tr .library__name'), l.untitled);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.id), 'library-search', 'focus moves into the dialog');
    await shot(page, 'en-light-1440-library');
    await click(page, '.library-new');
    await until(page, first => document.querySelector('aithema-session').session.id !== first, first);
    const second = await inShadow(page, c => c.session.id);
    assert.equal(await inShadow(page, c => c.session.identity.status), 'verified', 'AIT-135: new conversations inherit visitor evidence');
    assert.equal(await page.evaluate(() => localStorage.getItem('aithema-reset-slice-1-session')), second, 'the host adopted the new conversation');
    await shadow(page, '.chooser__continue');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('conversations-toggle'));
    await click(page, '.conversations-toggle'); await click(page, '.library-open-dialog');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('dialog.library tbody tr').length === 2);
    // Rename the first conversation in place: its row keeps its box while the name is edited.
    const row = `dialog.library tbody tr[data-key="${first}"]`, other = `dialog.library tbody tr[data-key="${second}"]`;
    const keys = () => inShadow(page, c => [...c.shadowRoot.querySelectorAll('dialog.library tbody tr')].map(r => r.dataset.key));
    assert.deepEqual(await keys(), [second, first], 'last activity first');
    const rowBefore = await box(page, row), otherBefore = await box(page, other), renameBefore = await box(page, `${row} .library-rename`);
    await click(page, `${row} .library-rename`);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.id), `library-rename-${first}`);
    sameBox(rowBefore, await box(page, row), 'the renamed row');
    // Save with the pointer resting on Save: the rename makes this conversation the latest, yet no row moves.
    const saveBox = await rest(page, `${row} .library-save`);
    await page.keyboard.type('Bakery preorders'); await page.keyboard.press('Enter');
    await until(page, row => document.querySelector('aithema-session').shadowRoot.querySelector(`${row} .library__name`).textContent === 'Bakery preorders', row);
    assert.equal(await text(page, 'dialog.library .library__message'), l.renamed);
    // The rename's library.state event reloads the list in the background; give it time, then measure.
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(await keys(), [second, first], 'the renamed row stays in place until the next load or search');
    sameBox(rowBefore, await box(page, row), 'the renamed row after saving');
    sameBox(otherBefore, await box(page, other), 'the other row after saving');
    sameBox(renameBefore, await box(page, `${row} .library-rename`), 'Rename after saving');
    sameBox(saveBox, await box(page, `${row} .library-save`), 'Save under the pointer');
    await shot(page, 'en-light-1440-library-saved');
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
    await click(page, '.conversations-toggle'); await click(page, '.library-open-dialog');
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
    await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.className === 'conversations-toggle');
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'conversations-toggle', 'Escape returns focus to the opener');
    tally.push('library: new, rename in place, sort, open, delete with erasure wording');

    // Dark, 400 px: the bar, the library and the verified pane fit without sideways scrolling.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 400, height: 800 });
    assert.equal(await overflow(page), 0);
    await shot(page, 'en-dark-400-bar', '.host-bar');
    await click(page, '.conversations-toggle'); await click(page, '.library-open-dialog');
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
    assert.equal(await text(dePage, '.conversations-toggle'), de.hostSurface.library.open);
    assert.equal(await text(dePage, '.library-open-dialog'), de.display.manageConversations);
    assert.equal(await text(dePage, '.host-verify .verify-entry'), de.hostSurface.verify.entry);
    await shot(dePage, 'de-dark-400-locked', '.verify-lock');
    await click(dePage, '.settings-open'); await click(dePage, '[data-tab="general"]');
    await inShadow(dePage, c => c.shadowRoot.querySelector('.verify-entry').click());
    assert.equal(await inShadow(dePage, c => c.shadowRoot.querySelector('dialog.settings').open), false);
    await until(dePage, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
    assert.equal(await inShadow(dePage, c => c.shadowRoot.activeElement?.id), 'verify-dialog-email');
    // The modal covers the conversation's notice line, so the AI notice is in view inside the dialog itself.
    const modalNotice = await inShadow(dePage, c => {
      const r = c.shadowRoot, line = r.querySelector('dialog.verify-dialog .verify-dialog__notice'), rect = line.getBoundingClientRect();
      const hit = r.elementFromPoint(rect.x + Math.min(rect.width / 2, 20), rect.y + rect.height / 2);
      return { text: line.textContent, notice: r.querySelector('#ai-notice').textContent, inView: rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
        visible: getComputedStyle(line).visibility === 'visible', onTop: line.contains(hit) };
    });
    assert.deepEqual(modalNotice, { text: modalNotice.notice, notice: modalNotice.notice, inView: true, visible: true, onTop: true });
    assert.match(modalNotice.notice, /KI-Assistenz/u);
    await shot(dePage, 'de-dark-400-verify-dialog');
    await dePage.keyboard.press('Escape');
    await until(dePage, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('settings-open'));
    await click(dePage, '.conversations-toggle'); await click(dePage, '.library-open-dialog');
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

test('AIT-214: retiring an idle session removes its export and reload creates a fresh conversation', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-retention-browser-'));
  const child = fork(new URL('../fixtures/retention-server.js', import.meta.url), [], {
    env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite') }, silent: true,
  });
  child.stdout.resume(); child.stderr.resume();
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stopDemo(child); await rm(directory, { recursive: true, force: true }); }
  });
  const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Retention host exited'); })]);
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    env: { PATH: process.env.PATH, HOME: homedir() }, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(ready.url);
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  const id = await page.$eval('aithema-session', c => c.session.id);
  assert.equal(await page.evaluate(id => fetch(`/api/sessions/${id}/export`).then(r => r.status), id), 200);
  // Disconnect live traffic; a connected stream deliberately protects its session.
  await page.goto('about:blank');
  const retired = once(child, 'message'); child.send({ type: 'retire', id });
  const [result] = await retired;
  assert.deepEqual(result, { type: 'retired', result: { retired: 1, failed: 0, more: false } });
  await page.goto(ready.url);
  await page.waitForFunction(id => {
    const c = document.querySelector('aithema-session'); return c?.session?.id && c.session.id !== id;
  }, {}, id);
  const gone = await page.evaluate(async id => {
    const response = await fetch(`/api/sessions/${id}/export`);
    return { status: response.status, type: response.headers.get('content-type'), body: await response.json() };
  }, id);
  assert.deepEqual(gone, { status: 404, type: 'application/json', body: { error: 'session-not-found' } });
  assert.deepEqual(await page.$eval('aithema-session', c => c.session.transcript), []);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
    await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-214-fresh-session.png'), fullPage: false });
  }
});

test('AIT-261: every terminal reason disables the demo UI and preserves export in DE and EN', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-terminal-browser-'));
  const demo = await startDemo(directory); let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
  });
  browser = await launch(directory, 'terminal-profile');
  const page = await browser.newPage(), problems = [];
  await preparePage(page, ['de'], problems);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(demo.url); await shadow(page, '.composer');
  const original = await inShadow(page, c => c.session);
  const legal297 = await inShadow(page, c => c.querySelector('#demo-legal').outerHTML);
  const export294Checks = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const assertExport = async (locale, surface) => {
    for (const width of [320, 360, 390]) {
      await page.setViewport({ width, height: 844 }); await settleEvidenceFrame(page);
      const metric = await inShadow(page, (c, surface) => {
        const link = c.shadowRoot.querySelector(surface), b = link.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(link.querySelector('span') ?? link);
        const lines = [...range.getClientRects()].filter(r => r.width > 0);
        const icon = link.querySelector('svg'), i = icon.getBoundingClientRect();
        const container = link.closest('.composer-out') ?? link.closest('.foot'), p = container.getBoundingClientRect();
        return { lines: new Set(lines.map(r => r.y)).size, left: b.left, right: b.right, width: b.width,
          contained: b.left >= p.left && b.right <= p.right && b.bottom <= p.bottom,
          icon: icon.checkVisibility({ visibilityProperty:true }), iconAligned: i.right <= lines[0]?.left && i.top >= b.top && i.bottom <= b.bottom,
          overflow: container.scrollWidth - container.clientWidth };
      }, surface);
      assert.equal(metric.lines, 1, `AIT-294: ${locale}/${width}/${surface} export has one line box: ${JSON.stringify(metric)}`);
      assert.equal(metric.icon, true); assert.equal(metric.iconAligned, true);
      assert.equal(metric.contained, true, `AIT-294: export stays in its surface: ${JSON.stringify(metric)}`);
      assert.equal(metric.overflow, 0); assert.ok(metric.left >= 0 && metric.right <= width);
      export294Checks.push({ head: evidenceCommit, locale, width, surface, pass: true, ...metric });
    }
  };
  const shot294 = async name => {
    if (!evidence) return;
    await mkdir(evidence, { recursive:true }); await settleEvidenceFrame(page);
    await page.screenshot({ path: join(evidence, name), fullPage:false, captureBeyondViewport:false });
  };
  // Reuse a single page/browser for this state-only matrix. The server's actual
  // deadline and spend paths are covered with fake clocks in the unit suite.
  for (const locale of ['de', 'en']) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
    const expected = (locale === 'de' ? de : en).hostSurface.credits.ended[reason].body;
    await page.setViewport({ width: 390, height: 844 });
    await inShadow(page, (c, { original, locale, reason, copy }) => {
      const session = { ...original, locale, credits: null, transcript: [],
        understanding: { ...original.understanding, summary: 'A website for our bakery.', readinessAssessed: true } };
      // AIT-260: preserve the bound-voice terminal-disable path.
      c.configure({ copy, session, voiceClient: {}, host: { credits: true } });
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'terminal-demo-input', role: 'user', content: locale === 'de' ? 'Wir brauchen eine App.' : 'We need an app.' } });
      c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason } });
      c.receive({ seq: c.session.seq + 1, type: 'conversation.end-requested', data: { reason, preserveTranscript: true, settleOutstanding: true } });
      c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'ending', endReason: reason, remainingMs: 0 } });
    }, { original, locale, reason, copy: locale === 'de' ? de : en });
    await until(page, expected => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return r.querySelector('form.composer').inert && r.querySelector('.composer-out__body > [data-active="true"]').textContent === expected;
    }, expected);
    const state = await inShadow(page, c => {
      const r = c.shadowRoot, link = r.querySelector('.composer-out__export');
      return { inert: r.querySelector('form.composer').inert, voiceDisabled: r.querySelector('.voice-start').disabled,
        exportVisible: link.getClientRects().length > 0 && link.getAttribute('aria-hidden') === 'false', href: link.href,
        transcript: c.session.transcript[0].content };
    });
    assert.equal(state.inert, true); assert.equal(state.voiceDisabled, true); assert.equal(state.exportVisible, true);
    const titleLines = await inShadow(page, c => {
      const title = c.shadowRoot.querySelector('.composer-out__title');
      return title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight);
    });
    assert.ok(titleLines <= 1.01, `${locale}/${reason}: title fits the existing single row at 390 px`);
    assert.ok(state.transcript.length > 0);
    assert.equal(await page.evaluate(async href => (await fetch(href)).status, state.href), 200);
    assert.equal(await overflow(page), 0);
    await assertExport(locale, '.composer-out__export');
    await assertExport(locale, '.export');
    if (locale === 'de' && reason === 'one-hour') await shot294('390-de-one-hour-light.png');
    if (process.env.AITHEMA_EVIDENCE_DIR && locale === 'de' && reason !== 'session') {
      await page.setViewport({ width: 1440, height: 1000 });
      await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
      await page.mouse.move(-1, -1);
      await inShadow(page, async c => {
        document.activeElement?.blur(); c.shadowRoot.activeElement?.blur(); await document.fonts.ready;
        await Promise.all(c.shadowRoot.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      });
      await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait-291-${locale}-light-1440-${reason}.png`), fullPage: false });
    }
  }
  // AIT-291 r2: extend this in-page matrix; no extra browser process or test file.
  for (const locale of ['de', 'en']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    let reserved;
    for (const variant of ['upgrade', 'unconfirmed', 'no-upgrade']) {
      await creditFixture(page, locale, { address: variant === 'upgrade' ? null : 'reader@example.test',
        delivery: true, confirmed: variant === 'no-upgrade',
        spent: variant === 'upgrade' ? 12_000_000 : variant === 'unconfirmed' ? 18_000_000 : 24_000_000 });
      const beforeLimit = await inShadow(page, c => {
        c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
        return ['.composer-shell', '.question-card', '.band'].map(selector => {
          const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        });
      });
      await inShadow(page, c => {
        c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
      });
      await page.mouse.move(-1, -1);
      await inShadow(page, async c => {
        document.activeElement?.blur(); c.shadowRoot.activeElement?.blur(); await document.fonts.ready;
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      });
      const geometry = await inShadow(page, c => {
        const r = c.shadowRoot, box = selector => {
          const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        };
        const upgrade = r.querySelector('.composer-out__upgrade'), link = r.querySelector('.composer-out__export');
        return { boxes: ['.composer-shell', '.question-card', '.composer-out__bar', '.composer-out__actions', '.composer-out__export', '.band', '.settings-open'].map(box),
          primary: upgrade.getAttribute('aria-hidden') === 'false', export: getComputedStyle(link).visibility,
          heights: [upgrade, link].map(n => n.getBoundingClientRect().height),
          sameRow: Math.abs(upgrade.getBoundingClientRect().y - link.getBoundingClientRect().y) < 1,
          linkStyle: getComputedStyle(upgrade).textDecorationLine,
          overlap: upgrade.getBoundingClientRect().right > link.getBoundingClientRect().left && upgrade.getBoundingClientRect().bottom > link.getBoundingClientRect().top,
          bodyClear: r.querySelector('.composer-out__body span').getBoundingClientRect().bottom <= Math.min(upgrade.getBoundingClientRect().top, link.getBoundingClientRect().top),
          textContained: r.querySelector('.composer-out__title').getBoundingClientRect().top >= r.querySelector('.composer-out').getBoundingClientRect().top && link.getBoundingClientRect().bottom <= r.querySelector('.composer-out').getBoundingClientRect().bottom,
          clip: box('.composer-out'), body: r.querySelector('.composer-out__body > [data-active="true"]').textContent };
      });
      assert.deepEqual([geometry.boxes[0], geometry.boxes[1], geometry.boxes[5]], beforeLimit, `${locale}/${width}/${variant}: 0 px on entering host-limit`);
      reserved ??= geometry.boxes;
      assert.deepEqual(geometry.boxes, reserved, `${locale}/${width}/${variant}: 0 px between host-limit variants`);
      assert.equal(geometry.primary, variant !== 'no-upgrade');
      assert.equal(geometry.export, 'visible');
      assert.equal(geometry.sameRow, true);
      assert.equal(geometry.overlap, false);
      assert.equal(geometry.bodyClear, true, 'body clears both 44 px action targets');
      assert.equal(geometry.textContained, true, 'title and action targets remain inside the surface');
      assert.equal(geometry.linkStyle, 'underline');
      assert.ok(geometry.heights.every(height => height >= 44), 'both actions retain 44 px touch targets');
      assert.equal(await overflow(page), 0);
      t.diagnostic(`PASS AIT-291 r2 ${locale}/${width}/${variant}: 0 px; primary upgrade + independent export; 44 px targets`);
      if (width === 390) {
        await assertExport(locale, '.composer-out__export');
        if (locale === 'de' && variant === 'upgrade') await shot294('390-de-host-limit-upgrade-light.png');
      }
      if (process.env.AITHEMA_EVIDENCE_DIR && locale === 'de' && width === 1440) {
        const [x, y, cropWidth, height] = geometry.clip;
        assert.ok(y >= 0 && y + height <= 1000, 'crop stays inside the viewport');
        await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait-291-r2-de-light-1440-${variant}.png`), fullPage: false,
          clip: { x, y, width: cropWidth, height } });
      }
    }
  }
  await normalComposerEvidence(page, t);
  await postRelease297(page, t, legal297);
  assert.equal(export294Checks.length, 66, 'AIT-294: every terminal, upgrade variant and overview export width');
  const export294Pass = 'AIT-294 r2 PASS: export text/icon one unwrapped unit at 320/360/390 DE/EN; all terminal reasons, host-limit upgrade variants and overview; no overflow or clipping.';
  t.diagnostic(export294Pass);
  if (evidence) await writeFile(join(evidence, 'ait294-r2-export-checks.json'), JSON.stringify({ head:evidenceCommit, passLines:[export294Pass], checks:export294Checks }, null, 2));
  // AIT-291 release evidence reuses this browser and page; unit tests own the gauge matrix.
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await page.setViewport({ width: 1440, height: 1000 });
    const catalog = await page.evaluate(async id => (await fetch(`/api/sessions/${id}/settings`)).json(), original.id);
    catalog.settings.voice = 'off'; catalog.settings.visuals = 'off';
    catalog.presets.best.defaults.voice = 'off'; catalog.presets.best.defaults.visuals = 'off';
    for (const model of catalog.presets.best.models) model.facts = { ...model.facts,
      qualification: 'unverified', germanQuality: 'unverified', free: false,
      cost: { inputMicro: null, outputMicro: null, reviewedAt: null },
      hostQualified: true, hostPriceReviewed: true, hostCountries: ['US'],
      processingLocations: ['unverified'], hostTraining: true };
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().endsWith('/settings') && request.method() === 'GET') {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) });
      } else void request.continue();
    });
    await inShadow(page, (c, { original, copy, catalog }) => {
      c.configure({ copy, session: { ...original, locale: 'de', settings: catalog.settings,
        credits: null, transcript: [], engine: { ...original.engine, voice: 'off', visuals: 'off' } }, host: { credits: true } });
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.openSettings();
    }, { original, copy: de, catalog });
    await until(page, () => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return r.querySelector('[data-gauge="quality"]').dataset.state === 'hostQualified' &&
        r.querySelector('[data-gauge="cost"]').dataset.state === 'hostPriceReviewed' &&
        r.querySelector('[data-gauge="privacy"] .gauge__value').textContent === 'USA';
    });
    await page.mouse.move(-1, -1);
    await inShadow(page, async c => {
      document.activeElement?.blur(); c.shadowRoot.activeElement?.blur(); await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    });
    await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-291-de-light-1440-gauges.png'), fullPage: false });
  }
  assert.deepEqual(problems, []);
});

// Browser-context reader: measure painted text, including wrapped lines.
function textAlignment297(c) {
  const text = selector => {
    const n = c.shadowRoot.querySelector(selector), range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter(b => b.width > 0), box = n.getBoundingClientRect();
    return { x: Math.min(...rects.map(b => b.x)), lines: new Set(rects.map(b => b.y)).size,
      right: Math.max(...rects.map(b => b.right)), boxRight: box.right, height: box.height,
      top: box.top, bottom: box.bottom, textTop: Math.min(...rects.map(b => b.top)),
      textBottom: Math.max(...rects.map(b => b.bottom)), lineHeight: parseFloat(getComputedStyle(n).lineHeight) };
  };
  return { card: text('.qtext'), title: text('.composer-out__title > span'), body: text('.composer-out__body > span') };
}

// AIT-297: reuse the terminal test's browser; exercise both action rows and real host legal links.
async function postRelease297(browserPage, t, legalHTML) {
  const checks = [], fractionalChecks = [], narrow360Checks = [], alignmentChecks = [], audits = [], footerHeights = new Map(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390, 320, 388.5]) {
    const height = width < 600 ? 844 : 1000;
    await browserPage.setViewport({ width: Math.ceil(width), height });
    await browserPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    let page = browserPage, capturePage = browserPage, frameElement;
    if (!Number.isInteger(width)) {
      // CDP viewport widths are integers. A real fractional iframe viewport
      // exercises media queries at 388.5 CSS px without rounding to 389.
      // The shipped demo forbids child frames. A separate test wrapper embeds
      // that unchanged demo, rather than disabling its CSP in the real page.
      capturePage = await browserPage.browser().newPage();
      // A 2x wrapper gives Chrome an integral physical width (777 px)
      // while preserving the exact 388.5 px media-query viewport.
      await capturePage.setViewport({ width: width * 2, height: height * 2 });
      await capturePage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
      const wrapperURL = new URL('/ait297-fractional-wrapper', browserPage.url()).href;
      await capturePage.setRequestInterception(true);
      capturePage.on('request', request => {
        if (request.url() === wrapperURL) void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html style="zoom:2"><head><title>Fractional viewport fixture</title></head><body style="margin:0"></body></html>' });
        else void request.continue();
      });
      await capturePage.goto(wrapperURL);
      const handle = await capturePage.evaluateHandle(({ width, height, appURL }) => {
        const frame = document.createElement('iframe'); frame.src = appURL;
        frame.style.cssText = `position:fixed;inset:0;border:0;z-index:99999;width:${width}px;height:${height}px`;
        document.body.append(frame); return frame;
      }, { width, height, appURL: browserPage.url() });
      frameElement = handle.asElement(); page = await frameElement.contentFrame();
      await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
      // The frame shares its parent's pointer; all DOM work stays in the frame.
      page.mouse = capturePage.mouse;
      assert.equal(await page.evaluate(() => matchMedia('(width: 388.5px)').matches), true, 'exact fractional CSS viewport');
      assert.equal(await page.evaluate(() => matchMedia('(width < 389px)').matches), true, 'fractional viewport selects the stacked range');
    }
    let reserved;
    for (const variant of ['upgrade', 'unconfirmed', 'no-upgrade']) {
      await creditFixture(page, locale, { address: variant === 'upgrade' ? null : 'reader@example.test', delivery: true, demo: true,
        confirmed: variant === 'no-upgrade', spent: variant === 'upgrade' ? 12_000_000 : variant === 'unconfirmed' ? 18_000_000 : 24_000_000 });
      const prepare = () => inShadow(page, async (c, { legalHTML, theme, labels }) => {
        c.setAttribute('theme', theme); document.documentElement.dataset.theme = theme; document.documentElement.lang = c.session.locale;
        c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
        for (const legal of c.querySelectorAll('[slot="legal"]')) legal.remove();
        c.insertAdjacentHTML('beforeend', legalHTML);
        c.querySelector('#demo-legal').setAttribute('aria-label', labels.legal);
        const { paintLicenseLabel } = await import('/demo/license-label.js');
        paintLicenseLabel(c.querySelector('#demo-license'), labels.license);
        c.querySelector('#demo-legal-source').textContent = labels.legalSource;
      }, { legalHTML, theme, labels: (locale === 'de' ? de : en).host.slots });
      await prepare();
      await settleEvidenceFrame(page);
      const stable = () => inShadow(page, c => ['.composer-shell', '.question-card', '.band', '.display-foot', '.settings-open'].map(selector => {
        const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
      }));
      const before = await stable();
      await inShadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }));
      await settleEvidenceFrame(page);
      const after = await stable(), label = `${locale}/${theme}/${width}/${variant}`;
      assert.deepEqual(after, before, `${label}: zero layout shift on host-limit entry`);
      const footerKey = `${theme}/${width}`;
      if (!footerHeights.has(footerKey)) footerHeights.set(footerKey, after[3][3]);
      assert.equal(after[3][3], footerHeights.get(footerKey), `${label}: footer height stays fixed across languages and tiers`);
      const state = await inShadow(page, c => {
        const r = c.shadowRoot, selectors = ['.composer-out__upgrade', '.composer-out__export'];
        return { boxes: selectors.map(selector => {
          const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        }), lines: selectors.map(selector => {
          const n = r.querySelector(selector), text = n.querySelector('[aria-hidden="false"]') ?? n.querySelector('span');
          const range = document.createRange(); range.selectNodeContents(text);
          return new Set([...range.getClientRects()].filter(b => b.width > 0).map(b => b.y)).size;
        }), bodyBox: (() => { const n = r.querySelector('.composer-out__body span'), b = n.getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, bottom:b.bottom, height:b.height, font:getComputedStyle(n).font }; })(), upgradeVisible: r.querySelector('.composer-out__upgrade').getAttribute('aria-hidden') === 'false', bodyClear: r.querySelector('.composer-out__body span').getBoundingClientRect().bottom <= Math.min(...selectors.map(selector => r.querySelector(selector).getBoundingClientRect().top)),
        overlap: (() => { const [a, b] = selectors.map(selector => r.querySelector(selector).getBoundingClientRect());
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; })(),
        licenceLines: (() => {
          const range = document.createRange(); range.selectNodeContents(c.querySelector('#demo-license .demo-license-id'));
          return new Set([...range.getClientRects()].map(b => b.y)).size;
        })(), legal: [...c.querySelectorAll('#demo-legal a')].map(n => {
          const b = n.getBoundingClientRect(); return { left:b.left, top:b.top, right:b.right, bottom:b.bottom, width: b.width, height: b.height, visible: n.checkVisibility({ visibilityProperty: true }), clipped: n.scrollWidth > n.clientWidth || n.scrollHeight > n.clientHeight };
        }), preset: (() => { const b = r.querySelector('.engine-info').getBoundingClientRect(); return { left:b.left, top:b.top, right:b.right, bottom:b.bottom, width:b.width }; })() };
      });
      state.textAlignment = await inShadow(page, textAlignment297);
      if (width < 600) for (const name of ['title', 'body']) assert.ok(Math.abs(state.textAlignment[name].x - state.textAlignment.card.x) <= 1,
        `${label}: ${name} aligns with the card text (±1 px)`);
      if (width < 389) {
        const { title, body } = state.textAlignment;
        t.diagnostic(`AIT-297 reserved title ${label}: ${JSON.stringify(title)}`);
        assert.ok(title.lines >= 1 && title.lines <= 2, `${label}: title occupies at most two lines`);
        assert.ok(Math.abs(title.height - 2 * title.lineHeight) <= .1, `${label}: title reserves exactly two line boxes`);
        assert.ok(title.textTop >= title.top && title.textBottom <= title.bottom, `${label}: title text fits inside the reserved block`);
        assert.ok(title.bottom <= body.top, `${label}: reserved title clears the body`);
        assert.ok(title.right <= title.boxRight + 1, `${label}: title stays inside its inline padding at 320`);
      }
      reserved ??= state.boxes;
      assert.deepEqual(state.boxes, reserved, `${label}: action targets stay in place across tier receipts`);
      assert.deepEqual(state.lines, [1, 1], `${label}: both action labels occupy one line`);
      assert.equal(state.upgradeVisible, variant !== 'no-upgrade', `${label}: fixture renders the requested tier action`);
      if (!state.bodyClear) t.diagnostic(`${label}: clearance geometry ${JSON.stringify(state)}`);
      assert.equal(state.bodyClear, true, `${label}: body clears both actions`);
      if (width < 389) assert.ok(state.legal.every(n => n.top >= Math.max(...state.boxes.map(([, y, , h]) => y + h))), `${label}: stacked action targets clear legal targets`);
      assert.equal(state.overlap, false, `${label}: action targets do not overlap`);
      assert.equal(state.licenceLines, 1, `${label}: AGPL-3.0-only stays unbroken`);
      assert.ok(state.legal.every(n => !n.clipped && n.left >= 0 && n.right <= width && n.top >= 0 && n.bottom <= height), `${label}: legal targets stay unclipped in the viewport`);
      assert.ok(state.legal.every(n => n.width >= 44 && n.height >= 44), `${label}: legal targets retain 44 px for touch too`);
      for (const [x, y, w, h] of state.boxes) { assert.ok(x >= 0 && x + w <= width && y >= 0 && y + h <= height, `${label}: action is in viewport`); assert.ok(h >= 44); }
      assert.equal(state.legal.length, 2);
      assert.equal(state.preset.width, 44, `${label}: preset target cannot shrink`);
      assert.ok(state.legal.every(n => n.left >= state.preset.right), `${label}: legal links clear the preset target`);
      assert.ok(state.legal.every(n => n.visible && n.width >= 24 && n.height >= 24), `${label}: legal target size`);
      assert.equal(await overflow(page), 0, `${label}: no horizontal overflow`);
      if (variant === 'upgrade' && width < 600) {
        alignmentChecks.push({ locale, theme, width, ...state.textAlignment });
        t.diagnostic(`AIT-297 alignment ${label}: ${JSON.stringify(state.textAlignment)}`);
      }
      (Number.isInteger(width) ? checks : fractionalChecks).push({ head: evidenceCommit, locale, theme, width, variant, shift: 0, ...state });
      if (evidence && ['upgrade', 'no-upgrade'].includes(variant)) {
        await mkdir(evidence, { recursive: true });
        await settleEvidenceFrame(page);
        await capturePage.screenshot({ path: join(evidence, `ait-297-${locale}-${theme}-${width}-host-limit-${variant === 'upgrade' ? 'legal' : 'no-upgrade'}.png`), fullPage: false, captureBeyondViewport: false });
        if (variant === 'no-upgrade' && theme === 'dark' && width === 320) {
          const clip = await inShadow(page, c => {
            const card = c.shadowRoot.querySelector('.qcard').getBoundingClientRect(), out = c.shadowRoot.querySelector('.composer-out').getBoundingClientRect();
            return { x: card.x, y: card.y, width: card.width, height: out.bottom - card.y };
          });
          await settleEvidenceFrame(page);
          await capturePage.screenshot({ path: join(evidence, `ait-297-${locale}-dark-320-host-limit-crop.png`), clip, captureBeyondViewport: false });
        }
        // Axe is explicit remote evidence only; never add audits to CI workloads.
        if (a11yEvidenceMode) {
          if (!await page.evaluate(() => typeof window.axe === 'object')) await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
          const audit = await page.evaluate(async () => {
            const result = await axe.run(document, { iframes: false, runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
            return { version: result.testEngine.version, violations: result.violations.map(rule => ({ id: rule.id, impact: rule.impact, targets: rule.nodes.map(n => n.target) })) };
          });
          audits.push({ head: evidenceCommit, locale, theme, width, ...audit });
          assert.deepEqual(audit.violations.filter(rule => ['serious', 'critical'].includes(rule.impact)), [], `${label}: axe serious/critical findings`);
        }
      }
      if (width === 390) {
        // Reuse the page and fixture for 360px entry checks without extending
        // the original cross-language footer invariant to this extra width.
        await browserPage.setViewport({ width: 360, height });
        await creditFixture(page, locale, { address: variant === 'upgrade' ? null : 'reader@example.test', delivery: true, demo: true,
          confirmed: variant === 'no-upgrade', spent: variant === 'upgrade' ? 12_000_000 : variant === 'unconfirmed' ? 18_000_000 : 24_000_000 });
        await prepare();
        await settleEvidenceFrame(page);
        const before = await stable();
        await inShadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }));
        await settleEvidenceFrame(page);
        const after = await stable(), label = `${locale}/${theme}/360/${variant}`;
        assert.deepEqual(after, before, `${label}: zero layout shift on host-limit entry`);
        const alignment = await inShadow(page, textAlignment297), { title, body } = alignment;
        for (const name of ['title', 'body']) assert.ok(Math.abs(alignment[name].x - alignment.card.x) <= 1, `${label}: ${name} aligns with the card text (±1 px)`);
        assert.ok(title.right <= title.boxRight + 1, `${label}: title stays inside its inline padding`);
        assert.ok(Math.abs(title.height - 2 * title.lineHeight) <= .1, `${label}: title reserves exactly two line boxes`);
        assert.ok(title.lines >= 1 && title.lines <= 2 && title.textTop >= title.top && title.textBottom <= title.bottom, `${label}: title text fits inside the reserved block`);
        assert.ok(title.bottom <= body.top, `${label}: reserved title clears the body`);
        const { actionsTop, actionsBottom, legalTop } = await inShadow(page, c => {
          const boxes = ['.composer-out__upgrade', '.composer-out__export'].map(selector => c.shadowRoot.querySelector(selector).getBoundingClientRect());
          return { actionsTop: Math.min(...boxes.map(b => b.top)), actionsBottom: Math.max(...boxes.map(b => b.bottom)),
            legalTop: Math.min(...[...c.querySelectorAll('#demo-legal a')].map(n => n.getBoundingClientRect().top)) };
        });
        t.diagnostic(`AIT-297 360 geometry ${label}: ${JSON.stringify({ before, after, title, body, actionsTop })}`);
        assert.ok(body.bottom <= actionsTop, `${label}: body clears both actions`);
        assert.ok(actionsBottom <= legalTop, `${label}: stacked action targets clear legal targets`);
        narrow360Checks.push({ head: evidenceCommit, locale, theme, width: 360, variant, shift: 0, textAlignment: alignment, actionsTop, actionsBottom, legalTop });
        if (variant === 'upgrade') {
          alignmentChecks.push({ locale, theme, width: 360, ...alignment });
          t.diagnostic(`AIT-297 alignment ${label}: ${JSON.stringify(alignment)}`);
        }
        if (evidence && ['upgrade', 'no-upgrade'].includes(variant)) {
          await settleEvidenceFrame(page);
          await browserPage.screenshot({ path: join(evidence, `ait-297-${locale}-${theme}-360-host-limit-${variant === 'upgrade' ? 'legal' : 'no-upgrade'}.png`), fullPage: false, captureBeyondViewport: false });
        }
        if (evidence && locale === 'en' && theme === 'light' && variant === 'no-upgrade') {
          const clip = await inShadow(page, c => {
            const card = c.shadowRoot.querySelector('.qcard').getBoundingClientRect(), out = c.shadowRoot.querySelector('.composer-out').getBoundingClientRect();
            return { x: card.x, y: card.y, width: card.width, height: out.bottom - card.y };
          });
          await settleEvidenceFrame(page);
          await browserPage.screenshot({ path: join(evidence, 'ait-297-en-light-360-host-limit-crop.png'), clip, captureBeyondViewport: false });
        }
        await browserPage.setViewport({ width, height });
        await settleEvidenceFrame(page);
      }
    }
    if (frameElement) await capturePage.close();
  }
  assert.equal(checks.length, 48);
  assert.equal(fractionalChecks.length, 12);
  t.diagnostic('AIT-297 PASS: DE/EN light/dark 1440/1024/390/360/320/388.5; clear single-line actions, zero layout shift, unbroken licence, legal targets >=44px.');
  if (evidence) await writeFile(join(evidence, 'ait-297-host-limit-checks.json'), JSON.stringify({ head: evidenceCommit, checks, fractionalChecks, narrow360Checks, alignmentChecks, audits }, null, 2));
  assert.equal(narrow360Checks.length, 12);
  assert.equal(alignmentChecks.length, 16);
  for (const { locale, theme, width, card, title, body } of alignmentChecks) {
    for (const [name, text] of Object.entries({ title, body })) assert.ok(Math.abs(text.x - card.x) <= 1,
      `${locale}/${theme}/${width}: host-limit ${name} x=${text.x} equals card text x=${card.x} (±1 px)`);
    if (width === 320) {
      assert.ok(title.lines <= 2, `${locale}/${theme}/320: title fits its reserved two lines`);
      assert.ok(title.right <= title.boxRight + 1, `${locale}/${theme}/320: title stays inside its inline padding`);
    }
  }
}

// AIT-376: reuse one browser and page for the deadline matrix. All consent I/O
// is deferred in-page; the real page, legal document, CSS and action wiring run.
test('AIT-376: consent deadline viewport matrix, focus, announcements and zero movement', { timeout: 90_000 }, async t => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const head = eventPath ? JSON.parse(await readFile(eventPath, 'utf8')).pull_request?.head.sha ?? evidenceCommit : evidenceCommit;
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-deadlines-'));
  const demo = await startDemo(directory); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); } });
  browser = await launch(directory, 'consent-deadlines');
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], primaryChecks = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/demo/consent.js') void request.respond({ status: 200, contentType: 'text/javascript', body: '' });
    else void request.continue();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const matrix = [
    { width: 1440, theme: 'light', locale: 'de' }, { width: 1440, theme: 'light', locale: 'en' },
    { width: 390, theme: 'light', locale: 'de' }, { width: 390, theme: 'light', locale: 'en' },
    { width: 1440, theme: 'dark', locale: 'de' },
  ];
  for (const variant of matrix) {
    const { width, theme, locale } = variant, label = `${width}/${theme}/${locale}`;
    await page.setViewport({ width, height: width === 390 ? 1000 : 900 });
    await page.goto(`${demo.url}/consent/?session=deadline&return=%2F%3Fsaved%3D1`, { waitUntil: 'networkidle0' });
    await page.evaluate(async ({ theme, locale, contract, voicePresentation }) => {
      localStorage.setItem('aithema-demo-locale', locale); localStorage.setItem('aithema-theme', theme);
      const [{ mountConsentPage }, { withDemoConsentCopy }, language] = await Promise.all([
        import('/demo/consent-page.js'), import('/demo/consent-copy.js'), import(`/packages/ui/src/i18n/${locale}.js`),
      ]);
      let now = 0, sequence = 0;
      document.documentElement.style.setProperty('--ui', 'ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif');
      const timers = new Map(), flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
      const f = window.consentDeadline = { stallGet: true, posts: [], gets: [], returns: [], lateGets: [], selected: ['voice-elevenlabs'],
        copy: withDemoConsentCopy(language[locale]).host.consentPage, announcements: [], contract, flush };
      const status = document.querySelector('#consent-status');
      new MutationObserver(records => {
        for (const record of records) if (record.target === document.querySelector('#status-text')) f.announcements.push({ state: status.dataset.state, text: record.target.textContent });
      }).observe(status, { childList: true, subtree: true });
      f.advance = async ms => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } await flush(); };
      const clock = { setTimeout(fn, delay) { const key = ++sequence; timers.set(key, { fn, at: now + delay }); return key; }, clearTimeout(key) { timers.delete(key); } };
      f.mounting = mountConsentPage({ clock, navigate: path => f.returns.push(path), fetchImpl: async (path, options) => {
        f.gets.push({ path, signal: options.signal });
        if (path === '/demo/config') return Response.json({ processingConsent: contract, voiceMode: 'off', voicePresentation });
        if (path === '/api/sessions/deadline') return Response.json({ id: 'deadline', locale, engine: {}, consentRevision: 1, consentWithdrawn: false });
        if (f.stallGet) { const answer = Promise.withResolvers(); f.lateGets.push(answer); return answer.promise; }
        return Response.json({ ...contract, selected: f.selected });
      }, submit: (path, body, options) => {
        const answer = Promise.withResolvers(); f.posts.push({ body, signal: options.signal, ...answer }); return answer.promise;
      } });
      await flush();
    }, { ...variant, contract: { contract: 'deadline-v1', items: CONSENT_ITEMS, intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL }, voicePresentation: consentVoiceManifest.presentation });
    const snapshot = () => page.evaluate(() => {
      const f = window.consentDeadline, status = document.querySelector('#consent-status'), text = document.querySelector('#status-text'), action = document.querySelector('#retry');
      const selectors = ['#consent-status', '#status-text', '#retry', ...['top', 'bottom'].flatMap(position => ['[data-back]', '[data-revoke]', '[data-select-all]', '[data-grant]'].map(selector => `.consent-actions--${position} ${selector}`))];
      const range = document.createRange(); range.selectNodeContents(text);
      const rects = [...range.getClientRects()].filter(r => r.width > 0), lines = new Set(rects.map(r => r.y)).size;
      const actionRect = action.getBoundingClientRect();
      return { state: status.dataset.state, text: text.textContent, copy: f.copy, action: action.textContent, focused: document.activeElement?.id, theme: document.documentElement.dataset.theme,
        actionVisible: actionRect.top >= 0 && actionRect.bottom <= innerHeight,
        polite: status.getAttribute('aria-live'), role: status.getAttribute('role'), checked: document.querySelectorAll('input:checked').length,
        grantDisabled: document.querySelector('[data-grant]').disabled, revokeDisabled: document.querySelector('[data-revoke]').disabled,
        fieldsDisabled: document.querySelector('fieldset').disabled, boxes: selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; }),
        lines, textFits: text.scrollHeight <= text.clientHeight && rects.every(r => r.right <= text.getBoundingClientRect().right + .01),
        announcements: f.announcements, posts: f.posts.map(p => ({ body: p.body, aborted: p.signal.aborted })), returns: f.returns };
    });
    const shot = async state => {
      if (!evidence || theme === 'dark' && !['C3', 'C4'].includes(state)) return;
      await page.evaluate(async () => { document.activeElement?.blur(); window.scrollTo(0, 0); await document.fonts.ready; await Promise.all(document.getAnimations().map(a => a.finished)); });
      await page.mouse.move(-10, -10);
      await settleEvidenceFrame(page);
      await page.screenshot({ path: join(evidence, `ait375a-${width}-${theme}-${locale}-${state}.png`), fullPage: false, captureBeyondViewport: false });
    };
    const validate = async (state, message, focus = false) => {
      const s = await snapshot(); assert.equal(s.state, state, label); assert.equal(s.text, s.copy[message], label);
      assert.equal(s.polite, 'polite'); assert.equal(s.role, 'status'); assert.equal(s.theme, theme);
      if (focus) {
        assert.equal(s.focused, 'retry', `${label}: focus goes to recovery action`);
        assert.equal(s.actionVisible, true, `${label}: focused recovery action is visible`);
      }
      assert.ok(s.lines <= (width === 390 ? 2 : 1), `${label}/${state}: reserved text rows (${s.lines})`);
      assert.equal(s.textFits, true, `${label}/${state}: all copy fits`);
      assert.equal(s.announcements.filter(a => a.state === state).at(-1)?.text, s.text);
      return s;
    };
    const stable = (before, after, journey) => {
      // Text ink may use fewer lines; its reserved element and every button stay fixed.
      assert.deepEqual(after.boxes, before.boxes, `${label}/${journey}: movementPx 0`);
      checks.push({ ...variant, journey, movementPx: 0 });
    };
    const disabledPrimary = async state => {
      const result = await page.evaluate(() => {
        const grants = [...document.querySelectorAll('[data-grant]')];
        const geometry = () => [...document.querySelectorAll('.consent-page, .consent-page *')].map(n => {
          const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
        });
        const current = geometry();
        // Remove only the new paint rule to compare with the unchanged base layout.
        const sheet = [...document.styleSheets].find(s => s.href?.endsWith('/demo/host.css'));
        const index = [...sheet.cssRules].findIndex(r => r.selectorText === '.consent-actions [data-grant]:disabled');
        const rule = index < 0 ? null : sheet.cssRules[index].cssText;
        if (rule) sheet.deleteRule(index);
        const base = geometry();
        if (rule) sheet.insertRule(rule, index);
        const secondary = getComputedStyle(document.querySelector('[data-select-all]'));
        return { current, base, secondarySurface: secondary.backgroundColor, labels: grants.map(n => n.textContent),
          buttons: grants.map(n => { const s = getComputedStyle(n); return { disabled: n.disabled,
            image: s.backgroundImage, surface: s.backgroundColor, text: s.color }; }) };
      });
      assert.deepEqual(result.current, result.base, `${label}/${state}: AIT-387 changes paint by 0 px`);
      for (const button of result.buttons) {
        assert.equal(button.disabled, true);
        assert.equal(button.image, 'none', `${label}/${state}: disabled primary drops the brand fill`);
        assert.equal(button.surface, result.secondarySurface);
        assert.equal(button.text, theme === 'light' ? 'rgb(73, 100, 119)' : 'rgb(157, 180, 196)');
      }
      primaryChecks.push({ ...variant, state, ...result, movementPx: 0 });
    };
    await page.evaluate(() => document.fonts.ready);
    const loading = await validate('loading', 'loading'); await shot('C1');
    await disabledPrimary('loading');
    await page.evaluate(() => consentDeadline.advance(7999)); assert.equal((await snapshot()).state, 'loading');
    await page.evaluate(() => consentDeadline.advance(1));
    const timedOut = await validate('load-timeout', 'loadTimeout', true);
    assert.equal(timedOut.checked, 0); assert.equal(timedOut.fieldsDisabled, true); assert.equal(timedOut.revokeDisabled, true);
    stable(loading, timedOut, 'C1-C3'); await shot('C3');
    await disabledPrimary('load-timeout');
    await page.evaluate(async () => { const f = consentDeadline; f.lateGets[0].resolve(Response.json({ ...f.contract, selected: f.contract.items.map(i => i.id) })); await f.flush(); });
    const lateLoad = await snapshot(); assert.equal(lateLoad.state, timedOut.state); assert.equal(lateLoad.text, timedOut.text); assert.equal(lateLoad.checked, 0);
    await page.evaluate(async () => { document.querySelector('#retry').click(); await consentDeadline.flush(); });
    const retried = await validate('loading', 'loading'); stable(loading, retried, 'C3-C1');
    await page.evaluate(async () => { const f = consentDeadline; f.stallGet = false; f.lateGets.at(-1).resolve(Response.json({ ...f.contract, selected: f.selected })); await f.flush(); f.api = await f.mounting; });
    // mount returns after its original timeout; the retried load settles separately.
    await page.waitForFunction(() => document.querySelector('#consent-status').dataset.state === 'ready');
    await page.evaluate(async () => { document.querySelector('[data-select-all]').click(); const bottom = document.querySelector('.consent-actions--bottom [data-grant]'); bottom.scrollIntoView({ block: 'center', behavior: 'instant' }); bottom.focus({ preventScroll: true }); bottom.click(); await consentDeadline.flush(); });
    const saving = await validate('saving', 'saving'); assert.equal(saving.revokeDisabled, false); stable(loading, saving, 'C1-C2');
    await page.evaluate(() => consentDeadline.advance(9999)); assert.equal((await snapshot()).state, 'saving');
    await page.evaluate(() => consentDeadline.advance(1));
    const unknown = await validate('save-unconfirmed', 'saveUnconfirmed', true);
    assert.equal(unknown.action, unknown.copy.loadCurrent); assert.equal(unknown.posts[0].aborted, true); assert.equal(unknown.grantDisabled, true);
    stable(saving, unknown, 'C2-C4'); await shot('C4');
    await disabledPrimary('save-unconfirmed');
    await page.evaluate(async () => { consentDeadline.posts[0].resolve(Response.json({ granted: true })); await consentDeadline.flush(); });
    const late = await snapshot(); assert.equal(late.state, unknown.state); assert.equal(late.text, unknown.text); assert.deepEqual(late.returns, []);
    await page.evaluate(async () => { document.querySelector('#retry').click(); await consentDeadline.flush(); });
    await page.waitForFunction(() => document.querySelector('#consent-status').dataset.state === 'ready');
    const different = await validate('ready', 'notSavedYet');
    assert.equal(different.grantDisabled, false); assert.equal(different.fieldsDisabled, false); assert.equal(different.posts.length, 1); stable(saving, different, 'C4-reread-different');
    // The matching GET is authoritative and returns without another POST.
    await page.evaluate(async () => { document.querySelector('[data-select-all]').click(); document.querySelector('[data-grant]').click(); await consentDeadline.flush(); await consentDeadline.advance(10000); consentDeadline.selected = consentDeadline.contract.items.map(i => i.id); document.querySelector('#retry').click(); await consentDeadline.flush(); });
    await page.waitForFunction(() => consentDeadline.returns.length === 1);
    assert.deepEqual((await snapshot()).returns, ['/?saved=1']); assert.equal((await snapshot()).posts.length, 2);
    await page.evaluate(async () => { const f = consentDeadline; f.returns.length = 0; await f.api.load(); document.querySelector('[data-grant]').click(); await f.flush(); });
    assert.equal((await snapshot()).revokeDisabled, false); await shot('C5');
    await page.evaluate(async () => { const bottom = document.querySelector('.consent-actions--bottom [data-revoke]'); bottom.scrollIntoView({ block: 'center', behavior: 'instant' }); bottom.focus({ preventScroll: true }); bottom.click(); await consentDeadline.flush(); });
    const withdrawal = await snapshot(); stable(saving, withdrawal, 'C2-C5'); assert.equal(withdrawal.posts[2].aborted, true); assert.equal(withdrawal.posts[3].body.granted, false); assert.deepEqual(withdrawal.posts[3].body.processing.items, []);
    await page.evaluate(() => consentDeadline.advance(10000));
    const withdrawn = await validate('withdraw-unconfirmed', 'withdrawUnconfirmed', true); stable(saving, withdrawn, 'C5-timeout'); await shot('C5-timeout');
    await disabledPrimary('withdraw-unconfirmed');
    await page.evaluate(async () => { document.querySelector('#retry').click(); await consentDeadline.flush(); });
    const repeated = await snapshot(); assert.deepEqual(repeated.posts[4].body, repeated.posts[3].body);
    // One DOM text mutation per state entry, including repeated entries.
    const entries = await page.evaluate(() => consentDeadline.announcements);
    for (let i = 1; i < entries.length; i++) assert.notDeepEqual(entries[i], entries[i - 1], `${label}: no duplicate announcement`);
    assert.deepEqual(Object.fromEntries(['loading', 'ready', 'saving', 'load-timeout', 'save-unconfirmed', 'withdraw-unconfirmed'].map(state => [state, entries.filter(e => e.state === state).length])),
      { loading: 4, ready: 3, saving: 4, 'load-timeout': 1, 'save-unconfirmed': 2, 'withdraw-unconfirmed': 1 }, `${label}: one text mutation per entered state`);
    checks.push({ ...variant, loadDeadlineMs: 8000, saveDeadlineMs: 10000, withdrawDeadlineMs: 10000, focusTarget: '#retry',
      focusVisible: [timedOut, unknown, withdrawn].every(s => s.actionVisible), liveRegion: 'polite', liveRegionText: { C3: timedOut.text, C4: unknown.text, C5: withdrawn.text }, announcements: entries,
      announcesOncePerState: true, lateAnswerIgnored: true, lateLoadIgnored: true, lateSaveIgnored: true, rereadMatchNavigates: true, rereadMismatchEditable: true, noBlindRepost: true,
      withdrawalAbortsSave: true, withdrawalReceived: true, withdrawalRetryIdempotent: true, noCheckedBoxesAfterLoadTimeout: true,
      targets44px: [...timedOut.boxes.slice(2), ...unknown.boxes.slice(2)].every(r => r[2] >= 44 && r[3] >= 44), movementPx: 0 });
    assert.equal(checks.at(-1).targets44px, true);
    if (theme === 'light' && (width === 390 || locale === 'de')) {
      // Paired evidence fixture: actual primary controls, same label and host CSS.
      const pair = await page.evaluate(async label => {
        const row = document.createElement('div'); row.className = 'consent-actions';
        for (const disabled of [true, false]) {
          const button = document.querySelector('[data-grant]').cloneNode(true);
          button.textContent = label; button.disabled = disabled; row.append(button);
        }
        document.querySelector('.consent-page article').replaceChildren(row);
        document.activeElement?.blur(); scrollTo(0, 0); await document.fonts.ready;
        await Promise.all(document.getAnimations().map(a => a.finished));
        return [...row.children].map(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n);
          return { label: n.textContent, disabled: n.disabled, image: s.backgroundImage, surface: s.backgroundColor,
            text: s.color, box: [r.x, r.y, r.width, r.height], visible: r.top >= 0 && r.bottom <= innerHeight }; });
      }, primaryChecks.find(c => c.width === width && c.locale === locale && c.theme === theme && c.state === 'loading').labels[0]);
      assert.deepEqual(pair.map(p => p.disabled), [true, false]);
      assert.ok(pair.every(p => p.visible));
      assert.equal(pair[0].label, pair[1].label);
      assert.equal(pair[0].image, 'none'); assert.match(pair[1].image, /^linear-gradient/u);
      await page.mouse.move(-10, -10); await settleEvidenceFrame(page);
      const blurred = await page.evaluate(() => !document.activeElement?.matches('button, input, select, textarea, a[href]'));
      assert.equal(blurred, true);
      const filename = `ait387-${width}-light-${locale}-disabled-enabled.png`;
      if (evidence) await page.screenshot({ path: join(evidence, filename), fullPage: false, captureBeyondViewport: false });
      primaryChecks.push({ ...variant, state: 'paired comparison fixture', filename, pair, blurred, settled: true, viewportOnly: true });
    }
  }
  if (evidence) await writeFile(join(evidence, 'ait375a-checks.json'), JSON.stringify({ commit: evidenceCommit, spec: 'AIT-376 Tick v1', checks }, null, 2));
  if (evidence) {
    const dir = join(evidence, 'ait387'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'checks.json'), JSON.stringify({ head, commit: evidenceCommit, spec: 'AIT-387 Tick v1', checks: primaryChecks }, null, 2));
  }
});


// Probe every actual status string, including legacy errors, with the page's
// real typography. Legacy screenshots are reached through the mounted page.
test('AIT-376 round 2: every DE/EN status fits at 390, including stale failed and missing', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-fit-'));
  const demo = await startDemo(directory); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); } });
  browser = await launch(directory, 'consent-fit'); const page = await browser.newPage();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.setViewport({ width: 390, height: 1000 }); await page.setRequestInterception(true);
  page.on('request', request => { if (new URL(request.url()).pathname === '/demo/consent.js') void request.respond({ status: 200, contentType: 'text/javascript', body: '' }); else void request.continue(); });
  for (const locale of ['de', 'en']) {
    await page.goto(`${demo.url}/consent/?session=fit`, { waitUntil: 'networkidle0' });
    await page.evaluate(async ({ locale, items }) => {
      localStorage.setItem('aithema-demo-locale', locale); localStorage.setItem('aithema-theme', 'light');
      const [{ mountConsentPage }, { withDemoConsentCopy }, language] = await Promise.all([import('/demo/consent-page.js'), import('/demo/consent-copy.js'), import(`/packages/ui/src/i18n/${locale}.js`)]);
      const copy = withDemoConsentCopy(language[locale]), f = window.consentFit = { copy, mode: 'ready' };
      f.api = await mountConsentPage({ navigate: () => {}, fetchImpl: async path => {
        if (path === '/demo/config') return Response.json({ processingConsent: { contract: 'v1', items } });
        if (path === '/api/sessions/fit') return Response.json({ id: 'fit', locale, engine: {}, consentRevision: 1 });
        if (f.mode === 'failed') throw new Error('Fixture failed read');
        if (f.mode === 'missing') return new Response(null, { status: 404 });
        return Response.json({ contract: f.mode === 'stale' ? 'v2' : 'v1', items, selected: [], consentRevision: 1 });
      }, submit: async () => Response.json({ error: 'host-consent-required' }, { status: 409 }) });
    }, { locale, items: CONSENT_ITEMS });
    const fit = async name => {
      const result = await page.evaluate(() => {
        const text = document.querySelector('#status-text'), retry = document.querySelector('#retry'), range = document.createRange(); range.selectNodeContents(text);
        const bounds = text.getBoundingClientRect(), action = retry.getBoundingClientRect(), ink = [...range.getClientRects()].filter(r => r.width);
        return { text: text.textContent, fits: ink.every(r => r.left >= bounds.left && r.right <= bounds.right + .01 && r.bottom <= bounds.bottom + .01 && r.bottom <= action.top), lines: new Set(ink.map(r => r.y)).size };
      });
      assert.equal(result.fits, true, `${locale}/${name}: text stays inside its slot above the action row`);
      checks.push({ locale, width: 390, state: name, ...result });
    };
    for (const state of ['stale', 'failed', 'missing']) {
      await page.evaluate(async state => { const f = consentFit; f.mode = 'ready'; await f.api.load(); f.mode = state;
        if (state === 'stale') { document.querySelector('[data-select-all]').click(); await f.api.save(); } else await f.api.load();
      }, state);
      assert.equal(await page.$eval('#consent-status', node => node.dataset.state), state);
      await fit(state);
      if (evidence) {
        await page.evaluate(async () => { document.activeElement?.blur(); scrollTo(0, 0); await document.fonts.ready; await Promise.all(document.getAnimations().map(a => a.finished)); });
        await page.mouse.move(-10, -10); await settleEvidenceFrame(page);
        await page.screenshot({ path: join(evidence, `ait375a-390-light-${locale}-${state}.png`), fullPage: false, captureBeyondViewport: false });
      }
    }
    const names = await page.evaluate(() => {
      const h = consentFit.copy.host, c = h.consentPage;
      consentFit.messages = { loading: c.loading, saving: c.saving, loadTimeout: c.loadTimeout, saveUnconfirmed: c.saveUnconfirmed, notSavedYet: c.notSavedYet,
        withdrawUnconfirmed: c.withdrawUnconfirmed, stale: c.stale, failed: h.consentFailed, missing: c.missing, withdrawn: h.consentWithdrawn,
        processingSaved: h.processingSaved, allowed: h.consentAllowed, processingWaiting: h.processingWaiting, required: h.consentRequired, unavailable: '' };
      return Object.keys(consentFit.messages);
    });
    for (const name of names) { await page.$eval('#status-text', (node, name) => { node.textContent = consentFit.messages[name]; }, name); await fit(name); }
  }
  if (evidence) await writeFile(join(evidence, 'ait375a-fit-checks.json'), JSON.stringify({ commit: evidenceCommit, checks }, null, 2));
});

// Reuse this existing shard/file and one page for the complete AIT-395 matrix.
import { sessionCreditsCheck } from './session-credits-check.js';
test('AIT-395: session credit matrix, sibling frame sampling and zero movement', { timeout: 90_000 }, sessionCreditsCheck);

test('AIT-433: handover notice and reserved states fit without movement at narrow widths', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-handover-fit-'));
  const demo = await startDemo(directory); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); } });
  browser = await launch(directory, 'handover-fit'); const page = await browser.newPage();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], failures = [], problems = [];
  await preparePage(page, ['de'], problems);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await inShadow(page, c => {
    window.ait433 = { seed: structuredClone(c.session) };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path.endsWith('/handover')) return Response.json({ offer: { available: true }, handover: { status: 'idle' } });
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        if (init.signal?.aborted) controller.close();
        else init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path === `/api/sessions/${c.session.id}`) return Response.json(c.session);
      return nativeFetch(url, init);
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const width of [390, 640, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    const expected = await inShadow(page, async (c, locale) => {
      const { [locale]: bundle } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const copy = { ...bundle, hostSurface: { ...bundle.hostSurface, handover: { ...bundle.hostSurface.handover, ...bundle.host.handover } } };
      const session = structuredClone(window.ait433.seed);
      session.locale = locale; session.demo = true; session.paused = false; session.settings.origin = 'chosen';
      session.transcript = [{ id: 'ait433-input', role: 'user', content: locale === 'de' ? 'Wir brauchen eine App.' : 'We need an app.' }];
      session.understanding = { ...session.understanding, summary: session.transcript[0].content, readinessAssessed: true };
      session.handover = { status: 'idle' };
      c.setAttribute('motion', 'off'); c.setAttribute('theme', 'light');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; document.documentElement.dataset.theme = 'light';
      c.configure({ session, copy, host: { handover: true } });
      c.querySelector('[slot="handover-offer"]').textContent = bundle.host.slots.handoverOffer;
      return { notice: bundle.host.slots.handoverOffer, sent: copy.hostSurface.handover.sent, error: copy.hostSurface.handover.failed };
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.handover-request').getAttribute('aria-disabled') === 'false');
    await inShadow(page, c => c.shadowRoot.querySelector('.handover').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await settleEvidenceFrame(page);
    let baseline;
    for (const state of ['idle', 'sent', 'error']) {
      if (state !== 'idle') await inShadow(page, async (c, state) => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        c.receive({ seq: c.session.seq + 1, type: 'handover.state', data: { status: state === 'error' ? 'failed' : state, revision: inputRevision(c.session) } });
      }, state);
      await settleEvidenceFrame(page);
      const metric = await inShadow(page, c => {
        const root = c.shadowRoot, rect = n => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
        const measure = selector => {
          const n = root.querySelector(selector), css = getComputedStyle(n), range = document.createRange(); range.selectNodeContents(n);
          const slot = n.querySelector('slot'), assigned = slot?.assignedNodes({ flatten: true });
          const pane = root.querySelector('.analysis-content'), viewport = pane.getBoundingClientRect();
          const lines = (assigned?.length ? assigned : [n]).flatMap(node => {
            range.selectNodeContents(node); return [...range.getClientRects()].filter(r => r.width > 0);
          });
          return { ...rect(n), text: assigned?.length ? assigned.map(n => n.textContent).join('') : n.textContent, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
            scrollWidth: n.scrollWidth, clientWidth: n.clientWidth, maxHeight: css.maxHeight, clamp: css.webkitLineClamp,
            textAlign: css.textAlign, lines: new Set(lines.map(r => r.y)).size,
            inkInsidePane: lines.every(r => r.left >= viewport.left + pane.clientLeft && r.right <= viewport.left + pane.clientLeft + pane.clientWidth) };
        };
        // Before AIT-433 the divider stretched across this same overview grid track.
        // Measure the content column, not the padded scrollport that can hide an outset.
        return { overview: rect(root.querySelector('.analysis-content > .notice')),
          block: rect(root.querySelector('.handover')), row: rect(root.querySelector('.handover__row')),
          heading: rect(root.querySelector('.handover h3')), action: rect(root.querySelector('.handover-request')),
          notice: measure('.handover__offer'), state: measure('.handover__state') };
      });
      baseline ??= metric;
      const label = `${locale}/${width}/${state}`, require = (ok, message) => { if (!ok) failures.push(`${label}: ${message}`); };
      const beside = metric.state.x >= metric.action.x + metric.action.width;
      for (const name of ['heading', 'notice', 'action', ...(!beside ? ['state'] : [])]) {
        require(Math.abs(metric[name].x - metric.overview.x) <= .5,
          `${name} starts at ${metric[name].x}px, overview column starts at ${metric.overview.x}px`);
      }
      require(Math.abs(metric.block.x - metric.overview.x) <= .5 &&
        Math.abs(metric.block.x + metric.block.width - metric.overview.x - metric.overview.width) <= .5,
      `divider must span the original overview column: ${JSON.stringify(metric.block)} vs ${JSON.stringify(metric.overview)}`);
      for (const name of ['notice', 'state']) {
        require(metric[name].scrollHeight <= metric[name].clientHeight, `${name} vertically overflows ${metric[name].scrollHeight} > ${metric[name].clientHeight}`);
        require(metric[name].scrollWidth <= metric[name].clientWidth, `${name} horizontally overflows`);
        require(metric[name].inkInsidePane, `${name} text is clipped by the assessment pane`);
      }
      require(metric.notice.text === expected.notice, 'full demo notice remains present');
      require(metric.state.text === (state === 'idle' ? '' : expected[state]), 'actual handover state text is shown');
      require(metric.notice.maxHeight === 'none' && ['none', '0'].includes(metric.notice.clamp), 'notice has no max-height or line clamp');
      require(!beside || metric.state.width >= 200, `beside-action state column is ${metric.state.width}px < 200px`);
      require(metric.notice.y >= metric.heading.y + metric.heading.height && metric.action.y >= metric.notice.y + metric.notice.height, 'heading, full notice, then action');
      if (width < 640 || !beside) {
        require(!beside && metric.state.y >= metric.action.y + metric.action.height, 'state stacks below action');
        require(metric.action.width === metric.row.width && metric.action.height === 44, 'stacked action is full width and 44px');
        require(metric.state.x === metric.row.x && ['start', 'left'].includes(metric.state.textAlign), 'stacked state is left-aligned');
      }
      if (width === 390 && locale === 'de') require(metric.state.lines <= 2, `state uses ${metric.state.lines} lines > 2`);
      const displacement = Math.max(...['block', 'action', 'state'].flatMap(name => ['x', 'y', 'width', 'height'].map(key => Math.abs(metric[name][key] - baseline[name][key]))));
      require(displacement === 0, `block/action/state displacement is ${displacement}px`);
      checks.push({ locale, width, phase: state, beside, displacement, ...metric });
      if (evidence && locale === 'de' && ((width === 390 && state !== 'error') || (width === 1440 && state === 'sent'))) {
        await page.screenshot({ path: join(evidence, `ait-433-de-light-${width}-handover-${state}.png`), fullPage: false, captureBeyondViewport: false });
      }
    }
  }
  if (evidence) await writeFile(join(evidence, 'ait-433-checks.json'), JSON.stringify({ commit: evidenceCommit, checks, failures }, null, 2));
  t.diagnostic(JSON.stringify({ checks: checks.length, failures }));
  assert.deepEqual(failures, [], 'Tick spec v1: full notice, readable reserved states, and exact zero movement');
  assert.deepEqual(problems, []);
});
