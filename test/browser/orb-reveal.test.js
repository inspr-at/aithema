// AIT-140's isolated band, until AIT-131 owns the real header integration. Run remotely:
// remote-browser.sh <worktree> browser test/browser/orb-reveal.test.js
// AITHEMA_EVIDENCE_DIR receives frames, a timeline manifest and 50ms rendered-pixel exit samples.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url))), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function browserPath() {
  // Respect CHROME_PATH, including the refusing stub on mbp2607. Never override it.
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ...['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'],
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name))),
  ];
  for (const path of new Set(candidates)) { try { await access(path, constants.X_OK); return path; } catch { /* next */ } }
  throw new Error('Set CHROME_PATH to the remote browser executable');
}

const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>
:root { --paper:#fbf7ef; --surface:#fffcf8; --teal:#0e6f6c; --ink:#102b42; --muted:#496477; --line:rgba(16,43,66,.13); --display:Georgia,"Iowan Old Style","Palatino Linotype",serif; --ui:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; --mono:ui-monospace,"SF Mono",Menlo,monospace; color-scheme:light; }
:root[data-theme="dark"] { --paper:#0b1a26; --surface:#102433; --teal:#12908c; --ink:#eaf1f6; --muted:#9db4c4; --line:rgba(234,241,246,.14); color-scheme:dark; }
* { box-sizing:border-box; } body { margin:0; font:14px var(--ui); color:var(--ink); background:var(--paper); } button { font:inherit; color:inherit; cursor:pointer; border:0; background:none; }
.band { position:relative; isolation:isolate; display:grid; grid-template-columns:40px minmax(0,1fr) auto; align-items:center; gap:14px; height:84px; padding:12px 24px 18px 54px; background:linear-gradient(to bottom,color-mix(in srgb,var(--teal) 7%,var(--paper)),var(--paper)); }
.band::after { content:''; position:absolute; left:0; right:0; bottom:6px; height:1px; background:linear-gradient(to right,transparent,var(--line) 18%,var(--line) 82%,transparent); }
.band > .voice,.band > .nav { position:relative; z-index:1; display:flex; align-items:center; gap:10px; } .nav { justify-content:flex-end; }
.band > .orb { z-index:4; } .orb[role="button"] { cursor:pointer; } .orb:focus-visible { outline:2px solid var(--teal); outline-offset:3px; }
.voice button { display:grid; place-items:center; width:40px; height:40px; border-radius:50%; border:1px solid var(--line); background:color-mix(in srgb,var(--surface) 50%,transparent); }
.voice button svg { width:18px; height:18px; } .voice button.pause { background:var(--ink); color:var(--paper); } .voice .stop { color:#a3402a; }
.wave { position:relative; display:flex; align-items:center; justify-content:center; height:40px; gap:1.4px; width:200px; } .wave i { display:block; width:1.6px; background:var(--teal); opacity:.4; border-radius:2px; } .wave span { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); background:var(--paper); padding:3px 8px; color:var(--muted); font-size:11px; white-space:nowrap; }
.nav button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:44px; padding:0 6px; white-space:nowrap; } .nav svg { width:16px; height:16px; } .nav .settings { width:44px; padding:0; }
main { max-width:1100px; margin:60px auto; padding:0 54px; } h1 { margin:0 0 12px; font:400 48px/1.05 var(--display); letter-spacing:-.03em; } main p { color:var(--muted); line-height:1.6; } #outside { margin-top:20px; color:var(--teal); min-height:44px; padding:0 8px; }
@media(max-width:1100px) { .band { grid-template-columns:40px minmax(0,1fr); height:136px; row-gap:10px; } .voice { grid-column:1 / -1; grid-row:2; } .nav { grid-column:2; grid-row:1; } }
@media(max-width:600px) { .band { padding-right:14px; } .nav { gap:3px !important; } .nav button { font-size:11px; padding:0 2px; } .nav .appearance span { display:none; } .wave { width:116px; } .voice { gap:8px !important; } .voice button { width:36px; height:36px; } main { padding:0 24px; } h1 { font-size:38px; } }
</style></head><body><header class="band" id="band"><div class="voice" id="voice"></div><nav class="nav" id="nav"></nav></header><main><h1 id="heading"></h1><p id="intro"></p><button id="outside" type="button"></button><div id="component"></div></main><script type="module">
import { createOrb } from '/packages/ui/src/orb.js';
import { createReveal } from '/packages/ui/src/reveal.js';
import { icon } from '/packages/ui/src/icons.js';
import { en } from '/packages/ui/src/i18n/en.js';
import { de } from '/packages/ui/src/i18n/de.js';
const params = new URLSearchParams(location.search), locale = params.get('locale') || 'de', copy = locale === 'de' ? de : en;
document.documentElement.lang = locale; document.documentElement.dataset.theme = params.get('theme') || 'light';
const band = document.getElementById('band'), orb = createOrb(document, { motion: params.get('motion') !== 'off' }); band.prepend(orb.element); orb.mount();
const voice = document.getElementById('voice'), nav = document.getElementById('nav');
const control = (parent, name, cls, html) => { const button = document.createElement('button'); button.type = 'button'; button.className = cls; button.setAttribute('aria-label', name); button.setAttribute('data-reveal',''); button.innerHTML = html; parent.append(button); return button; };
control(voice, copy.voiceSpeakerOn, '', icon('volume'));
const wave = document.createElement('div'); wave.className = 'wave'; wave.setAttribute('data-reveal',''); for (let i=0;i<62;i++) { const bar=document.createElement('i'); bar.style.height=(4+Math.sin(i*.7)**2*16)+'px'; wave.append(bar); } const status=document.createElement('span'); status.textContent=copy.voiceStates.listening; wave.append(status); voice.append(wave);
control(voice, 'Pause', 'pause', icon('pause')); control(voice, copy.voiceMicOn, '', icon('mic')); control(voice, copy.voiceClose, 'stop', icon('stop'));
control(nav, locale==='de'?'Gespräche':'Conversations', 'conversations', (locale==='de'?'Gespräche':'Conversations')+' ▾');
const globe='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>';
const appearance=params.get('theme')==='dark'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></svg>';
control(nav, locale==='de'?'Sprache':'Language', 'language', globe+locale.toUpperCase()+' ▾');
control(nav, locale==='de'?'Darstellung':'Appearance', 'appearance', appearance+'<span>'+(locale==='de'?(params.get('theme')==='dark'?'Dunkel':'Hell'):(params.get('theme')==='dark'?'Dark':'Light'))+'</span> ▾');
control(nav, locale==='de'?'Einstellungen':'Settings', 'settings', icon('settings'));
const controls=[...band.querySelectorAll('[data-reveal]')], reveal=createReveal({band,orb,controls,links:copy.reveal.links,version:{product:'Aithema 2026.10',commit:'d886da3',date:'2026-10-12'},copy,motion:params.get('motion')!=='off'});
document.getElementById('heading').textContent=locale==='de'?'Ihr Projekt.':'Your project.'; document.getElementById('intro').textContent=copy.entrance.promise.slice(1).join(' '); document.getElementById('outside').textContent=locale==='de'?'Gespräch fortsetzen':'Continue conversation';
window.fixture={orb,reveal,band,controls,copy}; window.ready=true;
if(params.has('component')) { await import('/packages/ui/src/session-element.js'); const {createSession}=await import('/packages/core/src/session.js'); const element=document.createElement('aithema-session'); element.configure({copy,session:createSession({locale,demo:true})}); document.getElementById('component').append(element); window.component=element; }
</script></body></html>`;

async function server(t) {
  const host = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const file = resolve(repo, `.${path}`);
    if (!path.startsWith('/packages/') || !file.startsWith(repo + sep) || !file.endsWith('.js')) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening'); t.after(() => new Promise(resolve => host.close(resolve)));
  return `http://127.0.0.1:${host.address().port}`;
}

// Chrome's 1x1 RGB/RGBA PNG has one scanline. Its first pixel has no neighbours for PNG filtering.
function rgb(png) {
  const chunks = []; let type;
  for (let i = 8; i < png.length;) { const length = png.readUInt32BE(i), name = png.toString('ascii', i + 4, i + 8); const data = png.subarray(i + 8, i + 8 + length);
    if (name === 'IHDR') { assert.equal(data.readUInt32BE(0), 1); assert.equal(data.readUInt32BE(4), 1); assert.equal(data[8], 8); type = data[9]; }
    if (name === 'IDAT') chunks.push(data); i += length + 12;
  }
  assert.ok(type === 2 || type === 6); return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}
const layout = page => page.evaluate(() => window.fixture.controls.map(node => { const r = node.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }));
function assertStill(before, after, label) { before.forEach((box, i) => box.forEach((value, j) => assert.ok(Math.abs(after[i][j] - value) <= .5, `${label}: control ${i} dimension ${j} shifted`))); }
const freeze = page => page.evaluate(() => {
  window.timeline = window.fixture.band.getAnimations({subtree:true}).filter(animation => animation.animationName !== 'aithema-prism-turn');
  window.timeline.forEach(animation => { animation.pause(); animation.currentTime = 0; });
});
const seek = (page, ms) => page.evaluate(ms => { window.timeline.forEach(animation => animation.currentTime = ms); }, ms);

for (const locale of ['de', 'en']) test(`AIT-140 glass orb and reveal evidence: ${locale}, light/dark, 1440/1024/390`, { timeout: 240_000 }, async t => {
  const url = await server(t), evidence = process.env.AITHEMA_EVIDENCE_DIR, executablePath = await browserPath();
  const directory = await mkdtemp(join(tmpdir(), 'aithema-orb-'));
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: directory, env: { PATH:process.env.PATH, HOME:homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(() => browser.close()); if (evidence) await mkdir(evidence, {recursive:true});
  const page = await browser.newPage(), problems = [], colours = [], frames = [];
  page.on('pageerror', error => problems.push(error.message)); page.setDefaultTimeout(30_000);
  for (const theme of ['light','dark']) for (const width of [1440,1024,390]) {
    const label = `${locale}-${theme}-${width}`; await page.setViewport({width,height:width===390?844:900,deviceScaleFactor:1});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
    await page.goto(`${url}/?locale=${locale}&theme=${theme}`); await page.waitForFunction(() => window.ready); await page.mouse.move(0,400);
    const shot = async (name, ms) => { if(evidence) await page.screenshot({path:join(evidence,`${label}-${name}.png`),clip:{x:0,y:0,width,height:240}}); frames.push({label,name,animation_ms:ms}); };
    const baseline = await layout(page); assert.equal(await page.$eval('.orb', node => node.getBoundingClientRect().width),40);
    await page.evaluate(() => { const turn=window.fixture.orb.element.querySelector('.orb__prism').getAnimations()[0]; turn.pause(); turn.currentTime=0; }); await shot('orb-rest',0);
    await page.evaluate(() => { window.fixture.orb.element.querySelector('.orb__prism').getAnimations()[0].currentTime=3500; }); await shot('orb-turning',3500);
    await page.evaluate(() => { window.fixture.orb.setVoice('speaking'); window.fixture.orb.setEnergy(.7); window.fixture.orb.element.getAnimations({subtree:true}).forEach(a=>{if(a.animationName?.startsWith('aithema-glass')) {a.pause();a.currentTime=1200;}}); }); await shot('orb-speaking',1200);
    await page.evaluate(() => { window.fixture.orb.setVoice('listening'); window.fixture.orb.setEnergy(0); });
    // A real quick pointer pass must not start the sequence.
    const orbBox=await page.$eval('.orb',n=>{const r=n.getBoundingClientRect();return{x:r.x+20,y:r.y+20};});
    await page.mouse.move(orbBox.x,orbBox.y); await wait(120); await page.mouse.move(0,400); await wait(260);
    assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'closed',label+' quick pass');
    // Real dwell, then freeze only for deterministic timeline screenshots.
    await page.mouse.move(orbBox.x,orbBox.y); await page.waitForFunction(()=>window.fixture.band.dataset.aithemaRevealState==='open',{polling:10}); await freeze(page);
    for(const ms of [0,300,700,1200]) { await seek(page,ms); await shot(`reveal-${ms}ms`,ms); }
    await seek(page,2200); await shot('reveal-open',2200);
    const anchors=await page.$$eval('.aithema-reveal__link',nodes=>nodes.map(n=>({href:n.href,visible:getComputedStyle(n).opacity,rect:{x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,bottom:n.getBoundingClientRect().bottom},title:n.querySelector('.aithema-reveal__title').textContent})));
    assert.equal(anchors.length,3); assert.ok(anchors.every(n=>n.visible==='1'&&n.href.startsWith('https://')&&n.rect.right<=width+.5),label+' accessible links fit the band');
    const bandHeight=await page.$eval('#band',n=>n.getBoundingClientRect().height); assert.ok(anchors.every(n=>n.rect.bottom<=bandHeight),label+' links stay inside');
    // Hold cleanup while advancing genuine CSS transitions in 50ms steps. Every sample is a rendered pixel,
    // not an inferred CSS colour; animation time is independent of screenshot/remote-host latency.
    await page.evaluate(()=>{ const native=window.setTimeout; window.setTimeout=(fn)=>{window.exitCleanup=fn;return 0;}; window.fixture.reveal.close(); window.setTimeout=native; }); await freeze(page);
    const samples=[], samplePoint={x:width-8,y:bandHeight-10,width:1,height:1};
    for(let ms=0;ms<=900;ms+=50) { await seek(page,ms); const pixel=rgb(Buffer.from(await page.screenshot({clip:samplePoint}))); const opacity=await page.$eval('.aithema-reveal__glass',n=>Number(getComputedStyle(n).opacity)); samples.push({ms,rgb:pixel,glass_opacity:opacity}); if([0,300,700,900].includes(ms)) await shot(`exit-${ms}ms`,ms); }
    colours.push({label,source:'rendered 1x1 PNG pixels',clock:'paused CSS timeline advanced in exactly 50ms steps',point:samplePoint,samples});
    if(evidence) await writeFile(join(evidence,`exit-colour-samples-${locale}.json`),JSON.stringify(colours,null,2)+'\n');
    for(let channel=0;channel<3;channel++) { const direction=Math.sign(samples.at(-1).rgb[channel]-samples[0].rgb[channel]); for(let i=1;i<samples.length;i++) assert.ok((samples[i].rgb[channel]-samples[i-1].rgb[channel])*direction>=-2,`${label}: exit channel ${channel} changed direction at ${samples[i].ms}ms: ${JSON.stringify(samples)}`); }
    for(let i=1;i<samples.length;i++) assert.ok(samples[i].glass_opacity<=samples[i-1].glass_opacity+.0001);
    await seek(page,1500); await page.evaluate(()=>window.exitCleanup()); await shot('exit-restored',1500); assertStill(baseline,await layout(page),label+' after exit');
    assert.ok(await page.evaluate(()=>window.fixture.controls.every(n=>!n.inert&&getComputedStyle(n).opacity==='1'))); assert.equal(await page.$('.aithema-reveal__stars'),null);
    // Explicit motion off is a 200ms opacity-only crossfade with no decorative animation.
    await page.mouse.move(0,400); await page.evaluate(()=>{window.fixture.orb.setMotion(false);window.fixture.reveal.setMotion(false);window.fixture.orb.setVoice('speaking');window.fixture.orb.element.focus();}); await wait(250); await shot('motion-off-open',200);
    assert.equal(await page.$('.aithema-reveal__stars'),null);
    const calm=await page.evaluate(()=>{const {band,orb,controls}=window.fixture;return {animations:band.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({target:a.effect.target.className,name:a.animationName,property:a.transitionProperty})),ring:getComputedStyle(band.querySelector('.aithema-reveal__ring')).display,duration:getComputedStyle(band.querySelector('.aithema-reveal__glass')).transitionDuration,delays:controls.map(n=>getComputedStyle(n).transitionDelay),breath:getComputedStyle(orb.element.querySelector('.orb__body')).animationName};});
    assert.deepEqual(calm.animations,[],label+' calm'); assert.equal(calm.ring,'none'); assert.equal(calm.duration,'0.2s'); assert.ok(calm.delays.every(delay=>delay==='0s')); assert.equal(calm.breath,'none');
    await page.keyboard.press('Escape'); await wait(250); await shot('motion-off-closed',200); assertStill(baseline,await layout(page),label+' calm exit');
  }
  if(evidence) { await writeFile(join(evidence,`exit-colour-samples-${locale}.json`),JSON.stringify(colours,null,2)+'\n'); await writeFile(join(evidence,`timeline-${locale}.json`),JSON.stringify(frames,null,2)+'\n'); }
  assert.deepEqual(problems,[]); t.diagnostic(`${frames.length} frames; ${colours.length*19} rendered colour samples; all exit RGB channels monotonic within 2/255 quantisation tolerance.`);
});

test('AIT-140: real keyboard navigation, reduced-motion preference, hidden tab and existing component', {timeout:90_000}, async t=>{
  const url=await server(t), browser=await puppeteer.launch({executablePath:await browserPath(),headless:true,env:{PATH:process.env.PATH,HOME:homedir()},args:process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]}); t.after(()=>browser.close());
  const page=await browser.newPage(), problems=[]; page.on('pageerror',error=>problems.push(error.message));
  await page.setViewport({width:1440,height:900}); await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${url}/?locale=en&theme=light&component=1`); await page.waitForFunction(()=>window.ready&&window.component); await wait(250);
  assert.equal(await page.$eval('.orb',n=>n.dataset.orbMotion),'off'); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealMotion),'off');
  await page.keyboard.press('Tab'); assert.equal(await page.$eval('.orb',n=>document.activeElement===n),true); await wait(250);
  for(const href of ['https://aithema.inspr.at/','https://inspr.at/','https://augmentoring.com/']) {await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.href),href);}
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('.orb',n=>document.activeElement===n),true); await wait(250);
  assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'closed');
  await page.keyboard.press('Space'); await wait(250); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'open');
  await page.evaluate(()=>document.getElementById('outside').focus()); await wait(250); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'closed');
  const existing=await page.evaluate(()=>{const root=window.component.shadowRoot,orb=root.querySelector('.orb');return{slabs:orb.querySelectorAll('.orb__slab').length,canvas:!!orb.querySelector('canvas'),width:orb.getBoundingClientRect().width};}); assert.equal(existing.slabs,6);assert.equal(existing.canvas,false);assert.ok(existing.width>=64&&existing.width<=100);
  const evidence=process.env.AITHEMA_EVIDENCE_DIR;if(evidence)await page.screenshot({path:join(evidence,'existing-component-glass-orb.png')});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]); await page.evaluate(()=>{window.fixture.orb.setMotion(true);window.fixture.reveal.setMotion(true);});
  const other=await browser.newPage();await other.goto('about:blank');await other.bringToFront();await wait(100);
  // Headless Chrome may keep background pages visible; when it does, exercise its lifecycle via CDP.
  const client=await page.createCDPSession();await client.send('Page.setWebLifecycleState',{state:'frozen'});await client.send('Page.setWebLifecycleState',{state:'active'});await page.bringToFront();
  assert.deepEqual(problems,[]);
});
