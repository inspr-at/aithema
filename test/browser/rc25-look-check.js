import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';

for (const finding of ['M1', 'M2']) test(`AIT-540 ${finding}: readable compact notice and one consent owner`, { timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc25-look-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile();
  const evidence=process.env.AITHEMA_EVIDENCE_DIR;
  if(evidence) await mkdir(join(evidence,'shots'),{recursive:true});
  t.after(async () => { await browser.close(); await server.kill(); });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390,568],[390,1000],[1024,1000],[1440,1000]]) await t.test(`${locale}/${theme}/${width}x${height}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height });
      await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:theme },{ name:'prefers-reduced-motion', value:'reduce' }]);
      await page.setRequestInterception(true);
      page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
        ? request.respond({ status:200, contentType:'text/html', body:fixture }) : request.continue()); });
      await page.goto(`${server.url}/combined-fixture?locale=${locale}`); await page.waitForFunction(() => globalThis.ready);
      const shot=async state=>{ if(evidence&&width!==1024) await page.screenshot({path:join(evidence,'shots',`ait-540-${finding}-${locale}-${theme}-${width}x${height}-${state}.png`),fullPage:false}); };
      await shot('ready');
      if (finding === 'M1') {
        const notice = await page.$eval('aithema-session', c => {
          const n=c.shadowRoot.querySelector('.composer-notice'), s=getComputedStyle(n), r=n.getBoundingClientRect();
          const summary=n.querySelector('summary, button[aria-haspopup="dialog"]');
          return { box:[r.x,r.y,r.width,r.height], overflow:s.overflowY, scroll:n.scrollHeight, client:n.clientHeight,
            summary:summary?.textContent, full:n.textContent, line:parseFloat(s.lineHeight) };
        });
        assert.ok(notice.box[2]>0 && notice.box[3]>0, 'positive notice geometry');
        assert.notEqual(notice.overflow, 'auto', 'AIT-540 M1: disclosure must not be a scrolling box');
        assert.ok(notice.scroll<=notice.client+1, 'AIT-540 M1: no clipped notice line');
        if(width<600) assert.match(notice.summary ?? '', locale==='de'?/Mehr/:/More/, 'first sentence plus disclosure');
        else assert.ok(notice.box[3]<notice.line*5, 'desktop notice uses its real content height');
        const presetBoxes=()=>page.$eval('aithema-session',c=>['textarea','.composer-mic','.send','.composer-feedback','.composer-status'].map(s=>{const r=c.shadowRoot.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));
        const beforePreset=await presetBoxes();beforePreset.forEach(b=>assert.ok(b[2]>0&&b[3]>0));
        await page.evaluate(()=>{const snapshot=c.session;snapshot.processingPreset='eu';snapshot.featureMatrix.eu=structuredClone(snapshot.featureMatrix.best);mount(snapshot);});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const afterPreset=await presetBoxes();afterPreset.forEach(b=>assert.ok(b[2]>0&&b[3]>0));
        for(let i=0;i<beforePreset.length;i++) for(let j=0;j<4;j++) assert.ok(Math.abs(beforePreset[i][j]-afterPreset[i][j])<=.5,
          `AIT-540 M1: notice content grows downward without moving control ${i}[${j}]: ${beforePreset[i][j]} -> ${afterPreset[i][j]}`);
        await shot('eu-notice');

        if(width<600) {
          const controls=()=>page.$eval('aithema-session',c=>['textarea','.composer-mic','.send','.composer-feedback','.composer-status'].map(s=>{const r=c.shadowRoot.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));
          const before=await controls(); before.forEach(b=>assert.ok(b[2]>0&&b[3]>0));
          await page.click('aithema-session >>> .composer-notice__more');
          await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.composer-notice-dialog').open);
          assert.equal(await page.$eval('aithema-session',c=>{const d=c.shadowRoot.querySelector('.composer-notice-dialog');return d.querySelector('p').textContent===c.shadowRoot.querySelector('.composer-notice__wide').textContent;}),true,'disclosure exposes the entire notice');
          await shot('notice-disclosed');
          await page.click('aithema-session >>> .composer-notice-dialog button');
          const after=await controls();after.forEach(b=>assert.ok(b[2]>0&&b[3]>0));
          assert.deepEqual(after,before,'disclosure keeps every control pinned');
        }
      } else {
        const consent = await page.$eval('aithema-session', c => {
          const r=c.shadowRoot;
          return { composer:r.querySelectorAll('.composer .consent-action').length, rail:r.querySelector('.voice-state').textContent,
            actions:r.querySelectorAll('.voice-state .consent-action, .ready__consent').length, ready:r.querySelector('.ready').textContent };
        });
        assert.equal(consent.composer,1,'one composer consent link');
        assert.equal(consent.actions,0,'AIT-540 M2: no second consent action in voice bar or ready card');
        assert.doesNotMatch(consent.rail,/consent|Einwillig/i,'voice bar asks nothing before the mic gesture');
        if(locale==='de') assert.doesNotMatch(consent.ready,/Freigabe|Freigegeben|Zustimmung/,'German consent uses Einwilligung');
        await page.goto(`${server.url}/combined-fixture?locale=${locale}&unchosen`);await page.waitForFunction(()=>globalThis.ready);
        await shot('chooser');
        // The short-phone evidence must include the same changed states as desktop.
        if(height===568) {
          await page.goto(`${server.url}/combined-fixture?locale=${locale}`);await page.waitForFunction(()=>globalThis.ready);
          await page.click('aithema-session >>> .composer-mic');await shot('voice-consent');
          await page.goto(`${server.url}/combined-fixture?locale=${locale}`);await page.waitForFunction(()=>globalThis.ready);
          await page.type('aithema-session >>> textarea','A retained draft');await page.click('aithema-session >>> .send');await shot('text-consent');
          await page.evaluate(()=>grant());await page.waitForFunction(()=>sent.length===1);await shot('text-sent');
          await page.evaluate(()=>{denied=true;});await page.click('aithema-session >>> .composer-mic');
          await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length>0);
          assert.equal(await page.$eval('aithema-session',c=>c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-message')),false,'blocked mic has one wording');
          await shot('microphone-blocked');
          await page.evaluate(()=>{denied=false;});await page.click('aithema-session >>> .composer-mic');
          await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.composer-mic').getAttribute('aria-pressed')==='true');await shot('listening');
          await page.click('aithema-session >>> .composer-mic');await shot('muted');
          await page.click('aithema-session >>> .voice-close');
          await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length>0);await shot('call-ended');
          await page.evaluate(()=>{failSend=true;});await page.type('aithema-session >>> textarea','Retain on failure');await page.click('aithema-session >>> .send');
          await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));await shot('call-ended-send-failed');
        }
      }
    } finally { await page.close(); }
  });
});
