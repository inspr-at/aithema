import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';

// A real browser and component, with only fixture consent and voice ports. No autoplay override or fake media flags.
const fixture = `<!doctype html><html lang="en"><body><button id="host">Host control</button><script type="module">
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
const state = page => page.$eval('aithema-session', c => ({ ready: !c.shadowRoot.querySelector('.intro').hidden,
  focus: c.shadowRoot.activeElement?.className, host: document.activeElement.id, starts: globalThis.starts }));

test('AIT-501: consent continuation in the browser, including default gesture policy and navigation', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-start-consent-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  t.after(() => server.kill());
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(() => browser.close());
  const checks = [];
  for (const scenario of ['text', 'voice', 'inactive-voice', 'host-focus', 'text-navigation', 'voice-navigation', 'review']) {
    await t.test(scenario, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 390, height: 844 });
        await page.setRequestInterception(true);
        page.on('request', request => { void (async () => {
          const url = new URL(request.url());
          if (url.pathname === '/start-fixture') return request.respond({ status: 200, contentType: 'text/html', body: fixture });
          if (url.pathname.endsWith('/events')) return request.respond({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
          if (url.pathname.startsWith('/api/sessions/')) {
            const body = await page.$eval('aithema-session', (c, consent) => {
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
        if (scenario === 'host-focus') await page.click('#host');
        if (scenario === 'inactive-voice') await page.waitForFunction(() => !navigator.userActivation.isActive, { polling: 100 });
        if (scenario.endsWith('navigation')) {
          await page.$eval('aithema-session', c => { const s=c.session;s.consentRevision++;sessionStorage.setItem('fixture-session',JSON.stringify(s)); });
          await page.goto('about:blank'); await page.goto(url); await page.waitForFunction(() => globalThis.fixtureReady);
        } else await page.evaluate(() => grant());
        if (scenario !== 'review') await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.intro').hidden);
        const result = await state(page); checks.push({ scenario, ...result });
        assert.equal(result.ready, scenario === 'review');
        assert.equal(result.starts, scenario === 'voice' ? 1 : 0);
        if (scenario === 'inactive-voice' || scenario === 'voice-navigation') assert.equal(result.focus, 'voice-start');
        if (scenario === 'host-focus') assert.equal(result.host, 'host');
        if (scenario === 'text' || scenario === 'text-navigation') assert.equal(result.focus, ''); // textarea has no class
      } finally { await page.close(); }
    });
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-501-browser.json'), JSON.stringify(checks, null, 2));
  }
});
