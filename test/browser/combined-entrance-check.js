import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';
const fixture = `<!doctype html><html><head><style>body{margin:0}aithema-session{--aithema-height:900px}</style></head><body><script type="module">
import '/packages/ui/src/session-element.js';
import {createSession} from '/packages/core/src/session.js';
import {voiceEvents} from '/packages/core/src/live-voice.js';
import {en} from '/packages/ui/src/i18n/en.js';
import {de} from '/packages/ui/src/i18n/de.js';
const locale=new URL(location.href).searchParams.get('locale')||'en';
document.documentElement.lang=locale;
Date.now=()=>1800000000000;
const saved=sessionStorage.getItem('combined-fixture-session');sessionStorage.removeItem('combined-fixture-session');
globalThis.trace=[];globalThis.sent=[];globalThis.granted=Boolean(saved&&JSON.parse(saved).consentRevision>0);globalThis.denied=false;
const allowed={available:true},blocked={available:false,reason:'current processing consent required'};
const c=document.createElement('aithema-session');document.body.append(c);globalThis.c=c;
const nativeFetch=fetch;
globalThis.fetch=async(url,options={})=>{
 if(!String(url).startsWith('/api/sessions/'))return nativeFetch(url,options);
 if(String(url).endsWith('/events'))return new Response(new ReadableStream({start(controller){options.signal?.addEventListener('abort',()=>controller.close(),{once:true})}}));
 if(String(url).endsWith('/consent'))return Response.json({consentRevision:c.session.consentRevision,selected:[],features:{}});
 if(String(url).endsWith('/turns')){const b=JSON.parse(options.body);sent.push(b);return Response.json({seq:c.session.seq+1,type:'turn.final',data:{id:b.clientEventId,role:'user',content:b.content,...b.voiceCallId?{voiceCallId:b.voiceCallId}:{}}})}
 const s=c.session;s.featureMatrix.best={text:granted?allowed:blocked,voice:granted?allowed:blocked,analysis:allowed};return Response.json(s);
};
const client={async start({callId}){trace.push('admission');trace.push('permission');if(denied)throw Object.assign(new Error('blocked'),{name:'NotAllowedError'});trace.push('call');const events=voiceEvents();return {callId,providerSessionId:'fixture',events,async setInput(value){trace.push(['capture',value])},async setOutput(){},async updateContext(){},async sendText(text){trace.push(['typed',text])},async pause(){return {acknowledged:true,paused:true}},async resume(){return {acknowledged:true,paused:false}},async heartbeat(){return {acknowledged:true,browserLivenessDeadlineAt:Date.now()+30000}},async close(){events.end();return {closureConfirmed:true}}}}};
globalThis.mount=(snapshot)=>{c.configure({entrance:'combined',copy:locale==='de'?de:en,session:snapshot||createSession({demo:true,locale,settings:{origin:'chosen',voice:'fixture'}}),voiceClient:client})};
const session=saved?JSON.parse(saved):createSession({demo:true,locale,settings:{origin:new URL(location.href).searchParams.has('unchosen')?'default':'chosen',voice:'fixture'}});session.featureMatrix={best:{text:granted?allowed:blocked,voice:granted?allowed:blocked,analysis:allowed}};mount(session);
c.addEventListener('aithema-consent',e=>{trace.push('consent');globalThis.consent=e.detail});
globalThis.grant=()=>{granted=true;c.receive({seq:c.session.seq+1,type:'consent.revised',data:{granted:true,changed:['text','voice'],removed:[]}})};
globalThis.ready=true;
</script></body></html>`;
const boxes = (page) => page.$eval('aithema-session', c => Object.fromEntries(['textarea', '.composer-mic', '.send', '.composer-status', '.composer-notice'].map(selector => {
  const box = c.shadowRoot.querySelector(selector)?.getBoundingClientRect();
  return [selector, box ? [box.x, box.y, box.width, box.height] : null];
})));
function positive(rects) {
  for (const [selector, box] of Object.entries(rects)) assert.ok(box && box[2] > 0 && box[3] > 0, `${selector} positive box: ${JSON.stringify(box)}`);
}
function unmoved(before, after) {
  positive(before); positive(after);
  for (const selector of Object.keys(before)) for (let i = 0; i < 4; i++) assert.ok(Math.abs(before[selector][i] - after[selector][i]) <= .5,
    `${selector}[${i}] moved: ${before[selector][i]} -> ${after[selector][i]}`);
}
async function entranceFits(page, selector) {
  const rects = await page.$eval('aithema-session', (c, selector) => Object.fromEntries(['.intro', selector].map(key => {
    const box = c.shadowRoot.querySelector(key).getBoundingClientRect();
    return [key, [box.x, box.y, box.width, box.height]];
  })), selector);
  positive(rects);
  const intro = rects['.intro'], content = rects[selector];
  assert.ok(content[1] >= intro[1] - .5 && content[1] + content[3] <= intro[1] + intro[3] + .5,
    `${selector} must fit the entrance without a clipped or scrolling card: ${JSON.stringify(rects)}`);
}
export async function combinedEntranceCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-combined-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, tables = [];
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const page = await browser.newPage(), problems = [];
    try {
      page.on('pageerror', error => problems.push(error.message));
      await page.setViewport({ width, height: 1000 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setRequestInterception(true);
      page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
        ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
      await page.goto(`${server.url}/combined-fixture?locale=${locale}`); await page.waitForFunction(() => globalThis.ready);
      const shot = async state => {
        const measured = await boxes(page); positive(measured); tables.push({ locale, theme, width, state, boxes: measured });
        if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, 'shots', `ait-506-${locale}-${theme}-${width}-${state}.png`), fullPage: true });
        return measured;
      };
      const initial = await shot('ready');
      await entranceFits(page, '.ready');
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.ready__start')), null);
      assert.deepEqual(await page.evaluate(() => trace), []);
      await page.type('aithema-session >>> textarea', 'A bounded draft');
      await page.click('aithema-session >>> .send');
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('textarea').readOnly), true);
      unmoved(initial, await shot('text-consent'));
      await page.evaluate(() => grant());
      await page.waitForFunction(() => sent.length === 1);
      assert.equal(await page.evaluate(() => sent[0].content), 'A bounded draft');
      unmoved(initial, await shot('text-sent'));
      // Reload a fresh blocked snapshot; test denied microphone and a usable text field.
      await page.goto(`${server.url}/combined-fixture?locale=${locale}`); await page.waitForFunction(() => globalThis.ready);
      const before = await boxes(page); positive(before);
      await page.click('aithema-session >>> .composer-mic');
      assert.deepEqual(await page.evaluate(() => trace), ['consent']);
      unmoved(before, await shot('voice-consent'));
      await page.evaluate(() => { denied = true; grant(); });
      await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').readOnly);
      // Consent can outlive browser activation: a fresh click is always admitted.
      if (!await page.evaluate(() => trace.includes('permission'))) await page.click('aithema-session >>> .composer-mic');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      const deniedBox = await shot('microphone-blocked'); unmoved(before, deniedBox);
      assert.match(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.composer-status').textContent), locale === 'de' ? /Mikrofon gesperrt/ : /Microphone blocked/);
      assert.equal(await page.$eval('aithema-session', c => getComputedStyle(c.shadowRoot.querySelector('.composer-reason')).visibility), 'hidden',
        'microphone status must not overlap the keyboard shortcut');
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('textarea').disabled), false);
      assert.deepEqual(await page.evaluate(() => trace.slice(0, 3)), ['consent', 'admission', 'permission']);
      await page.evaluate(() => { denied = false; }); await page.click('aithema-session >>> .composer-mic');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed') === 'true');
      const live = await shot('listening'); unmoved(before, live);
      await page.type('aithema-session >>> textarea', 'Typed while listening');
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed')), 'true');
      await page.click('aithema-session >>> .send'); await page.waitForFunction(() => trace.some(x => Array.isArray(x) && x[0] === 'typed'));
      assert.ok(await page.evaluate(() => trace.some(x => Array.isArray(x) && x[0] === 'typed' && x[1] === 'Typed while listening')));
      await page.click('aithema-session >>> .composer-mic');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed') === 'false');
      unmoved(live, await shot('muted'));
      // First visitor input reveals a second column by design; mute itself retains the row.
      const muted = await boxes(page); positive(muted); await page.click('aithema-session >>> .composer-mic');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed') === 'true');
      unmoved(muted, await boxes(page));
      assert.ok(live.textarea[2] > 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const mode of ['text', 'voice']) for (const covered of [true, false]) {
        const url = `${server.url}/combined-fixture?locale=${locale}`;
        await page.goto(url); await page.waitForFunction(() => globalThis.ready);
        await page.type('aithema-session >>> textarea', 'Returned draft');
        await page.click(`aithema-session >>> ${mode === 'text' ? '.send' : '.composer-mic'}`);
        await page.$eval('aithema-session', (c, covered) => { const snapshot = c.session; if (covered) snapshot.consentRevision++; sessionStorage.setItem('combined-fixture-session', JSON.stringify(snapshot)); }, covered);
        await page.goto('about:blank'); await page.goto(url); await page.waitForFunction(() => globalThis.ready);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('textarea').value === 'Returned draft');
        assert.equal(await page.$eval('aithema-session', (c, mode) => c.shadowRoot.activeElement === c.shadowRoot.querySelector(mode === 'voice' ? '.composer-mic' : 'textarea'), mode), true);
        assert.deepEqual(await page.evaluate(() => sent), []);
        assert.deepEqual(await page.evaluate(() => trace), []);
        assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('textarea').readOnly), false);
        await shot(`${mode}-return${covered ? '' : '-ungranted'}`);
      }
      await page.goto(`${server.url}/combined-fixture?locale=${locale}&unchosen`); await page.waitForFunction(() => globalThis.ready);
      assert.equal(await page.$eval('aithema-session', c => Boolean(c.shadowRoot.querySelector('.chooser'))), true);
      assert.deepEqual(await page.evaluate(() => trace), []);
      unmoved(initial, await shot('chooser'));
      await entranceFits(page, '.chooser');
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  }
  assert.equal(tables.length, 144);
  if (evidence) await writeFile(join(evidence, 'ait-506-rects.json'), JSON.stringify(tables, null, 2));
}
