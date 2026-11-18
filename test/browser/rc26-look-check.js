// RC25 findings 7–13, promoted to RC26. Each entrance gets a fresh document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';

const html = fixture.replace("import '/packages/ui/src/session-element.js';", `import '/packages/ui/src/session-element.js';
import { AudioRail } from '/packages/ui/src/audio-rail.js';
const render = AudioRail.prototype.render;
AudioRail.prototype.render = function () { globalThis.lookRail = this; return render.call(this); };`)
  .replace("entrance:'combined'", "entrance:new URL(location.href).searchParams.get('entrance')||'combined'");
const settle = page => page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(c.shadowRoot.getAnimations({subtree:true}).filter(a => a.playState==='running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
});
const boxes = (page, selectors) => page.evaluate(selectors => selectors.map(s => {
  const b=c.shadowRoot.querySelector(s).getBoundingClientRect(); return [b.x,b.y,b.width,b.height];
}), selectors);
const positive = values => values.forEach(b=>assert.ok(b[2]>0&&b[3]>0, `positive box ${b}`));
const stable = (a,b) => { positive(a);positive(b);assert.deepEqual(b,a,'exact 0 px layout shift'); };
const intersects = (a,b) => a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1];

for (const item of [7,8,9,10,11,12,13]) test(`AIT-541 look ${item}: RC26 visitor presentation`, {timeout:300_000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'aithema-rc26-look-'));
  const server=await startChild(new URL('../fixtures/no-provider-server.js',import.meta.url),join(dir,'fixture.sqlite'),{AITHEMA_VOICE_MODE:'off',AITHEMA_IMAGE_MODE:'off',AITHEMA_HTML_MODE:'off'});
  const browser=await browserForFile(), records=[];
  t.after(async()=>{await browser.close();await server.kill();});
  const evidence=process.env.AITHEMA_EVIDENCE_DIR;
  if(evidence) await mkdir(join(evidence,'look','r1'),{recursive:true});
  const widths=item===7?[390,393,1440]:[390,...[12,13].includes(item)?[1024,1200]:[],1440];
  for(const [locale,theme] of (item===9?[['en','light'],['en','dark'],['de','light'],['de','dark']]:[['en','light'],['de','dark']])) for(const width of widths) for(const entrance of [7,8].includes(item)?['combined','choice']:['combined']) await t.test(`${locale}/${theme}/${width}/${entrance}`,async()=>{
    const page=await browser.newPage(), label=`item-${item}-${locale}-${theme}-${width}-${entrance}`;
    try {
      await page.setViewport({width,height:1000});
      await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]);
      await page.setRequestInterception(true);
      page.on('request',r=>{void(new URL(r.url()).pathname==='/look-fixture'?r.respond({status:200,contentType:'text/html',body:html}):r.continue());});
      await page.goto(`${server.url}/look-fixture?locale=${locale}&entrance=${entrance}&opener`);
      await page.waitForFunction(()=>globalThis.ready);
      await page.evaluate(theme=>{c.setAttribute('theme',theme);c.style.setProperty('--aithema-height','100dvh');c.style.setProperty('--aithema-font','ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');c.style.setProperty('--aithema-display','Georgia,"Iowan Old Style","Palatino Linotype",serif');},theme);
      await settle(page);
      const shot=async state=>{await page.evaluate(()=>{c.shadowRoot.activeElement?.blur();document.activeElement?.blur();scrollTo(0,0);});await page.mouse.move(-1,-1);await settle(page);if(evidence)await page.screenshot({path:join(evidence,'look','r1',`${label}-${state}.png`),fullPage:false});};
      const live=async()=>{await page.evaluate(async()=>{const {inputRevision}=await import('/packages/core/src/session.js');const s=c.session;s.transcript=[{id:'u',role:'user',content:'A website'},{id:'a',role:'assistant',content:'Which visitors?'}];const revision=inputRevision(s);s.transcript[1].inputRevision=revision;Object.assign(s.understanding,{inputRevision:revision,readinessAssessed:true,draft:false,summary:'A website',openQuestions:['Which visitors?','Which languages?']});s.operations={inputRevision:revision,running:[],failures:[],lastFailure:null};s.featureMatrix.best={text:{available:true},analysis:{available:true},voice:{available:true}};granted=true;mount(s);});await settle(page);};
      if(item===7||item===8){
        if(item===8){
          await shot('before-start');
          const before=await page.evaluate(()=>({opener:!!c.shadowRoot.querySelector('[data-host-opener]'),start:!!c.shadowRoot.querySelector('.ready__start')}));
          records.push({label,before});
          assert.equal(before.start,entrance==='choice');assert.equal(before.opener,entrance==='combined');
        }
        if(entrance==='choice'){await page.evaluate(()=>grant());await settle(page);await page.click('aithema-session >>> .ready__mode[data-mode=type]');await page.click('aithema-session >>> .ready__start');await settle(page);}
        const pair=await boxes(page,['.fold','[data-host-opener]']);await shot('opener');
        records.push({label,pair});positive(pair);if(item===7)assert.equal(intersects(...pair),false,'fold never intersects the first bubble');
        const pinned=['.fold','.band','.display-foot'];const before=await boxes(page,pinned);
        await page.click('aithema-session >>> .fold');await settle(page);const folded=await boxes(page,pinned);
        await page.click('aithema-session >>> .fold');await settle(page);const unfolded=await boxes(page,pinned);
        records.push({label,pair,before,folded,unfolded});stable(before,folded);stable(before,unfolded);
      } else if(item===9){
        await live();
        await page.evaluate(async()=>{const {EmailOffer}=await import('/packages/ui/src/email-offer.js');const { [c.session.locale]:copy}=await import('/packages/ui/src/i18n/'+c.session.locale+'.js');const row=document.createElement('li');c.shadowRoot.querySelector('.transcript-shell ol').append(row);globalThis.lookOffer=new EmailOffer({root:c.shadowRoot,copy,verification:{email:{canCollect:true,delivery:true,demo:true,paintNotice(){}},canSave:false,async sendIdentityLink(){return {ok:false,status:400}}},session:()=>c.session,streaming:()=>false});lookOffer.paintRow(row);row.querySelector('input').value='a(b)@example.com';});
        await settle(page);const pinned=['.email-offer','input#email-offer-input','.email-offer__send','.composer'];const before=await boxes(page,pinned);await shot('email-ready');
        await page.evaluate(()=>lookOffer.save());await settle(page);await shot('email-refused');
        const refused=await page.evaluate(()=>{const input=c.shadowRoot.querySelector('#email-offer-input'),message=c.shadowRoot.querySelector('.email-offer__message'),probe=document.createElement('span');probe.style.color='var(--aithema-warning)';c.shadowRoot.append(probe);const warning=getComputedStyle(probe).color;probe.remove();return {invalid:input.getAttribute('aria-invalid'),outline:getComputedStyle(input).outlineStyle,icon:message.querySelector('svg')?.outerHTML,color:getComputedStyle(message).color,warning};});
        const after=await boxes(page,pinned);records.push({label,before,after,refused});stable(before,after);
        assert.equal(refused.invalid,'true');assert.equal(refused.outline,'solid');assert.ok(refused.icon);assert.equal(refused.color,refused.warning);
        await page.type('aithema-session >>> #email-offer-input','x');
        assert.equal(await page.$eval('aithema-session',c=>c.shadowRoot.querySelector('#email-offer-input').hasAttribute('aria-invalid')),false,'editing removes invalid state');stable(before,await boxes(page,pinned));
      } else if(item===10){
        await shot('processing');const copy=await page.evaluate(()=>({route:c.shadowRoot.querySelector('.ready__route').textContent,notice:c.shadowRoot.querySelector('.composer-notice__wide').textContent}));records.push({label,...copy});
        assert.doesNotMatch(copy.notice,/plugin|declared facts|Angaben des jeweiligen/iu);assert.equal(copy.route,'','processing is stated once on the combined ready screen');
        await page.evaluate(async()=>{const {[c.session.locale]:defaults}=await import('/packages/ui/src/i18n/'+c.session.locale+'.js');globalThis.fixtureCopy=structuredClone(defaults);fixtureCopy.settings.processingDetails.best='Host processing location override.';mount(c.session);});await settle(page);
        assert.match(await page.$eval('aithema-session',c=>c.shadowRoot.querySelector('.composer-notice__wide').textContent),/Host processing location override\./u);
      } else if(item===11){
        await live();const pinned=['textarea','.send','.composer-feedback'];const before=await boxes(page,pinned);await shot('message-ready');
        await page.evaluate(()=>{failSend=true;const input=c.shadowRoot.querySelector('textarea');input.value='A retained message';input.dispatchEvent(new Event('input',{bubbles:true}));c.shadowRoot.querySelector('.composer').requestSubmit();});
        await page.waitForFunction(()=>c.shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));await settle(page);await shot('message-failed');
        const line=await page.evaluate(()=>['.composer-reason .question-why','.send-failure-detail'].map(s=>{const n=c.shadowRoot.querySelector(s),r=document.createRange();r.selectNodeContents(n);const b=r.getBoundingClientRect(),style=getComputedStyle(n);return {size:style.fontSize,line:style.lineHeight,y:b.y,height:b.height};}));records.push({label,line});
        stable(before,await boxes(page,pinned));if(width>=600){assert.equal(line[0].size,line[1].size);assert.equal(line[0].line,line[1].line);assert.equal(line[0].y,line[1].y);assert.equal(line[0].height,line[1].height);}
      } else if(item===12){
        await live();const pinned=['.band','textarea','.send','.understanding .head'];const before=await boxes(page,pinned);
        for(const reason of ['idle','spend-deadline']){
          await page.evaluate(reason=>{lookRail.session=null;lookRail.endMessage(reason,{timeLimit:'call'});lookRail.render();},reason);await settle(page);await shot(reason);
          const pair=await boxes(page,['.voice-state','.understanding .head']);const text=await page.evaluate(()=>c.shadowRoot.querySelector('.voice-state .consent-narrow')?.dataset.copy);records.push({label,reason,pair,text});stable(before,await boxes(page,pinned));positive(pair);
          if(width<600)assert.match(text,locale==='en'?/keep typing|continue/i:/weiterschreiben|weiter/i,'visible label says the conversation continues');
          else assert.equal(intersects(...pair),false,'popup clears the overview heading');
          await page.evaluate(()=>lookRail.clearMessage());
        }
      } else if(item===13){
        await live();const pinned=['.open-question','.question-state','.composer','.understanding .foot'];const before=await boxes(page,pinned);await shot('question-ready');
        await page.evaluate(async()=>{const native=fetch;globalThis.fetch=(url,options)=>options?.method==='POST'&&String(url).endsWith('/focus-question')?Promise.resolve(Response.json({event:{seq:c.session.seq+1,type:'question.focused',data:{...c.openQuestionItems[0],questionId:c.openQuestionItems[0].id,requestId:'look-question',chosenBy:'user',inputRevision:c.session.operations.inputRevision}}},{status:202})):native(url,options);await c.focusQuestion(c.openQuestionItems[0].id);c.receive({type:'lane.failed',data:{lane:'reaction',retryable:true,inputRevision:c.session.operations.inputRevision}});});await settle(page);await shot('question-failed');
        const failure=await page.evaluate(()=>{const n=c.shadowRoot.querySelector('.open-question .question-why'),s=getComputedStyle(n);return {text:n.textContent,ellipsis:s.textOverflow,scroll:n.scrollWidth,client:n.clientWidth,state:n.closest('.open-question').dataset.state};});records.push({label,failure});
        assert.equal(failure.state,'retry');stable(before,await boxes(page,pinned));if(width>=600){assert.notEqual(failure.ellipsis,'ellipsis');assert.ok(failure.scroll<=failure.client,`complete failure text ${JSON.stringify(failure)}`);}
      }
    }catch(error){records.push({label,error:error.message});throw error;}finally{await page.close();}
  });
  if(evidence)await writeFile(join(evidence,'look','r1',`item-${item}-geometry.json`),JSON.stringify(records,null,2));
});
