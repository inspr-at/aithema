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

export async function withdrawalFocusFrames(t) {
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
        overlaps:[...r.querySelectorAll('.turn,.turn-role,.composer')].filter(n=>overlaps(nb,box(n))).map(n=>n.className),
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
  const page=await browser.newPage(),checks=[],shots=[],evidence=process.env.AITHEMA_EVIDENCE_DIR;
  if(evidence)await mkdir(evidence,{recursive:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.ready);
  const configs=[
    [390,'light','de','t1'],[1440,'light','de','t1'],[390,'light','de','t2'],[1440,'light','de','t2'],
    [390,'light','en','t1'],[390,'dark','de','t1'],[1440,'dark','de','t1'],
  ];
  const mount=async(width,theme,locale,state,mixed=false)=>{
    const session=createSession({demo:true});session.id='ait385';session.locale=locale;session.consentRevision=1;
    session.visualsBound=true;session.settings.visuals=state==='t2'?'off':'html';session.settings.origin='chosen';
    session.conceptVisualKind='html';session.conceptCost={maxMicro:0};
    session.transcript=[{id:'source',role:'user',content:locale==='de'?'Ein Dashboard für unser Team.':'A dashboard for our team.'}];session.inputRevision=1;
    session.concepts=[...(mixed?[{id:'image',mediaType:'image/png',turnIds:['source']}]:[]),{id:'draft',mediaType:'text/html',turnIds:['source']}];session.conceptStatus={phase:'ready'};
    session.featureMatrix={best:{text:{available:true},analysis:{available:true},html:{available:state!=='t2',reason:state==='t2'?'visuals off':undefined},images:{available:false,reason:'visual kind not selected'}}};
    await page.setViewport({width,height:width===390?844:900});await page.evaluate(mount=>window.mount(mount),{session,theme,locale});
    await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  };
  const capture=async(width,theme,locale,state)=>{
    await page.evaluate(async()=>{c.shadowRoot.activeElement?.blur();document.activeElement?.blur();await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    await page.mouse.move(-10,-10);const name=`ait385-${width}-${theme}-${locale}-${state}.png`;shots.push(name);
    if(evidence)await page.screenshot({path:join(evidence,name),fullPage:false,captureBeyondViewport:false});
  };
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
