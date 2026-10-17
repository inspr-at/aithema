import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { test } from 'node:test';
import puppeteer from './launch.js';
import { HTML_PREVIEW_HOST_CSP, inspectHTML } from '@inspr/aithema-core';
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
window.show = html => { document.querySelector('aithema-html-preview').artifact = { bytes: new TextEncoder().encode(html), mediaType: 'text/html' }; };
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
  const hits = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/destination/')) {
      hits.push(path); res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><script>fetch("/beacon/destination-script");new Image().src="/beacon/destination-image"</script>');
    }
    if (path.startsWith('/beacon/')) { hits.push(path); res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); return res.end('ok'); }
    if (['/', '/no-policy', '/unverified-policy', '/report-only-probe', '/script-policy'].includes(path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'host-cookie=host-cookie-secret; Path=/',
        ...(path === '/' ? { 'content-security-policy': HTML_PREVIEW_HOST_CSP } : {}),
        ...(['/unverified-policy', '/report-only-probe'].includes(path) ? { 'content-security-policy-report-only': HTML_PREVIEW_HOST_CSP } : {}) });
      const declarations = {
        '/no-policy': '',
        '/unverified-policy': `<meta http-equiv="Content-Security-Policy-Report-Only" content="${HTML_PREVIEW_HOST_CSP}">`,
        // The test-only property declares the policy to the element, while the
        // absent content attribute leaves Chrome with only the report-only header.
        '/report-only-probe': `<meta id="claimed-policy" http-equiv="Content-Security-Policy"><script>Object.defineProperty(document.getElementById('claimed-policy'),'content',{value:"${HTML_PREVIEW_HOST_CSP}"});</script>`,
        '/script-policy': `<meta id="claimed-policy"><script>const claim=document.getElementById('claimed-policy');claim.httpEquiv='Content-Security-Policy';claim.content="${HTML_PREVIEW_HOST_CSP}";</script>`,
      };
      return res.end(path === '/' ? host : host.replace(declaration, declarations[path]));
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
  assert.match(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.state').textContent), /host page must block frame navigation/u);
  assert.deepEqual(await page.evaluate(() => window.results), []);
  // A report-only header and meta do not enforce the host policy. The element
  // rejects this declaration before starting its browser policy probe.
  await page.goto(`http://127.0.0.1:${port}/unverified-policy`); await page.waitForFunction(() => window.ready === true);
  assert.equal(await page.evaluate(html => {
    window.show(html); return Boolean(document.querySelector('[data-aithema-html-policy-probe]'));
  }, hostile(port)), false);
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').state), 'policy');
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
  assert.deepEqual(await page.evaluate(() => window.results), []);
  // This second report-only case reaches the probe: a non-enforcing property
  // satisfies the declaration check, but a trusted report cannot prove enforcement.
  await page.goto(`http://127.0.0.1:${port}/report-only-probe`); await page.waitForFunction(() => window.ready === true);
  assert.deepEqual(await page.evaluate(() => {
    const meta = document.getElementById('claimed-policy'); return [meta.content, meta.getAttribute('content')];
  }), [HTML_PREVIEW_HOST_CSP, null]);
  assert.equal(await page.evaluate(html => {
    window.show(html); return Boolean(document.querySelector('[data-aithema-html-policy-probe]'));
  }, hostile(port)), true, 'the non-enforcing declaration reaches the policy probe');
  await page.waitForFunction(policy => window.violations.some(v => v.trusted && v.directive === 'frame-src' &&
    v.disposition === 'report' && v.policy === policy && (v.blocked === '' || v.blocked === 'data' || v.blocked.startsWith('data:'))), {}, HTML_PREVIEW_HOST_CSP);
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
    const found = page.frames().find(f => f !== page.mainFrame() && f.url() === 'about:srcdoc');
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
      element.artifact = html === null ? null : { bytes: new TextEncoder().encode(html), mediaType: 'text/html' };
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
      assert.equal(await page.evaluate(async html => {
        window.show(html); await Promise.resolve(); return document.querySelector('aithema-html-preview').state;
      }, draft), 'ready', 'the verified host policy authorizes the draft before it attempts navigation');
      const destination = `http://127.0.0.1:${port}/destination/${delayed ? 'after-load' : 'immediate'}`;
      await page.waitForFunction(url => window.violations.some(v => v.trusted && v.directive === 'frame-src' && v.blocked === url && v.disposition === 'enforce'), {}, destination);
      await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'navigated');
      assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
      assert.match(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('.state').textContent), /tried to open another page and was stopped/u);
      assert.equal(page.url(), `http://127.0.0.1:${port}${hostPath}`);
      assert.deepEqual(hits, [], `${hostPath}: ZERO navigation requests and ZERO requests from destination scripts`);
    }
    t.diagnostic(`${hostPath} CSP evidence: ${JSON.stringify(await page.evaluate(() => window.violations.filter(v => v.directive === 'frame-src')))}`);
  }
  t.diagnostic(`navigation and destination-script requests: ${JSON.stringify(hits)} (ZERO)`);
});

// AIT-282 stays in this small existing shard workload: one page, state changes
// in place, and the expensive screenshot matrix only in explicit evidence mode.
test('AIT-282: concept backdrop has zero layout shift at 1440/1024/390 in DE/EN', { timeout: 180_000 }, async t => {
  const { writeFile } = await import('node:fs/promises');
  const evidence = isCI ? undefined : process.env.AITHEMA_EVIDENCE_DIR;
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
  const browser = await puppeteer.launch({ executablePath:await browserPath(), headless:true, userDataDir:join(directory,'chrome'), args:process.platform==='linux'&&isCI?['--no-sandbox']:[] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive:true,force:true}); });
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
  for (const locale of ['de','en']) for (const width of [1440,1024,390]) for (const theme of evidence?['light','dark']:['light']) {
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
