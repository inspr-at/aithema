// Static mocked component fixture; run only on the remote browser lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserForFile } from './shared-browser.js';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body { margin:0; } aithema-session { min-height:100dvh; } html { color-scheme:light; }
</style></head><body><script type="module">
import '/packages/ui/src/session-element.js';
import { createSession } from '/packages/core/src/session.js';
import { en } from '/packages/ui/src/i18n/en.js';
import { de } from '/packages/ui/src/i18n/de.js';
const c = document.createElement('aithema-session'); document.body.append(c);
const instant = 1800000000000;
const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } };
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': fixture\\n\\n')); } }));
  if (String(url).endsWith('/turns')) {
    const body = JSON.parse(options.body), start = c.session.seq;
    const events = [...(!c.session.transcript.length && c.session.opener ? [{ seq:start+1, type:'turn.final', data:{id:'host:opener',role:'assistant',origin:'host',content:c.session.opener.text} }] : [])];
    const event = { seq:start+events.length+1,type:'turn.final',data:{id:body.clientEventId,role:'user',content:body.content} }; events.push(event);
    return Response.json({...event,event,events});
  }
  return Response.json(c.session);
};
globalThis.seed = (locale, text, preset = 'best') => {
  const session = createSession({ locale, demo:true, processingPreset:preset });
  session.settings.origin = 'chosen';
  session.featureMatrix = { [preset]: { text:{available:true}, analysis:{available:true} } };
  if (text) session.opener = { text, locale };
  const deviceReasoning = { id:'fixture-device',model:'fixture-model',async connect(){},async *stream(request){ globalThis.deviceRequest=request; yield JSON.stringify({content:'A fixture reply.',question_short:null,options:[]});} };
  c.configure({copy:locale==='de'?de:en,session,deviceReasoning:preset==='device'?deviceReasoning:undefined});
  c.shadowRoot.querySelector('.ready__start').click();
};
globalThis.component = c; globalThis.ready = true;
</script></body></html>`;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const rects = page => page.evaluate(() => ['.composer', 'textarea', '.send'].map(selector => {
  const r = component.shadowRoot.querySelector(selector).getBoundingClientRect();
  return { selector, x:r.x, y:r.y, width:r.width, height:r.height };
}));
function positive(boxes) { for (const box of boxes) assert.ok(box.width > 0 && box.height > 0, `positive box: ${JSON.stringify(box)}`); }
function stable(before, after, label) {
  positive(before); positive(after);
  before.forEach((box, i) => { for (const key of ['x','y','width','height']) assert.ok(Math.abs(box[key]-after[i][key]) <= .5, `${label}/${box.selector}/${key}: ${box[key]} -> ${after[i][key]}`); });
}
test('AIT-505: opener EN/DE light/dark at 390/1024/1440; stable composer, persistence and first send', { timeout:180_000 }, async t => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/') { response.setHeader('content-type','text/html'); response.end(html); return; }
    const file = resolve(root, '.'+path);
    if (!path.startsWith('/packages/') || !file.startsWith(root+sep) || !/\.(?:js|json)$/u.test(file)) { response.writeHead(404).end(); return; }
    try { response.setHeader('content-type', file.endsWith('.json') ? 'application/json':'text/javascript'); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await browserForFile(); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => globalThis.ready);
  const tables=[]; const evidence=process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence,{recursive:true});
  for (const locale of ['en','de']) for (const theme of ['light','dark']) for (const width of [390,1024,1440]) await t.test(`${locale}/${theme}/${width}`, async () => {
    const text = locale==='de' ? 'Willkommen. Ihre KI-Assistenz ist bereit. Welches Vorhaben möchten Sie klären?' : 'Welcome. Your AI assistant is ready. What project would you like to clarify?';
    await page.setViewport({width,height:900});
    await page.evaluate(theme => {document.documentElement.style.colorScheme=theme;component.setAttribute('theme',theme);},theme);
    const seed = async text => { await page.evaluate((locale,text) => seed(locale,text),locale,text); await frames(page); };
    await seed(null); const empty=await rects(page); positive(empty);
    await seed(text); const shown=await rects(page); stable(empty,shown,'render-only');
    assert.equal(await page.evaluate(() => component.session.transcript.length),0);
    assert.equal(await page.evaluate(() => component.shadowRoot.querySelector('.workspace').dataset.understanding),'absent');
    const shot = async state => { if(evidence && width!==1024) await page.screenshot({path:join(evidence,`ait-505-${locale}-${theme}-${width}-${state}.png`),fullPage:true}); };
    await shot('opener');
    await page.evaluate(text => {globalThis.openerRow=component.shadowRoot.querySelector('[data-id="host:opener"]');component.receive({seq:1,type:'turn.final',data:{id:'host:opener',role:'assistant',origin:'host',content:text}});},text);
    await frames(page); const persisted=await rects(page);stable(shown,persisted,'persisted');
    assert.equal(await page.evaluate(() => openerRow===component.shadowRoot.querySelector('[data-id="host:opener"]')),true);
    await shot('persisted');
    await page.evaluate(() => component.receive({seq:2,type:'voice.interrupted',data:{id:'host:opener',interruption:{heardLength:'unknown'}}}));
    await frames(page);const interrupted=await rects(page);stable(persisted,interrupted,'interrupted');
    assert.equal(await page.evaluate(() => component.session.transcript[0].content),text);
    await shot('interrupted');
    const long=(text+' ').repeat(10).slice(0,1000);await seed(long);const longBoxes=await rects(page);stable(shown,longBoxes,'long');
    assert.equal(await page.evaluate(() => getComputedStyle(component.shadowRoot.querySelector('[data-id="host:opener"] .turn-text')).webkitLineClamp),'6');
    await shot('long');
    await page.click('aithema-session >>> .host-opener-more');
    await page.waitForFunction(() => component.shadowRoot.querySelector('.voice-reply-dialog').open);
    assert.equal(await page.evaluate(() => component.shadowRoot.querySelector('.voice-reply-text').textContent),long);
    await shot('read-full');await page.keyboard.press('Escape');
    await seed(text);await page.type('aithema-session >>> textarea',locale==='de'?'Ein Rechnungssystem.':'An invoice system.');await page.click('aithema-session >>> .send');
    await page.waitForFunction(() => component.session.transcript.some(t=>t.role==='user'));
    assert.deepEqual(await page.evaluate(() => component.session.transcript.map(t=>t.id==='host:opener'?'host':t.role)),['host','user']);
    assert.equal(await page.evaluate(() => component.shadowRoot.querySelectorAll('[data-id="host:opener"]').length),1);
    tables.push({locale,theme,width,empty,shown,persisted,interrupted,long:longBoxes});
  });
  assert.deepEqual(errors,[]);
  if(evidence) await writeFile(join(evidence,'ait-505-rects.json'),JSON.stringify(tables,null,2));
});
