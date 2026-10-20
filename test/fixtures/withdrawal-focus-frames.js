// AIT-385: offline, synchronous removal checks and settled viewport evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, htmlPreviewHostPolicy } from '../../packages/core/src/index.js';
import { previewFixture } from './html-preview-route.js';
import { installConsentClock } from './consent-clock.js';
import { browserForFile } from '../browser/shared-browser.js';

export async function withdrawalFocusFrames(t, { transcriptTop = false } = {}) {
  const root = new URL('../../', import.meta.url).pathname, preview = previewFixture();
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>
    body{margin:0} ait385-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}
    </style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';
    import {ConceptView} from '/packages/ui/src/concept-view.js';
    (${installConsentClock.toString()})();
    const update=ConceptView.prototype.update;
    ConceptView.prototype.update=function(){window.view=this;return update.apply(this,arguments);};
    customElements.define('ait385-session',class extends customElements.get('aithema-session'){connectedCallback(){}});
    window.mount=async({session,theme,locale})=>{window.c?.remove();const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
      const c=document.createElement('ait385-session');window.c=c;document.documentElement.lang=locale;
      c.configure({session,copy,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
      c.setAttribute('theme',theme);c.setAttribute('motion','off');document.body.append(c);
      view.update(session,{consentRevision:session.consentRevision,selected:['drafts','images'],features:{html:['drafts'],images:['images']}});};
    window.boxes=()=>[...c.shadowRoot.querySelectorAll('.transcript-shell,.turn,.composer')].map(n=>{const b=n.getBoundingClientRect();return[b.x,b.y,b.width,b.height];});
    window.withdraw=()=>{const s={...c.session,consentRevision:c.session.consentRevision+1};view.update(s,{consentRevision:s.consentRevision,selected:['images'],features:{html:['drafts'],images:['images']}});};
    window.inspect=old=>{const r=c.shadowRoot,box=n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};},
      notice=r.querySelector('.concept-withdrawn'),tile=r.querySelector('.concept-preview'),chevron=r.querySelector('.fold'),
      visible=n=>n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden'&&getComputedStyle(n).display!=='none',
      hit=r.elementFromPoint(old.x,old.y),nb=box(notice),cb=box(chevron),overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      return {focus:r.activeElement?.className,documentFocus:document.activeElement===c,focusVisible:!!r.activeElement&&visible(r.activeElement),
        notice:notice.textContent,noticeBox:nb,chevronBox:cb,gap:nb.top-cb.bottom,chevronOverlap:overlaps(nb,cb),
        overlaps:[...r.querySelectorAll('.turn,.speaker-name,.composer')].filter(n=>overlaps(nb,box(n))).map(n=>n.className),
        tileAbsent:!visible(tile),hitTile:!!hit?.closest('.concept-preview'),hit:hit?.className,
        hitTranscriptOrComposer:!!hit?.closest('.conversation,.transcript-shell,.composer-dock'),
        outline:getComputedStyle(notice).outlineStyle,layout:r.querySelector('.workspace').dataset.conceptLayout,boxes:boxes()};};
    window.ready=true;</script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (await preview(req, res)) return;
      if (path.endsWith('/preview')) return preview({url:'/fixture/mint',method:'POST',headers:req.headers,async *[Symbol.asyncIterator](){yield '<!doctype html><html><head><title>Draft</title></head><body>Offline draft</body></html>';}},res);
      if (path.endsWith('/eligibility')) { res.writeHead(200,{'content-type':'application/json'});return res.end('{}'); }
      if (path === '/') {res.writeHead(200,{'content-type':'text/html','content-security-policy':htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`)});return res.end(html);}
      if (/^\/packages\/(ui|core)\/src\/[\w/-]+\.(js|json)$/u.test(path)) {res.writeHead(200,{'content-type':path.endsWith('.json')?'application/json':'text/javascript'});return res.end(await readFile(join(root,path)));}
      res.writeHead(404);res.end();
    } catch(error) {res.writeHead(500);res.end(error.message);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await browserForFile();
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage(),checks=[],shots=[],evidence=process.env.AITHEMA_EVIDENCE_DIR && (transcriptTop ? join(process.env.AITHEMA_EVIDENCE_DIR, 'ait400') : process.env.AITHEMA_EVIDENCE_DIR);
  if(evidence)await mkdir(evidence,{recursive:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.ready);
  const configs=[
    [390,'light','de','t1'],[1440,'light','de','t1'],[390,'light','de','t2'],[1440,'light','de','t2'],
    [390,'light','en','t1'],[390,'dark','de','t1'],[1440,'dark','de','t1'],
  ];
  const mount=async(width,theme,locale,state,mixed=false,turns)=>{
    const session=createSession({demo:true});session.id='ait385';session.locale=locale;session.consentRevision=1;
    session.visualsBound=true;session.settings.visuals=state==='t2'?'off':'html';session.settings.origin='chosen';
    session.conceptVisualKind='html';session.conceptCost={maxMicro:0};
    session.transcript=[{id:'source',role:'user',content:locale==='de'?'Ein Dashboard für unser Team.':'A dashboard for our team.'}];if(turns)session.transcript=turns;session.inputRevision=1;
    session.concepts=[...(mixed?[{id:'image',mediaType:'image/png',turnIds:['source']}]:[]),{id:'draft',mediaType:'text/html',turnIds:['source']}];session.conceptStatus={phase:'ready'};
    session.featureMatrix={best:{text:{available:true},analysis:{available:true},html:{available:state!=='t2',reason:state==='t2'?'visuals off':undefined},images:{available:false,reason:'visual kind not selected'}}};
    await page.setViewport({width,height:width===390?844:900});await page.evaluate(mount=>window.mount(mount),{session,theme,locale});
    await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  };
  const capture=async(width,theme,locale,state)=>{
    await page.evaluate(async()=>{c.shadowRoot.activeElement?.blur();document.activeElement?.blur();await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    await page.mouse.move(-10,-10);const name=`${transcriptTop ? 'ait400' : 'ait385'}-${width}-${theme}-${locale}-${state}.png`;shots.push(name);
    if(evidence)await page.screenshot({path:join(evidence,name),fullPage:false,captureBeyondViewport:false});
  };
  if (transcriptTop) {
    const head = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.head?.sha : process.env.AITHEMA_COMMIT;
    for (const width of [390, 1024, 1440]) for (const locale of ['de', 'en']) await t.test(`${width}/light/${locale}`, async () => {
      const content = locale === 'de'
        ? ['Wir sind eine Bäckerei und wollen Vorbestellungen per App annehmen.', 'Abgeholt wird am nächsten Morgen in der Filiale.', 'Großkunden bestellen jede Woche dasselbe.', 'Danke. Wer holt die Bestellungen am Morgen ab?']
        : ['We are a bakery and want to accept preorders through an app.', 'Orders are collected the next morning at the shop.', 'Wholesale customers order the same items every week.', 'Thanks. Who collects the orders in the morning?'];
      const turns = content.map((content, i) => ({ id: i ? `turn-${i}` : 'source', role: i === 3 ? 'assistant' : 'user', content }));
      await mount(width, 'light', locale, 't1', false, turns);
      await page.mouse.move(-10, -10);
      const inspect = () => page.evaluate(() => {
        const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), box = n => { const b = n.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; };
        return { shell: box(shell), composer: box(r.querySelector('.composer')), slot: box(r.querySelector('.concept-bar')),
          top: shell.querySelector('.turn').getBoundingClientRect().top, scrollTop: shell.scrollTop,
          headerBottom: r.querySelector('.band').getBoundingClientRect().bottom,
          slotBottom: r.querySelector('.concept-bar').getBoundingClientRect().bottom,
          notice: r.querySelector('.concept-withdrawn').textContent,
          firstVisible: [...shell.querySelectorAll('.turn')].filter(n => n.getBoundingClientRect().bottom > shell.getBoundingClientRect().top + 8)
            .map(n => ({ id:n.dataset.id, top:n.getBoundingClientRect().top, bottom:n.getBoundingClientRect().bottom }))[0] };
      });
      const before = await inspect();
      await page.evaluate(() => withdraw());
      await capture(width, 'light', locale, 'transcript-withdrawal');
      const withdrawn = await inspect();
      await page.evaluate(() => clock.tick(4000));
      await capture(width, 'light', locale, 'transcript-expired');
      const expired = await inspect();
      checks.push({ width, locale, before, withdrawn, expired });
      if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head, capture:'viewport', blurred:true, reducedMotion:true, shots, checks }, null, 2));
      assert.deepEqual(withdrawn.slot, before.slot, 'AIT-400: status occupies the reserved slot at 0 px');
      assert.deepEqual(expired.slot, before.slot, 'AIT-400: status expiry preserves the reserved slot at 0 px');
      assert.deepEqual(withdrawn.shell, before.shell, 'AIT-400: withdrawal moves the scroll area 0 px');
      assert.deepEqual(expired.shell, before.shell, 'AIT-400: expiry moves the scroll area 0 px');
      assert.deepEqual(withdrawn.composer, before.composer, 'AIT-400: withdrawal moves the composer 0 px');
      assert.deepEqual(expired.composer, before.composer, 'AIT-400: expiry moves the composer 0 px');
      for (const state of [withdrawn, expired]) {
        assert.ok(state.shell[1] >= Math.max(state.headerBottom, state.slotBottom), `AIT-400: scroll area follows the last top row: ${JSON.stringify(state)}`);
        assert.ok(state.top >= Math.max(state.shell[1] + 8, state.headerBottom, state.slotBottom), `AIT-400: first bubble is wholly below the last top row and fade: ${JSON.stringify(state)}`);
      }
      // Read an interior turn, away from both ends; status changes must retain it.
      const long = Array.from({ length: 24 }, (_, i) => ({ ...turns[i % turns.length], id: i ? `reading-${i}` : 'source' }));
      await mount(width, 'light', locale, 't1', false, long);
      await page.evaluate(() => {
        const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), row = r.querySelector('[data-id="reading-10"]');
        // Scroll offsets are integer CSS pixels; round toward a fully visible row.
        shell.scrollTop = Math.floor(shell.scrollTop + row.getBoundingClientRect().top - shell.getBoundingClientRect().top - 8);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const reading = await inspect();
      assert.ok(reading.scrollTop > 0, 'reading anchor is away from the top');
      assert.equal(reading.firstVisible.id, 'reading-10', 'fixture starts on an interior row');
      assert.ok(reading.firstVisible.top >= reading.shell[1] + 8, 'fixture starts with the reading row fully visible');
      await page.evaluate(() => withdraw());
      await capture(width, 'light', locale, 'transcript-reading-withdrawal');
      const readingWithdrawn = await inspect();
      await page.evaluate(() => clock.tick(4000));
      await capture(width, 'light', locale, 'transcript-reading-expired');
      const readingExpired = await inspect();
      checks.at(-1).reading = { before:reading, withdrawn:readingWithdrawn, expired:readingExpired };
      if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head, capture:'viewport', blurred:true, reducedMotion:true, shots, checks }, null, 2));
      for (const state of [readingWithdrawn, readingExpired]) {
        assert.equal(state.scrollTop, reading.scrollTop, 'AIT-400: never jump to either end');
        assert.deepEqual(state.firstVisible, reading.firstVisible, 'AIT-400: keep the first visible reading row at 0 px');
        assert.ok(state.firstVisible.top >= Math.max(state.shell[1] + 8, state.headerBottom, state.slotBottom), 'AIT-400: the retained reading row is wholly below the last top row');
      }
    });
    return;
  }
  for(const [width,theme,locale,state] of configs)await t.test(`${state}/${width}/${theme}/${locale}`,async()=>{
    await mount(width,theme,locale,state);
    const before=await page.evaluate(()=>{const p=c.shadowRoot.querySelector('.concept-preview'),b=p.getBoundingClientRect();p.focus({preventScroll:true});return {old:{x:b.x+b.width/2,y:b.y+b.height/2},boxes:boxes()};});
    const result=await page.evaluate(old=>{withdraw();return inspect(old);},before.old);
    checks.push({width,theme,locale,state,...result,focusSteps:[result.focus],movementPx:Math.max(...result.boxes.flatMap((b,i)=>b.map((v,j)=>Math.abs(v-before.boxes[i][j]))))});
    assert.equal(result.focus,'concept-withdrawn','same-tick focus explains removal');assert.equal(result.documentFocus,true);assert.equal(result.focusVisible,true);
    assert.equal(result.tileAbsent,true,'empty tile is hidden in the removal tick');assert.equal(result.hitTile,false);assert.equal(result.hitTranscriptOrComposer,true);
    assert.equal(result.outline,'none','programmatic notice focus has no ring');assert.equal(result.chevronOverlap,false);
    if(width===390){assert.equal(result.chevronBox.height,44);assert.ok(result.gap>=8,`notice/chevron gap ${result.gap}px`);}
    assert.deepEqual(result.overlaps,[]);assert.deepEqual(result.boxes,before.boxes,'0 px below across removal');
    await capture(width,theme,locale,state);
    // Restore status focus after the evidence blur, then expire exactly 4 s.
    const after=await page.evaluate(()=>{c.shadowRoot.querySelector('.concept-withdrawn').focus();clock.tick(3999);const before=c.shadowRoot.activeElement?.className;clock.tick(1);return {before,focus:c.shadowRoot.activeElement?.className,boxes:boxes()};});
    assert.equal(after.before,'concept-withdrawn');assert.equal(after.focus,'consent-action');assert.deepEqual(after.boxes,before.boxes,'0 px notice to consent');checks.at(-1).focusSteps.push(after.before,after.focus);
    if(width===390&&theme==='light'&&locale==='de'&&state==='t1')await capture(width,theme,locale,'t4');
  });
  for(const origin of ['composer','viewer','tab','mixed'])await t.test(`focus/${origin}`,async()=>{
    await mount(390,'light','de','t1',origin==='mixed');
    const result=await page.evaluate(origin=>{const r=c.shadowRoot,p=r.querySelector('.concept-preview');p.focus();
      if(origin==='composer')r.querySelector('textarea').focus();if(origin==='viewer')view.open('draft');
      const before=r.activeElement;withdraw();return {same:before===r.activeElement,focus:r.activeElement?.className,open:view.dialog.open,items:view.items.map(i=>i.id)};},origin);
    if(origin==='composer'){assert.equal(result.same,true);await page.evaluate(()=>clock.tick(4000));assert.equal(await page.evaluate(()=>c.shadowRoot.activeElement?.tagName),'TEXTAREA');}
    else if(origin==='mixed'){assert.equal(result.focus,'concept-preview');assert.deepEqual(result.items,['image']);}
    else {assert.equal(result.focus,'concept-withdrawn');assert.equal(result.open,false);}
    if(origin==='tab'){await page.keyboard.press('Tab');const afterTab=await page.evaluate(()=>c.shadowRoot.activeElement?.className);assert.notEqual(afterTab,'concept-withdrawn');
      await page.evaluate(()=>clock.tick(4000));assert.equal(await page.evaluate(()=>c.shadowRoot.activeElement?.className),afterTab,'expiry never steals visitor focus');result.afterTab=afterTab;}
    checks.push({origin,...result});
  });
  if(evidence)await writeFile(join(evidence,'ait385-checks.json'),JSON.stringify({shots,checks,offline:true,viewportOnly:true},null,2));
}
