import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { test } from 'node:test';
import puppeteer from './launch.js';
// Dynamic fixtures must share a file-owned teardown, registered before tests run.
import './shared-browser.js';
import { HTML_PREVIEW_HOST_CSP, htmlPreviewHostPolicy, inspectHTML } from '@inspr/aithema-core';
import { previewFixture } from '../fixtures/html-preview-route.js';
import { fullMatrix } from './matrix-coverage.js';
// Real Chrome: the sandboxed preview cannot read the host page, its cookies or storage, and cannot fetch.
// Set AITHEMA_EVIDENCE_DIR to keep screenshots of the sample click-dummy (wide light/dark, phone).
const root = new URL('../../', import.meta.url).pathname;
const isCI = Boolean(process.env.CI);
const dummy = await readFile(join(root, 'test/fixtures/click-dummy.html'), 'utf8');
import { browserPath } from '../../scripts/install-test-browser.js';
const declaration = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_HOST_CSP}">`;
const host = `<!doctype html><html><head><meta charset="utf-8"><title>Host</title>
${declaration}
<style>body{margin:0;padding:24px;font:15px system-ui;background:#f7f5ef} aithema-html-preview{max-width:1200px}</style></head>
<body><p id="parent-secret">host-page-secret</p><aithema-html-preview></aithema-html-preview>
<script type="module">
import '/packages/ui/src/html-preview.js';
localStorage.setItem('host-storage', 'host-storage-secret');
window.results = []; addEventListener('message', event => window.results.push(event.data));
window.violations = []; addEventListener('securitypolicyviolation', event => window.violations.push({
  directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition, policy: event.originalPolicy, trusted: event.isTrusted }));
window.show = html => { document.querySelector('aithema-html-preview').artifact = { mediaType: 'text/html', previewURL: location.origin + '/_aithema/html-preview', mint: async signal => (await fetch('/fixture/mint', {method:'POST',body:html,signal})).json() }; };
window.ready = true;
</script></body></html>`;
// Obfuscated on purpose: it passes the static policy, so only the sandbox and CSP stand in the way.
const hostile = port => `<!doctype html><html><head><title>Hostile draft</title></head><body><p>probe</p><script>
(async () => {
  const w = self, base = 'ht' + 'tp:/' + '/127.0.0.1:${port}', R = { origin: String(w.origin) };
  try { R.parentDom = w['par' + 'ent'].document.getElementById('parent-secret').textContent; } catch (e) { R.parentDom = 'blocked ' + e.name; }
  try { R.cookie = document['coo' + 'kie']; } catch (e) { R.cookie = 'blocked ' + e.name; }
  try { R.storage = String(w['local' + 'Storage'].getItem('host-storage')); } catch (e) { R.storage = 'blocked ' + e.name; }
  try { await w['fe' + 'tch'](base + '/beacon/fetch'); R.fetch = 'reached'; } catch (e) { R.fetch = 'blocked ' + e.name; }
  R.image = await new Promise(resolve => { const i = new Image(); i.onload = () => resolve('reached'); i.onerror = () => resolve('blocked'); i['sr' + 'c'] = base + '/beacon/image'; });
  try { R.popup = w['op' + 'en'](base + '/beacon/popup') === null ? 'blocked' : 'opened'; } catch (e) { R.popup = 'blocked ' + e.name; }
  try { const f = document.createElement('form'); f['meth' + 'od'] = 'post'; f['act' + 'ion'] = base + '/beacon/form'; document.body.append(f); f.submit(); R.form = 'attempted'; } catch (e) { R.form = 'blocked ' + e.name; }
  try { w['to' + 'p']['loc' + 'ation'] = base + '/beacon/top'; R.top = 'attempted'; } catch (e) { R.top = 'blocked ' + e.name; }
  w['par' + 'ent'].postMessage(R, '*');
})();
</script></body></html>`;
const leaving = (port, delayed) => `<!doctype html><html><head><title>Leaving draft</title><script>
const leave = () => { self['loc' + 'ation']['hr' + 'ef'] = 'ht' + 'tp:/' + '/127.0.0.1:${port}/destination/${delayed ? 'after-load' : 'immediate'}'; };
${delayed ? "addEventListener('load', () => setTimeout(leave, 100));" : 'leave();'}
</script></head><body><p>leaving</p>
</body></html>`;
test('real Chrome isolates the html preview and renders the sample click-dummy', { timeout: 90_000 }, async t => {
  const hits = [], servePreview = previewFixture();
  let routeDelayMs = 0;
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/_aithema/html-preview?') && routeDelayMs) await new Promise(resolve => setTimeout(resolve, routeDelayMs));
    if (await servePreview(req, res)) return;
    const path = new URL(req.url, 'http://localhost').pathname;
    const routePolicy = htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`);
    if (path.startsWith('/destination/')) {
      hits.push(path); res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><script>fetch("/beacon/destination-script");new Image().src="/beacon/destination-image"</script>');
    }
    if (path.startsWith('/beacon/')) { hits.push(path); res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); return res.end('ok'); }
    if (['/', '/no-policy', '/unverified-policy', '/report-only-probe', '/script-policy'].includes(path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'host-cookie=host-cookie-secret; Path=/',
        ...(path === '/' ? { 'content-security-policy': routePolicy } : {}),
        ...(['/unverified-policy', '/report-only-probe'].includes(path) ? { 'content-security-policy-report-only': routePolicy } : {}) });
      const declarations = {
        '/no-policy': '',
        '/unverified-policy': `<meta http-equiv="Content-Security-Policy-Report-Only" content="${routePolicy}">`,
        // The test-only property declares the policy to the element, while the
        // absent content attribute leaves Chrome with only the report-only header.
        '/report-only-probe': `<meta id="claimed-policy" http-equiv="Content-Security-Policy"><script>Object.defineProperty(document.getElementById('claimed-policy'),'content',{value:"${routePolicy}"});</script>`,
        '/script-policy': `<meta id="claimed-policy"><script>const claim=document.getElementById('claimed-policy');claim.httpEquiv='Content-Security-Policy';claim.content="${routePolicy}";</script>`,
      };
      return res.end(path === '/' ? host.replace(declaration, `<meta http-equiv="Content-Security-Policy" content="${routePolicy}">`) : host.replace(declaration, declarations[path]));
    }
    const file = normalize(join(root, path));
    if (!/^\/packages\/(?:ui|core)\/src\/[\w-]+\.js$/u.test(path) || !file.startsWith(root)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(await readFile(file));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, directory = await mkdtemp(join(tmpdir(), 'aithema-preview-'));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH },
    args: process.platform === 'linux' && isCI ? ['--no-sandbox'] : [] });
  t.diagnostic(`Browser: ${await browser.version()}`);
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 1000 });
  // Missing policy fails visibly before any generated content can execute.
  await page.goto(`http://127.0.0.1:${port}/no-policy`); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(html => window.show(html), hostile(port));
  await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'policy');
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
  assert.match(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.state-message').textContent), /^Previews aren't enabled on this site\.$/u);
  assert.deepEqual(await page.evaluate(() => window.results), []);
  // A report-only header and meta do not enforce the host policy. The element
  // rejects this declaration before starting its browser policy probe.
  await page.goto(`http://127.0.0.1:${port}/unverified-policy`); await page.waitForFunction(() => window.ready === true);
  assert.equal(await page.evaluate(html => {
    window.show(html); return Boolean(document.querySelector('[data-aithema-html-policy-probe]'));
  }, hostile(port)), true);
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'policy');
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
  assert.deepEqual(await page.evaluate(() => window.results), []);
  // This second report-only case reaches the probe: a non-enforcing property
  // satisfies the declaration check, but a trusted report cannot prove enforcement.
  await page.goto(`http://127.0.0.1:${port}/report-only-probe`); await page.waitForFunction(() => window.ready === true);
  assert.deepEqual(await page.evaluate(() => {
    const meta = document.getElementById('claimed-policy'); return [meta.content, meta.getAttribute('content')];
  }), [htmlPreviewHostPolicy(`http://127.0.0.1:${port}/_aithema/html-preview`), null]);
  assert.equal(await page.evaluate(html => {
    window.show(html); return Boolean(document.querySelector('[data-aithema-html-policy-probe]'));
  }, hostile(port)), true, 'the non-enforcing declaration reaches the policy probe');
  await page.waitForFunction(policy => window.violations.some(v => v.trusted && v.directive === 'frame-src' &&
    v.disposition === 'report' && v.policy === policy && (v.blocked === '' || v.blocked === 'data' || v.blocked.startsWith('data:'))), {}, htmlPreviewHostPolicy(`http://127.0.0.1:${port}/_aithema/html-preview`));
  await page.waitForFunction(() => !document.querySelector('[data-aithema-html-policy-probe]'));
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'policy');
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
  assert.deepEqual(await page.evaluate(() => window.results), []);
  assert.equal(await page.evaluate(() => window.violations.some(v => v.disposition === 'enforce')), false);
  assert.deepEqual(hits, [], 'report-only policy verification never executes a hostile draft');
  t.diagnostic(`report-only probe evidence: ${JSON.stringify(await page.evaluate(() => window.violations))}`);
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready === true);
  assert.equal(await page.evaluate(() => document.cookie), 'host-cookie=host-cookie-secret', 'the host has a cookie worth stealing');
  const stage = () => page.evaluate(() => { const r = document.querySelector('aithema-html-preview').shadowRoot.querySelector('.stage').getBoundingClientRect();
    return [r.x, r.y, r.width, r.height]; });
  const state = () => page.evaluate(() => document.querySelector('aithema-html-preview').state);
  const waitFrame = async selector => { for (let i = 0; i < 100; i++) {
    const found = page.frames().find(f => f !== page.mainFrame() && f.url().includes('/_aithema/html-preview?cap='));
    if (found && await found.evaluate(selector => document.readyState === 'complete' && Boolean(document.querySelector(selector)), selector).catch(() => false)) return found;
    await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('click-dummy frame not ready'); };
  const empty = await stage();

  // 1. A hostile draft that passes the static policy is contained by sandbox + CSP.
  const probe = hostile(port); assert.equal(inspectHTML(new TextEncoder().encode(probe)).ok, true);
  await page.evaluate(html => window.show(html), probe);
  await page.waitForFunction(() => window.results.length === 1, { timeout: 15_000 });
  await new Promise(resolve => setTimeout(resolve, 750));
  const [result] = await page.evaluate(() => window.results);
  t.diagnostic(`hostile probe: ${JSON.stringify(result)}`);
  assert.equal(result.origin, 'null', 'opaque origin');
  assert.match(result.parentDom, /^blocked SecurityError$/u); assert.match(result.cookie, /^blocked SecurityError$/u);
  assert.match(result.storage, /^blocked SecurityError$/u); assert.match(result.fetch, /^blocked TypeError$/u);
  assert.equal(result.image, 'blocked'); assert.equal(result.popup, 'blocked');
  assert.deepEqual(hits, [], 'no request left the frame: fetch, image, popup, form and top navigation were all blocked');
  assert.equal(page.url(), `http://127.0.0.1:${port}/`); assert.equal(await state(), 'ready');
  assert.deepEqual(await stage(), empty, 'the stage does not move or resize when a draft arrives');

  // 2. The sample click-dummy works inside the frame, by pointer and keyboard.
  await page.evaluate(html => window.show(html), dummy);
  const frame = await waitFrame('#new');
  assert.equal(await frame.evaluate(() => document.compatMode), 'CSS1Compat', 'standards mode');
  await frame.click('#new'); assert.equal(await frame.evaluate(() => document.getElementById('dialog').open), true);
  await page.keyboard.press('Escape'); assert.equal(await frame.evaluate(() => document.getElementById('dialog').open), false);
  await frame.click('[data-filter="done"]');
  assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('.requests li .title')].map(n => n.textContent)), ['Bathroom fan is loud']);
  await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.seg [aria-checked="true"]').focus());
  await page.keyboard.press('Tab');
  assert.equal(await frame.evaluate(() => document.activeElement?.textContent), 'Auto', 'Tab moves from the width switch into the draft');
  assert.deepEqual(hits, []);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  // Colour transitions settle before each picture.
  const shoot = async name => { if (evidence) { await new Promise(resolve => setTimeout(resolve, 400)); await page.screenshot({ path: join(evidence, `${name}.png`) }); } };
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await shoot('preview-wide-light');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await shoot('preview-wide-dark');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => { document.querySelector('aithema-html-preview').width = 'phone'; });
  assert.deepEqual(await stage(), empty, 'switching to phone width keeps the stage fixed');
  assert.equal(await frame.evaluate(() => innerWidth), 390); await shoot('preview-phone-light');
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.work')).gridTemplateColumns.split(' ').length), 1, 'one column at phone width');
  await page.setViewport({ width: 390, height: 844 }); await page.evaluate(() => { document.body.style.padding = '8px'; });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await shoot('preview-phone-dark');
  await page.setViewport({ width: 1280, height: 1000 }); await page.emulateMediaFeatures([]);

  // Clearing and rejecting a focused draft both return to the selected width.
  for (const replacement of [null, '<p>unsafe fragment</p>']) {
    const focusedFrame = await waitFrame('#new');
    await focusedFrame.waitForSelector('#new'); await focusedFrame.click('#new');
    await page.evaluate(html => {
      const element = document.querySelector('aithema-html-preview');
      element.artifact = html === null ? null : { previewURL: location.origin + '/_aithema/html-preview', bytes: new TextEncoder().encode(html), mediaType: 'text/html' };
    }, replacement);
    assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.activeElement?.dataset.width), 'phone');
    await page.evaluate(html => window.show(html), dummy);
    await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'ready');
  }

  // 3. Immediate (before first load) and after-load navigation are blocked by
  // the embedding page, before the scripted HTML destination is ever fetched.
  // Positive control: outside the sandbox that very destination emits both
  // beacons, proving that the fixture can detect a missed navigation block.
  const control = await browser.newPage();
  const beacons = ['/beacon/destination-script', '/beacon/destination-image'].map(path => control.waitForResponse(`http://127.0.0.1:${port}${path}`));
  await control.goto(`http://127.0.0.1:${port}/destination/control`); await Promise.all(beacons); await control.close();
  assert.ok(hits.includes('/destination/control') && hits.includes('/beacon/destination-script') && hits.includes('/beacon/destination-image'));
  hits.length = 0;
  for (const hostPath of ['/', '/script-policy']) {
    if (hostPath === '/script-policy') {
      // Chrome enforces a connected meta when script installs its attributes.
      await page.goto(`http://127.0.0.1:${port}${hostPath}`); await page.waitForFunction(() => window.ready === true);
    }
    await page.evaluate(html => window.show(html), dummy);
    await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'ready');
    for (const delayed of [false, true]) {
      const draft = leaving(port, delayed); assert.equal(inspectHTML(new TextEncoder().encode(draft)).ok, true);
      await page.evaluate(html => window.show(html), draft);
      const destination = `http://127.0.0.1:${port}/destination/${delayed ? 'after-load' : 'immediate'}`;
      await page.waitForFunction(url => window.violations.some(v => v.trusted && v.directive === 'frame-src' && v.blocked === url && v.disposition === 'enforce'), {}, destination);
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'navigated');
      assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
      assert.match(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.state-message').textContent), /tried to open another page and was stopped/u);
      assert.equal(page.url(), `http://127.0.0.1:${port}${hostPath}`);
      assert.deepEqual(hits, [], `${hostPath}: ZERO navigation requests and ZERO requests from destination scripts`);
    }
    t.diagnostic(`${hostPath} CSP evidence: ${JSON.stringify(await page.evaluate(() => window.violations.filter(v => v.directive === 'frame-src')))}`);
  }
  // A draft can attempt a self-reload only against its already consumed cap.
  const reloadable = '<!doctype html><html><head><title>Reload</title></head><body><button id="reload">Reload</button><script>document.querySelector("#reload").onclick=()=>self["loc"+"ation"]["re"+"load"]();</script></body></html>';
  assert.equal(inspectHTML(new TextEncoder().encode(reloadable)).ok, true);
  await page.evaluate(html => window.show(html), reloadable);
  const reloadFrame = await waitFrame('#reload'), oldSource = reloadFrame.url();
  const denied = page.waitForResponse(response => response.url() === oldSource && response.status() === 403);
  await reloadFrame.click('#reload'); await denied;
  await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'navigated');
  await page.evaluate(html => window.show(html), dummy);
  const refreshed = await waitFrame('#new'); assert.notEqual(refreshed.url(), oldSource, 'reopening mints a fresh single-use capability');
  assert.deepEqual(hits, [], 'self-reload is refused; no destination script or foreign network request runs');
  t.diagnostic(`navigation and destination-script requests: ${JSON.stringify(hits)} (ZERO)`);

  await t.test('AIT-353: a route response delayed 3.5 s survives the pre-load phase and becomes ready', async () => {
    routeDelayMs = 3500;
    await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready === true);
    const response = page.waitForResponse(r => r.url().includes('/_aithema/html-preview?'), { timeout: 8000 });
    await page.evaluate(html => window.show(html), dummy);
    assert.equal((await response).status(), 200, 'the delayed single-use route succeeds');
    assert.equal(await state(), 'ready', 'network time must not consume the 1.5 s readiness budget');
    const frame = await waitFrame('#new');
    await frame.click('#new');
    assert.equal(await frame.evaluate(() => document.querySelector('#dialog').open), true);
    assert.equal(await state(), 'ready'); routeDelayMs = 0;
  });

  await t.test('AIT-353: a route slower than the capability pre-load budget shows failure without reminting', async () => {
    routeDelayMs = 3500;
    await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready === true);
    const request = page.waitForRequest(r => r.url().includes('/_aithema/html-preview?'));
    await page.evaluate(html => {
      window.mintCalls = 0;
      document.querySelector('aithema-html-preview').artifact = { mediaType: 'text/html', previewURL: location.origin + '/_aithema/html-preview',
        mint: async signal => {
          window.mintCalls++;
          const cap = await (await fetch('/fixture/mint', { method: 'POST', body: html, signal })).json();
          // Advertise a short-lived capability while the real route takes 3.5 s.
          return { ...cap, expiresInMs: 2000 };
        } };
    }, dummy);
    await request;
    await page.waitForFunction(() => ['failure', 'navigated'].includes(document.querySelector('aithema-html-preview').state), { timeout: 5000 });
    assert.equal(await state(), 'failure');
    assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.state-message').textContent),
      'The draft could not be loaded.');
    assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
    await page.evaluate(() => { const preview = document.querySelector('aithema-html-preview'); preview.width = 'phone'; preview.copy = {}; });
    // Let the original delayed response finish; it cannot revive the discarded frame.
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(await state(), 'failure'); assert.equal(await page.evaluate(() => window.mintCalls), 1);
    routeDelayMs = 0;
  });
});

// AIT-282 stays in this small existing shard workload: one page, state changes
// in place, and the expensive screenshot matrix only in explicit evidence mode.
test('AIT-282: concept backdrop has zero layout shift at 1440/1024/390 in DE/EN', { timeout: 180_000 }, async t => {
  const { writeFile } = await import('node:fs/promises');
  const evidence = fullMatrix ? process.env.AITHEMA_EVIDENCE_DIR : undefined;
  const directory = await mkdtemp(join(tmpdir(), 'aithema-backdrop-'));
  const pageHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#f7f5ef} aithema-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}
    </style></head><body><aithema-session></aithema-session><script type="module">
    import '/packages/ui/src/session-element.js';
    import { createSession } from '/packages/core/src/session.js';
    import { ConceptView } from '/packages/ui/src/concept-view.js';
    const update=ConceptView.prototype.update;
    ConceptView.prototype.update=function(session){window.conceptView=this;return update.call(this,session);};
    const c = document.querySelector('aithema-session');
    const canvas = document.createElement('canvas');canvas.width=1600;canvas.height=900;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#f4f2ec';ctx.fillRect(0,0,1600,900);
    ctx.fillStyle='#d6e8e5';ctx.fillRect(0,0,250,900);
    for(let i=0;i<8;i++){ctx.fillStyle='#91aaa9';ctx.fillRect(35,80+i*85,160,18);}
    for(let i=0;i<4;i++){ctx.fillStyle='#fff';ctx.fillRect(285+i*322,120,290,150);ctx.fillStyle='#1d3c54';ctx.fillRect(310+i*322,165,140,24);}
    ctx.fillStyle='#fff';ctx.fillRect(285,310,820,520);ctx.fillRect(1130,310,430,520);
    for(let i=0;i<11;i++){ctx.fillStyle='#14918c';ctx.fillRect(315+i*69,740-(i%4)*65,42,90+(i%4)*65);}
    for(let i=0;i<7;i++){ctx.fillStyle='#c4cdd4';ctx.fillRect(1160,350+i*65,340,18);}
    const bytes=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    window.artifactReads=[];window.posts=[];const nativeFetch=fetch.bind(window);
    window.fetch=async (url,options={})=>{
      const path=new URL(url,location.href).pathname;
      if(path.endsWith('/image')){window.artifactReads.push({path,token:new Headers(options.headers).get('x-aithema-session-token'),cache:options.cache});return new Response(bytes,{headers:{'content-type':'image/png'}});}
      if(path.endsWith('/events')) return new Response(new ReadableStream({start(controller){options.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}));
      if(path.startsWith('/api/')){if(options.body)window.posts.push({path,body:JSON.parse(options.body)});return Response.json(c.session??{});}
      return nativeFetch(url,options);
    };
    window.conceptItem=id=>({id,mediaType:'image/png',width:1600,height:900,turnIds:['source'],referenceIds:[],archived:false,feedback:{vote:'clear',chips:[]},provenance:{origin:'ai-generated',generator:{provider:'local-demo-fake'}}});
    window.seed=async (locale,bound=true)=>{
      const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
      const session=createSession({demo:true});session.id='backdrop-owner';session.locale=locale;
      session.settings.origin='chosen';session.settings.visuals='auto';session.visualsBound=bound;session.conceptVisualKind=bound?'image':undefined;session.conceptCost={maxMicro:30000};
      session.featureMatrix={best:Object.fromEntries(['text','analysis','images'].map(k=>[k,{available:true}]))};
      session.transcript=[{id:'source',role:'user',content:locale==='de'?'Etwa 400 Rechnungen im Monat, wir sind zu dritt.':'About 400 invoices a month, there are three of us.'},
        {id:'reply',role:'assistant',content:locale==='de'?'Bei 400 Rechnungen im Monat lohnt sich ein Blick auf die Freigabe. Soll ich skizzieren, wie der Abgleich aussehen könnte?':'At 400 invoices a month, approval is worth a look. Shall I sketch what reconciliation could look like?'}];
      session.inputRevision=1;session.concepts=[];session.conceptStatus={phase:'idle'};
      c.configure({session,copy,sessionToken:'fixture-owner'});document.documentElement.lang=locale;
    };
    window.state=(status,artifact)=>c.receive({seq:c.session.seq+1,type:'concept.state',data:{intent:c.session.conceptIntent,status,...(artifact?{artifact}: {})}});
    window.ready=true;
    </script></body></html>`;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.writeHead(200, { 'content-type':'text/html' }); return res.end(pageHTML); }
    if (!/^\/packages\/(?:ui|core)\/src\/[\w/-]+\.(?:js|json)$/u.test(path)) { res.writeHead(404); return res.end(); }
    try { res.writeHead(200, { 'content-type':path.endsWith('.json')?'application/json':'text/javascript' }); res.end(await readFile(join(root, path))); }
    catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => { try { await browser?.close(); } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive:true,force:true});
  } });
  browser = await puppeteer.launch({ executablePath:await browserPath(), headless:true, userDataDir:join(directory,'chrome'), args:process.platform==='linux'&&isCI?['--no-sandbox']:[] });
  const page = await browser.newPage(), errors = [], shots = [], passes = [], guardShots = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready, {timeout:5000}).catch(cause => { throw new Error(`Backdrop fixture startup: ${JSON.stringify(errors)}`, {cause}); });
  const head = /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1] ?? 'local';
  if (evidence) await mkdir(evidence,{recursive:true});
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    const root=document.querySelector('aithema-session').shadowRoot;
    await Promise.all(root.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  });
  const boxes = () => page.evaluate(() => {
    const root=document.querySelector('aithema-session').shadowRoot;
    return ['.concept-thread','.transcript-shell','.composer-shell','.composer-dock','.turn','.display-foot'].map(s=>{
      const r=root.querySelector(s).getBoundingClientRect();return [s,r.x,r.y,r.width,r.height];
    });
  });
  for (const locale of ['de','en']) for (const width of [1440,1024,390]) for (const theme of fullMatrix?['light','dark']:['light']) {
    await page.setViewport({width,height:900});
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'no-preference'}]);
    await page.evaluate(async ({locale,theme})=>{await window.seed(locale);document.querySelector('aithema-session').setAttribute('theme',theme);scrollTo(0,0);},{locale,theme});
    await settle(); const baseline = await boxes();
    const capture = async state => {
      await settle();
      const actualState=await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-access').dataset.state);
      assert.equal(actualState,({gen:'gen',gone:'gone',err:'err',none:'none'})[state]??'ready',`${state}: real presentation state`);
      if(state!=='focus')await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.activeElement?.blur());
      if(state!=='hover')await page.mouse.move(-10,-10);
      await settle();
      assert.deepEqual(await boxes(),baseline,`${locale}/${width}/${theme}/${state}: 0 px`);
      const pass=`PASS ${locale}/${width}/${theme}/${state}: 0 px`;passes.push(pass);
      if(evidence){const file=locale+'-'+width+'-'+theme+'-'+state+'.png';await page.screenshot({path:join(evidence,file),fullPage:false,captureBeyondViewport:false});shots.push({file,head,theme,locale,state,width,pass});}
    };
    await page.evaluate(()=>window.state({phase:'pending',startedAt:Date.now(),estimateMs:40000})); await capture('gen');
    await page.evaluate(()=>window.state({phase:'ready'},window.conceptItem('concept-a')));
    await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on]')?.complete);await capture('ready');
    const style=await page.evaluate(()=>{const root=document.querySelector('aithema-session').shadowRoot;return {opacity:getComputedStyle(root.querySelector('.concept-backdrop img[data-on]')).opacity,display:getComputedStyle(root.querySelector('.concept-backdrop')).display,phone:root.querySelector('.concept-access').closest('.composer-dock')!==null,slot:root.querySelector('.concept-access').getBoundingClientRect().height};});
    assert.equal(style.slot,44);assert.equal(style.phone,width===390);
    assert.equal(width===390?style.display:style.opacity,width===390?'none':theme==='dark'?'0.14':'0.18');
    await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-preview').focus({preventScroll:true}));await capture('focus');
    if(width>600){assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on]')).opacity),'0.35');}
    await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.activeElement?.blur());
    // Find actual free space, then send a real pointer. A bubble/control is never
    // a candidate, and the complete hint rectangle must also be exposed.
    const point=await page.evaluate(()=>{const root=document.querySelector('aithema-session').shadowRoot,b=root.querySelector('.concept-backdrop').getBoundingClientRect(),hint=root.querySelector('.concept-backdrop-hint');hint.textContent=root.querySelector('.concept-preview').getAttribute('aria-label');const w=hint.offsetWidth,h=hint.offsetHeight;const free=(x,y)=>{if(x<b.left||x>b.right||y<b.top||y>b.bottom)return false;const n=root.elementFromPoint(x,y);return Boolean(n&&!n.closest('.turn,button,a,input,textarea,select,.concept-bottom'));};for(let y=b.top+20;y<b.bottom-20;y+=8)for(let x=b.left+20;x<b.right-20;x+=8){if(!free(x,y))continue;for(const [dx,dy] of [[14,18],[14,-h-12],[-w-14,18],[-w-14,-h-12]]){let fits=true;for(let yy=y+dy-8;yy<=y+dy+h+8;yy+=4)for(let xx=x+dx-8;xx<=x+dx+w+8;xx+=4)if(!free(xx,yy))fits=false;if(fits)return {x,y};}}return null;});
    if(width>600){assert.ok(point,'free backdrop space exists');await page.mouse.move(point.x,point.y);}
    await capture('hover');
    if(width>600){
      const hintSafe=await page.evaluate(()=>{const root=document.querySelector('aithema-session').shadowRoot,hint=root.querySelector('.concept-backdrop-hint');if(!hint.hasAttribute('data-show'))return false;const h=hint.getBoundingClientRect();return [...root.querySelectorAll('.turn,button')].every(n=>{const b=n.getBoundingClientRect();return h.right<=b.left||h.left>=b.right||h.bottom<=b.top||h.top>=b.bottom;});});
      assert.equal(hintSafe,true,'hover hint is visible entirely on exposed space');
    }
    if(width>600){await page.mouse.click(point.x,point.y);assert.equal(await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-viewer').open),true);await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-close').click());}
    await page.mouse.move(-10,-10);
    await page.evaluate(()=>window.state({phase:'ready'},window.conceptItem('concept-b')));await capture('replace');
    await page.evaluate(()=>window.state({phase:'failed'}));await capture('err');
    // Reuse this error state/page: the sentence and priced button are adjacent inline boxes.
    const failure = await page.evaluate(() => {
      const r = document.querySelector('aithema-session').shadowRoot, text = r.querySelector('.concept-activity-text');
      const button = r.querySelector('.concept-request'), warning = text.querySelector('.warning');
      const range = document.createRange(); range.selectNodeContents(text);
      const sentence = range.getBoundingClientRect(), action = button.getBoundingClientRect();
      return { icon: Boolean(warning?.querySelector('svg')), color: getComputedStyle(warning).color,
        warningInk: getComputedStyle(r.querySelector('.workspace')).getPropertyValue('--aithema-warning').trim(),
        wrap: getComputedStyle(button).whiteSpace, adjacent: text.parentElement.nextElementSibling === button,
        gap: action.left - sentence.right, nextLine: action.top >= sentence.bottom - 1,
        withinSlot: action.bottom <= r.querySelector('.concept-access').getBoundingClientRect().bottom + .01,
        buttonHeight: action.height, lineHeight: parseFloat(getComputedStyle(button).lineHeight) };
    });
    assert.equal(failure.icon, true); assert.equal(failure.wrap, 'nowrap'); assert.equal(failure.adjacent, true);
    assert.ok(failure.buttonHeight <= failure.lineHeight + 1, 'priced button stays one line');
    assert.equal(failure.withinSlot, true, 'wrapped action stays inside its reserved 44px row');
    if (width === 1440) assert.ok(failure.gap >= 0 && failure.gap < 20, 'action directly follows separator');
    if (width === 1024 && locale === 'de') assert.equal(failure.nextLine, true, 'wrap after separator at 1024');
    passes.push(`PASS AIT-286 ${locale}/${width}/${theme}: warning glyph, adjacent atomic priced action; 0 px`);
    await page.evaluate(()=>{const c=document.querySelector('aithema-session');c.receive({seq:c.session.seq+1,type:'turn.withdrawn',data:{turnId:'source',at:new Date().toISOString()}});});
    // The real withdrawal also removes its transcript source. Preserve the same
    // transcript fixture for the geometry comparison while testing redaction.
    await page.evaluate(()=>{const c=document.querySelector('aithema-session'),r=c.shadowRoot;window.withdrawnCheck=r.querySelectorAll('.concept-backdrop img[src],.concept-preview img[src]').length;});
    assert.equal(await page.evaluate(()=>window.withdrawnCheck),0);
    // Use the public renderer update for the withdrawn presentation without
    // changing the conversation's independent transcript geometry.
    await page.evaluate(async locale=>{await window.seed(locale);window.state({phase:'ready'},window.conceptItem('withdrawn'));},locale);
    await page.waitForFunction(()=>document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on]'));
    await page.evaluate(()=>{const c=document.querySelector('aithema-session');c.receive({seq:c.session.seq+1,type:'concept.archived',data:{artifactId:'withdrawn'}});});await capture('gone');
    await page.evaluate(async locale=>{await window.seed(locale);const c=document.querySelector('aithema-session');window.state({phase:'idle'});window.conceptView.update({...c.session,visualsBound:false});},locale);await capture('none');
    await page.evaluate(()=>{const c=document.querySelector('aithema-session');c.setAttribute('motion','off');window.state({phase:'pending',startedAt:Date.now(),estimateMs:40000});});
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.concept-scene i')).animationName),'none');
    await page.evaluate(()=>window.state({phase:'ready'},window.conceptItem('reduce')));await capture('reduced-motion');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on]')).transitionDuration),'0s');
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.evaluate(()=>{document.querySelector('aithema-session').removeAttribute('motion');window.state({phase:'ready'},window.conceptItem('reduce-system'));});await settle();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on]')).transitionDuration),'0s');
    assert.deepEqual(errors,[]);
    // Round-3 screenshots are evidence only; guard coverage lives in units and
    // adds no states or browser work to the nearly full CI bins.
    if(evidence && width===390){
      const captureGuard=async state=>{
        await settle();
        await page.evaluate(()=>document.querySelector('aithema-session').shadowRoot.activeElement?.blur());
        await page.mouse.move(-10,-10);
        const file=locale+'-'+width+'-'+theme+'-'+state+'.png';
        await page.screenshot({path:join(evidence,file),fullPage:false,captureBeyondViewport:false});
        guardShots.push({file,head,theme,locale,state,width});
      };
      await page.evaluate(async locale=>{
        const {EmailAsk}=await import('/packages/ui/src/email-ask.js');
        const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
        const c=document.querySelector('aithema-session');
        const email={canCollect:true,address:'',delivery:false,numbers:{email:'1,500',confirmed:'2,000'},paintNotice(){}};
        window.evidenceAsk=new EmailAsk({root:c.shadowRoot,copy,verification:{email},session:()=>c.session,streaming:()=>false,request:async()=>({ok:false})});
        window.evidenceAsk.credits={balance:{owner:{availableMicro:6550000,limitMicro:10000000}},tiers:{next:'emailGiven',delta:5000000}};
        window.evidenceAsk.open=true;window.evidenceAsk.paint();
      },locale);
      await captureGuard('email-ask-ready');
      await page.evaluate(()=>window.evidenceAsk.destroy());
      await page.evaluate(async locale=>{
        await window.seed(locale);const c=document.querySelector('aithema-session');
        const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
        c.configure({copy,session:{...c.session,transcript:[],concepts:[window.conceptItem('not-live')],conceptStatus:{phase:'ready'}},sessionToken:'fixture-owner'});
        c.setAttribute('motion','off');
      },locale);
      await captureGuard('not-live');
    }
  }
  for(const width of [800,390]) {
  await page.setViewport({width,height:900});
  for (const bound of [false,true]) {
    await page.evaluate(async bound=>{
      await window.seed('en',bound);
      const c=document.querySelector('aithema-session');
      const {inputRevision}=await import('/packages/core/src/session.js');
      c.receive({seq:c.session.seq+1,type:'turn.final',data:{id:'card',role:'assistant',content:'Which system do you use?',question_short:'Which system?',
        options:[{text:'An API',likely:true}],inputRevision:inputRevision(c.session)}});
    },bound);
    await settle();
    const junction=await page.evaluate(()=>{const r=document.querySelector('aithema-session').shadowRoot,c=r.querySelector('.qcard').getBoundingClientRect(),input=r.querySelector('.composer-shell').getBoundingClientRect(),row=r.querySelector('.concept-phone-slot').getBoundingClientRect();return {gap:input.top-c.bottom,clear:row.bottom<=c.top+.01,row:row.height,thread:getComputedStyle(r.querySelector('.concept-thread')).display};});
    assert.equal(junction.gap,0,'question card stays joined to composer');
    assert.equal(junction.row,bound&&width===390?44:0,'phone row appears only for bound images on phones');
    if(bound&&width===390)assert.equal(junction.clear,true,'concept row stays above the question card');
    if(!bound)assert.equal(junction.thread,'contents','unbound transcript keeps its original grid participation');
    const hit=await page.evaluate(()=>{const root=document.querySelector('aithema-session').shadowRoot,input=root.querySelector('textarea');input.scrollIntoView({block:'center'});const r=input.getBoundingClientRect();return root.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName;});
    assert.equal(hit,'TEXTAREA',`${width}/${bound}: transcript cannot cover the input hit target`);
  }
  }
  assert.equal(await page.evaluate(()=>window.posts.length),0,'all reads and state fixtures are free');
  const reads=await page.evaluate(()=>window.artifactReads);
  assert.ok(reads.length>0);assert.ok(reads.every(r=>r.path.startsWith('/api/sessions/backdrop-owner/concepts/')&&r.token==='fixture-owner'&&r.cache==='no-store'));
  if(evidence)await writeFile(join(evidence,'checks.json'),JSON.stringify({head,shots,guardShots,passes,security:['PASS authenticated active-conversation loader only','PASS immediate withdrawal redaction','PASS no generation calls'],errors},null,2));
  console.log(`PASS AIT-282: ${passes.length} state comparisons, 0 px; authenticated bytes and immediate revocation`);
});

test('AIT-341: HTML preview under START strict host script policy', { timeout: 30_000 }, async t => {
  const template = await readFile(new URL('../fixtures/html-preview-strict-host.html', import.meta.url), 'utf8');
  const startup = await readFile(new URL('../fixtures/html-preview-strict-host-startup.js', import.meta.url), 'utf8');
  const importMap = /<script type="importmap">([^<]+)<\/script>/u.exec(template)[1];
  const hash = createHash('sha256').update(importMap).digest('base64');
  const servePreview = previewFixture();
  let policy;
  // START local mode, middleware.ts:96-116. The route replaces frame-src 'none';
  // only this fixture's exact import map is additionally hash-approved.
  const strictPolicy = route => `default-src 'self'; base-uri 'self'; connect-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; font-src 'self'; form-action 'none'; frame-ancestors 'none'; ${route}; img-src 'self' data:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; worker-src 'none'`;
  const server = createServer(async (req, res) => {
    if (await servePreview(req, res)) return;
    const path = new URL(req.url, 'http://localhost').pathname;
    const routePolicy = htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`);
    policy = strictPolicy(routePolicy);
    if (['/strict-header-only', '/strict-header-and-meta', '/strict-none', '/strict-overbroad', '/strict-report-only'].includes(path)) {
      const refused = path === '/strict-none' ? "frame-src 'none'" : path === '/strict-overbroad' ? "frame-src 'self'; child-src 'none'" : routePolicy;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        [path === '/strict-report-only' ? 'content-security-policy-report-only' : 'content-security-policy']: strictPolicy(refused) });
      return res.end(template.replace('<!-- HOST_POLICY_DECLARATION -->', path === '/strict-header-and-meta' ? `<meta http-equiv="Content-Security-Policy" content="${routePolicy}">` : ''));
    }
    if (path === '/strict-host-startup.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(startup);
    }
    if (!/^\/packages\/(?:ui|core)\/src\/[\w/-]+\.(?:js|json)$/u.test(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8' });
    res.end(await readFile(join(root, path)));
  });
  const directory = await mkdtemp(join(tmpdir(), 'aithema-strict-preview-'));
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    userDataDir: join(directory, 'chrome'), args: process.platform === 'linux' && isCI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  assert.equal(inspectHTML(new TextEncoder().encode(dummy)).ok, true, 'the unchanged click-dummy is a valid draft');
  for (const variant of ['header-only', 'header-and-meta']) {
    const errors = [];
    const record = message => { if (message.type() === 'error') errors.push(message.text()); };
    page.on('console', record);
    const response = await page.goto(`http://127.0.0.1:${server.address().port}/strict-${variant}`);
    assert.equal(response.headers()['content-security-policy'], policy, 'strict script CSP is an enforcing response header');
    // Fixture prerequisites must fail CI independently of the executing regressions.
    // Importing the bare specifier also proves the hash-approved map executed.
    await page.waitForFunction(() => window.ready === true, { timeout: 5000 });
    assert.equal(await page.evaluate(() => Boolean(customElements.get('aithema-html-preview'))), true);
    assert.equal(await page.evaluate(() => document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length), variant === 'header-only' ? 0 : 1);

    await t.test(`${variant}: unapproved host inline script stays blocked`, async () => {
      await page.evaluate(() => {
        const script = document.createElement('script');
        script.textContent = 'window.unapprovedInlineRan = true'; document.body.append(script);
      });
      await page.waitForFunction(() => window.violations.some(v => v.trusted && v.disposition === 'enforce' &&
        v.directive === 'script-src-elem' && v.blocked === 'inline'), { timeout: 3000 });
      assert.equal(await page.evaluate(() => window.unapprovedInlineRan), undefined, 'host inline code has no effect');
      const violations = await page.evaluate(() => window.violations);
      assert.ok(violations.some(v => v.policy === policy && v.blocked === 'inline' && v.trusted && v.disposition === 'enforce'));
      t.diagnostic(`${variant} control PASS: ${JSON.stringify(violations)}`);
    });

    await t.test(`${variant}: valid draft mounts, answers readiness and changes state on click`,
      async () => {
        await page.evaluate(() => { window.violations.length = 0; }); errors.length = 0;
        await page.evaluate(html => window.show(html), dummy);
        try {
          await page.waitForFunction(() => Boolean(document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), { timeout: 2500 });
        } catch (cause) {
          const evidence = await page.evaluate(() => ({
            state: document.querySelector('aithema-html-preview').state,
            iframe: Boolean(document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')),
            violations: window.violations,
          }));
          throw new Error(`${variant}: expected a mounted draft iframe; ${JSON.stringify({ ...evidence, console: errors })}`, { cause });
        }
        const element = await page.evaluateHandle(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe'));
        const frame = await element.asElement().contentFrame();
        assert.ok(frame, 'the mounted iframe has a browsing context');
        await frame.waitForSelector('#new', { timeout: 3000 });
        const answered = await page.evaluate(() => new Promise(resolve => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1500);
          channel.port1.onmessage = event => {
            clearTimeout(timer); channel.port1.close(); resolve(event.data === 'aithema-html-preview-ready');
          };
          document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe').contentWindow
            .postMessage('aithema-html-preview-ready', '*', [channel.port2]);
        }));
        assert.equal(answered, true, 'the draft answers readiness through the private reply port');
        assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'ready');
        assert.equal(await frame.evaluate(() => document.getElementById('dialog').open), false);
        await frame.click('#new');
        assert.equal(await frame.evaluate(() => document.getElementById('dialog').open), true, 'a real click changes draft state');
        await element.dispose();
      });
    page.off('console', record);
  }
  for (const variant of ['none', 'overbroad', 'report-only']) {
    await t.test(`${variant}: START frame policy fails closed`, async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/strict-${variant}`);
      await page.waitForFunction(() => window.ready === true);
      await page.evaluate(html => window.show(html), dummy);
      await page.waitForFunction(() => !document.querySelector('[data-aithema-html-policy-probe]'));
      assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'policy');
      assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
    });
  }
  await t.test('AIT-358: dialog Reload is reachable in both tab directions and activates with Enter and Space', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/strict-header-only`);
    await page.waitForFunction(() => window.ready === true);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(async () => {
      await import('/packages/ui/src/session-element.js');
      const { createSession } = await import('/packages/core/src/session.js');
      const { en } = await import('/packages/ui/src/i18n/en.js');
      const c = document.createElement('aithema-session'), session = createSession({ demo: true });
      session.transcript = [{ id: 'source', role: 'user', content: 'A keyboard-accessible draft' }];
      session.inputRevision = 1;
      session.concepts = [{ id: 'keyboard-draft', mediaType: 'text/html', turnIds: ['source'], referenceIds: [], archived: false,
        feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } }];
      session.conceptCost = { maxMicro: 0 };
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, html: { available: true } } };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const path = new URL(url, location.href).pathname;
        if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
          options.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }));
        if (path.endsWith('/preview')) {
          window.keyboardMints++;
          if (window.keyboardMints === 1) throw new Error('fixture network failure');
          return new Promise(resolve => { window.finishKeyboardMint = resolve; });
        }
        if (path.startsWith('/api/')) return Response.json(c.session);
        return nativeFetch(url, options);
      };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.configure({ session, copy: en, sessionToken: 'fixture-owner', concepts: { previewURL: location.origin + '/_aithema/html-preview' } });
      document.body.append(c);
      window.keyboardSession = c;
    });
    const backTab = async () => {
      await page.keyboard.down('Shift');
      try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
    };
    const focusAt = () => page.evaluate(() => {
      const root = window.keyboardSession.shadowRoot, preview = root.querySelector('.concept-html');
      return root.activeElement === preview ? preview.shadowRoot.activeElement?.className || preview.shadowRoot.activeElement?.dataset.width || preview.shadowRoot.activeElement?.tagName : root.activeElement?.className;
    });
    const geometry = () => page.evaluate(() => {
      const root = window.keyboardSession.shadowRoot, preview = root.querySelector('.concept-html').shadowRoot;
      return [...['.concept-viewer', '.concept-stage', '.concept-viewer-controls'].map(s => root.querySelector(s)),
        ...['.bar', '.stage', '.seg', '.state-content', '.reload'].map(s => preview.querySelector(s))].map(n => {
        const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      });
    });
    let previousSource;
    for (const key of ['Enter', 'Space']) {
      await page.evaluate(() => {
        window.keyboardMints = 0;
        window.keyboardSession.shadowRoot.querySelector('.concept-tab').focus();
      });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.keyboardSession.shadowRoot.querySelector('.concept-html').state === 'failure');
      assert.equal(await focusAt(), 'concept-close', 'opening by keyboard focuses Close');
      const baseline = await geometry();
      await page.keyboard.press('Tab');
      assert.equal(await focusAt(), 'wide', 'Tab enters the selected width control');
      await page.keyboard.press('Tab');
      assert.equal(await focusAt(), 'reload', 'Tab reaches Reload inside the failure-state preview');
      const ring = await page.evaluate(() => {
        const button = window.keyboardSession.shadowRoot.querySelector('.concept-html').shadowRoot.querySelector('.reload');
        const style = getComputedStyle(button);
        return { visible: button.matches(':focus-visible'), outline: style.outlineStyle, width: style.outlineWidth };
      });
      assert.equal(ring.visible, true); assert.equal(ring.outline, 'solid'); assert.equal(ring.width, '2px');
      await backTab(); assert.equal(await focusAt(), 'wide', 'Shift+Tab returns to width');
      await backTab(); assert.equal(await focusAt(), 'concept-close', 'Shift+Tab leaves the preview for Close');
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await focusAt(), 'concept-download', 'Tab leaves Reload for the next enabled dialog action');
      await backTab(); assert.equal(await focusAt(), 'reload', 'backwards entry reaches Reload before width');
      await page.keyboard.press(key);
      await page.waitForFunction(() => window.keyboardSession.shadowRoot.querySelector('.concept-html').state === 'loading');
      assert.equal(await focusAt(), 'state', `${key}: focus stays on the pending status`);
      assert.deepEqual(await geometry(), baseline, `${key}: failure to loading moves 0 px`);
      assert.deepEqual(await page.evaluate(() => {
        const root = window.keyboardSession.shadowRoot.querySelector('.concept-html').shadowRoot;
        return { calls: window.keyboardMints, disabled: root.querySelector('.reload').disabled, live: root.querySelector('.state').getAttribute('aria-live') };
      }), { calls: 2, disabled: true, live: 'polite' });
      await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => window.keyboardMints), 2, 'keys on pending status cannot mint again');
      await page.evaluate(async html => window.finishKeyboardMint(await fetch('/fixture/mint', { method: 'POST', body: html })), dummy);
      await page.waitForFunction(() => window.keyboardSession.shadowRoot.querySelector('.concept-html').state === 'ready');
      const handle = await page.$('aithema-session >>> .concept-html >>> iframe'), frame = await handle.contentFrame();
      await frame.waitForSelector('#new');
      assert.equal(await focusAt(), 'IFRAME', `${key}: fresh frame retains focus`);
      const source = await handle.evaluate(n => n.src);
      assert.notEqual(source, previousSource, `${key}: remount uses a fresh single-use capability`); previousSource = source;
      assert.equal(await page.evaluate(() => window.keyboardMints), 2, `${key}: exactly one reload mint`);
      assert.deepEqual(await geometry(), baseline, `${key}: loading to ready moves 0 px`);
      await handle.dispose();
      // Policy refusal still has just the width stop and cannot offer Reload.
      await page.evaluate(() => {
        const root = window.keyboardSession.shadowRoot, preview = root.querySelector('.concept-html');
        preview.artifact = { ...preview.artifact, previewURL: undefined };
        root.querySelector('.concept-close').focus();
      });
      assert.deepEqual(await page.evaluate(() => {
        const preview = window.keyboardSession.shadowRoot.querySelector('.concept-html'), button = preview.shadowRoot.querySelector('.reload');
        return { state: preview.state, hidden: button.getAttribute('aria-hidden'), disabled: button.disabled };
      }), { state: 'policy', hidden: 'true', disabled: true });
      await page.keyboard.press('Tab'); assert.equal(await focusAt(), 'wide');
      await page.keyboard.press('Tab'); assert.equal(await focusAt(), 'concept-download', 'policy Tab skips the unavailable Reload');
      await backTab(); assert.equal(await focusAt(), 'wide', 'policy backwards entry returns to width');
      await backTab(); assert.equal(await focusAt(), 'concept-close');
      assert.equal(await page.evaluate(() => window.keyboardMints), 2, 'policy navigation never mints');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => window.keyboardSession.remove());
  });
  // Reuse one page for Tick checks. Viewport-only shots, reduced
  // motion and the baseline system font keep evidence deterministic and cheap.
  await page.goto(`http://127.0.0.1:${server.address().port}/strict-header-only`);
  await page.waitForFunction(() => window.ready === true);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, shots = [], checks = [], focus = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const geometry = () => page.evaluate(() => {
    const root = document.querySelector('aithema-html-preview').shadowRoot;
    return ['.bar', '.stage', '.seg', '[data-width="wide"]', '[data-width="phone"]', '.state-content', '.state-icon', '.state-text', '.state-support', '.state-operator', '.reload'].map(selector => {
      const r = root.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    });
  });
  // Every mode retains all geometry cases, including Tick's three configurations.
  const scenarios = [1440, 1024, 390].flatMap(width => ['light', 'dark'].flatMap(theme => ['de', 'en'].map(locale => ({ width, theme, locale }))));
  for (const { width, theme, locale } of scenarios) {
    await page.setViewport({ width, height: 1000 });
    await page.evaluate(async ({ theme, locale }) => {
      document.documentElement.dataset.theme = theme; document.documentElement.lang = locale;
      const { [locale]: copy } = await import('/packages/ui/src/i18n/' + locale + '.js');
      const preview = document.querySelector('aithema-html-preview'); preview.copy = copy.conceptPreview;
      window.previewMintCalls = 0;
      preview.artifact = { mediaType: 'text/html', previewURL: location.origin + '/_aithema/html-preview',
        mint: () => { window.previewMintCalls++; return new Promise((resolve, reject) => { window.finishMint = resolve; window.failMint = reject; }); } };
    }, { theme, locale });
    await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'loading');
    const baseline = await geometry();
    const capture = async (state, reloading = false) => {
      await page.evaluate(async () => {
        const preview = document.querySelector('aithema-html-preview');
        preview.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready;
        await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.mouse.move(-10, -10);
      const boxes = await geometry(); assert.deepEqual(boxes, baseline, `${width}/${theme}/${locale}/${state}: 0 px`);
      const presentation = await page.evaluate(() => {
        const preview = document.querySelector('aithema-html-preview'), root = preview.shadowRoot;
        const icon = root.querySelector('.state-icon'), operator = root.querySelector('.state-operator'), reload = root.querySelector('.reload');
        return { iconSize: [icon.getBoundingClientRect().width, icon.getBoundingClientRect().height],
          iconVisibility: getComputedStyle(icon).visibility, iconColor: getComputedStyle(icon).color,
          ink2: getComputedStyle(root.querySelector('.state')).color,
          operatorVisibility: getComputedStyle(operator).visibility,
          operatorText: root.querySelector('.operator-message').textContent,
          message: root.querySelector('.state-message').textContent, expected: preview.copy[preview.state],
          expectedOperator: preview.copy.policyOperator,
          reload: { visibility: getComputedStyle(reload).visibility, disabled: reload.disabled, text: reload.textContent,
            expected: preview.copy.reload, background: getComputedStyle(reload).backgroundColor, border: getComputedStyle(reload).borderWidth,
            ariaHidden: reload.getAttribute('aria-hidden'), display: getComputedStyle(reload).display,
            height: reload.getBoundingClientRect().height, minHeight: parseFloat(getComputedStyle(reload).minHeight),
            messageGap: reload.getBoundingClientRect().top - root.querySelector('.state-message').getBoundingClientRect().bottom,
            sharedSlot: reload.parentElement === operator.parentElement,
            operatorTop: operator.getBoundingClientRect().top, top: reload.getBoundingClientRect().top,
            color: getComputedStyle(reload).color, accent: getComputedStyle(root.querySelector('[aria-checked="true"]')).color } };
      });
      assert.deepEqual(presentation.iconSize, [20, 20]);
      assert.equal(presentation.iconVisibility, state === 'failure' ? 'visible' : 'hidden');
      assert.equal(presentation.iconColor, presentation.ink2, 'alert uses the host muted ink token');
      assert.equal(presentation.operatorVisibility, state === 'policy' ? 'visible' : 'hidden');
      assert.equal(presentation.operatorText, state === 'policy' ? presentation.expectedOperator : '');
      assert.equal(presentation.message, state === 'ready' ? '' : presentation.expected);
      assert.equal(presentation.reload.visibility, state === 'failure' ? 'visible' : 'hidden');
      assert.equal(presentation.reload.ariaHidden, String(state !== 'failure'));
      assert.notEqual(presentation.reload.display, 'none', 'hidden Reload keeps its layout box');
      assert.ok(presentation.reload.height >= 44, 'Reload target is at least 44 px');
      assert.ok(presentation.reload.minHeight >= 44, 'Reload minimum height is at least 44 px');
      assert.equal(presentation.reload.sharedSlot, true);
      assert.equal(presentation.reload.top, presentation.reload.operatorTop, 'operator and Reload share the same row');
      if (state === 'failure') {
        assert.ok(presentation.reload.messageGap >= 12 && presentation.reload.messageGap <= 16,
          `${width}/${theme}/${locale}: message-to-button gap ${presentation.reload.messageGap} px`);
        assert.equal(presentation.reload.color, presentation.reload.accent, 'active Reload uses teal');
      }
      assert.equal(presentation.reload.disabled, state !== 'failure');
      assert.equal(presentation.reload.text, presentation.reload.expected);
      assert.equal(presentation.reload.background, 'rgba(0, 0, 0, 0)'); assert.equal(presentation.reload.border, '0px');
      checks.push({ width, theme, locale, state, reloading, boxes, presentation, movementPx: 0, iconSlotMovementPx: 0 });
      const requestedCrop = width === 1440 && theme === 'light' && locale === 'de' || width === 390 && theme === 'dark' && locale === 'en';
      if (evidence && requestedCrop && ['failure', 'policy'].includes(state)) {
        const file = `ait353-${width}-${theme}-${locale}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file);
      }
      if (evidence && (requestedCrop && (state === 'failure' || state === 'loading') || width === 390 && theme === 'light' && locale === 'de' && state === 'failure')) {
        const file = `ait358-${width}-${theme}-${locale}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file);
      }
    };
    await capture('loading');
    await page.evaluate(async html => window.finishMint(await (await fetch('/fixture/mint', { method: 'POST', body: html })).json()), dummy);
    await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'ready');
    const handle = await page.$('aithema-html-preview >>> iframe'), frame = await handle.contentFrame();
    await frame.waitForSelector('#new'); await frame.click('#new');
    assert.equal(await frame.evaluate(() => document.querySelector('#dialog').open), true);
    await frame.evaluate(() => parent.postMessage({ type: 'reload' }, '*'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.previewMintCalls), 1, 'the opaque draft cannot request a parent reload');
    const beforeWidth = await handle.evaluate(n => n.src);
    await page.evaluate(() => { document.querySelector('aithema-html-preview').width = 'phone'; });
    assert.equal(await handle.evaluate(n => n.src), beforeWidth, 'width changes never reload');
    await capture('ready');
    // Replacing a focused draft transfers focus; a mint failure returns to the width control.
    await handle.focus();
    await page.evaluate(() => {
      const preview = document.querySelector('aithema-html-preview');
      window.reloadMintCalls = 0;
      preview.artifact = { ...preview.artifact, mint: () => {
        if (++window.reloadMintCalls === 1) return Promise.reject(new Error('fixture 503'));
        return new Promise(resolve => { window.finishReload = resolve; });
      } };
    });
    await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'failure');
    assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.activeElement?.dataset.width), 'phone');
    focus.push({ width, theme, locale, restoredTo: 'phone', pass: true }); await capture('failure');
    // Exercise Reload in Tick's two crops, reusing the page and the real route.
    if (width === 1440 && theme === 'light' && locale === 'de' || width === 390 && theme === 'dark' && locale === 'en') {
      await page.click('aithema-html-preview >>> .reload');
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'loading');
      const pending = await page.evaluate(() => {
        const root = document.querySelector('aithema-html-preview').shadowRoot, button = root.querySelector('.reload');
        button.click();
        return { disabled: button.disabled, statusFocused: root.activeElement === root.querySelector('.state'), calls: window.reloadMintCalls };
      });
      assert.deepEqual(pending, { disabled: true, statusFocused: true, calls: 2 });
      focus.push({ width, theme, locale, afterReload: 'status', pass: true }); await capture('loading', true);
      await page.evaluate(async html => window.finishReload(await (await fetch('/fixture/mint', { method: 'POST', body: html })).json()), dummy);
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'ready');
      assert.equal(await page.evaluate(() => {
        const root = document.querySelector('aithema-html-preview').shadowRoot;
        return root.activeElement === root.querySelector('iframe');
      }), true);
      const freshHandle = await page.$('aithema-html-preview >>> iframe'), freshFrame = await freshHandle.contentFrame();
      await freshFrame.waitForSelector('#new');
      assert.notEqual(await freshHandle.evaluate(n => n.src), beforeWidth, 'Reload mounts a fresh single-use capability');
      assert.equal(await page.evaluate(() => window.reloadMintCalls), 2, 'one mint per click');
      focus.push({ width, theme, locale, afterReload: 'frame', pass: true }); await capture('ready'); await freshHandle.dispose();
      // A second failure returns the keyboard to the action that can retry it.
      await page.evaluate(() => {
        const preview = document.querySelector('aithema-html-preview');
        preview.artifact = { ...preview.artifact, mint: async () => { throw new Error('fixture repeated failure'); } };
      });
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'failure');
      assert.deepEqual(await page.evaluate(() => {
        const root = document.querySelector('aithema-html-preview').shadowRoot;
        root.querySelector('.reload').click();
        return { statusFocused: root.activeElement === root.querySelector('.state'),
          hidden: getComputedStyle(root.querySelector('.reload')).visibility };
      }), { statusFocused: true, hidden: 'hidden' });
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'failure');
      assert.equal(await page.evaluate(() => {
        const root = document.querySelector('aithema-html-preview').shadowRoot;
        return root.activeElement === root.querySelector('.reload');
      }), true, 'repeated failure focuses Reload');
      focus.push({ width, theme, locale, afterReload: 'repeated-failure-action', pass: true });
      await capture('failure');

    }
    await page.evaluate(() => {
      const preview = document.querySelector('aithema-html-preview'); preview.artifact = { ...preview.artifact, previewURL: undefined };
    });
    assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'policy'); await capture('policy');
    await handle.dispose();
  }
  if (evidence) await writeFile(join(evidence, 'ait353-checks.json'), JSON.stringify({ shots, checks, focus, movementPx: 0, iconSlotMovementPx: 0,
    geometrySelectors: ['.bar', '.stage', '.seg', '[data-width="wide"]', '[data-width="phone"]', '.state-content', '.state-icon', '.state-text', '.state-support', '.state-operator', '.reload'],
    strictHost: ['header-only: handshake and click/dialog PASS', 'header-and-meta: handshake and click/dialog PASS'],
    refusedPolicies: ['none', 'overbroad', 'report-only'], offline: true }, null, 2));
  if (evidence) await writeFile(join(evidence, 'ait358-checks.json'), JSON.stringify({ shots: shots.filter(file => file.startsWith('ait358-')),
    checks, focus: focus.filter(check => check.afterReload), movementPx: 0, reloadSlotMovementPx: 0,
    explicitReload: 'one fresh mint and remount per click; disabled in flight', draftMessagesCannotReload: true, offline: true }, null, 2));
  console.log(`PASS AIT-353: ${checks.length} geometry states, 0 px; ${focus.length} focus checks; strict host todos removed`);

});

// Reuse this measured shard workload; no shard count or workflow changes.
test('AIT-364: cross-tab single-item consent withdrawal removes HTML and images', { timeout: 60_000 }, async t => {
  const { partialConsentFrames } = await import('../fixtures/partial-consent-frames.js');
  await partialConsentFrames(t, { isCI });
});

test('AIT-369: delivered coverage survives visual choices and revokes per kind', { timeout: 45_000 }, async t => {
  const { deliveredConsentFrames } = await import('../fixtures/delivered-consent-frames.js');
  await deliveredConsentFrames(t);
});

// AIT-386 stays in the existing preview shard: reuse one page for the request
// matrix and two viewport pairs, without another browser file or shard bin.
test('AIT-386: delivered artifacts never turn draft bytes into image requests', { timeout: 45_000 }, async t => {
  const { createSession } = await import('../../packages/core/src/index.js');
  const { browserForFile } = await import('./shared-browser.js');
  const source = '<!doctype html><html><head><title>Offline draft</title></head><body><h1>Offline draft</h1></body></html>';
  const bytesPath = '/' + [...new TextEncoder().encode(source)].join(',');
  const preview = previewFixture(), requests = [], socketRequests = [], checks = [], keptImages = [], shots = [];
  let phase = 'bootstrap';
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>
    body{margin:0} aithema-session,ait386-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}
    </style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';
    import {ConceptView} from '/packages/ui/src/concept-view.js';
    import {de} from '/packages/ui/src/i18n/de.js';
    const update=ConceptView.prototype.update, fixedVisualKind=ConceptView.prototype.visualKind;
    ConceptView.prototype.update=function(){window.view=this;return update.apply(this,arguments);};
    window.baseline=enabled=>{ConceptView.prototype.visualKind=enabled?function(){return this.root.host.session.conceptVisualKind==='html'?'html':'image';}:fixedVisualKind;};
    customElements.define('ait386-session',class extends customElements.get('aithema-session'){connectedCallback(){}});
    window.mount=session=>{window.c?.remove();const c=document.createElement('ait386-session');window.c=c;
      c.configure({session,copy:de,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
      c.setAttribute('theme','light');c.setAttribute('motion','off');
      // Render without SSE: the wire fixture's only runtime traffic is through
      // authenticated concept routes and the scoped HTML preview document.
      document.body.append(c); view.update(session,{consentRevision:session.consentRevision,
        selected:['drafts','images'],features:{html:['drafts'],images:['images']}});};
    window.ready=true;
    </script></body></html>`;
  const server = createServer(async (req, res) => {
    socketRequests.push({ phase, method: req.method, path: req.url });
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (await preview(req, res)) return;
      if (/^\/api\/sessions\/ait386\/concepts\/[\w-]+\/preview$/u.test(path)) {
        return preview({ url: '/fixture/mint', method: 'POST', headers: req.headers,
          async *[Symbol.asyncIterator]() { yield source; } }, res);
      }
      if (path.endsWith('/html')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(source); }
      if (path.endsWith('/image')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); }
      if (path.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(); }
      if (path.endsWith('/eligibility')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
      if (path === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`) }); return res.end(html); }
      if (/^\/packages\/(?:ui|core)\/src\/[\w/-]+\.(?:js|json)$/u.test(path)) {
        res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' }); return res.end(await readFile(join(root, path)));
      }
      res.writeHead(404); res.end();
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage();
  page.on('request', request => requests.push({ phase, method: request.method(), url: request.url(), type: request.resourceType() }));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
  });
  const shoot = async label => {
    await settle(); await page.mouse.move(-10, -10);
    const name = `ait386-${label}-light-de.png`; shots.push(name);
    if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false });
  };
  const sessionFor = (visuals, kind) => {
    const session = createSession({ demo: true }); session.id = 'ait386'; session.locale = 'de'; session.visualsBound = true;
    session.settings.visuals = visuals; session.settings.origin = 'chosen';
    session.conceptVisualKind = visuals === 'html' ? 'html' : 'images';
    session.transcript = [{ id: 'source', role: 'user', content: 'Ein Dashboard für unser Team.' }]; session.inputRevision = 1;
    const artifact = type => ({ id: type, mediaType: type === 'html' ? 'text/html' : 'image/png', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } });
    session.concepts = kind === 'mixed' ? [artifact('image'), artifact('html')] : [artifact(kind)]; session.conceptStatus = { phase: 'ready' };
    session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'images', 'html'].map(feature => [feature,
      ['text', 'analysis', visuals].includes(feature) ? { available: true } : { available: false, reason: visuals === 'off' ? 'visuals off' : 'visual kind not selected' }])) };
    return session;
  };
  try {
    // Explicit positive control for the historical defect, replayed at final
    // head: the old backdrop path assigned its /html Uint8Array to img.src.
    // This is intentionally isolated from the production request assertions.
    for (const width of [1440, 390]) {
      phase = `before-replay/${width}`; await page.evaluate(() => baseline(true)); await page.setViewport({ width, height: 900 });
      await page.evaluate(session => mount(session), sessionFor('off', 'html'));
      await page.evaluate(async () => {
        const response = await fetch('/api/sessions/ait386/concepts/html/html', { headers: { 'x-aithema-session-token': 'fixture-owner' }, cache: 'no-store' });
        const image=c.shadowRoot.querySelector('.concept-backdrop img');
        image.src = new Uint8Array(await response.arrayBuffer()); image.dataset.id='html'; image.setAttribute('data-on','');
      });
      await page.waitForNetworkIdle({ idleTime: 100 }); await shoot(`before-replay-${width}`);
      assert.ok(socketRequests.some(r => r.phase === phase && r.path === bytesPath), 'positive control observes the original bytes-as-path leak at the host');
    }
    await page.evaluate(() => baseline(false));
    for (const visuals of ['off', 'images', 'html']) for (const kind of ['html', 'image', 'mixed']) {
      phase = `after/${visuals}/${kind}`;
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluate(session => mount(session), sessionFor(visuals, kind));
      await settle();
      if (visuals === 'off' && kind === 'html') {
        await page.waitForNetworkIdle({ idleTime: 100 }); await shoot('after-1440');
        await page.setViewport({ width: 390, height: 900 }); await shoot('after-390');
      }
      if (visuals === 'off' && kind === 'image') {
        for (const width of [1440, 390]) {
          await page.setViewport({ width, height: 900 });
          await page.waitForNetworkIdle({ idleTime: 100 }); await settle();
          const kept = await page.evaluate(async () => {
            const thumbnail = c.shadowRoot.querySelector('.concept-preview img[src]');
            return { src: thumbnail?.getAttribute('src'), id: thumbnail?.dataset.id,
              minted: await view.loadImageURL('image'), layout: c.shadowRoot.querySelector('.workspace').dataset.conceptLayout };
          });
          assert.ok(kept.src?.startsWith('blob:'), 'Off keeps a painted image thumbnail');
          assert.equal(kept.id, 'image');
          assert.equal(kept.src, kept.minted, 'the thumbnail uses this view’s object URL for the kept image');
          assert.equal(kept.layout, 'image', 'AIT-282 keeps the image layout reservation under Off');
          keptImages.push({ visuals, kind, width, kept });
          await shoot(`kept-image-after-${width}`);
        }
      }
      await page.evaluate(async () => {
        for (const item of view.items) {
          view.open(item.id);
          if (item.mediaType !== 'text/html') await (view.loadImageURL?.(item.id) ?? view.load(item.id));
          else {
            const preview=c.shadowRoot.querySelector('.concept-html'), started=performance.now();
            while(preview.state!=='ready') {
              if(performance.now()-started>3000) throw new Error('delivered HTML preview did not become ready');
              await new Promise(resolve=>requestAnimationFrame(resolve));
            }
          }
          view.close();
        }
        c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas();
      });
      await page.waitForNetworkIdle({ idleTime: 100 }); await settle();
      const images = await page.evaluate(() => [...c.shadowRoot.querySelectorAll('img[src]')].map(image => ({ src: image.getAttribute('src'), id: image.dataset.id })));
      const ids = await page.evaluate(() => view.items.map(i => i.id));
      assert.deepEqual(ids, kind === 'mixed' ? ['image', 'html'] : [kind], 'kept consent preserves each delivery');
      checks.push({ visuals, kind, images, ids });
    }
  } finally {
    if (evidence) await writeFile(join(evidence, 'ait386-requests.json'), JSON.stringify({ shots, checks, keptImages, requests, socketRequests,
      baseline: 'Explicit replay of the pre-fix Uint8Array-to-backdrop.src assignment; synthetic offline draft only.',
      offline: true, viewportOnly: true }, null, 2));
  }
  const conceptRequest = raw => { const url = new URL(raw); return url.protocol === 'blob:' || url.protocol === 'data:' ||
    url.origin === `http://127.0.0.1:${server.address().port}` && (/^\/api\/sessions\/ait386\/concepts\//u.test(url.pathname) || url.pathname === '/_aithema/html-preview'); };
  const runtime = requests.filter(r => r.phase.startsWith('after/'));
  assert.deepEqual(runtime.filter(r => !conceptRequest(r.url)), [], 'every runtime request stays within concept routes (or local blob/data resources)');
  assert.deepEqual(socketRequests.filter(r => r.phase.startsWith('after/') && !conceptRequest(`http://127.0.0.1:${server.address().port}${r.path}`)), [], 'the host sees no request outside concept routes');
  assert.equal(runtime.some(r => /\/(?:60,33,100|%3C!doctype)/iu.test(new URL(r.url).pathname)), false, 'no draft bytes in any request path');
  for (const check of checks) for (const image of check.images) {
    assert.ok(image.src.startsWith('blob:'), `${check.visuals}/${check.kind}: blob images only`);
    assert.equal(image.id, 'image', 'an HTML artifact is never painted as an image');
  }
  assert.equal(checks.length, 9);
  t.diagnostic(`AIT-386 request sweep: ${runtime.length} browser requests; no request outside concept routes; 9 states.`);
});

test('AIT-385: withdrawal removes the empty focus tile and clears the chevron', { timeout: 45_000 }, async t => {
  const { withdrawalFocusFrames } = await import('../fixtures/withdrawal-focus-frames.js');
  await withdrawalFocusFrames(t);
});


test('AIT-400: withdrawal preserves the top transcript row and reserved status slot', { timeout: 45_000 }, async t => {
  const { withdrawalFocusFrames } = await import('../fixtures/withdrawal-focus-frames.js');
  await withdrawalFocusFrames(t, { transcriptTop: true });
});
