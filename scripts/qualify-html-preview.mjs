// One loopback-only page per engine; no screenshots, suite conversion or provider calls.
// Usage: node scripts/qualify-html-preview.mjs /absolute/playwright-core/index.mjs output.json HEAD
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { qualificationHost, hostile, leaving } from '../test/qualification/preview-host.js';
import { startChild } from '../test/helpers.js';

const [modulePath, evidencePath, head] = process.argv.slice(2);
assert.ok(modulePath && evidencePath && head, 'playwright module, evidence file and committed HEAD required');
const engines = await import(pathToFileURL(modulePath).href);
const dummy = await readFile(new URL('../test/fixtures/click-dummy.html', import.meta.url), 'utf8');
const evidence = { head, guarantee: 'no network; a self-reload is refused', engines: {} };
let failed = false, doubleFetch = false;
const directory = await mkdtemp(join(tmpdir(), 'aithema-three-engine-'));
let demo;
try {
  demo = await startChild(new URL('../demo/server.js', import.meta.url), join(directory, 'demo.sqlite'));
  for (const name of ['chromium', 'webkit', 'firefox']) {
    const started = performance.now(), result = evidence.engines[name] = { checks: {}, redemptions: [] };
    const host = await qualificationHost();
    let browser;
    try {
      browser = await engines[name].launch({ headless: true });
      result.version = browser.version();
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const escaped = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if ([host.origin, demo.url].includes(url.origin)) return route.continue();
        escaped.push(url.protocol); return route.abort(); // Refuse every non-fixture socket, and fail below.
      });
      const page = await context.newPage(); page.setDefaultTimeout(6000);
      const response = await page.goto(host.origin + '/strict-header-only');
      assert.equal(response.headers()['content-security-policy'], host.policy());
      await page.waitForFunction(() => window.ready === true);
      assert.equal(await page.locator('head meta[http-equiv="Content-Security-Policy"]').count(), 0);
      assert.equal(await page.evaluate(() => document.cookie), 'host-cookie=host-cookie-secret');
      assert.equal(await page.evaluate(() => localStorage.getItem('host-storage')), 'host-storage-secret');
      const state = value => page.waitForFunction(value => document.querySelector('aithema-html-preview').state === value, value);
      const noFrame = async () => assert.equal(await page.locator('aithema-html-preview iframe').count(), 0);
      const singleLoad = () => {
        const counts = host.mints.map((_, i) => host.redemptions.filter(r => r.mint === i + 1).length);
        if (counts.some(n => n > 1)) {
          doubleFetch = true;
          throw Error(`STOP: ${name} double-fetched a frame load; report to LEAD; capability must remain single-use`);
        }
        assert.ok(counts.every(n => n === 1), 'each minted frame has exactly one independently counted GET');
      };
      const show = async (id, html) => {
        host.add(id, html); await page.evaluate(id => window.show(id), id);
        await page.waitForFunction(() => Boolean(document.querySelector('aithema-html-preview').shadowRoot.querySelector('iframe')));
        const frame = await page.locator('aithema-html-preview iframe').elementHandle().then(handle => handle.contentFrame());
        assert.ok(frame); return frame;
      };
      const quiet = () => new Promise(resolve => setTimeout(resolve, 250));
      // Prove the independent counter sees each destination outside the draft.
      const paths = ['fetch', 'image', 'form', 'popup', 'top'].map(kind => '/beacon/' + kind)
        .concat(['/destination/immediate', '/destination/delayed']);
      for (const path of paths) assert.equal((await fetch(host.origin + path)).status, 200);
      assert.deepEqual(host.hits.filter(p => paths.includes(p)), paths);
      host.hits.length = 0;
      await page.evaluate(() => {
        const script = document.createElement('script'); script.textContent = 'window.unapprovedInlineRan=true'; document.body.append(script);
      });
      await page.waitForFunction(() => window.violations.some(v => v.trusted && v.disposition === 'enforce' && v.blocked === 'inline'));
      assert.equal(await page.evaluate(() => window.unapprovedInlineRan), undefined);
      result.checks.strictHead = 'PASS: header-only strict script-src, hash-approved import map; inline control blocked';

      const frame = await show('hostile', hostile(host.origin));
      await page.waitForFunction(() => window.results.length === 1);
      const { result: probe, origin } = (await page.evaluate(() => window.results))[0];
      assert.equal(origin, 'null'); assert.equal(probe.origin, 'null');
      for (const key of ['parentDom', 'parentCookie', 'cookie', 'storage', 'sessionStorage', 'parentStorage']) assert.equal(probe[key], 'blocked SecurityError', key);
      assert.equal(probe.fetch, 'blocked TypeError'); assert.equal(probe.image, 'blocked'); assert.equal(probe.popup, 'blocked');
      assert.ok(['attempted', 'blocked SecurityError'].includes(probe.form), 'form submission was attempted');
      assert.ok(['attempted', 'blocked SecurityError'].includes(probe.top), 'top navigation was attempted');
      await frame.click('#interact'); assert.equal(await frame.locator('#interact').textContent(), 'Changed');
      await quiet(); assert.equal(context.pages().length, 1); assert.equal(page.url(), host.origin + '/strict-header-only');
      assert.deepEqual(host.hits.filter(p => p.startsWith('/beacon/')), []);
      singleLoad();
      for (const key of ['opaqueOrigin', 'hostDOM', 'cookies', 'storage', 'fetch', 'image', 'form', 'popup', 'topNavigation']) result.checks[key] = 'PASS';
      result.probe = probe;
      const clickDummy = await show('interactive', dummy);
      await clickDummy.click('#new'); assert.equal(await clickDummy.locator('#dialog').evaluate(node => node.open), true);
      result.checks.interactive = 'PASS'; singleLoad();
      const attrs = await page.locator('aithema-html-preview iframe').evaluate(f => [f.getAttribute('sandbox'), f.getAttribute('referrerpolicy')]);
      assert.deepEqual(attrs, ['allow-scripts', 'no-referrer']);
      for (const delayed of [false, true]) {
        await show(delayed ? 'delayed' : 'immediate', leaving(host.origin, delayed));
        await state('navigated'); await noFrame(); await quiet(); singleLoad();
        assert.deepEqual(host.hits.filter(p => p.startsWith('/destination/')), []);
        result.checks[delayed ? 'delayedSelfNavigation' : 'immediateSelfNavigation'] = 'PASS';
      }
      host.silent(true); await show('silent', dummy); await state('navigated'); await noFrame(); singleLoad(); host.silent(false);
      result.checks.readinessFailure = 'PASS: a 200 without the private-port bootstrap is removed';
      await show('revocation', dummy);
      await page.evaluate(() => { document.querySelector('aithema-html-preview').artifact = null; });
      await state('empty'); await noFrame();
      const held = await page.evaluate(async () => (await fetch('/api/sessions/qualification/concepts/revocation/preview', {
        method: 'POST', headers: { 'X-Aithema-Session-Token': 'fixture-owner' },
      })).json());
      host.session.consentWithdrawn = true;
      const deniedResponse = page.waitForResponse(r => r.url() === held.url);
      await page.evaluate(source => { document.querySelector('aithema-html-preview').artifact = {
        mediaType: 'text/html', previewURL: location.origin + '/_aithema/html-preview', mint: async () => source,
      }; }, held);
      const denied = await deniedResponse; assert.equal(denied.status(), 403);
      assert.match(denied.headers()['content-type'], /^text\/plain/u);
      assert.equal(denied.headers()['set-cookie'], undefined); assert.equal(denied.headers().location, undefined);
      await state('navigated'); await noFrame(); host.session.consentWithdrawn = false; singleLoad();
      host.publication(false); await page.evaluate(() => window.show('revocation')); await state('failure'); await noFrame(); host.publication(true);
      result.checks.revocation = 'PASS: delivered frame removed; held capability refused after consent withdrawal; publication blocks fresh mint';

      // Deliberate second GET is the only allowed repeat, after initial-load counting.
      const reloadFrame = await show('reload', dummy); await reloadFrame.waitForSelector('#new'); await quiet(); singleLoad();
      const source = await page.evaluate(() => window.lastSource);
      const reloaded = page.waitForResponse(r => r.url() === source.url);
      await reloadFrame.evaluate(() => location.reload());
      const refused = await reloaded; assert.equal(refused.status(), 403);
      assert.equal(await refused.text(), 'Forbidden');
      assert.equal(refused.headers()['cache-control'], 'private, no-store');
      assert.equal(refused.headers()['set-cookie'], undefined); assert.equal(refused.headers().location, undefined);
      await state('navigated'); await noFrame();
      assert.deepEqual(host.redemptions.filter(r => r.mint === host.mints.length).map(r => r.status), [200, 403]);
      result.checks.selfReload = 'PASS: exactly [200,403]; no automatic mint';
      assert.deepEqual(host.hits.filter(p => p.startsWith('/beacon/') || p.startsWith('/destination/')), []);
      assert.deepEqual(escaped, []);
      result.blockedDestinationHits = 0;

      // The real demo must boot under the same strict script policy in CI.
      const demoResponse = await page.goto(demo.url);
      assert.ok(demoResponse.headers()['content-security-policy'].startsWith("script-src 'self'; frame-src "));
      await page.waitForFunction(() => Boolean(customElements.get('aithema-session')));
      await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.demoInlineRan=true'; document.body.append(s); });
      await quiet(); assert.equal(await page.evaluate(() => window.demoInlineRan), undefined);
      result.checks.strictDemo = 'PASS';
    } catch (error) {
      failed = true; result.error = String(error.message).replace(/cap=[A-Za-z0-9_-]+/gu, 'cap=REDACTED');
      console.error(`${name}: ${result.error}`);
    } finally {
      result.redemptions = [...host.redemptions];
      result.serverHits = Object.fromEntries([...new Set(host.hits)].map(path => [path, host.hits.filter(p => p === path).length]));
      await browser?.close(); await host.close();
      result.seconds = Number(((performance.now() - started) / 1000).toFixed(3));
      console.log(`${name}: ${JSON.stringify(result)}`);
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
    if (doubleFetch) break;
  }
} finally { await demo?.kill(); await rm(directory, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
