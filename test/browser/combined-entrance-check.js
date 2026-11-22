import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';
export const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}aithema-session{--aithema-height:900px}</style></head><body><script type="module">
import '/packages/ui/src/session-element.js';
import {createSession} from '/packages/core/src/session.js';
import {voiceEvents} from '/packages/core/src/live-voice.js';
import {en} from '/packages/ui/src/i18n/en.js';
import {de} from '/packages/ui/src/i18n/de.js';
const locale=new URL(location.href).searchParams.get('locale')||'en';
document.documentElement.lang=locale;
Date.now=()=>1800000000000;
const saved=sessionStorage.getItem('combined-fixture-session');sessionStorage.removeItem('combined-fixture-session');
globalThis.failSend=false;globalThis.trace=[];globalThis.sent=[];globalThis.granted=Boolean(saved&&JSON.parse(saved).consentRevision>0);globalThis.denied=false;
if(new URL(location.href).searchParams.has('passiveDenied'))Object.defineProperty(navigator,'permissions',{value:{async query(){return {state:'denied'}}}});
const allowed={available:true},blocked={available:false,reason:'current processing consent required'};
const c=document.createElement('aithema-session');document.body.append(c);globalThis.c=c;
const nativeFetch=fetch;
globalThis.fetch=async(target,options={})=>{
 // The guarded owner-request helper sends absolute page-origin URLs; route on the path.
 const url=new URL(String(target),location.href).pathname;
 if(!url.startsWith('/api/sessions/'))return nativeFetch(target,options);
 if(url.endsWith('/events'))return new Response(new ReadableStream({start(controller){options.signal?.addEventListener('abort',()=>controller.close(),{once:true})}}));
 if(String(url).endsWith('/consent'))return Response.json({consentRevision:c.session.consentRevision,selected:[],features:{}});
 if(String(url).endsWith('/turns')){if(failSend)return Response.json({error:'fixture failure'},{status:503});const b=JSON.parse(options.body);sent.push(b);return Response.json({seq:c.session.seq+1,type:'turn.final',data:{id:b.clientEventId,role:'user',content:b.content,...b.voiceCallId?{voiceCallId:b.voiceCallId}:{}}})}
 const s=c.session;s.featureMatrix.best={text:granted?allowed:blocked,voice:granted?allowed:blocked,analysis:allowed};return Response.json(s);
};
const client={async start({callId}){trace.push('admission');trace.push('permission');if(denied)throw Object.assign(new Error('blocked'),{name:'NotAllowedError'});trace.push('call');const events=voiceEvents();return {callId,providerSessionId:'fixture',events,async setInput(value){trace.push(['capture',value])},async setOutput(){},async updateContext(){},async sendText(text){trace.push(['typed',text])},async pause(){return {acknowledged:true,paused:true}},async resume(){return {acknowledged:true,paused:false}},async heartbeat(){return {acknowledged:true,browserLivenessDeadlineAt:Date.now()+30000}},async close(){events.end();return {closureConfirmed:true}}}}};
globalThis.mount=(snapshot)=>{c.configure({entrance:'combined',copy:globalThis.fixtureCopy||(locale==='de'?de:en),session:snapshot||createSession({demo:true,locale,settings:{origin:'chosen',voice:'fixture'}}),voiceClient:client})};
const session=saved?JSON.parse(saved):createSession({demo:true,locale,settings:{origin:new URL(location.href).searchParams.has('unchosen')?'default':'chosen',voice:'fixture'}});if(new URL(location.href).searchParams.has('opener'))session.opener={text:locale==='de'?'Willkommen. Ihre KI-Assistenz ist für Sie bereit.':'Welcome. Your AI assistant is ready to help.',locale};session.featureMatrix={best:{text:granted?allowed:blocked,voice:granted?allowed:blocked,analysis:allowed}};mount(session);
c.addEventListener('aithema-consent',e=>{trace.push('consent');globalThis.consent=e.detail});
globalThis.grant=()=>{granted=true;c.receive({seq:c.session.seq+1,type:'consent.revised',data:{granted:true,changed:['text','voice'],removed:[]}})};
globalThis.ready=true;
</script></body></html>`;
const boxes = (page) => page.$eval('aithema-session', c => Object.fromEntries(['textarea', '.composer-mic', '.send', '.composer-status', '.composer-feedback'].map(selector => {
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
async function readableNotice(page) {
  const notice = await page.$eval('aithema-session', c => {
    const n=c.shadowRoot.querySelector('.composer-notice'), r=n.getBoundingClientRect();
    return { box:[r.x,r.y,r.width,r.height], scroll:n.scrollHeight, client:n.clientHeight,
      overflow:getComputedStyle(n).overflowY, phone:innerWidth<=600,
      sentence:n.querySelector('.composer-notice__first')?.textContent,
      more:n.querySelector('.composer-notice__more')?.textContent };
  });
  positive({notice:notice.box});
  assert.ok(notice.scroll<=notice.client+1,'AIT-540: every notice line is fully readable');
  assert.notEqual(notice.overflow,'auto','AIT-540: the notice is not a hidden scroll box');
  if(notice.phone) { assert.ok(notice.sentence?.trim()); assert.match(notice.more ?? '', /^(More|Mehr)$/u); }
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
async function exposedFeedback(page, selector) {
  const style = await page.$eval('aithema-session', (c, selector) => {
    const target = c.shadowRoot.querySelector(selector), feedback = c.shadowRoot.querySelector('.composer-feedback');
    const box = target.getBoundingClientRect();
    return { visibility: getComputedStyle(target).visibility, opacity: getComputedStyle(target).opacity,
      parentVisibility: getComputedStyle(feedback).visibility, text: target.textContent, box: [box.x, box.y, box.width, box.height] };
  }, selector);
  positive({ [selector]: style.box });
  assert.equal(style.parentVisibility, 'visible', 'mic status preserves the text feedback');
  assert.equal(style.visibility, 'visible'); assert.equal(style.opacity, '1'); assert.ok(style.text.trim());
  const cdp = await page.createCDPSession();
  try {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('aithema-session').shadowRoot.querySelector(${JSON.stringify(selector)})` });
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId });
    const live = nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
    assert.equal(live?.ignored, false, `${selector} stays in the accessibility tree`);
    assert.equal(live?.role?.value, 'status');
    assert.ok(live.properties.some(p => p.name === 'live' && p.value.value === 'polite'), 'feedback remains a polite live region');
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  } finally { await cdp.detach(); }
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
        const measured = await boxes(page); positive(measured); await readableNotice(page); tables.push({ locale, theme, width, state, boxes: measured });
        // AIT-587 (RC25 look 14): the fixture fixes the widget at 900 px in a 1000 px viewport; shoot the widget,
        // not the empty test page below it.
        const widget = await page.evaluate(() => { const r = document.querySelector('aithema-session').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, innerHeight - r.y) }; });
        if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, 'shots', `ait-506-${locale}-${theme}-${width}-${state}.png`), clip: widget });
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
      // Passive permission denial must coexist with consent, failure and Saved feedback.
      await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`); await page.waitForFunction(() => globalThis.ready);
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      const passive = await boxes(page); positive(passive); unmoved(initial, passive);
      await page.evaluate(() => grant());
      await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.text.available);
      await page.type('aithema-session >>> textarea', 'Retain on failure');
      await page.evaluate(() => { failSend = true; }); await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
      await exposedFeedback(page, '.composer-reason');
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('textarea').value), 'Retain on failure');
      unmoved(passive, await shot('microphone-blocked-send-failed'));
      await page.evaluate(() => { failSend = false; }); await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-saved-announcement').textContent.length > 0);
      await exposedFeedback(page, '.composer-saved-announcement');
      assert.equal(await page.$eval('aithema-session', c => getComputedStyle(c.shadowRoot.querySelector('.composer-saved')).opacity), '1');
      unmoved(passive, await shot('microphone-blocked-saved'));
      await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`); await page.waitForFunction(() => globalThis.ready);
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      await page.waitForFunction(() => Boolean(document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason .consent-action')));
      await exposedFeedback(page, '.composer-reason');
      unmoved(passive, await shot('microphone-blocked-consent'));
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
      assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-message')), false,
        'AIT-540: a blocked microphone is named once in the composer');
      assert.equal(await page.$eval('aithema-session', c => getComputedStyle(c.shadowRoot.querySelector('.composer-feedback')).visibility), 'visible',
        'microphone status keeps text feedback exposed');
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
      await page.click('aithema-session >>> .voice-close');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      unmoved(before, await shot('call-ended'));
      await page.type('aithema-session >>> textarea', 'Follow up after call');
      await page.evaluate(() => { failSend = true; }); await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
      await exposedFeedback(page, '.composer-reason');
      unmoved(before, await shot('call-ended-send-failed'));
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
      const continuation = await page.$eval('aithema-session', c => {
        const button = c.shadowRoot.querySelector('.chooser__continue');
        button.scrollIntoView({ block: 'nearest' });
        const box = button.getBoundingClientRect();
        const hit = c.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { box: [box.x, box.y, box.width, box.height], reachable: button === hit || button.contains(hit) };
      });
      positive({ continue: continuation.box });
      assert.equal(continuation.reachable, true, 'Continue remains reachable on the entrance surface');
      unmoved(initial, await boxes(page));
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  }
  assert.equal(tables.length, 204);
  if (evidence) await writeFile(join(evidence, 'ait-506-rects.json'), JSON.stringify(tables, null, 2));
}

// Dedicated integration matrix: the pre-input host row and every composer slot
// must fit above the real footer, including data-phone-short viewports.
export async function combinedOpenerCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-combined-opener-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, tables = [];
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390,1000],[1024,1000],[1440,1000],[390,620],[390,568]]) await t.test(`${locale}/${theme}/${width}x${height}`, async () => {
    const page = await browser.newPage(), problems = [];
    try {
      page.on('pageerror', error => problems.push(error.message));
      await page.setViewport({ width, height });
      await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:theme }, { name:'prefers-reduced-motion', value:'reduce' }]);
      await page.setRequestInterception(true);
      page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
        ? request.respond({ status:200, contentType:'text/html', body:fixture }) : request.continue()); });
      await page.goto(`${server.url}/combined-fixture?locale=${locale}&opener&passiveDenied`);
      await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      const shot = async state => {
        await settle();
        const measured = await boxes(page); await readableNotice(page);
        const placement = await page.$eval('aithema-session', c => {
          const root = c.shadowRoot, row = root.querySelector('[data-id="host:opener"]');
          const rect = node => { const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height]; };
          const selectors = ['[data-id="host:opener"]','textarea','.composer-mic','.send','.composer-feedback','.composer-status'];
          const shell=root.querySelector('.transcript-shell');
          return { shell:{box:rect(shell),height:shell.scrollHeight,client:shell.clientHeight,top:shell.scrollTop},
            concept:rect(root.querySelector('.concept-bar')),intro:root.querySelector('.intro').hidden?null:rect(root.querySelector('.intro')),opener:rect(row), footer:rect(root.querySelector('.display-foot')), dock:rect(root.querySelector('.composer-dock')),
            feedbackProbe:[...root.querySelectorAll('.composer-feedback, #composer-reason, .composer-feedback-reserve, .composer-feedback-reserve > *, .composer-feedback-reserve .question-status')].map(n=>({class:n.className,box:rect(n),text:n.textContent,font:getComputedStyle(n).font,lineHeight:getComputedStyle(n).lineHeight,display:getComputedStyle(n).display,overflow:getComputedStyle(n).overflow,align:getComputedStyle(n).alignItems})),
            scroll:rect(root.querySelector('.conversation-scroll')), short:root.querySelector('.workspace').hasAttribute('data-phone-short'),
            count:root.querySelectorAll('[data-id="host:opener"]').length,
            visible:selectors.map(selector => {const node=root.querySelector(selector),r=node.getBoundingClientRect();
              const hit=root.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
              return { selector,box:rect(node),hit:hit===node||node.contains(hit),visibility:getComputedStyle(node).visibility };}) };
        });
        measured.opener = placement.opener;
        positive(measured);
        positive({ footer:placement.footer, dock:placement.dock, scroll:placement.scroll });
        tables.push({locale,theme,width,height,state,boxes:measured,placement});
        if (evidence) await writeFile(join(evidence,'ait-506-opener-rects.json'),JSON.stringify(tables,null,2));
        if (evidence && width!==1024) await page.screenshot({ path:join(evidence,'shots',`ait-506-${locale}-${theme}-${width}x${height}-opener-${state}.png`),fullPage:false });
        assert.equal(placement.count,1,'one shared opener row');
        assert.equal(placement.short,height<=620,'short-phone matrix exercises the real layout flag');
        for (const target of placement.visible) {
          positive({[target.selector]:target.box});
          assert.ok(target.box[0]>=0 && target.box[1]>=0 && target.box[0]+target.box[2]<=width+.5 && target.box[1]+target.box[3]<=height+.5,
            `${locale}/${theme}/${width}x${height}/${state} visible ${target.selector}: ${JSON.stringify(placement)}`);
          assert.equal(target.visibility,'visible');
          assert.equal(target.hit,true,`${state}/${target.selector} is unobscured: ${JSON.stringify(placement)}`);
        }
        for (let i=0;i<placement.visible.length;i++) for(let j=i+1;j<placement.visible.length;j++) {
          const a=placement.visible[i],b=placement.visible[j],x=Math.min(a.box[0]+a.box[2],b.box[0]+b.box[2])-Math.max(a.box[0],b.box[0]),
            y=Math.min(a.box[1]+a.box[3],b.box[1]+b.box[3])-Math.max(a.box[1],b.box[1]);
          assert.ok(x<=.5||y<=.5,`${state}: ${a.selector} overlaps ${b.selector}`);
        }
        if (placement.intro) {
          positive({intro:placement.intro});
          assert.ok(placement.intro[1]>=placement.opener[1]+placement.opener[3]-.5,
            `readiness must not overlap the welcome: ${JSON.stringify(placement)}`);
        }
        assert.ok(placement.opener[1]>=placement.scroll[1]-.5 && placement.opener[1]+placement.opener[3]<=Math.min(placement.scroll[1]+placement.scroll[3],placement.dock[1])+.5,
          `opener fits above the composer: ${JSON.stringify(placement)}`);
        return measured;
      };
      const initial=await shot('ready');
      assert.equal(await page.$eval('aithema-session',c=>c.shadowRoot.querySelector('[data-id="host:opener"] .turn-text').textContent),
        locale==='de'?'Willkommen. Ihre KI-Assistenz ist für Sie bereit.':'Welcome. Your AI assistant is ready to help.',
        'the configured welcome preserves its UTF-8 text');
      await exposedFeedback(page,'.composer-reason');
      assert.equal(await page.evaluate(() => c.session.transcript.length),0);
      await page.type('aithema-session >>> textarea','A combined draft');await page.click('aithema-session >>> .send');
      unmoved(initial,await shot('consent'));
      await page.evaluate(() => {failSend=true;grant();});
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
      await exposedFeedback(page,'.composer-reason');
      unmoved(initial,await shot('send-failed'));
      await page.evaluate(() => {
        globalThis.openerRow=c.shadowRoot.querySelector('[data-id="host:opener"]');
        c.receive({seq:c.session.seq+1,type:'turn.final',data:{id:'host:opener',role:'assistant',origin:'host',content:c.session.opener.text}});
      });
      // AIT-553 item 5: playback gains its real row only after persistence.
      const canonical = { ...initial, opener: initial.opener.map((value, i) => i === 3 ? value + 44 : value) };
      unmoved(canonical,await shot('persisted'));
      assert.equal(await page.evaluate(() => openerRow===c.shadowRoot.querySelector('[data-id="host:opener"]')),true);
      await page.evaluate(() => {failSend=false;});await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => sent.length===1 && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-saved-announcement').textContent.length>0);
      await exposedFeedback(page,'.composer-saved-announcement');
      unmoved(canonical,await shot('saved'));
      await page.click('aithema-session >>> .composer-mic');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed')==='true');
      unmoved(canonical,await shot('listening'));
      await page.click('aithema-session >>> .voice-close');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length>0);
      unmoved(canonical,await shot('call-ended'));
      assert.deepEqual(problems,[]);
    } finally { await page.close(); }
  });
  assert.equal(tables.length,140);
}

export async function consentCancelCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-cancel-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, measurements = [];
  if (evidence) await mkdir(join(evidence, 'ait-542-look'), { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390,1000], [1440,1000], [390,568]]) {
    await t.test(`${locale}/${theme}/${width}x${height}`, async () => {
      const page = await browser.newPage(), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await page.setViewport({ width, height });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.setRequestInterception(true);
        page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture' && !new URL(request.url()).searchParams.has('consentPage')
          ? request.respond({ status: 200, contentType: 'text/html', body: fixture.replace('--aithema-height:900px', '--aithema-height:100dvh') }) : new URL(request.url()).searchParams.has('consentPage')
            ? request.respond({ status:200, contentType:'text/html', body:'<!doctype html><title>Host consent</title><p>Consent cancelled</p>' }) : request.continue()); });
        const visit = async () => { await page.goto(`${server.url}/combined-fixture?locale=${locale}`); await page.waitForFunction(() => globalThis.ready); };
        const shot = async state => {
          if (evidence) await page.screenshot({ path: join(evidence, 'ait-542-look', `${locale}-${theme}-${width}x${height}-${state}.png`) });
        };
        const idle = () => page.$eval('aithema-session', c => {
          const r=c.shadowRoot; return { readOnly:r.querySelector('textarea').readOnly, send:r.querySelector('.send').disabled,
            mic:r.querySelector('.composer-mic').disabled, draft:r.querySelector('textarea').value };
        });
        await visit();
        const draft = locale === 'de' ? 'Mein Entwurf bleibt erhalten.' : 'Keep my draft.';
        await page.type('aithema-session >>> textarea', draft);
        const before = await boxes(page); positive(before);
        await page.click('aithema-session >>> .send');
        assert.equal((await idle()).readOnly, true);
        const held = await boxes(page); unmoved(before, held); await shot('held');
        // Inspect inside the first animation frame after the host settles its dialog.
        const settled = await page.evaluate(() => new Promise(resolve => {
          consent.cancel();
          requestAnimationFrame(() => {
            const r=c.shadowRoot;
            resolve({ readOnly:r.querySelector('textarea').readOnly, send:r.querySelector('.send').disabled,
              mic:r.querySelector('.composer-mic').disabled, draft:r.querySelector('textarea').value });
          });
        }));
        assert.deepEqual(settled, { readOnly:false, send:false, mic:false, draft });
        const after = await boxes(page); unmoved(held, after); await shot('idle');
        measurements.push({ locale, theme, width, height, before:held, after, settled });
        await page.evaluate(() => { consent.cancel(); grant(); });
        await page.waitForFunction(() => c.session.featureMatrix.best.text.available);
        assert.equal(await page.evaluate(() => sent.length), 0, 'cancelled intent cannot submit after a later grant');
        assert.equal((await idle()).draft, draft);
        // A real navigation to a separate host page and back without any grant.
        for (const mode of ['text', 'voice']) {
          await visit(); await page.type('aithema-session >>> textarea', draft);
          await page.click(`aithema-session >>> ${mode === 'text' ? '.send' : '.composer-mic'}`);
          assert.equal((await idle()).readOnly, true, `${mode} start holds the field before navigating to consent`);
          await page.evaluate(() => sessionStorage.setItem('combined-fixture-session', JSON.stringify(c.session)));
          await page.goto(`${server.url}/combined-fixture?consentPage`);
          await page.goBack(); await page.waitForFunction(() => globalThis.ready);
          await page.waitForFunction(() => !c.shadowRoot.querySelector('textarea').readOnly);
          assert.deepEqual(await idle(), { readOnly:false, send:false, mic:false, draft });
          assert.equal(await page.evaluate(() => c.session.consentRevision), 0);
          assert.deepEqual(await page.evaluate(() => sent), []);
          assert.equal(await page.evaluate(() => trace.includes('permission')), false);
          assert.equal(await page.evaluate(() => sessionStorage.getItem('aithema-start-intent')), null);
        }
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  if (evidence) await writeFile(join(evidence, 'ait-542-look', 'measurements.json'), JSON.stringify(measurements, null, 2));
}
