import './host-opener-check.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../demo/processing-consent.js';

import { browserPath } from '../../scripts/install-test-browser.js';
const browserArgs = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
async function setup(t, settings = {}, server = '../../demo/server.js') {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-start-journey-'));
  const demo = await startChild(new URL(server, import.meta.url), join(directory, 'session.sqlite'), settings);
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await demo.kill(); } });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    env: { PATH: process.env.PATH, HOME: homedir() }, userDataDir: join(directory, 'chrome'),
    args: browserArgs });
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

test('AIT-113: live drafts consent is optional; granting and withdrawing only drafts follows the server verdict', { timeout: 120_000 }, async t => {
  const analysis = '~anthropic/claude-opus-latest', speech = '~anthropic/claude-haiku-latest';
  const { page, demo, voice } = await setup(t, { AITHEMA_PROVIDER: 'openrouter', AITHEMA_HTML_MODE: 'claude',
    OPENROUTER_MODEL: analysis, OPENROUTER_SPEECH_MODEL: speech, OPENROUTER_PROVIDER_ONLY: 'Anthropic',
    OPENROUTER_API_KEY: 'test-not-a-key', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [analysis]: { prompt: 5e-6, completion: 25e-6 },
      [speech]: { prompt: 1e-6, completion: 5e-6 } }) }, '../fixtures/no-provider-server.js');
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await ready(page);
  await visitConsent(page, demo.url);
  const drafts = 'input[value="drafts-anthropic"]';
  assert.equal(await page.$eval(drafts, b => b.checked), false);
  assert.match(await page.$eval(drafts, b => b.closest('.consent-item').innerText), /KI-Entwürfe \(Anthropic\).*optional/su);
  const before = await rect(page, '[data-grant]');
  await page.click('input[value="models-international"]');
  assert.deepEqual(await rect(page, '[data-grant]'), before);
  await saveAndReturn(page, '[data-grant]');
  await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.text.available);
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.html.available), false);
  await page.click('aithema-session >>> .chooser__continue');
  await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('[data-ready="consent"]')?.dataset.state === 'confirmed');
  await visitConsent(page, demo.url); await page.click(drafts); await saveAndReturn(page, '[data-grant]');
  await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.html.available);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.html.available), true);
  await visitConsent(page, demo.url);
  assert.equal(await page.$eval(drafts, b => b.checked), true);
  await page.click(drafts); await saveAndReturn(page, '[data-grant]');
  await page.waitForFunction(() => !document.querySelector('aithema-session').session.featureMatrix.best.html.available);
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.text.available), true);
  await visitConsent(page, demo.url);
  assert.equal(await page.$eval(drafts, b => b.checked), false);
  assert.equal(await page.$eval('input[value="models-international"]', b => b.checked), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.equal(await page.evaluate(() => globalThis.__microphoneRequests), 0); assert.deepEqual(voice, []);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-113-optional-drafts-phone.png'), fullPage: true });
  }
});


test('AIT-127: language repaints in place and keeps the selector under the pointer at desktop and phone sizes', { timeout: 120_000 }, async t => {
  const { page, demo } = await setup(t);
  for (const width of [1440, 390, 320]) {
    await page.setViewport({ width, height: 900 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await ready(page);
    await page.select('#locale', 'de');
    await page.waitForFunction(() => document.querySelector('aithema-session').session.locale === 'de');
    await page.evaluate(() => {
      const c = document.querySelector('aithema-session'), root = c.shadowRoot;
      globalThis.__localeNodes = { id: c.session.id, input: root.querySelector('textarea'), settings: root.querySelector('.settings-open'),
        chooser: root.querySelector('.chooser-option'), continue: root.querySelector('.chooser__continue') };
      globalThis.__localeNodes.input.value = 'Draft waiting here';
    });
    const before = await rect(page, '#locale');
    await page.mouse.move(before[0] + before[2] / 2, before[1] + before[3] / 2);
    await page.select('#locale', 'en');
    await page.waitForFunction(() => document.querySelector('aithema-session').session.locale === 'en' && document.documentElement.lang === 'en');
    const after = await rect(page, '#locale');
    assert.ok(before.every((value, i) => Math.abs(value - after[i]) < .5), `${width}px: locale selector moved: ${before} → ${after}`);
    assert.equal(await page.evaluate(() => {
      const c = document.querySelector('aithema-session'), root = c.shadowRoot, old = globalThis.__localeNodes;
      return c.session.id === old.id && root.querySelector('textarea') === old.input && old.input.value === 'Draft waiting here'
        && root.querySelector('.settings-open') === old.settings && root.querySelector('.chooser-option') === old.chooser
        && root.querySelector('.chooser__continue') === old.continue;
    }), true);
    assert.equal(await page.$eval('#language-note', n => n.textContent), '');
    assert.equal(await page.$eval('aithema-session >>> .chooser__continue > span', n => n.textContent), 'Continue');
  }
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
  assert.equal(await page.$eval('aithema-session', c => c.session.settings.origin), 'chosen', 'the unchanged entrance choice survives the consent return');
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.text.available), true);
  assert.equal(await page.evaluate(() => globalThis.__microphoneRequests), 0); assert.deepEqual(voice, []);
  await visitConsent(page, demo.url); assert.equal(await page.$eval('input', b => b.checked), true);
  await saveAndReturn(page, '[data-revoke]');
  await page.waitForFunction(() => !document.querySelector('aithema-session').session.featureMatrix.best.text.available);
  await page.select('#locale', 'en');
  await page.waitForFunction(() => document.querySelector('aithema-session').session.locale === 'en');
  assert.equal(await page.$eval('#language-note', p => p.textContent), '');
  const old = await page.$eval('aithema-session', c => c.session.id);
  await page.click('aithema-session >>> .conversations-toggle'); await page.click('aithema-session >>> .conversations-new'); await page.waitForFunction(old => document.querySelector('aithema-session').session.id !== old, {}, old);
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
      if (evidence) {
        const state = () => page.evaluate(() => {
          const root = document.querySelector('aithema-session').shadowRoot;
          return { fonts: document.fonts.status, animations: [...document.getAnimations(), ...root.getAnimations()].map(a => ({
            name: a.animationName ?? a.transitionProperty, time: a.currentTime, state: a.playState,
            duration: a.effect.getComputedTiming().duration, target: a.effect.target?.className,
          })), text: root.innerText, cards: [...root.querySelectorAll('.chooser-option')].map(el => {
            const s = getComputedStyle(el), r = el.getBoundingClientRect();
            return { text: el.innerText, x: r.x, y: r.y, width: r.width, height: r.height,
              font: s.font, backdropFilter: s.backdropFilter, background: s.background, boxShadow: s.boxShadow };
          }) };
        });
        const before = await state();
        const diagnostic = join(evidence, '..', 'diagnostics', evidence.split('/').at(-1));
        await mkdir(diagnostic, { recursive: true });
        await page.screenshot({ path: join(diagnostic, `ait-129-root-${device}-${theme}-unsettled.png`), fullPage: false });
        // Wait for real finite transitions, including theme/entry paint. Pin only
        // repeating decorative animation to its initial frame for both engines.
        await page.evaluate(async () => {
          await document.fonts.ready;
          const root = document.querySelector('aithema-session').shadowRoot;
          for (let pass = 0; pass < 3; pass++) {
            const animations = [...document.getAnimations(), ...root.getAnimations()];
            await Promise.all(animations.map(a => {
              if (a.effect.getComputedTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; return; }
              return a.finished.catch(() => {});
            }));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          }
        });
        await writeFile(join(diagnostic, `ait-129-root-${device}-${theme}.json`), JSON.stringify({ before, after: await state() }, null, 2));
        await page.screenshot({ path: join(evidence, `ait-129-root-${device}-${theme}.png`), fullPage: false });
        // Diagnostic ablation only: the actual sample above keeps its blur.
        await page.evaluate(() => {
          const style = document.createElement('style'); style.id = 'ait199-no-backdrop';
          style.textContent = '* { backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }';
          document.querySelector('aithema-session').shadowRoot.append(style);
        });
        await page.screenshot({ path: join(diagnostic, `ait-129-root-${device}-${theme}-no-backdrop.png`), fullPage: false });
        await page.evaluate(() => document.querySelector('aithema-session').shadowRoot.querySelector('#ait199-no-backdrop').remove());
      }
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

// A real browser and component, with only fixture consent and voice ports. No autoplay override or fake media flags.
const startConsentFixture = `<!doctype html><html lang="en"><body><button id="host">Host control</button><script type="module">
import '/packages/ui/src/session-element.js';
import {createSession} from '/packages/core/src/session.js';
import {en} from '/packages/ui/src/i18n/en.js';
import {voiceEvents} from '/packages/core/src/live-voice.js';
const mode = new URL(location.href).searchParams.get('mode');
const saved = sessionStorage.getItem('fixture-session'); sessionStorage.removeItem('fixture-session');
const session = saved ? JSON.parse(saved) : createSession({demo:true, settings:{origin:'chosen', voice:mode==='voice'?'fixture':'off'}});
const blocked = {available:false,reason:'current processing consent required'};
session.featureMatrix = {best:{text:blocked,voice:blocked,analysis:blocked}};
globalThis.covering = Boolean(saved); globalThis.starts = 0; globalThis.events = [];
const c = document.createElement('aithema-session'); document.body.append(c);
c.addEventListener('aithema-consent', e => events.push(e.detail));
c.configure({copy:en,session, ...(mode==='voice'?{voiceClient:{async start({callId}){
 starts++; const events=voiceEvents(); return {callId,providerSessionId:'fixture',events,async setInput(){},async setOutput(){},async updateContext(){},async close(){events.end();return {closureConfirmed:true}}};
}}}:{})});
globalThis.grant = () => {covering=true;c.receive({seq:c.session.seq+1,type:'consent.revised',data:{granted:true,changed:['text','voice'],removed:[]}})};
globalThis.fixtureReady=true;
</script></body></html>`;
// Puppeteer's convenience evaluations carry a user gesture. Consent snapshots and
// asynchronous grants must not manufacture activation for the inactive-voice case.
async function withoutGesture(page, fn, argument) {
  const client = await page.createCDPSession();
  try {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`,
      userGesture: false, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally { await client.detach(); }
}
const consentStartState = page => withoutGesture(page, () => {
  const c = document.querySelector('aithema-session');
  return { ready: !c.shadowRoot.querySelector('.intro').hidden,
    focus: c.shadowRoot.activeElement?.className, host: document.activeElement.id, starts: globalThis.starts };
});

test('AIT-501: consent continuation in the browser, including default gesture policy and navigation', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-start-consent-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  t.after(() => server.kill());
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: browserArgs });
  t.after(() => browser.close());
  const checks = [];
  for (const scenario of ['text', 'voice', 'inactive-voice', 'host-focus', 'host-focus-voice', 'text-navigation', 'voice-navigation', 'review']) {
    await t.test(scenario, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 390, height: 844 });
        await page.setRequestInterception(true);
        page.on('request', request => { void (async () => {
          const url = new URL(request.url());
          if (url.pathname === '/start-fixture') return request.respond({ status: 200, contentType: 'text/html', body: startConsentFixture });
          if (url.pathname.endsWith('/events')) return; // Hold SSE open; reconnects must not add unrelated refreshes.
          if (url.pathname.startsWith('/api/sessions/')) {
            const body = await withoutGesture(page, consent => {
              const c = document.querySelector('aithema-session');
              if (consent) return { consentRevision: c.session.consentRevision, selected: [], features: {} };
              const s = c.session;
              if (globalThis.covering) s.featureMatrix.best = { text: { available: true }, voice: { available: true }, analysis: { available: true } };
              return s;
            }, url.pathname.endsWith('/consent'));
            return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          }
          return request.continue();
        })().catch(error => { checks.push({ interception: error.message }); }); });
        const mode = scenario.includes('voice') ? 'voice' : 'type', url = `${server.url}/start-fixture?mode=${mode}`;
        await page.goto(url); await page.waitForFunction(() => globalThis.fixtureReady);
        await page.click('aithema-session >>> .ready__start');
        assert.equal(await page.evaluate(() => events.at(-1).intent), 'start');
        if (scenario === 'review') await page.click('aithema-session >>> .ready__consent');
        if (scenario.startsWith('host-focus')) await page.click('#host');
        if (scenario === 'inactive-voice') await withoutGesture(page, async () => {
          const deadline = performance.now() + 10_000;
          while (navigator.userActivation.isActive) {
            if (performance.now() > deadline) throw new Error('fixture activation did not expire');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        });
        if (scenario.endsWith('navigation')) {
          await page.$eval('aithema-session', c => { const s=c.session;s.consentRevision++;sessionStorage.setItem('fixture-session',JSON.stringify(s)); });
          await page.goto('about:blank'); await page.goto(url); await page.waitForFunction(() => globalThis.fixtureReady);
        } else {
          const active = await withoutGesture(page, () => { const active = navigator.userActivation.isActive; grant(); return active; });
          if (scenario === 'inactive-voice') assert.equal(active, false, 'the host grant must arrive without browser activation');
        }
        if (scenario === 'inactive-voice') await withoutGesture(page, async () => {
          const deadline = performance.now() + 10_000;
          while (!document.querySelector('aithema-session').shadowRoot.querySelector('.intro').hidden) {
            if (performance.now() > deadline) throw new Error('consent continuation did not settle');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        });
        else if (scenario !== 'review') await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.intro').hidden);
        const result = await consentStartState(page); checks.push({ scenario, ...result });
        assert.equal(result.ready, scenario === 'review');
        assert.equal(result.starts, ['voice', 'host-focus-voice'].includes(scenario) ? 1 : 0);
        if (scenario === 'inactive-voice' || scenario === 'voice-navigation') assert.equal(result.focus, 'voice-start');
        if (scenario.startsWith('host-focus')) assert.equal(result.host, 'host');
        if (scenario === 'text' || scenario === 'text-navigation') assert.equal(result.focus, ''); // textarea has no class
      } finally { await page.close(); }
    });
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-501-browser.json'), JSON.stringify(checks, null, 2));
  }
});


test('AIT-501 v2.2: the real host open/adopt/configure return resumes typing from its granted snapshot', { timeout: 120_000 }, async t => {
  const { page, demo } = await setup(t, { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' }, '../fixtures/no-provider-server.js');
  const boxes = [];
  for (const width of [390, 1440]) {
    await page.setViewport({ width, height: 900 });
    await page.goto(demo.url); await ready(page);
    const sessionId = await page.evaluate(async () => {
      const { sessionKey } = await import('/demo/page-preferences.js');
      const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, settings: { voice: 'off' } }) });
      if (!response.ok) throw new Error('fixture session refused');
      const session = await response.json(); localStorage.setItem(sessionKey, session.id); return session.id;
    });
    await page.reload(); await ready(page);
    assert.equal(await page.$eval('aithema-session', c => c.session.id), sessionId);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('aithema-session >>> .ready__start')]);
    await consentReady(page); await page.click('[data-select-all]'); await saveAndReturn(page, '[data-grant]');
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.intro').hidden);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('aithema-start-intent')), null);
    for (const selector of ['.composer', '.composer-dock']) {
      const box = await page.$eval('aithema-session', (c, selector) => {
        return c.shadowRoot.querySelector(selector).getBoundingClientRect().toJSON();
      }, selector);
      boxes.push({ viewport: width, selector, ...box });
      assert.ok(box.width > 0 && box.height > 0, `${width}: ${selector} must be visible: ${JSON.stringify(box)}`);
    }
    await page.reload(); await ready(page);
    assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.intro').hidden), false, 'reload must not reuse the intent');
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-501-host-return-boxes.json'), JSON.stringify(boxes, null, 2));
  }
});

import { combinedEntranceCheck } from './combined-entrance-check.js';
test('AIT-506: combined entrance states retain positive composer boxes in EN/DE, light/dark, 390/1024/1440',
  { timeout: 180_000 }, combinedEntranceCheck);
