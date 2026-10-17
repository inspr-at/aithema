// AIT-140's isolated band, until AIT-131 owns the real header integration. Run remotely:
// remote-browser.sh <worktree> browser test/browser/orb-reveal.test.js
// AITHEMA_EVIDENCE_DIR receives frames, a timeline manifest and 50ms rendered-pixel exit samples.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { after, test } from 'node:test';
import { browserForFile } from './shared-browser.js';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url))), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// One fixture host, browser and primary page for all serial scenarios. The
// keyboard lifecycle proof still creates its explicit background-tab probe.
let fileHost, fileBrowser, primaryPage, closeHost;
after(async () => { await fileBrowser?.close(); await closeHost?.(); });
const orbBrowser = async () => fileBrowser ??= await browserForFile();
async function pageForFile(browser) {
  primaryPage ??= await browser.newPage();
  await primaryPage.bringToFront();
  await primaryPage.goto('about:blank');
  primaryPage.removeAllListeners('pageerror');
  await primaryPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  return primaryPage;
}
const server = () => fileHost ??= createFileServer();
// Capture the same rendered 1x1 PNG through CDP, without Puppeteer's general
// screenshot viewport/setup work. Pixel values and live timestamps stay intact.
async function pixel(page, clip) {
  page.pixelSession ??= await page.createCDPSession();
  const { data } = await page.pixelSession.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: 1 },
  });
  return rgb(Buffer.from(data, 'base64'));
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

async function createFileServer() {
  const host = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const file = resolve(repo, `.${path}`);
    if (!path.startsWith('/packages/') || !file.startsWith(repo + sep) || !(file.endsWith('.js') || path === '/packages/ui/src/versioning/display.json')) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/javascript'); res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening'); closeHost = () => new Promise(resolve => host.close(resolve));
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
const freeze = page => page.evaluate(async () => {
  window.timeline = window.fixture.band.getAnimations({subtree:true}).filter(animation => animation.animationName !== 'aithema-prism-turn');
  window.timeline.forEach(animation => { animation.pause(); animation.currentTime = 0; });
  await Promise.all(window.timeline.map(animation => animation.ready));
});
const seek = (page, ms) => page.evaluate(async ms => {
  window.timeline.forEach(animation => animation.currentTime = ms);
  // A seek changes computed styles immediately; capture after the compositor paints them.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, ms);

function assertMonotonicRgb(samples, label) {
  for (let channel = 0; channel < 3; channel++) {
    const values = samples.map(sample => sample.rgb[channel]), direction = Math.sign(values.at(-1) - values[0]);
    if (direction === 0) {
      assert.ok(Math.max(...values) - Math.min(...values) <= 2, `${label}: equal endpoints hide a variation in channel ${channel}: ${values}`);
    } else {
      for (let i = 1; i < values.length; i++) assert.ok((values[i] - values[i - 1]) * direction >= -2, `${label}: exit channel ${channel} changed direction at sample ${i}: ${values}`);
    }
  }
}

test('AIT-140: monotonic RGB checks reject excursions with equal endpoints', () => {
  const samples = values => values.map(value => ({ rgb: [100, value, 100] }));
  assert.doesNotThrow(() => assertMonotonicRgb(samples([100, 101, 100]), 'quantisation'));
  assert.doesNotThrow(() => assertMonotonicRgb(samples([100, 150, 200]), 'rising'));
  assert.doesNotThrow(() => assertMonotonicRgb(samples([200, 150, 100]), 'falling'));
  assert.throws(() => assertMonotonicRgb(samples([100, 200, 100]), 'excursion'), /equal endpoints/);
  assert.throws(() => assertMonotonicRgb(samples([100, 80, 100]), 'dip'), /equal endpoints/);
});

const exitOpacities = page => page.evaluate(() => ({
  brand_row_opacity: Number(getComputedStyle(window.fixture.band.querySelector('.aithema-reveal__row')).opacity),
  control_opacities: window.fixture.controls.map(node => Number(getComputedStyle(node).opacity)),
  proxy_opacities: [...window.fixture.band.querySelectorAll('.aithema-reveal__proxy')].map(node => Number(getComputedStyle(node).opacity)),
}));
function assertExitOverlap(sample, label) {
  if (sample.brand_row_opacity > .25) assert.ok([...sample.control_opacities, ...sample.proxy_opacities].every(value => value <= .25), `${label}: brand and returning controls exceed 25% together: ${JSON.stringify(sample)}`);
}
function contrastRatio(foreground, background) {
  const luminance = channels => channels.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
// Timeline frames may intentionally be intermediate. Contrast belongs to the settled
// reveal: finish the actual finite effects rather than assuming a 2200ms seek is enough.
async function settleReveal(page, label) {
  const state = await page.evaluate(async () => {
    const { band, controls } = window.fixture;
    const animations = band.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime));
    await Promise.all(animations.map(animation => animation.ready));
    animations.forEach(animation => animation.finish());
    await Promise.all(animations.map(animation => animation.finished));
    // Let the settled styles reach a painted frame before the backdrop capture.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { phase: band.dataset.aithemaRevealState,
      glass: getComputedStyle(band.querySelector('.aithema-reveal__glass')).opacity,
      brand: getComputedStyle(band.querySelector('.aithema-reveal__row')).opacity,
      controls: controls.map(node => getComputedStyle(node).opacity),
      links: [...band.querySelectorAll('.aithema-reveal__link')].map(node => getComputedStyle(node).opacity) };
  });
  assert.equal(state.phase, 'open', label + ' contrast belongs to the open reveal');
  assert.equal(state.glass, '1', label + ' settled glass');
  assert.equal(state.brand, '1', label + ' settled brand');
  assert.ok(state.controls.every(opacity => opacity === '0'), label + ' settled hidden controls');
  assert.ok(state.links.every(opacity => opacity === '1'), label + ' settled links');
}

async function renderedTextContrast(page, label) {
  await settleReveal(page, label);
  const { targets, clip } = await page.evaluate(() => {
    const { band } = window.fixture;
    const targets = [...band.querySelectorAll('.aithema-reveal__letter,.aithema-reveal__title,.aithema-reveal__subtitle,.aithema-reveal__version > *')].filter(node => getComputedStyle(node).display !== 'none').map(node => {
      const rect = node.getBoundingClientRect(), colour = getComputedStyle(node).color.match(/[\d.]+/g).map(Number);
      // Inspect the whole text box, conservatively including gaps and the title arrow.
      return { element: node.className || node.tagName.toLowerCase(), text: node.textContent, colour, rect: { x: Math.floor(rect.x), y: Math.floor(rect.y), right: Math.ceil(rect.right), bottom: Math.ceil(rect.bottom) } };
    });
    band.querySelector('.aithema-reveal__row').style.visibility = 'hidden';
    band.querySelector('.aithema-reveal__stars')?.style.setProperty('visibility', 'hidden');
    const rect = band.getBoundingClientRect();
    return { targets, clip: { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) } };
  });
  try {
    for (const target of targets) assert.ok(target.rect.x >= clip.x && target.rect.y >= clip.y && target.rect.right <= clip.x + clip.width && target.rect.bottom <= clip.y + clip.height, label + ' text stays inside the sampled band');
    // Decode one rendered backdrop in the remote browser. Glass, warm wash and white glare stay visible.
    const png = Buffer.from(await page.screenshot({ clip })).toString('base64');
    const pixels = await page.evaluate(async ({ png, targets, clip }) => {
      const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      return targets.map(target => {
        const colours = new Map(); let sampled = 0;
        for (let y = target.rect.y; y < target.rect.bottom; y++) for (let x = target.rect.x; x < target.rect.right; x++) {
          const offset = ((y - clip.y) * canvas.width + x - clip.x) * 4;
          const colour = Array.from(data.subarray(offset, offset + 3));
          colours.set(colour.join(','), { background_rgb: colour, point: { x, y } }); sampled++;
        }
        return { sampled, backgrounds: [...colours.values()] };
      });
    }, { png, targets, clip });
    for (const [index, target] of targets.entries()) {
      const alpha = target.colour[3] ?? 1;
      assert.deepEqual(target.colour.slice(0, 3), [255, 255, 255], label + ' white copy');
      assert.ok(alpha >= (target.element.includes('title') && !target.element.includes('subtitle') ? 1 : .9), label + ' copy opacity');
      const samples = pixels[index].backgrounds.map(sample => {
        const foreground = target.colour.slice(0, 3).map((value, i) => alpha * value + (1 - alpha) * sample.background_rgb[i]);
        return { ...sample, contrast: contrastRatio(foreground, sample.background_rgb) };
      });
      assert.ok(samples.length > 0, label + ' rendered text backdrop');
      Object.assign(target, samples.reduce((minimum, sample) => sample.contrast < minimum.contrast ? sample : minimum), { sampled_pixels: pixels[index].sampled });
      assert.ok(target.contrast >= 4.5, `${label}: ${target.text} contrast ${target.contrast.toFixed(2)}:1`);
    }
  } finally {
    await page.evaluate(() => { window.fixture.band.querySelector('.aithema-reveal__row').style.removeProperty('visibility'); window.fixture.band.querySelector('.aithema-reveal__stars')?.style.removeProperty('visibility'); });
  }
  return targets;
}
async function assertFocusRing(page, label) {
  const ring = await page.$eval('.orb', node => { const style = getComputedStyle(node); return { visible: node.matches(':focus-visible'), colour: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset, halo: style.boxShadow, breathOpacity: getComputedStyle(node.querySelector('.orb__breath')).opacity }; });
  assert.equal(ring.visible, true, label + ' keyboard focus'); assert.equal(ring.colour, 'rgba(255, 255, 255, 0.7)'); assert.equal(ring.width, '2px'); assert.equal(ring.offset, '2px');
  assert.equal(ring.halo, 'rgb(16, 43, 66) 0px 0px 0px 5px', label + ' 1px dark halo outside the outline'); return ring;
}
async function assertCalmUnderline(page, label) {
  const underline = await page.$eval('.aithema-reveal__link', node => {
    const title = node.querySelector('.aithema-reveal__title'), style = getComputedStyle(title, '::after');
    return { duration: style.transitionDuration, transform: style.transform, animations: title.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').map(animation => animation.transitionProperty) };
  });
  assert.equal(underline.duration, '0s', label); assert.equal(underline.transform, 'matrix(1, 0, 0, 1, 0, 0)', label); assert.deepEqual(underline.animations, [], label);
}

test('AIT-153: contrast waits for delayed entry and still rejects a settled contrast defect', { timeout: 60_000 }, async t => {
  const url = await server(t), browser = await orbBrowser();
  const page = await pageForFile(browser); await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${url}/?locale=en&theme=light`); await page.waitForFunction(() => window.ready);
  assert.equal(await page.$eval('.aithema-reveal__glass', node => getComputedStyle(node).opacity), '0', 'the closed backdrop is established before opening');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    // Delay the genuine glass transition past the old screenshot clock. Text
    // is already visible while its backdrop is still entering on a busy runner.
    const style = document.createElement('style');
    style.textContent = '.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__glass { transition-delay:3s !important; }';
    document.head.append(style);
    document.querySelector('.orb').focus();
  });
  assert.equal(await page.$eval('.aithema-reveal__glass', node => getComputedStyle(node).transitionDelay), '3s', 'the fixture delays the actual glass transition');
  await freeze(page); await seek(page, 2200);
  await renderedTextContrast(page, 'delayed entry');
  await page.evaluate(() => { window.fixture.band.querySelector('.aithema-reveal__glass').style.background = '#fff'; });
  await assert.rejects(renderedTextContrast(page, 'settled defect'), /contrast [\d.]+:1/);
});

for (const locale of ['de', 'en']) test(`AIT-140 glass orb and reveal evidence: ${locale}, light/dark, 1440/1024/390`, { timeout: 240_000 }, async t => {
  const url = await server(t), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const browser = await orbBrowser(); if (evidence) await mkdir(evidence, {recursive:true});
  const page = await pageForFile(browser), problems = [], colours = [], frames = [], metrics = [], client = await page.createCDPSession();
  page.on('pageerror', error => problems.push(error.message)); page.setDefaultTimeout(30_000);
  for (const theme of ['light','dark']) for (const width of [1440,1024,390]) {
    const label = `${locale}-${theme}-${width}`; await page.setViewport({width,height:width===390?844:900,deviceScaleFactor:1});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
    await page.goto(`${url}/?locale=${locale}&theme=${theme}`); await page.waitForFunction(() => window.ready); await page.mouse.move(0,400);
    const shot = async (name, ms) => { if(evidence) await page.screenshot({path:join(evidence,`${label}-${name}.png`),clip:{x:0,y:0,width,height:240}}); frames.push({label,name,animation_ms:ms}); };
    const baseline = await layout(page); assert.equal(await page.$eval('.orb', node => node.getBoundingClientRect().width),40);
    const edgePoint = await page.$eval('#band', node => ({ x: Math.floor(node.getBoundingClientRect().width / 2), y: Math.round(node.getBoundingClientRect().bottom - parseFloat(getComputedStyle(node, '::after').bottom) + 1), width: 1, height: 1 }));
    const belowHairline = await pixel(page, edgePoint);
    await page.evaluate(() => { const turn=window.fixture.orb.element.querySelector('.orb__prism').getAnimations()[0]; turn.pause(); turn.currentTime=0; }); await shot('orb-rest',0);
    await page.evaluate(() => { window.fixture.orb.element.querySelector('.orb__prism').getAnimations()[0].currentTime=2450; }); await shot('orb-turning',2450);
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
    const anchors=await page.$$eval('.aithema-reveal__link',nodes=>nodes.map(n=>{const title=n.querySelector('.aithema-reveal__title'), subtitle=n.querySelector('.aithema-reveal__subtitle'), rect=title.getBoundingClientRect();return {href:n.href,visible:getComputedStyle(n).opacity,rect:{x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,bottom:n.getBoundingClientRect().bottom},title:title.textContent,tooltip:n.title,subtitle:subtitle.textContent,subtitleDisplay:getComputedStyle(subtitle).display,titleRect:{x:rect.x,y:rect.y,right:rect.right,height:rect.height,contentHeight:rect.height-parseFloat(getComputedStyle(title).paddingTop)-parseFloat(getComputedStyle(title).paddingBottom),lineHeight:parseFloat(getComputedStyle(title).lineHeight)},subtitleFits:subtitle.scrollWidth<=subtitle.clientWidth};}));
    assert.equal(anchors.length,3); assert.ok(anchors.every(n=>n.visible==='1'&&n.href.startsWith('https://')&&n.rect.right<=width+.5),label+' accessible links fit the band');
    assert.ok(anchors.every(n=>n.subtitleFits),label+' subtitles fit their columns');
    assert.ok(anchors.every(n=>n.tooltip===n.subtitle),label+' subtitles remain available as link titles');
    const wordmarkBox=await page.$eval('.aithema-reveal__wordmark',n=>({bottom:n.getBoundingClientRect().bottom})), versionBox=await page.$eval('.aithema-reveal__version',n=>({top:n.getBoundingClientRect().top,right:n.getBoundingClientRect().right}));
    if(width<600) { assert.ok(anchors.every(n=>n.subtitleDisplay==='none'&&n.titleRect.contentHeight<=n.titleRect.lineHeight+.5&&n.titleRect.right<=width),label+' mobile titles only'); assert.ok(anchors.every(n=>Math.abs(n.titleRect.y-anchors[0].titleRect.y)<=.5&&n.titleRect.y>wordmarkBox.bottom),label+' one link row under wordmark'); assert.ok(versionBox.top<anchors[0].titleRect.y&&versionBox.right>=anchors.at(-1).titleRect.right,label+' version at top right'); }
    const edge=await page.evaluate(()=>{const {band}=window.fixture,fx=band.querySelector('.aithema-reveal__fx'),b=band.getBoundingClientRect();return {hairlineBottom:b.bottom-parseFloat(getComputedStyle(band,'::after').bottom),glassClipBottom:fx.getBoundingClientRect().bottom};});
    assert.ok(Math.abs(edge.hairlineBottom-edge.glassClipBottom)<=.5,label+' glass ends at hairline');
    assert.deepEqual(await pixel(page, edgePoint),belowHairline,label+' no glass below hairline');
    if(evidence) { const crop={x:Math.max(0,Math.floor(width/2)-120),y:edge.hairlineBottom-8,width:Math.min(width,240),height:16,scale:3}; const {data}=await client.send('Page.captureScreenshot',{format:'png',clip:crop}); await writeFile(join(evidence,`${label}-glass-bottom-edge-3x.png`),Buffer.from(data,'base64')); }
    const contrast=await renderedTextContrast(page,label); metrics.push({label,edge,anchors,wordmark:wordmarkBox,version:versionBox,text_contrast:contrast});
    const bandHeight=await page.$eval('#band',n=>n.getBoundingClientRect().height); assert.ok(anchors.every(n=>n.rect.bottom<=bandHeight),label+' links stay inside');
    // Hold cleanup while advancing genuine CSS transitions in 50ms steps. Every sample is a rendered pixel,
    // not an inferred CSS colour; animation time is independent of screenshot/remote-host latency.
    await page.evaluate(()=>{ const native=window.setTimeout; window.setTimeout=(fn)=>{window.exitCleanup=fn;return 0;}; window.fixture.reveal.close(); window.setTimeout=native; }); await freeze(page);
    // Paused animation seeks update computed opacity synchronously. Read every
    // original 10ms point in-page; the 50ms rendered-PNG sweep below still waits
    // for the compositor after each seek, with every original sample retained.
    const overlapSamples = await page.evaluate(() => {
      const { band, controls } = window.fixture, samples = [];
      for (let ms = 0; ms <= 300; ms += 10) {
        window.timeline.forEach(animation => { animation.currentTime = ms; });
        samples.push({ ms,
          brand_row_opacity: Number(getComputedStyle(band.querySelector('.aithema-reveal__row')).opacity),
          control_opacities: controls.map(node => Number(getComputedStyle(node).opacity)),
          proxy_opacities: [...band.querySelectorAll('.aithema-reveal__proxy')].map(node => Number(getComputedStyle(node).opacity)),
        });
      }
      return samples;
    });
    for (const sample of overlapSamples) assertExitOverlap(sample, label);
    const samples=[], samplePoint={x:width-8,y:bandHeight-10,width:1,height:1};
    for(let ms=0;ms<=900;ms+=50) { await seek(page,ms); const rgbSample=await pixel(page, samplePoint); const opacity=await page.$eval('.aithema-reveal__glass',n=>Number(getComputedStyle(n).opacity)); const sample={ms,rgb:rgbSample,glass_opacity:opacity,...await exitOpacities(page)}; assertExitOverlap(sample,label); samples.push(sample); if([0,150,300,450,700,900].includes(ms)) await shot(`exit-${ms}ms`,ms); }
    colours.push({label,source:'rendered 1x1 PNG pixels and computed brand/control opacities',clock:'paused CSS timeline advanced in exactly 50ms steps; overlap also checked every 10ms through 300ms',point:samplePoint,control_labels:await page.evaluate(()=>window.fixture.controls.map(n=>n.getAttribute('aria-label')||n.textContent)),overlap_samples:overlapSamples,samples});
    if(evidence) await writeFile(join(evidence,`exit-colour-samples-${locale}.json`),JSON.stringify(colours,null,2)+'\n');
    assertMonotonicRgb(samples,label);
    for(let i=1;i<samples.length;i++) assert.ok(samples[i].glass_opacity<=samples[i-1].glass_opacity+.0001);
    await seek(page,1500); await page.evaluate(()=>window.exitCleanup()); await shot('exit-restored',1500); assertStill(baseline,await layout(page),label+' after exit');
    assert.ok(await page.evaluate(()=>window.fixture.controls.every(n=>!n.inert&&getComputedStyle(n).opacity==='1'))); assert.equal(await page.$('.aithema-reveal__stars'),null);
    // Explicit motion off is a 200ms opacity-only crossfade with no decorative animation.
    await page.mouse.move(0,400); await page.evaluate(()=>{window.fixture.orb.setMotion(false);window.fixture.reveal.setMotion(false);window.fixture.orb.setVoice('speaking');}); await page.keyboard.press('Tab'); await wait(250); await shot('motion-off-open',200);
    assert.equal(await page.$('.aithema-reveal__stars'),null);
    const calm=await page.evaluate(()=>{const {band,orb,controls}=window.fixture;return {animations:band.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({target:a.effect.target.className,name:a.animationName,property:a.transitionProperty})),ring:getComputedStyle(band.querySelector('.aithema-reveal__ring')).display,duration:getComputedStyle(band.querySelector('.aithema-reveal__glass')).transitionDuration,delays:controls.map(n=>getComputedStyle(n).transitionDelay),breath:getComputedStyle(orb.element.querySelector('.orb__body')).animationName};});
    assert.deepEqual(calm.animations,[],label+' calm'); assert.equal(calm.ring,'none'); assert.equal(calm.duration,'0.2s'); assert.ok(calm.delays.every(delay=>delay==='0s')); assert.equal(calm.breath,'none');
    metrics.at(-1).motion_off_focus=await assertFocusRing(page,label+' calm'); assert.equal(metrics.at(-1).motion_off_focus.breathOpacity,'0');
    await page.keyboard.press('Tab'); await assertCalmUnderline(page,label+' calm keyboard underline'); await page.hover('.aithema-reveal__link'); await assertCalmUnderline(page,label+' calm hover underline');
    await page.keyboard.press('Escape'); await wait(250); await shot('motion-off-closed',200); assertStill(baseline,await layout(page),label+' calm exit'); metrics.at(-1).closed_focus=await assertFocusRing(page,label+' light/dark band');
    await page.mouse.move(0,400); await page.evaluate(()=>{window.fixture.orb.setMotion(true);window.fixture.reveal.setMotion(true);window.fixture.orb.setVoice('listening');}); await page.keyboard.press('Enter'); await freeze(page); await seek(page,2200); await shot('keyboard-focus-open',2200); metrics.at(-1).keyboard_focus=await assertFocusRing(page,label); metrics.at(-1).keyboard_text_contrast=await renderedTextContrast(page,label+' keyboard');
    // A host with its hairline at the band's bottom uses the same module, with no hard-coded 6px inset.
    await page.evaluate(()=>{window.edgeOverride=document.createElement('style');window.edgeOverride.textContent='.band::after { bottom:0; }';document.head.append(window.edgeOverride);window.dispatchEvent(new Event('resize'));});
    assert.equal(await page.evaluate(()=>window.fixture.band.querySelector('.aithema-reveal__fx').getBoundingClientRect().bottom),bandHeight,label+' host hairline at bottom');
    await page.evaluate(()=>window.edgeOverride.remove());
  }
  if(evidence) { await writeFile(join(evidence,`exit-colour-samples-${locale}.json`),JSON.stringify(colours,null,2)+'\n'); await writeFile(join(evidence,`timeline-${locale}.json`),JSON.stringify(frames,null,2)+'\n'); await writeFile(join(evidence,`qa-metrics-${locale}.json`),JSON.stringify(metrics,null,2)+'\n'); }
  assert.deepEqual(problems,[]); t.diagnostic(`${frames.length} frames; ${colours.length*19} rendered colour samples; all exit RGB channels monotonic within 2/255 quantisation tolerance.`);
});

test('AIT-140: real keyboard navigation, reduced-motion preference, hidden tab and existing component', {timeout:90_000}, async t=>{
  const url=await server(t), browser=await orbBrowser();
  const page=await pageForFile(browser), problems=[]; page.on('pageerror',error=>problems.push(error.message));
  await page.setViewport({width:1440,height:900}); await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${url}/?locale=en&theme=light&component=1`); await page.waitForFunction(()=>window.ready&&window.component?.shadowRoot); await wait(250);
  assert.equal(await page.$eval('.orb',n=>n.dataset.orbMotion),'off'); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealMotion),'off');
  await page.keyboard.press('Tab'); assert.equal(await page.$eval('.orb',n=>document.activeElement===n),true); await wait(250);
  for(const href of ['https://aithema.inspr.at/','https://inspr.at/','https://augmentoring.com/']) {await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.href),href);if(href==='https://aithema.inspr.at/')await assertCalmUnderline(page,'system reduced-motion keyboard underline');}
  await page.hover('.aithema-reveal__link'); await assertCalmUnderline(page,'system reduced-motion hover underline');
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('.orb',n=>document.activeElement===n),true); await wait(250);
  assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'closed');
  await page.keyboard.press('Space'); await wait(250); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'open');
  await page.evaluate(()=>document.getElementById('outside').focus()); await wait(250); assert.equal(await page.$eval('#band',n=>n.dataset.aithemaRevealState),'closed');
  const existing=await page.evaluate(()=>{const root=window.component.shadowRoot,orb=root.querySelector('.band-orb .orb'),intro=root.querySelector('.intro__orb .orb');return{slabs:orb.querySelectorAll('.orb__slab').length,canvas:!!orb.querySelector('canvas'),width:orb.getBoundingClientRect().width,visual:orb.querySelector('.orb__body').getBoundingClientRect().width,introWidth:intro.getBoundingClientRect().width,reveal:!!root.querySelector('.band > .aithema-reveal__row')};}); assert.equal(existing.slabs,6);assert.equal(existing.canvas,false);assert.equal(existing.width,44);assert.equal(existing.visual,40);assert.ok(existing.introWidth>=64&&existing.introWidth<=100);assert.equal(existing.reveal,true);
  const evidence=process.env.AITHEMA_EVIDENCE_DIR;if(evidence)await page.screenshot({path:join(evidence,'existing-component-glass-orb.png')});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]); await page.evaluate(()=>{window.fixture.orb.setMotion(true);window.fixture.reveal.setMotion(true);});
  const other=await browser.newPage();await other.goto('about:blank');await other.bringToFront();await wait(100);
  // Headless Chrome may keep background pages visible; when it does, exercise its lifecycle via CDP.
  const client=await page.createCDPSession();await client.send('Page.setWebLifecycleState',{state:'frozen'});await client.send('Page.setWebLifecycleState',{state:'active'});await page.bringToFront();
  assert.deepEqual(problems,[]);
  await other.close();
});

test('AIT-140: early leave holds the circle; live exit colour samples every 50ms', {timeout:60_000}, async t=>{
  const url=await server(t), evidence=process.env.AITHEMA_EVIDENCE_DIR;
  const browser=await orbBrowser();
  const page=await pageForFile(browser), records=[];
  for(const theme of ['light','dark']) for(const width of [1440,390]) {
    await page.setViewport({width,height:900,deviceScaleFactor:1}); await page.goto(`${url}/?locale=de&theme=${theme}`); await page.waitForFunction(()=>window.ready); await wait(100);
    await page.evaluate(()=>window.fixture.orb.element.focus()); await wait(140);
    const circle=await page.evaluate(()=>{const glass=window.fixture.band.querySelector('.aithema-reveal__glass');const before=getComputedStyle(glass).transform;window.fixture.reveal.close();return {before,after:getComputedStyle(glass).transform};});
    assert.equal(circle.after,circle.before,'an early exit cannot change the circle radius');
    if(evidence) await page.screenshot({path:join(evidence,`de-${theme}-${width}-early-exit.png`),clip:{x:0,y:0,width,height:240}});
    await page.waitForFunction(()=>window.fixture.band.dataset.aithemaRevealState==='closed');
    // Reopen without freezing; the ordinary CSS/JS exit runs on its real clock for this proof.
    await page.evaluate(()=>window.fixture.orb.element.dispatchEvent(new Event('focus'))); await wait(2100);
    const height=await page.$eval('#band',n=>n.getBoundingClientRect().height), point={x:2,y:height-10,width:1,height:1};
    const start=performance.now(); await page.evaluate(()=>window.fixture.reveal.close()); const samples=[];
    for(let ms=0;ms<=900;ms+=50) {
      await wait(Math.max(0,start+ms-performance.now()));
      const before=performance.now(), rgbSample=await pixel(page, point), after=performance.now();
      const sample={scheduled_ms:ms,capture_start_ms:Math.round(before-start),capture_end_ms:Math.round(after-start),rgb:rgbSample,...await exitOpacities(page)}; assertExitOverlap(sample,`${theme}-${width} live`); samples.push(sample);
    }
    records.push({theme,width,clock:'live, unfrozen CSS and ordinary exit cleanup; 50ms schedule with actual capture times',point,circle,samples});
    if(evidence) await writeFile(join(evidence,'exit-colour-samples-live.json'),JSON.stringify(records,null,2)+'\n');
    assertMonotonicRgb(samples,`${theme}-${width} live`);
    await page.waitForFunction(()=>window.fixture.band.dataset.aithemaRevealState==='closed');assert.ok(await page.evaluate(()=>window.fixture.controls.every(n=>!n.inert&&getComputedStyle(n).opacity==='1')));
  }
  t.diagnostic('76 live rendered-pixel colour samples, four early-leave checks; actual capture timestamps retained.');
});
