import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';

for (const finding of ['M1', 'M2']) test(`AIT-540 ${finding}: readable compact notice and one consent owner`, { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc25-look-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile();
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
      if (finding === 'M1') {
        const notice = await page.$eval('aithema-session', c => {
          const n=c.shadowRoot.querySelector('.composer-notice'), s=getComputedStyle(n), r=n.getBoundingClientRect();
          const summary=n.querySelector('summary');
          return { box:[r.x,r.y,r.width,r.height], overflow:s.overflowY, scroll:n.scrollHeight, client:n.clientHeight,
            summary:summary?.textContent, full:n.textContent, line:parseFloat(s.lineHeight) };
        });
        assert.ok(notice.box[2]>0 && notice.box[3]>0, 'positive notice geometry');
        assert.notEqual(notice.overflow, 'auto', 'AIT-540 M1: disclosure must not be a scrolling box');
        assert.ok(notice.scroll<=notice.client+1, 'AIT-540 M1: no clipped notice line');
        if(width<600) assert.match(notice.summary ?? '', locale==='de'?/Mehr/:/More/, 'first sentence plus disclosure');
        else assert.ok(notice.box[3]<notice.line*5, 'desktop notice uses its real content height');
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
      }
    } finally { await page.close(); }
  });
});
