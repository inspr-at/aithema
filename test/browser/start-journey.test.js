import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../demo/processing-consent.js';

async function browserPath() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name))) ];
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* remote runner */ } }
  throw new Error('No browser available on the remote test runner');
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-start-journey-'));
  const demo = await startChild(new URL('../../demo/server.js', import.meta.url), join(directory, 'session.sqlite'));
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    env: { PATH: process.env.PATH, HOME: homedir() }, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  const problems = []; page.on('pageerror', error => problems.push(error.message));
  t.after(() => assert.deepEqual(problems, []));
  const voice = [];
  page.on('request', request => { if (/\/voice\/.*\/(?:start|recover)$/u.test(new URL(request.url()).pathname)) voice.push(request.url()); });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
    globalThis.__microphoneRequests = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      globalThis.__microphoneRequests++; throw new Error('Consent must never request the microphone');
    };
  });
  return { page, demo, browser, voice };
}
const ready = page => page.waitForFunction(() => Boolean(document.querySelector('aithema-session')?.session?.id));
const consentReady = page => page.waitForFunction(() => document.querySelector('#consent-status')?.dataset.state === 'ready');
async function visitConsent(page, origin) {
  const id = await page.$eval('aithema-session', c => c.session.id);
  await page.goto(`${origin}/consent/?session=${id}&return=/`, { waitUntil: 'domcontentloaded' }); await consentReady(page);
}
async function saveAndReturn(page, action) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click(action)]); await ready(page);
}
const rect = (page, selector) => page.$eval(selector, node => {
  const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
});

test('AIT-129: German entrance → mock consent → readiness, withdrawal, stored language and theme, without audio', { timeout: 120_000 }, async t => {
  const { page, demo, voice } = await setup(t);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.$eval('aithema-session', c => c.session.locale), 'de', 'English browser chrome does not change the fresh German default');
  assert.equal(await page.$('section[aria-labelledby="consent-title"]'), null);
  assert.equal(await page.$eval('#source', a => a.href), 'https://github.com/inspr-at/aithema');
  await page.select('#theme', 'dark');
  assert.equal(await page.$eval('aithema-session', c => c.getAttribute('theme')), 'dark');
  await page.click('aithema-session >>> .chooser__continue'); await consentReady(page);
  assert.equal(new URL(page.url()).pathname, '/consent/');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.$eval('input', b => b.checked), false);
  assert.equal(await page.$eval('#source', a => getComputedStyle(a).display !== 'none'), true);
  await page.click('[data-select-all]'); await saveAndReturn(page, '[data-grant]');
  await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.intro').dataset.mode === 'ready');
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.text.available), true);
  assert.equal(await page.evaluate(() => globalThis.__microphoneRequests), 0); assert.deepEqual(voice, []);
  await visitConsent(page, demo.url); assert.equal(await page.$eval('input', b => b.checked), true);
  await saveAndReturn(page, '[data-revoke]');
  await page.waitForFunction(() => !document.querySelector('aithema-session').session.featureMatrix.best.text.available);
  await page.select('#locale', 'en');
  assert.equal(await page.$eval('aithema-session', c => c.session.locale), 'de');
  assert.match(await page.$eval('#language-note', p => p.textContent), /Neue Gespräche/u);
  const old = await page.$eval('aithema-session', c => c.session.id);
  await page.click('#new'); await page.waitForFunction(old => document.querySelector('aithema-session').session.id !== old, {}, old);
  assert.equal(await page.$eval('aithema-session', c => c.session.locale), 'en');
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.select('#theme', 'system');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
  assert.equal(await page.$eval('aithema-session', c => c.getAttribute('theme')), 'system');
  await page.goto(`${demo.url}/consent/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#consent-status').dataset.state === 'missing');
  assert.equal(await page.$eval('[data-grant]', b => b.disabled), true);
  assert.deepEqual(voice, []);
});

test('AIT-129: live host has no developer chrome; contract consent stays stable at 1440×900 and 390×844, light/dark evidence', { timeout: 120_000 }, async t => {
  const { page, demo, voice } = await setup(t), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const contract = { contract: 'browser-document-v1', items: CONSENT_ITEMS, intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL };
  let selected = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      const path = new URL(request.url()).pathname;
      if (path === '/demo/config') {
        const config = await fetch(request.url()).then(r => r.json());
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...config, demoHost: false, voiceMode: 'off', processingConsent: contract }) });
      } else if (path.endsWith('/consent') && request.method() === 'GET') {
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...contract, selected }) });
      } else {
        if (path.endsWith('/consent') && request.method() === 'POST') { const body = JSON.parse(request.postData()); selected = body.granted ? body.processing.items : []; }
        await request.continue();
      }
    })().catch(error => t.assert.fail(error.message));
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const [width, height, device] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    await page.setViewport({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await ready(page); await page.select('#theme', theme);
      const body = await page.$eval('body', b => b.innerText);
      assert.doesNotMatch(body, /Demo|Mock|mock|provider|Reload or restart|Settings \(in/iu);
      assert.equal(await page.$$eval('[data-demo-only]', nodes => nodes.length), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      assert.equal(await page.$eval('aithema-session', c => c.getBoundingClientRect().width), width);
      if (evidence) await page.screenshot({ path: join(evidence, `ait-129-root-${device}-${theme}.png`), fullPage: true });
      await visitConsent(page, demo.url);
      assert.equal(await page.$$eval('.consent-item', rows => rows.length), CONSENT_ITEMS.length);
      const before = await rect(page, '[data-grant]'), last = await rect(page, '.consent-actions--bottom');
      await page.hover('[data-grant]'); assert.deepEqual(await rect(page, '[data-grant]'), before);
      await page.$eval('[data-grant]', button => button.focus({ preventScroll: true }));
      assert.deepEqual(await rect(page, '[data-grant]'), before);
      assert.notEqual(await page.$eval('[data-grant]', button => getComputedStyle(button).outlineStyle), 'none');
      await page.click('[data-select-all]'); assert.deepEqual(await rect(page, '[data-grant]'), before);
      assert.deepEqual(await rect(page, '.consent-actions--bottom'), last);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      if (width === 390) assert.equal(await page.$eval('main', m => m.getBoundingClientRect().left + parseFloat(getComputedStyle(m).paddingLeft)), 16);
      await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
      if (evidence) await page.screenshot({ path: join(evidence, `ait-129-consent-${device}-${theme}.png`), fullPage: true });
      await saveAndReturn(page, '[data-grant]');
      assert.equal(await page.evaluate(() => globalThis.__microphoneRequests), 0);
    }
  }
  assert.deepEqual(voice, []);
});

test('AIT-129: failed and stale saves remain on consent; unsafe return targets go home', { timeout: 120_000 }, async t => {
  const { page, demo } = await setup(t);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await ready(page);
  const id = await page.$eval('aithema-session', c => c.session.id);
  let failure = true;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/consent') && failure) {
      void request.respond({ status: 500, contentType: 'application/json', body: '{}' });
    } else void request.continue();
  });
  await visitConsent(page, demo.url); await page.click('[data-select-all]'); await page.click('[data-grant]');
  await page.waitForFunction(() => document.querySelector('#consent-status').dataset.state === 'failed');
  assert.equal(new URL(page.url()).pathname, '/consent/');
  failure = false; await saveAndReturn(page, '#retry');
  for (const destination of ['//evil.example/', 'https://evil.example/']) {
    await page.goto(`${demo.url}/consent/?session=${id}&return=${encodeURIComponent(destination)}`, { waitUntil: 'domcontentloaded' }); await consentReady(page);
    assert.equal(await page.$eval('[data-back]', a => new URL(a.href).pathname), '/');
    await saveAndReturn(page, '[data-grant]'); assert.equal(page.url(), `${demo.url}/`);
  }
});
