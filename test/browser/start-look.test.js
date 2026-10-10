// AIT-128: START's look in a real browser, on the reference host (AIT-129): the page's theme choice, a new
// conversation, the entrance, the host's consent page and back, readiness with its explicit start, the
// conversation with the understanding and the voice rail. Each step is checked and photographed at
// 1440 × 900, 1280 × 720 and 390 × 844, light and dark. Screenshots go to AITHEMA_EVIDENCE_DIR when it is set.
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
import { palette } from '../../packages/ui/src/styles.js';

const waitTimeout = 45_000;
async function browserPath() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/opt/google/chrome/chrome', ...(process.env.PATH ?? '').split(delimiter).flatMap(dir =>
      ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => join(dir, name))).filter(path => path !== '/snap/bin/chromium'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const path of new Set(candidates)) { try { await access(path, constants.X_OK); return path; } catch { /* next */ } }
  throw new Error('No Chrome or Chromium found. Set CHROME_PATH to its executable.');
}
async function startDemo(directory) {
  const child = fork(new URL('../../demo/server.js', import.meta.url), [], {
    env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite') }, silent: true });
  child.stdout.resume(); child.stderr.resume();
  const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Demo host exited (code ${code})`); })]);
  return { child, url: message.url };
}
async function stopDemo(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
}
const inShadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: waitTimeout }, arg);
const box = (page, selector) => inShadow(page, (c, selector) => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);
const boxes = (page, selector) => inShadow(page, (c, selector) => [...c.shadowRoot.querySelectorAll(selector)].map(n => {
  const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}), selector);
const stage = page => inShadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage);
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('START look on the reference host: entrance, consent page, readiness, conversation with understanding and the voice rail at three sizes, light and dark (AIT-128)',
  { timeout: 420_000 }, async t => {
    const executablePath = await browserPath(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const directory = await mkdtemp(join(tmpdir(), 'aithema-start-look-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => { try { await browser?.close(); } finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); } });
    if (evidence) await mkdir(evidence, { recursive: true });
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() }, userDataDir: join(directory, 'chrome'),
      timeout: waitTimeout, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(); page.setDefaultTimeout(waitTimeout);
    const problems = []; page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return;
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      // English conversations unless a step chooses German on the page itself.
      try { if (!sessionStorage.getItem('start-look-german')) localStorage.setItem('aithema-demo-locale', 'en'); } catch { /* Storage can be denied. */ }
      // Count every microphone request in this document: none may happen before the explicit voice start.
      window.microphoneRequests = 0;
      const media = navigator.mediaDevices;
      if (media?.getUserMedia) { const native = media.getUserMedia.bind(media); media.getUserMedia = constraints => { window.microphoneRequests++; return native(constraints); }; }
    });
    const shot = async (name, options = {}) => { if (evidence) await page.screenshot({ path: join(evidence, `start-look-${name}.png`), ...options }); };
    const sizes = [[1440, 900], [1280, 720], [390, 844]], modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.chooser-option'));
    const tally = [];
    for (const theme of ['light', 'dark']) {
      // The page's own theme choice (AIT-129) sets the component's theme attribute; the system preference is the other one.
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme === 'light' ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await page.select('#theme', theme);
      for (const [width, height] of sizes) {
        const label = `${theme}-${width}x${height}`;
        await page.setViewport({ width, height });
        // A fresh conversation in this layout and theme: its processing consent is its own.
        const previous = await inShadow(page, c => c.session.id);
        await page.click('#new');
        await until(page, id => document.querySelector('aithema-session').session.id !== id
          && document.querySelector('aithema-session').shadowRoot.querySelector('.intro').dataset.mode === 'chooser', previous);
        await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.move(0, 0); await settle(450);

        // One canvas: the page paints START's paper and lighting, the component paints no backdrop of its own.
        assert.equal(await inShadow(page, c => c.getAttribute('theme')), theme, label);
        assert.equal(await inShadow(page, c => getComputedStyle(c).getPropertyValue('--aithema-paper').trim()), palette[theme].paper, label);
        assert.deepEqual(await page.evaluate(() => {
          const body = getComputedStyle(document.body), host = getComputedStyle(document.querySelector('aithema-session'));
          return { lighting: body.backgroundImage.split('radial-gradient').length - 1, fixed: body.backgroundAttachment.startsWith('fixed'), component: [host.backgroundImage, host.backgroundColor] };
        }), { lighting: 3, fixed: true, component: ['none', 'rgba(0, 0, 0, 0)'] }, `${label}: no seam between page and component`);
        assert.equal(await page.evaluate(() => document.querySelectorAll('h1').length), 1, `${label}: one h1 on the page`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${label}: no sideways scrolling`);
        // Entrance: the promise, the orb and four choices; Continue keeps its place while choosing.
        assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.promise span')].map(n => n.textContent)), en.entrance.promise);
        const orb = await box(page, '.intro__orb .orb'); assert.ok(orb.width >= 60 && orb.width <= 100, `${label}: entrance orb ${orb.width}px`);
        const options = await boxes(page, '.chooser-option');
        assert.equal(options.length, 4);
        const columns = new Set(options.map(([x]) => x)).size; assert.equal(columns, width >= 832 ? 4 : 2, `${label}: START's ${width >= 832 ? 4 : 2} columns`);
        await shot(`entrance-${label}`); if (width < 600) await shot(`entrance-${label}-full`, { fullPage: true });
        await inShadow(page, c => c.shadowRoot.querySelector('.chooser-option[data-preset="custom"]').scrollIntoView({ block: 'nearest' }));
        const before = { options: await boxes(page, '.chooser-option'), go: await box(page, '.chooser__continue') };
        await page.hover('aithema-session >>> .chooser-option[data-preset="custom"]');
        assert.deepEqual(await boxes(page, '.chooser-option'), before.options, `${label}: hover moves no choice`);
        await page.click('aithema-session >>> .chooser-option[data-preset="device"]');
        await page.click('aithema-session >>> .chooser-option[data-preset="best"]');
        assert.deepEqual(await boxes(page, '.chooser-option'), before.options, `${label}: selection moves no choice`);
        assert.deepEqual(await box(page, '.chooser__continue'), before.go, `${label}: Continue keeps its place`);
        assert.equal(await page.evaluate(() => window.microphoneRequests), 0, `${label}: no microphone request at the entrance`);

        // Continue without consent goes to the host's consent page; granting returns to readiness, still without audio.
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('aithema-session >>> .chooser__continue')]);
        await until(page, () => document.querySelector('#consent-status')?.dataset.state === 'ready');
        assert.equal(new URL(page.url()).pathname, '/consent/');
        await page.click('[data-select-all]');
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-grant]')]);
        await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.intro')?.dataset.mode === 'ready');
        await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.move(0, 0); await settle(400);
        assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('[data-ready="consent"]').dataset.state), 'confirmed');
        assert.equal(await page.evaluate(() => window.microphoneRequests), 0, `${label}: no microphone request on the way to readiness`);
        await shot(`readiness-${label}`);
        const modes = await boxes(page, '.ready__mode');
        await page.click('aithema-session >>> .ready__mode[data-mode="type"]');
        assert.deepEqual(await boxes(page, '.ready__mode'), modes, `${label}: the mode choice keeps its width`);
        await page.click('aithema-session >>> .ready__start');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
        assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.id), 'message', `${label}: typing continues in the composer`);
        assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent');

        // The first input opens the understanding beside the conversation (START's reveal); the composer does not jump.
        await page.keyboard.type('operations: hosted; data: public; systems: API; reach: international');
        const composer = await box(page, '.composer');
        await page.keyboard.down(modifier); await page.keyboard.press('Enter'); await page.keyboard.up(modifier);
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.understanding === 'present');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.notice').textContent === 'Current assessment');
        await until(page, () => document.querySelectorAll('aithema-session')[0].shadowRoot.querySelectorAll('ol li.turn').length >= 2);
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').hasAttribute('data-reveal'));
        if (width >= 960) {
          const after = await box(page, '.composer'), conversation = await box(page, '.conversation'), aside = await box(page, '.understanding');
          assert.ok(Math.abs(after.y + after.height - (composer.y + composer.height)) <= 1, `${label}: the composer keeps its bottom edge (${JSON.stringify(composer)} → ${JSON.stringify(after)})`);
          assert.ok(aside.width >= 352, `${label}: understanding at least 22rem (${aside.width})`);
          assert.ok(Math.abs(conversation.width / aside.width - 1.55 / .88) < .25 || aside.width === 352, `${label}: START's 1.55 / 0.88 split (${conversation.width} / ${aside.width})`);
          assert.ok(aside.y + aside.height <= height + 1 && after.y + after.height <= height + 1, `${label}: panes and composer are viewport-contained`);
        }
        await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.move(0, 0);
        await shot(`conversation-${label}`);
        if (width < 600) {
          await inShadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
          await shot(`understanding-${label}`);
          await page.evaluate(() => window.scrollTo(0, 0));
        }

        // The voice rail: the orb becomes the avatar, icon controls around the waveform and one status phrase.
        await inShadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
        await until(page, () => ['listening', 'speaking'].includes(document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state));
        await settle(900);
        assert.ok(await inShadow(page, c => Boolean(c.shadowRoot.querySelector('.audio-rail .voice-orb .orb'))), `${label}: the orb is docked in the rail`);
        const rail = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.audio-rail button')].filter(b => getComputedStyle(b).visibility === 'visible')
          .map(b => ({ name: b.textContent.trim(), width: Math.round(b.getBoundingClientRect().width), pressed: b.getAttribute('aria-pressed') })));
        assert.ok(rail.length >= 4 && rail.every(control => control.name && control.width === 44), `${label}: ${JSON.stringify(rail)}`);
        await shot(`voice-${label}`);
        await inShadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'idle');
        assert.equal(await stage(page), 'live');
        tally.push(label);
      }
    }
    // German entrance at the desktop size (the page's language choice applies to the next conversation), and
    // reduced motion: nothing animates.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setViewport({ width: 1440, height: 900 });
    await page.select('#theme', 'system');
    await page.evaluate(() => sessionStorage.setItem('start-look-german', '1'));
    await page.select('#locale', 'de'); await page.click('#new');
    await until(page, () => document.querySelector('aithema-session').session.locale === 'de'
      && document.querySelector('aithema-session').shadowRoot.querySelector('.intro').dataset.mode === 'chooser');
    assert.equal(await inShadow(page, c => getComputedStyle(c).getPropertyValue('--aithema-paper').trim()), palette.light.paper, 'system follows the light preference');
    assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.promise span')].map(n => n.textContent)), de.entrance.promise);
    const motion = await inShadow(page, c => ({ workspace: getComputedStyle(c.shadowRoot.querySelector('.workspace')).transitionDuration,
      orb: getComputedStyle(c.shadowRoot.querySelector('.orb__layer--a')).animationName }));
    assert.deepEqual(motion, { workspace: '0s', orb: 'none' });
    await page.mouse.move(0, 0); await settle(300); await shot('entrance-de-light-1440x900');
    assert.deepEqual(problems, []);
    t.diagnostic(`START look checked and photographed on the reference host: ${tally.join(', ')}; German entrance; reduced motion.`);
  });
