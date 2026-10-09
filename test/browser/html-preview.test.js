import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { inspectHTML } from '@inspr/aithema-core';
// Real Chrome: the sandboxed preview cannot read the host page, its cookies or storage, and cannot fetch.
// Set AITHEMA_EVIDENCE_DIR to keep screenshots of the sample click-dummy (wide light/dark, phone).
const root = new URL('../../', import.meta.url).pathname;
const dummy = await readFile(join(root, 'test/fixtures/click-dummy.html'), 'utf8');
async function browserPath() {
  for (const path of [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('No Chrome or Chromium found. Set CHROME_PATH to its executable.');
}
const host = `<!doctype html><html><head><meta charset="utf-8"><title>Host</title>
<style>body{margin:0;padding:24px;font:15px system-ui;background:#f7f5ef} aithema-html-preview{max-width:1200px}</style></head>
<body><p id="parent-secret">host-page-secret</p><aithema-html-preview></aithema-html-preview>
<script type="module">
import '/packages/ui/src/html-preview.js';
localStorage.setItem('host-storage', 'host-storage-secret');
window.results = []; addEventListener('message', event => window.results.push(event.data));
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
const leaving = port => `<!doctype html><html><head><title>Leaving draft</title></head><body><p>leaving</p><script>
setTimeout(() => { self['loc' + 'ation']['hr' + 'ef'] = 'ht' + 'tp:/' + '/127.0.0.1:${port}/beacon/navigate'; }, 100);
</script></body></html>`;
test('real Chrome isolates the html preview and renders the sample click-dummy', { timeout: 90_000 }, async t => {
  const hits = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/beacon/')) { hits.push(path); res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); return res.end('ok'); }
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'host-cookie=host-cookie-secret; Path=/' }); return res.end(host); }
    const file = normalize(join(root, path));
    if (!/^\/packages\/(?:ui|core)\/src\/[\w-]+\.js$/u.test(path) || !file.startsWith(root)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(await readFile(file));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, directory = await mkdtemp(join(tmpdir(), 'aithema-preview-'));
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready === true);
  assert.equal(await page.evaluate(() => document.cookie), 'host-cookie=host-cookie-secret', 'the host has a cookie worth stealing');
  const stage = () => page.evaluate(() => { const r = document.querySelector('aithema-html-preview').shadowRoot.querySelector('.stage').getBoundingClientRect();
    return [r.x, r.y, r.width, r.height]; });
  const state = () => page.evaluate(() => document.querySelector('aithema-html-preview').state);
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
  const frame = await (async () => { for (let i = 0; i < 100; i++) {
    const found = page.frames().find(f => f !== page.mainFrame() && f.url() === 'about:srcdoc');
    if (found && await found.evaluate(() => document.readyState === 'complete' && Boolean(document.getElementById('new'))).catch(() => false)) return found;
    await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('click-dummy frame not ready'); })();
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

  // 3. A draft that navigates its own frame away is removed and the state says so.
  await page.evaluate(html => window.show(html), leaving(port));
  await page.waitForFunction(() => document.querySelector('aithema-html-preview').state === 'navigated', { timeout: 15_000 });
  assert.equal(await page.evaluate(() => document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')), null);
  assert.equal(page.url(), `http://127.0.0.1:${port}/`);
  // Residual, documented: CSP cannot stop a frame navigating itself; the request carries only the draft's own data.
  t.diagnostic(`self-navigation requests observed: ${JSON.stringify(hits)}`);
  assert.ok(hits.every(path => path === '/beacon/navigate'));
});
