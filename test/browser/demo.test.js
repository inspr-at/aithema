import { mockConsent } from './consent-helpers.js';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { FEATURES } from '../../packages/core/src/presets.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../demo/processing-consent.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { START_GERMAN_CONSENT, FEATURE_REASON_CODES, VOICE_REASON_CODES } from '../fixtures/german-server-texts.js';
import { pdf } from '../extractor-fixtures.js';
import { formatBytes } from '../../packages/ui/src/uploads.js';
import { AI_NOTICE } from '../../packages/core/src/ai-notice.js';

const waitTimeout = 45_000;
const content = 'operations: hosted; data: public; systems: API; reach: international';

async function browserPath() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir =>
      ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => join(dir, name)))
      .filter(path => path !== '/snap/bin/chromium'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const path of new Set(candidates)) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next installed browser. */ }
  }
  throw new Error(process.env.CHROME_PATH
    ? 'CHROME_PATH is not an executable browser. Set it to the absolute path of Chrome or Chromium.'
    : 'No Chrome or Chromium found. Install a system browser or set CHROME_PATH to its executable.');
}

// Observe the shadow root itself: document MutationObservers cannot see its updates.
async function waitForShadow(page, selector, expected = {}) {
  await page.evaluate(async (selector, expected, timeout) => {
    await customElements.whenDefined('aithema-session');
    const root = document.querySelector('aithema-session').shadowRoot;
    await new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => {
        observer.disconnect(); reject(new Error(`Demo UI did not become ready: ${selector}`));
      }, timeout);
      function check() {
        const node = root.querySelector(selector);
        if (!node || (expected.text !== undefined && node.textContent !== expected.text)
          || (expected.enabled !== undefined && !node.disabled !== expected.enabled)) return;
        observer.disconnect(); clearTimeout(timer); resolve();
      }
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      check();
    });
  }, selector, expected, waitTimeout);
}

function waitForDownload(cdp, signal) {
  return new Promise((resolve, reject) => {
    let guid;
    const cleanup = () => {
      cdp.off('Browser.downloadWillBegin', begin); cdp.off('Browser.downloadProgress', progress);
      signal.removeEventListener('abort', abort);
    };
    const begin = event => { guid = event.guid; };
    const progress = event => {
      if (event.guid !== guid) return;
      if (event.state === 'completed') { cleanup(); resolve(event); }
      else if (event.state === 'canceled') { cleanup(); reject(new Error('Export download was canceled')); }
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    cdp.on('Browser.downloadWillBegin', begin); cdp.on('Browser.downloadProgress', progress);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Fault only the host module served to this browser; never edit the parallel demo work.
async function injectRegression(page, url, fail) {
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      if (request.url() !== `${url}/demo/host.js`) { await request.continue(); return; }
      const response = await fetch(request.url());
      assert.equal(response.status, 200);
      const source = await response.text();
      const faulty = source.replace("await postJson('/api/sessions', { ...request, locale: preferredLocale() })",
        "await fetch('/api/sessions', { method: 'POST', body: JSON.stringify({ ...request, locale: preferredLocale() }) })");
      assert.notEqual(faulty, source, 'Regression injection must replace the demo session POST');
      await request.respond({ status: 200, contentType: 'text/javascript', body: faulty });
    })().catch(fail);
  });
}

// A loopback OpenAI-compatible server, as a visitor's local model would run it, allowing the demo origin.
async function loopbackModel(t) {
  const chats = [];
  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'loopback-small' }, { id: 'loopback-large' }] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); chats.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const content of ['Hello from ', body.model]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, chats };
}

// Shadow-root geometry for layout-stability checks; never deep-compared DOM nodes.
const shadowRect = (page, selector, { document: absolute = false } = {}) => page.$eval('aithema-session', (component, selector, absolute) => {
  const rect = component.shadowRoot.querySelector(selector).getBoundingClientRect();
  return { x: rect.x + (absolute ? scrollX : 0), y: rect.y + (absolute ? scrollY : 0), width: rect.width, height: rect.height };
}, selector, absolute);
const shadowRects = (page, selector) => page.$eval('aithema-session', (component, selector) =>
  [...component.shadowRoot.querySelectorAll(selector)].map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }), selector);
const shadowFocus = page => page.$eval('aithema-session', component => {
  const active = component.shadowRoot.activeElement; return active ? active.className || active.id || active.tagName : null;
});

test('demo works in a real browser: consent, turn, understanding, settings, reload and ZIP export',
  { timeout: 120_000 }, async t => {
    // Fail before starting the host if the browser is missing.
    const executablePath = await browserPath();
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-'));
    const child = fork(new URL('../../demo/server.js', import.meta.url), [], {
      // No inherited provider selection or credentials can reach the demo.
      env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite') },
      silent: true,
    });
    child.stdout.resume(); child.stderr.resume();
    let browser;
    const controller = new AbortController();
    t.after(async () => {
      controller.abort();
      try { await browser?.close(); }
      finally {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            const killTimeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
            try { child.kill('SIGTERM'); await exited; }
            finally { clearTimeout(killTimeout); }
          }
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    });

    const readyController = new AbortController();
    const readyTimeout = setTimeout(() => readyController.abort(new Error('Demo host did not start')), waitTimeout);
    let url;
    try {
      const [message] = await Promise.race([
        once(child, 'message', { signal: readyController.signal }),
        once(child, 'exit', { signal: readyController.signal }).then(([code]) => {
          throw new Error(`Demo host exited before ready (code ${code})`);
        }),
      ]);
      url = message.url;
    } finally { clearTimeout(readyTimeout); readyController.abort(); }

    browser = await puppeteer.launch({ executablePath, headless: true,
      env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'),
      // GitHub's Ubuntu runner restricts the Chrome sandbox with AppArmor.
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [],
      timeout: waitTimeout,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(waitTimeout);
    const failure = Promise.withResolvers();
    const fail = error => failure.reject(error);
    let reloading = false, exporting = false;
    const isSameOrigin = requestUrl => new URL(requestUrl).origin === new URL(url).origin;
    const consoleError = message => { if (message.type() === 'error') fail(new Error(`Browser console error: ${message.text()}`)); };
    const responseError = response => {
      if (isSameOrigin(response.url()) && response.status() >= 400) {
        fail(new Error(`Demo request failed: ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`));
      }
    };
    const requestError = request => {
      if (!isSameOrigin(request.url())) return;
      // Reload deliberately cancels the previous long-lived SSE connection.
      if (reloading && request.resourceType() === 'fetch' && new URL(request.url()).pathname.endsWith('/events')
        && request.failure()?.errorText === 'net::ERR_ABORTED') return;
      // Chrome transfers attachment navigations to its download manager.
      if (exporting && request.isNavigationRequest() && new URL(request.url()).pathname.endsWith('/export')
        && request.failure()?.errorText === 'net::ERR_ABORTED') return;
      fail(new Error(`Demo request failed: ${request.failure()?.errorText} ${request.method()} ${new URL(request.url()).pathname}`));
    };
    page.on('console', consoleError); page.on('pageerror', fail); page.on('error', fail);
    page.on('response', responseError); page.on('requestfailed', requestError);
    child.once('exit', () => fail(new Error('Demo host exited during the browser smoke test')));
    try {
      await Promise.race([failure.promise, (async () => {
        if (process.env.AITHEMA_BROWSER_REGRESSION === '1') await injectRegression(page, url, fail);
        // The page language follows the browser; pin English whatever the machine locale is.
        await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); localStorage.setItem('aithema-demo-locale', 'en'); });
        // The demo has no favicon. Avoid Chrome's implicit, unrelated /favicon.ico probe.
        await page.evaluateOnNewDocument(() => {
          document.addEventListener('DOMContentLoaded', () => {
            const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,';
            document.head.append(icon);
          }, { once: true });
        });
        const cdp = await browser.target().createCDPSession();
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true,
        });
        const created = page.waitForResponse(response => response.url() === `${url}/api/sessions`
          && response.request().method() === 'POST', { signal: controller.signal });
        const [, response] = await Promise.all([page.goto(url, { waitUntil: 'domcontentloaded' }), created]);
        assert.equal(response.status(), 201, 'The page must create a session');
        const { id } = await response.json();
        assert.ok(id);
        await waitForShadow(page, '.composer textarea');
        assert.equal(await page.$eval('aithema-session', component => component.session.id), id);
        // GUI-27 item 5: the preset chooser is a plain list on hairlines, not a row of equal
        // bordered tiles, and hover or selection never moves or resizes an option.
        // Positions are relative to the list, since hovering may scroll it into view.
        const chooserGeometry = () => page.$$eval('aithema-session >>> .chooser-option', nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect(), list = node.parentElement.getBoundingClientRect(), style = getComputedStyle(node);
          return { x: rect.x - list.x, y: rect.y - list.y, width: rect.width, height: rect.height, radius: style.borderTopLeftRadius,
            sides: [style.borderLeftWidth, style.borderRightWidth], shadow: style.boxShadow, background: style.backgroundColor };
        }));
        for (const width of [390, 1024]) {
          await page.setViewport({ width, height: 900 });
          const resting = await chooserGeometry();
          assert.equal(resting.length, 4);
          assert.ok(resting.every((o, i) => o.x === resting[0].x && o.width === resting[0].width && (!i || o.y > resting[i - 1].y)), `one column at ${width}px: ${JSON.stringify(resting)}`);
          assert.ok(resting.every(o => o.radius === '0px' && o.sides.every(side => side === '0px') && o.shadow === 'none' &&
            o.background === 'rgba(0, 0, 0, 0)'), `no bordered or filled tiles at ${width}px`);
          await page.hover('aithema-session >>> .chooser-option[data-preset="custom"]');
          assert.deepEqual(await chooserGeometry(), resting, `hover moves nothing at ${width}px`);
          await page.click('aithema-session >>> .chooser-option[data-preset="device"]');
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot
            .querySelector('.chooser-option[data-preset="device"]').getAttribute('aria-pressed') === 'true', { polling: 'mutation' });
          assert.deepEqual(await chooserGeometry(), resting, `selection moves nothing at ${width}px`);
          await page.click('aithema-session >>> .chooser-option[data-preset="best"]');
        }
        await page.setViewport({ width: 800, height: 600 });
        assert.match(await page.$eval('#provider', node => node.textContent), /Mock reasoning/u);

        for (const [selector, enabled] of [['#grant', true], ['#revoke', false], ['#grant', true]]) {
          const consent = page.waitForResponse(response => response.url() === `${url}/api/sessions/${id}/consent`
            && response.request().method() === 'POST', { signal: controller.signal });
          const [, saved] = await Promise.all([mockConsent(page, selector === '#grant'), consent]);
          assert.equal(saved.status(), 200, `${selector} must save consent through the demo UI`);
          await waitForShadow(page, '.composer textarea', { enabled });
        }
        await page.mouse.move(0, 0);
        assert.equal(await page.$eval('aithema-session', component =>
          component.shadowRoot.querySelector('.summary-text').textContent), '');
        // Keyboard input and the actual shortcut handler, inside the open shadow DOM.
        const composer = await page.$('aithema-session >>> .composer textarea');
        await composer.type(content);
        const turnResponse = page.waitForResponse(`${url}/api/sessions/${id}/turns`, { signal: controller.signal });
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        const [, saved] = await Promise.all([(async () => {
          await page.keyboard.down(modifier);
          try { await page.keyboard.press('Enter'); } finally { await page.keyboard.up(modifier); }
        })(), turnResponse]);
        assert.equal(saved.status(), 200, 'The keyboard shortcut must send the person turn');
        await waitForShadow(page, 'ol li.user span', { text: content });
        await waitForShadow(page, 'aside .summary-text', { text: content });
        await waitForShadow(page, 'aside .notice', { text: 'Current assessment' });
        await waitForShadow(page, 'ol li:not(.user) span', { text: 'What should improve first?' });

        // Settings: change preset, model and response style; every change waits for the server.
        const settingsSaved = () => page.waitForResponse(response => response.url() === `${url}/api/sessions/${id}/settings`
          && response.request().method() === 'POST', { signal: controller.signal });
        await page.click('aithema-session >>> .settings-open');
        await waitForShadow(page, 'dialog.settings[open] [data-select="model"] [role=option]');
        assert.equal(await shadowFocus(page), 'done', 'focus moves into the settings dialog');
        const [, presetSaved] = await Promise.all([page.click('aithema-session >>> .preset-option[data-preset="custom"]'), settingsSaved()]);
        assert.equal(presetSaved.status(), 200, 'the server acknowledges the preset');
        await waitForShadow(page, '.save-status', { text: 'Changes saved' });
        await page.click('aithema-session >>> [data-select="model"] .select__button');
        const swift = await page.waitForFunction(() => [...document.querySelector('aithema-session').shadowRoot
          .querySelectorAll('[data-select="model"] [role=option]')].find(node => node.querySelector('strong').textContent === 'Swift (mock)'));
        const [, modelSaved] = await Promise.all([swift.click(), settingsSaved()]);
        assert.equal(modelSaved.status(), 200, 'the server acknowledges the model');
        assert.deepEqual(JSON.parse(modelSaved.request().postData()), { processingPreset: 'custom', model: 'mock/swift', effort: 'none', voice: 'off', visuals: 'off', baseRevision: 1 });
        await waitForShadow(page, '.save-status', { text: 'Changes saved' });
        const effort = await page.$('aithema-session >>> #settings-effort');
        await effort.focus();
        const [, effortSaved] = await Promise.all([page.keyboard.press('ArrowRight'), settingsSaved()]);
        assert.equal(effortSaved.status(), 200); assert.equal(JSON.parse(effortSaved.request().postData()).effort, 'low');
        await waitForShadow(page, '#settings-effort-value', { text: 'Low' });
        await page.click('aithema-session >>> .done');
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
        assert.equal(await shadowFocus(page), 'settings-open', 'focus returns to the Settings button');
        await waitForShadow(page, '.engine__value', { text: 'Custom' });
        await waitForShadow(page, '.engine__detail', { text: 'Swift (mock) · Low · Voice: Off · Visuals: Off' });
        // The effect: the next reply comes from the newly chosen model.
        await composer.type('What about our data?');
        const nextTurn = page.waitForResponse(`${url}/api/sessions/${id}/turns`, { signal: controller.signal });
        await Promise.all([page.click('aithema-session >>> .send'), nextTurn]);
        await waitForShadow(page, 'ol li:last-child span', { text: 'Briefly: what should improve first?' });
        await waitForShadow(page, 'ol li:last-child .engine-tag', { text: 'Swift (mock) · Low' });

        const restored = page.waitForResponse(`${url}/api/sessions/${id}`, { signal: controller.signal });
        let snapshot;
        reloading = true;
        try { [, snapshot] = await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), restored]); }
        finally { reloading = false; }
        assert.equal(snapshot.status(), 200);
        await waitForShadow(page, 'ol li.user span', { text: content });
        assert.equal(await page.$eval('aithema-session', component => component.session.id), id, 'Reload must restore the same session');
        await waitForShadow(page, 'aside .summary-text', { text: `${content} What about our data?` });
        assert.equal(await page.$eval('#error', node => node.textContent), '');
        await waitForShadow(page, '.engine__detail', { text: 'Swift (mock) · Low · Voice: Off · Visuals: Off' });

        const exported = page.waitForResponse(`${url}/api/sessions/${id}/export`, { signal: controller.signal });
        const downloaded = waitForDownload(cdp, AbortSignal.any([controller.signal, AbortSignal.timeout(waitTimeout)]));
        exporting = true;
        const [, zipResponse, download] = await Promise.all([
          page.click('aithema-session >>> a.export'), exported, downloaded,
        ]);
        assert.equal(zipResponse.status(), 200);
        assert.match(zipResponse.headers()['content-type'], /^application\/zip(?:;|$)/u);
        const bytes = await readFile(join(directory, download.guid));
        assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'The completed download must be a ZIP');
        assert.ok(bytes.includes(Buffer.from(content)), 'The downloaded export must contain the person turn');
        exporting = false;

        // At 400 px the dialog fits the viewport, scrolls inside, and hover moves nothing.
        await page.setViewport({ width: 400, height: 800 });
        const workspace = await shadowRect(page, '.workspace', { document: true });
        await page.click('aithema-session >>> .settings-open');
        await waitForShadow(page, 'dialog.settings[open] [data-select="model"] [role=option]');
        const box = await shadowRect(page, 'dialog.settings');
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 400 && box.y + box.height <= 800, `dialog fits 400x800: ${JSON.stringify(box)}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 400), 'no horizontal overflow at 400 px');
        const done = await shadowRect(page, 'dialog.settings .done');
        assert.ok(done.y + done.height <= 800 && done.width > 0, 'Done stays reachable');
        const targets = 'dialog.settings :is(.preset-option, .select__button, .gauge, .done, [role=tab])';
        for (const selector of ['.preset-option[data-preset="eu"]', '.preset-option[data-preset="device"]', '[data-select="voice"] .select__button', '[data-gauge="privacy"]']) {
          // Scroll first, so only the hover itself is measured.
          await page.$eval('aithema-session', (c, selector) => c.shadowRoot.querySelector(`dialog.settings ${selector}`).scrollIntoView({ block: 'center' }), selector);
          const before = await shadowRects(page, targets);
          await page.hover(`aithema-session >>> dialog.settings ${selector}`);
          assert.deepEqual(await shadowRects(page, targets), before, `hovering ${selector} moves no control`);
        }
        assert.notEqual(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.context-message').textContent), '', 'hover explains in the help line');
        assert.deepEqual(await shadowRect(page, '.workspace', { document: true }), workspace, 'the open dialog shifts nothing behind it');
        // AIT-118: the selected tab shows a check in a slot every tab keeps, so selection never rests on colour alone,
        // it is no edge accent, and selecting another tab moves no tab, icon or label.
        const tabMarks = () => page.$eval('aithema-session', c => [...c.shadowRoot.querySelectorAll('.settings__tabs [role=tab]')].map(tab => {
          const check = tab.querySelector('.tab-check'), style = getComputedStyle(tab), mark = check.getBoundingClientRect();
          return { tab: tab.dataset.tab, selected: tab.getAttribute('aria-selected') === 'true', checkVisible: getComputedStyle(check).visibility === 'visible' && mark.width > 0 && mark.height > 0,
            edge: [style.borderBottomWidth, style.borderTopWidth, style.borderLeftWidth, style.borderRightWidth].some(width => width !== '0px') || style.boxShadow !== 'none' || style.textDecorationLine !== 'none',
            boxes: [tab, tab.querySelector('.tab-icon'), tab.querySelector('.tab-label'), check].map(node => JSON.stringify(node.getBoundingClientRect())) };
        }));
        const firstTab = (await tabMarks()).find(tab => tab.selected).tab, tabLayout = (await tabMarks()).map(tab => tab.boxes);
        for (const name of ['general', 'local', 'model', firstTab]) {
          await page.click(`aithema-session >>> .settings__tabs [data-tab="${name}"]`);
          const marks = await tabMarks();
          assert.deepEqual(marks.map(tab => [tab.tab, tab.selected, tab.checkVisible, tab.edge]), marks.map(tab => [tab.tab, tab.tab === name, tab.tab === name, false]), `only the ${name} tab shows its check`);
          assert.deepEqual(marks.map(tab => tab.boxes), tabLayout, `selecting ${name} moves no tab, icon, label or check slot`);
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
        assert.equal(await shadowFocus(page), 'settings-open', 'Escape returns focus to the Settings button');

        // Advanced: the browser connects straight to a loopback model; the host server is never involved.
        await page.setViewport({ width: 1280, height: 900 });
        const local = await loopbackModel(t);
        await page.click('aithema-session >>> .settings-open');
        await page.click('aithema-session >>> [data-tab="local"]');
        const endpoint = await page.$('aithema-session >>> #local-endpoint');
        await endpoint.click({ count: 3 }); await endpoint.type(local.endpoint);
        await page.click('aithema-session >>> .local-connect');
        await waitForShadow(page, '.local-status', { text: 'Connected to your device: loopback-small' });
        await page.$eval('aithema-session', component => {
          const select = component.shadowRoot.querySelector('#local-model'); select.value = 'loopback-large';
          select.dispatchEvent(new Event('change'));
        });
        await waitForShadow(page, '.local-status', { text: 'Connected to your device: loopback-large' });
        await page.click('aithema-session >>> .local-test');
        const message = await page.$('aithema-session >>> #local-message');
        await message.type('Are you there?'); await page.click('aithema-session >>> .local-send');
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.local__messages').textContent.includes('Hello from loopback-large'));
        assert.deepEqual(local.chats.map(chat => [chat.model, chat.stream, chat.messages]), [['loopback-large', true, [{ role: 'system', content: '' }, { role: 'user', content: 'Are you there?' }]]]);
        await page.keyboard.press('Escape');
        t.diagnostic(`Browser: ${await browser.version()}; session creation, consent grant/regrant (POST 200, "Mock processing allowed.", enabled composer), revocation (POST 200, disabled composer), shortcut, understanding, settings (preset, model and effort acknowledged; next reply from Swift), reload, ZIP download, 400 px dialog layout/focus and a loopback local model (handshake, model choice, streamed test chat) passed.`);
      })()]);
    } finally {
      controller.abort();
      page.off('console', consoleError); page.off('pageerror', fail); page.off('error', fail);
      page.off('response', responseError); page.off('requestfailed', requestError);
    }
  });

async function startDemo(directory, port = '0') {
  const child = fork(new URL('../../demo/server.js', import.meta.url), [], {
    // The demo default: fake clickable HTML drafts (AIT-113), shown in the concept viewer.
    env: { PATH: process.env.PATH, PORT: port, AITHEMA_DB: join(directory, 'session.sqlite') }, silent: true,
  });
  child.stdout.resume(); child.stderr.resume();
  const [message] = await Promise.race([once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Demo host exited before ready (code ${code})`); })]);
  return { child, url: message.url };
}
async function stopDemo(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
}
test('AIT-117: a German processing-consent page contains START German copy and no English server reasons',
  { timeout: 120_000 }, async t => {
    const executablePath = await browserPath();
    const directory = await mkdtemp(join(tmpdir(), 'aithema-german-consent-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'), timeout: waitTimeout,
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(); await preparePage(page, ['de-DE', 'de']);
    const problems = [], external = [];
    page.on('pageerror', error => problems.push(error.message));
    // The production host module receives English server copy with both START
    // item ids. Provider setup and calls are replaced by this local fixture.
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== demo.url && url.protocol !== 'data:') {
        external.push(request.url()); void request.abort();
      } else if (url.pathname === '/demo/config') {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
          label: 'Mock reasoning — deterministic demo', imageLabel: 'Images off', voiceMode: 'off', voiceDisabledReason: 'agent-api-get-403',
          processingConsent: { contract: 'browser-fixture', intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL, items: CONSENT_ITEMS },
        }) });
      } else if (url.pathname.endsWith('/consent') && request.method() === 'GET') {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ selected: ['voice-elevenlabs'] }) });
      } else void request.continue();
    });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await waitForShadow(page, '.composer textarea');
    assert.equal(await inShadow(page, c => c.session.locale), 'de');
    const consentSessionId = await inShadow(page, c => c.session.id);
    await page.goto(`${demo.url}/consent/?session=${consentSessionId}&return=/`, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('#processing-items span')?.textContent === 'KI-Modelle international');
    const consent = await page.evaluate(() => ({
      intro: document.querySelector('#consent-text').textContent,
      items: [...document.querySelectorAll('#processing-items input')].map(input => ({ id: input.value,
        title: input.parentElement.querySelector('span').textContent, text: [...input.closest('.consent-item').querySelectorAll('p')].map(p => p.textContent).join(' '), checked: input.checked })),
      visible: document.querySelector('main.consent-page').innerText,
    }));
    assert.equal(consent.intro, de.host.consentPage.intro);
    for (const item of consent.items) {
      const expected = START_GERMAN_CONSENT.items[item.id];
      assert.equal(item.title, expected.title);
      assert.equal(item.text, `${expected.recipients} ${expected.text}`);
    }
    assert.deepEqual(consent.items.map(item => [item.id, item.checked]), [['models-international', false], ['voice-elevenlabs', true]]);
    for (const english of [CONSENT_INTRO, CONSENT_WITHDRAWAL, ...CONSENT_ITEMS.flatMap(item => [item.title, item.recipients, item.text])]) {
      assert.equal(consent.visible.includes(english), false, english);
    }
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await waitForShadow(page, '.composer textarea');
    assert.ok((await page.$eval('#provider', node => node.textContent)).includes(de.reasons['agent-api'].replace('{status}', '403')));
    await waitForShadow(page, '.composer-reason', { text: de.reasons['current processing consent required'] });
    // Exercise every grepped reason through actual feature rows, including HTML and uploads,
    // delegated voice reasons and the bounded agent API status-code family.
    const codes = [...FEATURE_REASON_CODES, ...VOICE_REASON_CODES,
      ...FEATURE_REASON_CODES.map(code => `delegated reasoning: ${code}`), 'agent-api-get-401', 'agent-api-post-403', 'agent-api-patch-503'];
    const rendered = await page.evaluate(async codes => {
      const { de } = await import('/packages/ui/src/i18n/de.js');
      const { FEATURES } = await import('/packages/core/src/presets.js');
      const c = document.querySelector('aithema-session'), session = c.session, rows = [];
      for (const reason of codes) {
        session.featureMatrix.best = Object.fromEntries(FEATURES
          .map(feature => [feature, { available: false, reason }]));
        c.configure({ copy: de, session });
        rows.push({ labels: [...c.shadowRoot.querySelectorAll('.features li')].map(node => node.firstChild.nodeValue),
          reasons: [...c.shadowRoot.querySelectorAll('.features span')].map(node => node.textContent) });
      }
      return rows;
    }, codes);
    for (const [index, code] of codes.entries()) {
      const inner = code.replace(/^delegated reasoning: /u, ''), status = /^agent-api-(?:get|post|patch)-(\d{3})$/u.exec(code);
      const expected = status ? de.reasons['agent-api'].replace('{status}', status[1])
        : inner !== code ? de.reasons.delegated.replace('{reason}', de.reasons[inner]) : de.reasons[code];
      assert.deepEqual(rendered[index].labels, FEATURES.map(feature => de.features[feature]), code);
      assert.equal(rendered[index].reasons.length, FEATURES.length, code);
      assert.ok(rendered[index].reasons.every(text => text === expected), code);
      const english = status ? en.reasons['agent-api'].replace('{status}', status[1])
        : inner !== code ? en.reasons.delegated.replace('{reason}', en.reasons[inner]) : en.reasons[code];
      assert.ok(rendered[index].reasons.every(text => text !== english), `English reason leaked: ${code}`);
    }
    assert.deepEqual(problems, []); assert.deepEqual(external, []);
    t.diagnostic(`START German consent: 2 items plus intro/withdrawal; ${codes.length} reason cases rendered in German, no provider requests.`);
  });
async function preparePage(page, languages) {
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(waitTimeout);
  await page.evaluateOnNewDocument(languages => {
    Object.defineProperty(navigator, 'languages', { get: () => languages });
    Object.defineProperty(navigator, 'language', { get: () => languages[0] });
    localStorage.setItem('aithema-demo-locale', languages[0].startsWith('de') ? 'de' : 'en');
    document.addEventListener('DOMContentLoaded', () => {
      const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,'; document.head.append(icon);
    }, { once: true });
  }, languages);
}
const inShadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const box = (page, selector) => inShadow(page, (c, selector) => {
  const rect = c.shadowRoot.querySelector(selector).getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}, selector);
function sameBox(before, after, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(before[key] - after[key]) <= .5, `${label} moved under the pointer: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
}
// Rest the pointer on the visible part of an element and leave it there.
async function rest(page, selector) {
  await inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).scrollIntoView({ block: 'nearest' }), selector);
  const target = await box(page, selector);
  await page.mouse.move(target.x + Math.min(target.width / 2, 40), target.y + Math.min(target.height / 2, 10));
  return target;
}
// The changing upload row's own boxes: the row, its name, its action slot and (while it exists) the button.
const rowBoxes = (page, selector) => inShadow(page, (c, selector) => {
  const row = c.shadowRoot.querySelector(selector), rect = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { row: rect(row), name: rect(row.querySelector('.upload__name')), action: rect(row.querySelector('.upload__action')), button: rect(row.querySelector('.upload-withdraw')) };
}, selector);
function sameRow(before, after, label) {
  for (const part of ['row', 'name', 'action']) sameBox(before[part], after[part], `${label}: ${part}`);
  if (before.button && after.button) sameBox(before.button, after.button, `${label}: Withdraw upload`);
}
// Rest the pointer on a part of an upload row (its name by default) and measure the row.
async function restOnRow(page, selector, part = '.upload__name') {
  await rest(page, `${selector} ${part}`);
  return rowBoxes(page, selector);
}
// Holds upload states after "pending" (and every event after them) in the page, then delivers them in order:
// the pending row can then be measured under a resting pointer however fast the file is read.
const hold = (page, on) => inShadow(page, (c, on) => {
  if (!c.heldUploadEvents) {
    const deliver = c.receive.bind(c), queue = c.heldUploadEvents = [];
    c.receive = event => {
      if (c.holdUploadEvents && event?.seq && (queue.length || event.type === 'upload.state' && event.data?.state !== 'pending')) { queue.push(event); return; }
      return deliver(event);
    };
    c.deliverHeldUploadEvents = () => { for (const event of queue.splice(0).sort((a, b) => a.seq - b.seq)) deliver(event); };
  }
  c.holdUploadEvents = on; if (!on) c.deliverHeldUploadEvents();
}, on);
// Attach a file that cannot be read and rest on its Withdraw upload while it is pending (held, however fast the
// file is read); it turns unreadable, then the keyboard presses Withdraw: each time the row keeps its box, name and action.
async function unreadableThenWithdrawn(page, path, width, shot, shotName) {
  await hold(page, true);
  await inShadow(page, c => c.shadowRoot.querySelector('.attach').focus());
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.keyboard.press('Enter')]);
  await chooser.accept([path]);
  await until(page, () => [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')].at(-1)?.dataset.state === 'pending');
  const id = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('ol li.upload')].at(-1).dataset.id), selector = `ol li[data-id="${id}"]`;
  const pending = await restOnRow(page, selector, '.upload-withdraw');
  await hold(page, false);
  await until(page, selector => document.querySelector('aithema-session').shadowRoot.querySelector(selector).dataset.state === 'unreadable', selector);
  sameRow(pending, await rowBoxes(page, selector), `pending → unreadable at ${width}`);
  assert.match(await inShadow(page, (c, selector) => c.shadowRoot.querySelector(`${selector} .upload__state`).textContent, selector), /^Nicht lesbar: .+ Bitte fügen Sie den relevanten Teil als Text ein\.$/u);
  await page.mouse.move(0, 0); await shot(shotName, selector);
  const before = await restOnRow(page, selector, '.upload-withdraw');
  await inShadow(page, (c, selector) => c.shadowRoot.querySelector(`${selector} .upload-withdraw`).focus({ preventScroll: true }), selector);
  await page.keyboard.press('Enter');
  await until(page, selector => document.querySelector('aithema-session').shadowRoot.querySelector(selector).dataset.state === 'withdrawn', selector);
  sameRow(before, await rowBoxes(page, selector), `unreadable → withdrawn at ${width}`);
  assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.dataset.state), 'withdrawn', `unreadable → withdrawn at ${width}: focus stays on the row`);
}
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: waitTimeout }, arg);
const sendTurn = (page, text) => inShadow(page, (c, text) => {
  c.shadowRoot.querySelector('textarea').value = text; c.shadowRoot.querySelector('form').requestSubmit();
}, text);
const voiceState = page => inShadow(page, c => c.shadowRoot.querySelector('.audio-rail').dataset.state);
async function startCall(page) {
  await inShadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
  await until(page, () => ['listening', 'speaking'].includes(document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state));
}
async function endCall(page) {
  await inShadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'idle');
}

test('live updates appear under a resting pointer without moving it; blur, reload, restart and German behave (AIT-116)',
  { timeout: 240_000 }, async t => {
    const executablePath = await browserPath();
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-live-'));
    let demo = await startDemo(directory), browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'), timeout: waitTimeout,
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const problems = []; let restarting = false;
    const watch = page => {
      page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
      page.on('response', response => {
        if (response.status() >= 400 && !(restarting && response.status() === 503)) {
          problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
        }
      });
    };
    const page = await browser.newPage(); await preparePage(page, ['en-US', 'en']); watch(page);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await waitForShadow(page, '.composer textarea', { enabled: true });
    await sendTurn(page, 'We are a bakery and want a pre-order app for our customers.');
    await waitForShadow(page, 'aside .notice', { text: 'Current assessment' });

    // D7: window blur alone never pauses the call or the session.
    await startCall(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.notEqual(await voiceState(page), 'paused');
    assert.equal(await inShadow(page, c => c.session.paused), false, 'blur must not pause the session');

    // D2: the transcript under a resting pointer receives new turns at once and the hovered row stays put.
    const lastRow = await inShadow(page, c => c.shadowRoot.querySelector('ol li:last-child').dataset.id);
    const rowBefore = await rest(page, `ol li[data-id="${lastRow}"]`);
    const rowsBefore = await inShadow(page, c => c.shadowRoot.querySelectorAll('ol li').length);
    await page.evaluate(() => document.querySelector('#fake-say').click());
    await page.evaluate(() => document.querySelector('#fake-say').click());
    await until(page, count => {
      const c = document.querySelector('aithema-session'), rows = c.shadowRoot.querySelectorAll('ol li').length;
      return rows >= count + 4 && rows === c.session.transcript.filter(turn => !turn.erased || turn.role === 'user').length;
    }, rowsBefore);
    sameBox(rowBefore, await box(page, `ol li[data-id="${lastRow}"]`), 'hovered transcript row');

    // D2: the aside under a resting pointer shows new understanding at once; content above grows without moving it.
    const heading = '.analysis-content section:nth-of-type(2) h3';
    const headingBefore = await rest(page, heading), summaryBefore = await inShadow(page, c => c.shadowRoot.querySelector('.summary-text').textContent);
    // A long typed turn makes the summary above the hovered heading several lines taller.
    await sendTurn(page, 'Customers order bread online the day before, pick it up at a chosen time, and staff see one list per morning sorted by pickup time and branch.');
    await until(page, before => {
      const c = document.querySelector('aithema-session'), shown = c.shadowRoot.querySelector('.summary-text').textContent;
      return shown !== before && shown === c.session.understanding.summary;
    }, summaryBefore);
    sameBox(headingBefore, await box(page, heading), 'hovered aside heading');
    assert.ok(await inShadow(page, c => c.shadowRoot.querySelector('.analysis-content').scrollTop) > 0, 'the summary grew above the pointer');
    await endCall(page);

    // D2: the concept rail under a resting pointer shows the finished concept at once.
    const requestBefore = await rest(page, '.concept-request');
    await page.mouse.down(); await page.mouse.up();
    await until(page, () => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return !r.querySelector('.concept-tab').disabled && r.querySelector('.concept-preview').style.visibility !== 'hidden'
        && r.querySelector('.concept-activity-text').textContent === 'Draft revision 1 is ready.';
    });
    sameBox(requestBefore, await box(page, '.concept-request'), 'concept request button');

    // D3: Like, a guidance chip and Regenerate show their effect while the pointer rests on them.
    await inShadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
    await waitForShadow(page, '.concept-count', { text: '1 of 1' });
    const likeBefore = await rest(page, '.concept-up'); await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-up').getAttribute('aria-pressed') === 'true');
    sameBox(likeBefore, await box(page, '.concept-up'), 'Like');
    // GUI-27 (AIT-118): guidance choices are plain toggles; pressing one marks it with a check in its own slot and moves nothing.
    const guidanceBefore = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.concept-guidance-options button')].map(b => JSON.stringify(b.getBoundingClientRect())));
    const chipBefore = await rest(page, '.concept-guidance-options button'); await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-guidance-options button').getAttribute('aria-pressed') === 'true');
    sameBox(chipBefore, await box(page, '.concept-guidance-options button'), 'guidance toggle');
    assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.concept-guidance-options button')].map(b => JSON.stringify(b.getBoundingClientRect()))), guidanceBefore, 'no guidance toggle moved');
    assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.concept-viewer button')].map(b => getComputedStyle(b))
      .filter(style => style.borderTopWidth !== '0px' || parseFloat(style.borderTopLeftRadius) > 8).length), 0, 'no bordered boxes or pills among the viewer controls');
    // The new revision waits while the pointer rests on the controls: the count, Next and a notice update at once.
    const regenerateBefore = await rest(page, '.concept-regenerate'); await page.mouse.down(); await page.mouse.up();
    await waitForShadow(page, '.concept-count', { text: '1 of 2' });
    await waitForShadow(page, '.concept-next', { enabled: true });
    await waitForShadow(page, '.concept-viewer-message', { text: 'A newer revision is ready. Select Next to see it.' });
    sameBox(regenerateBefore, await box(page, '.concept-regenerate'), 'Regenerate');
    await page.keyboard.press('ArrowRight');
    await waitForShadow(page, '.concept-count', { text: '2 of 2' });
    await page.keyboard.press('Escape'); await page.mouse.move(0, 0);

    // D4: reloading during a call ends it cleanly: no pause, no conflict, Start call works at once.
    await startCall(page);
    const sessionId = await inShadow(page, c => c.session.id);
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea', { enabled: true });
    await until(page, id => sessionStorage.getItem(`aithema-voice-call:${id}`) === null, sessionId);
    assert.equal(await inShadow(page, c => c.session.paused), false, 'a reload must not leave the session paused');
    assert.equal(await inShadow(page, c => c.session.featureMatrix.best.text.available), true, 'D8: the server verdict shows the active grant');
    await startCall(page);
    await endCall(page);

    // D6: a host restart drops in-memory grants; the open page shows that without a reload.
    const port = new URL(demo.url).port;
    restarting = true; await stopDemo(demo.child); demo = await startDemo(directory, port);
    await waitForShadow(page, '.composer textarea', { enabled: false });
    await until(page, () => !document.querySelector('aithema-session').session.featureMatrix.best.text.available);
    await waitForShadow(page, '.status', { text: 'Connected' });
    restarting = false;

    // D1: a German browser gets a German page and German replies; a new choice applies to the next conversation.
    const context = await browser.createBrowserContext(), german = await context.newPage();
    await preparePage(german, ['de-DE', 'de']); watch(german);
    await german.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(german, '.composer textarea');
    assert.equal(await inShadow(german, c => c.session.locale), 'de');
    assert.equal(await german.evaluate(() => document.documentElement.lang), 'de');
    assert.equal(await german.$eval('#new', node => node.textContent), 'Neues Gespräch beginnen');
    await mockConsent(german); await waitForShadow(german, '.composer textarea', { enabled: true });
    assert.equal(await inShadow(german, c => c.session.featureMatrix.best.text.available), true);
    await sendTurn(german, 'Wir sind eine Tischlerei. Betrieb: wir hosten selbst; Daten: nur intern');
    await waitForShadow(german, 'aside .notice', { text: 'Aktuelle Einschätzung' });
    assert.equal(await inShadow(german, c => c.session.transcript.at(-1).content), 'Was sollte sich als Erstes verbessern?');
    assert.deepEqual(await inShadow(german, c => [...c.shadowRoot.querySelectorAll('.cleared summary')].map(n => n.textContent).sort()), ['Betrieb', 'Daten']);
    // AIT-118: the header names the active visual kind (clickable drafts by default), never the image label.
    assert.equal(await german.$eval('#provider', node => node.textContent), 'Mock-Auswertung: deterministische Demo · Testentwürfe (lokaler Klick-Entwurf)');
    // AIT-118: at 400 px every English and German voice message, the longest German recovery and closure
    // messages included, is whole in the rail's reserved lines and moves no control.
    const voiceMessages = [en, de].flatMap(copy => Object.entries(copy).filter(([key, value]) => /^voice[A-Z]/u.test(key) && typeof value === 'string'
      && !['voiceRail', 'voiceStart', 'voiceClose', 'voiceMicOn', 'voiceMicOff', 'voiceSpeakerOn', 'voiceSpeakerOff', 'voiceRetry', 'voicePlaybackRetry', 'voiceHostConsentTitle', 'voiceHostConsent'].includes(key))
      .map(([, value]) => value)).sort((a, b) => b.length - a.length);
    assert.ok([de.voiceRecoveryFailed, de.voiceClosureUncertain, de.voiceConflict].every(message => voiceMessages.includes(message)));
    await german.setViewport({ width: 400, height: 800 });
    const voiceFit = await inShadow(german, (c, messages) => {
      const r = c.shadowRoot, state = r.querySelector('.voice-state'), info = r.querySelector('.voice-info'), rail = r.querySelector('.audio-rail'), original = state.textContent;
      const boxes = () => [...r.querySelectorAll('.voice-orb, .voice-controls button, .concept-rail, .transcript-shell')].map(node => JSON.stringify(node.getBoundingClientRect()));
      const before = boxes(), result = messages.map(message => {
        state.textContent = message;
        const lines = Math.round(state.scrollHeight / parseFloat(getComputedStyle(state).lineHeight));
        return { message: message.slice(0, 40), lines, clipped: state.scrollHeight > state.clientHeight + 1 || info.scrollHeight > info.clientHeight + 1 || rail.scrollHeight > rail.clientHeight + 1,
          moved: boxes().some((box, index) => box !== before[index]) };
      });
      state.textContent = original; return result;
    }, voiceMessages);
    assert.ok(voiceFit[0].lines >= 3, `the longest message wraps (${voiceFit[0].lines} lines)`);
    assert.deepEqual(voiceFit.filter(fit => fit.clipped || fit.moved), [], 'no voice message is clipped or moves a control at 400 px');
    await german.setViewport({ width: 1440, height: 1000 });
    await german.select('#locale', 'en');
    assert.equal(await german.$eval('#language-note', node => node.textContent),
      'Neue Gespräche beginnen auf Englisch. Dieses Gespräch bleibt auf Deutsch.');
    await german.click('#new');
    await until(german, () => document.querySelector('aithema-session').session.locale === 'en' && document.documentElement.lang === 'en');
    await waitForShadow(german, '.send', { text: 'Send' });
    assert.equal(await german.$eval('#language-note', node => node.textContent), '');
    await context.close();
    assert.deepEqual(problems, []);
    t.diagnostic('Under a resting pointer: transcript, aside, concept rail and viewer updated at once with 0 px movement; blur kept the call; reload ended it without pause or 409; restart showed consent required; German page and replies.');
  });

// A same-origin page with one component and no server traffic: geometry under a resting pointer (AIT-116 D2).
const anchorFixture = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Anchor fixture</title><body style="margin:0;padding:48px">
<script type="module">
import '/packages/ui/src/session-element.js';
import { en } from '/packages/ui/src/i18n/en.js';
import { createSession, inputRevision } from '/packages/core/src/session.js';
import { reduceUnderstanding } from '/packages/core/src/understanding.js';
window.fetch = () => new Promise(() => {});
const c = document.createElement('aithema-session'), session = createSession({ demo: true });
session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
c.configure({ copy: en, session }); document.body.append(c);
c.receive({ seq: 1, type: 'turn.final', data: { id: 't1', role: 'user', content: 'Fixture' } });
window.assess = (signals, openQuestions) => {
  const s = c.session;
  c.receive({ seq: s.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(s.understanding,
    { summary: 'Fixture summary', signals, openQuestions, constraints: Object.fromEntries(s.preset.slots.map(slot => [slot, null])),
      progress: { talk: { value: .5 }, build: { value: .5 } } }, { transcript: s.transcript, inputRevision: inputRevision(s) }) });
};
window.fixtureReady = true;
</script>`;
// The preset chooser before a choice, with EU offered until a host restart drops it (AIT-116 D2).
const chooserFixture = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Chooser fixture</title><body style="margin:0;padding:48px">
<script type="module">
import '/packages/ui/src/session-element.js';
import { en } from '/packages/ui/src/i18n/en.js';
import { createSession } from '/packages/core/src/session.js';
const offered = { available: true, reason: null }, missing = { available: false, reason: 'not configured' };
let euOffered = true, endStream = () => {};
const verdicts = () => ({ best: { text: offered, analysis: offered }, eu: { text: euOffered ? offered : missing, analysis: euOffered ? offered : missing },
  device: { text: offered }, custom: { text: offered } });
const c = document.createElement('aithema-session'), session = createSession({ demo: true });
window.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
    endStream = () => controller.close(); options.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } });
  if (String(url).endsWith(\`/api/sessions/\${session.id}\`)) return Response.json({ ...c.session, featureMatrix: verdicts() });
  return new Promise(() => {});
};
session.featureMatrix = verdicts();
c.configure({ copy: en, session }); document.body.append(c);
// The host restarts: the event stream ends and the reconnect re-reads verdicts without EU.
window.restartHost = () => new Promise(resolve => { euOffered = false; c.addEventListener('aithema-features', resolve, { once: true }); endStream(); });
window.fixtureReady = true;
</script>`;
const grown = `First signal, now grown: ${'several more words of evidence '.repeat(12)}`;
const questions = Array.from({ length: 16 }, (_, i) => `Open question ${i + 1}: which detail matters most for this part of the plan?`);

test('AIT-116 gate: exact pointer anchoring, reload keeps the pause, cross-tab liveness, dark tokens and phone layout',
  { timeout: 240_000 }, async t => {
    const executablePath = await browserPath();
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-gate-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'), timeout: waitTimeout,
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const problems = [];
    const watch = page => {
      page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
      page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
    };

    // D2: the hovered element itself is anchored, padding never accumulates, and spare space works.
    const fixture = await browser.newPage(); await fixture.setViewport({ width: 1440, height: 1000 }); watch(fixture);
    await fixture.setRequestInterception(true);
    fixture.on('request', request => {
      if (request.url() === `${demo.url}/anchor-fixture`) void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: anchorFixture });
      else void request.continue();
    });
    await fixture.goto(`${demo.url}/anchor-fixture`); await fixture.waitForFunction(() => window.fixtureReady);
    const signal = index => fixture.evaluate(i => {
      const rect = document.querySelector('aithema-session').shadowRoot.querySelectorAll('.signals li')[i].getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }, index);
    const pane = () => fixture.evaluate(() => {
      const node = document.querySelector('aithema-session').shadowRoot.querySelector('.analysis-content'), style = getComputedStyle(node);
      return { top: node.style.getPropertyValue('--aithema-slack-top'), bottom: node.style.getPropertyValue('--aithema-slack-bottom'),
        padding: `${style.paddingTop} ${style.paddingBottom}`, spare: node.scrollHeight <= node.clientHeight };
    });
    const hover = async index => { const at = await signal(index); await fixture.mouse.move(at.x + 12, at.y + 8); return at; };
    const still = async (index, before, label) => {
      const after = await signal(index);
      assert.ok(Math.abs(after.y - before.y) <= 1, `${label}: the hovered item moved ${after.y - before.y} px`);
    };
    const short = ['First signal', 'Second signal', 'Third signal'];
    // A pane with spare space (a taller aside, fresh content): padding alone first fills it, so the anchor must measure again.
    const tall = height => fixture.evaluate(height => { document.querySelector('aithema-session').shadowRoot.querySelector('.understanding').style.height = height; }, height);
    await tall('1400px'); await fixture.evaluate(signals => window.assess(signals, ['One open question?']), short);
    const roomy = await pane(); assert.equal(roomy.spare, true, 'this pane has spare space');
    let before = await hover(2);
    // Every growth here needs slack; repeated rounds must not accumulate it.
    for (let round = 0; round < 5; round++) {
      await fixture.evaluate(signals => window.assess(signals, ['One open question?']), [grown, ...short.slice(1)]);
      await still(2, before, `growth ${round} in a pane with spare space`);
      assert.notEqual((await pane()).bottom, '', 'temporary slack makes the room');
      await fixture.evaluate(signals => window.assess(signals, ['One open question?']), short);
      await still(2, before, `shrink ${round} in a pane with spare space`);
      assert.deepEqual(await pane(), roomy, 'back to the original content: no slack, even while hovered');
    }
    await fixture.evaluate(signals => window.assess(signals, ['One open question?']), [grown, ...short.slice(1)]);
    await fixture.mouse.move(4, 4);
    assert.deepEqual(await pane(), roomy, 'leaving the component leaves 0 px residual padding');
    await tall('');
    // A pane with scroll room: growth of a preceding item moves the hovered item itself 0 px.
    await fixture.evaluate((signals, questions) => window.assess(signals, questions), short, questions);
    const baseline = await pane(); assert.equal(baseline.spare, false, 'this pane has scroll room');
    before = await hover(2);
    await fixture.evaluate((signals, questions) => window.assess(signals, questions), [grown, ...short.slice(1)], questions);
    await still(2, before, 'growth of a preceding item');
    await fixture.evaluate((signals, questions) => window.assess(signals, questions), short, questions);
    await still(2, before, 'shrink of a preceding item');
    await fixture.mouse.move(4, 4);
    assert.deepEqual(await pane(), baseline, 'no residual padding after the pointer leaves');
    await fixture.close();

    // D2 at conversation start: with the pointer resting on Device, a live refresh that makes EU unavailable
    // adds a line above it. The hovered node survives and does not move.
    const chooser = await browser.newPage(); await chooser.setViewport({ width: 1440, height: 1000 }); watch(chooser);
    await chooser.setRequestInterception(true);
    chooser.on('request', request => {
      if (request.url() === `${demo.url}/chooser-fixture`) void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: chooserFixture });
      else void request.continue();
    });
    await chooser.goto(`${demo.url}/chooser-fixture`); await chooser.waitForFunction(() => window.fixtureReady);
    const device = () => chooser.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot, option = root.querySelector('.chooser-option[data-preset="device"]');
      const rect = option.getBoundingClientRect(), intro = root.querySelector('.intro');
      return { x: rect.x, y: rect.y, same: option === window.deviceBefore, connected: window.hoveredBefore?.isConnected ?? null,
        euRefused: root.querySelector('.chooser-option[data-preset="eu"]').getAttribute('aria-disabled') === 'true',
        euNote: root.querySelector('.chooser-option[data-preset="eu"] .chooser-option__note').getBoundingClientRect().height,
        slack: intro.style.getPropertyValue('--aithema-slack-top') + intro.style.getPropertyValue('--aithema-slack-bottom') };
    });
    const resting = await device();
    assert.equal(resting.euRefused, false, 'EU is offered at first');
    await chooser.mouse.move(resting.x + 40, resting.y + 10);
    await chooser.evaluate((x, y) => {
      const root = document.querySelector('aithema-session').shadowRoot;
      window.hoveredBefore = root.elementFromPoint(x, y); window.deviceBefore = root.querySelector('.chooser-option[data-preset="device"]');
    }, resting.x + 40, resting.y + 10);
    assert.ok(await chooser.evaluate(() => window.deviceBefore.contains(window.hoveredBefore)), 'the pointer rests on Device');
    await chooser.evaluate(() => window.restartHost());
    const refreshed = await device();
    assert.equal(refreshed.euRefused, true, 'the live refresh made EU unavailable');
    assert.ok(refreshed.euNote > 0, 'an unavailable line was added above Device');
    assert.equal(refreshed.same, true, 'Device keeps its node'); assert.equal(refreshed.connected, true, 'the hovered node stays connected');
    assert.ok(Math.abs(refreshed.y - resting.y) <= 1, `the hovered Device option moved ${refreshed.y - resting.y} px`);
    await chooser.mouse.move(4, 4);
    assert.equal((await device()).slack, '', 'no residual padding after the pointer leaves');
    await chooser.close();

    const page = await browser.newPage(); await preparePage(page, ['en-US', 'en']); watch(page);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await waitForShadow(page, '.composer textarea', { enabled: true });
    const sessionId = await inShadow(page, c => c.session.id), journalKey = `aithema-voice-call:${sessionId}`;
    const journal = target => target.evaluate(key => JSON.parse(sessionStorage.getItem(key)), journalKey);
    const hide = target => target.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
    });

    // D4: a reload after an automatic pause never resumes by itself: it stays paused behind one focused Resume.
    await startCall(page); await hide(page);
    await until(page, () => document.querySelector('aithema-session').session.paused);
    assert.deepEqual(Object.keys(await journal(page)).sort(), ['callId', 'providerSessionId'], 'the journal holds call identity only');
    const pauses = [];
    const recordPause = request => { if (request.method() === 'POST' && request.url().endsWith('/pause')) pauses.push(request.postData()); };
    page.on('request', recordPause);
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await until(page, key => sessionStorage.getItem(key) === null, journalKey);
    await waitForShadow(page, '.status', { text: 'Still paused. Select Resume to continue.' });
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(await inShadow(page, c => c.session.paused), true, 'a reload never lifts the pause');
    assert.deepEqual(pauses, [], 'no pause change without the person');
    assert.deepEqual(await inShadow(page, c => {
      const resume = c.shadowRoot.querySelector('.pause'), box = resume.getBoundingClientRect();
      return { focused: c.shadowRoot.activeElement === resume, visible: resume.matches(':focus-visible') && box.width > 0 && box.height > 0, text: resume.textContent };
    }), { focused: true, visible: true, text: 'Resume' }, 'Resume is focused and visible');
    await page.keyboard.press('Enter');
    await until(page, () => !document.querySelector('aithema-session').session.paused);
    assert.deepEqual(pauses.map(body => JSON.parse(body)), [{ paused: false }], 'one action resumes');
    page.off('request', recordPause);

    // D4 cross-tab: an auxiliary window inherits the journal but never ends the call its opener drives.
    await startCall(page);
    const callId = (await journal(page)).callId, opened = new Promise(resolve => browser.once('targetcreated', resolve));
    await page.evaluate(url => { window.open(url, 'aithema-auxiliary'); }, demo.url);
    const auxiliary = await (await opened).page(); const closes = [];
    auxiliary.on('request', request => { if (request.url().endsWith('/close')) closes.push(request.url()); });
    await auxiliary.waitForFunction(() => document.querySelector('aithema-session')?.session?.id, { polling: 50 });
    await until(auxiliary, key => sessionStorage.getItem(key) === null, journalKey);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual(closes, [], 'the auxiliary window sends no close');
    assert.ok(['listening', 'speaking', 'paused'].includes(await voiceState(page)), 'the opener still drives its call');
    assert.equal((await journal(page)).callId, callId);
    await auxiliary.close();
    if (await voiceState(page) === 'paused') await inShadow(page, c => c.shadowRoot.querySelector('.voice-pause').click());
    await endCall(page);

    // D9: dark tokens apply under prefers-color-scheme: dark, the placeholder included.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const dark = await inShadow(page, c => {
      const host = getComputedStyle(c), textarea = c.shadowRoot.querySelector('textarea');
      return { surface: host.getPropertyValue('--aithema-surface').trim(), paper: getComputedStyle(document.body).backgroundColor,
        conversation: getComputedStyle(c.shadowRoot.querySelector('.conversation')).backgroundColor,
        placeholder: getComputedStyle(textarea, '::placeholder').color };
    });
    assert.deepEqual(dark, { surface: '#1b2223', paper: 'rgb(20, 26, 27)', conversation: 'rgb(27, 34, 35)', placeholder: 'rgb(155, 173, 171)' });
    // The AIT-112 settings dialog follows the same tokens: its primary button inverts and the gauge panel darkens.
    const settingsDark = await inShadow(page, c => {
      c.openSettings(); const r = c.shadowRoot;
      return { done: getComputedStyle(r.querySelector('dialog.settings .done')).color,
        gauges: getComputedStyle(r.querySelector('.gauge-panel')).backgroundImage.includes('rgb(27, 34, 35)') };
    });
    assert.deepEqual(settingsDark, { done: 'rgb(20, 26, 27)', gauges: true });
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    assert.equal(await inShadow(page, c => getComputedStyle(c).getPropertyValue('--aithema-surface').trim()), '#fffef9');

    // D14: at 400 px the transcript keeps a usable height, the concept status is whole, nothing overflows sideways.
    await page.setViewport({ width: 400, height: 800 });
    const phone = await inShadow(page, c => {
      const r = c.shadowRoot, status = r.querySelector('.concept-activity-text'), conversation = r.querySelector('.conversation');
      return { transcript: r.querySelector('.transcript-shell').getBoundingClientRect().height,
        statusClipped: status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1,
        conversationOverflow: conversation.scrollWidth - conversation.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.ok(phone.transcript >= 320, `transcript height ${phone.transcript} px at 400 px`);
    assert.equal(phone.statusClipped, false, 'the concept status is not clipped');
    assert.equal(phone.conversationOverflow, 0); assert.equal(phone.pageOverflow, 0, 'no horizontal overflow');
    assert.deepEqual(problems, []);
    t.diagnostic(`D2 0±1 px with scroll room, spare space and 5 grow/shrink rounds, no residual padding; chooser Device kept its node and 0±1 px across a live EU refusal; D4 foreign pause kept, auxiliary window left the call alone; D9 dark tokens; D14 transcript ${phone.transcript} px at 400 px.`);
  });

// The shown draft: preview state, the revision its frame holds, and the viewer's words.
const draftView = page => inShadow(page, c => {
  const r = c.shadowRoot, preview = r.querySelector('.concept-html'), frame = preview.shadowRoot.querySelector('iframe');
  return { state: preview.state, hidden: preview.hidden, revision: /Revision (\d+)/u.exec(frame?.getAttribute('srcdoc') ?? '')?.[1] ?? null,
    sandbox: frame?.getAttribute('sandbox') ?? null, title: r.querySelector('#concept-title').textContent, count: r.querySelector('.concept-count').textContent,
    label: preview.shadowRoot.querySelector('.label-text').textContent, image: !r.querySelector('.concept-image').hidden };
});
const waitDraft = (page, revision) => until(page, revision => {
  const preview = document.querySelector('aithema-session').shadowRoot.querySelector('.concept-html');
  return preview.state === 'ready' && preview.shadowRoot.querySelector('iframe')?.getAttribute('srcdoc').includes(`Revision ${revision}`);
}, revision);
const VIEWER_CONTROLS = ['.concept-close', '.concept-count', '.concept-stage', '.concept-html', '.concept-previous', '.concept-next', '.concept-download',
  '.concept-regenerate', '.concept-up', '.concept-down', '.concept-reject', '.concept-guidance-options button'];
const boxes = page => Promise.all(VIEWER_CONTROLS.map(selector => box(page, selector)));
// Every visible viewer button, whole: neither its own text nor any clipping or scrolling ancestor cuts it off.
const viewerClipping = c => {
  const r = c.shadowRoot, found = [], name = node => node.className || node.textContent;
  for (const button of r.querySelectorAll('.concept-viewer button')) {
    if (button.hidden || !button.getClientRects().length) continue;
    if (button.scrollHeight > button.clientHeight + 1 || button.scrollWidth > button.clientWidth + 1) found.push(`${name(button)}: its text`);
    const rect = button.getBoundingClientRect();
    for (let node = button.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node); if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = node.getBoundingClientRect(), left = outer.left + node.clientLeft, top = outer.top + node.clientTop;
      if (rect.left < left - .5 || rect.top < top - .5 || rect.right > left + node.clientWidth + .5 || rect.bottom > top + node.clientHeight + .5) found.push(`${name(button)}: by ${name(node)}`);
    }
  }
  for (const node of r.querySelectorAll('.concept-disclosure, .concept-guidance-options')) {
    if (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) found.push(`${name(node)}: overflows`);
  }
  return found;
};

test('clickable html drafts: request, sandboxed preview, a refresh revision in place, Like and Reject, light/dark/400 px/German (AIT-113 B2)',
  { timeout: 240_000 }, async t => {
    const executablePath = await browserPath(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-drafts-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    if (evidence) await mkdir(evidence, { recursive: true });
    // Rail shots scroll the conversation into view first; viewer shots show the full-window dialog.
    const shot = async (target, name) => {
      if (!evidence) return;
      if (name.endsWith('-rail') || name.endsWith('-reject')) await inShadow(target, c => {
        c.shadowRoot.querySelector('.conversation').scrollIntoView({ block: 'start' }); c.shadowRoot.querySelector('.transcript-shell').scrollTop = 0;
      });
      await target.screenshot({ path: join(evidence, `${name}.png`) });
    };
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'), timeout: waitTimeout,
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const problems = [];
    const watch = page => {
      page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
      // The preview's host-policy probe is blocked by design: that refusal proves frame-src 'none' is enforced.
      page.on('console', message => { if (message.type() === 'error' && !/^Framing '' violates the following Content Security Policy directive: "frame-src 'none'"/u.test(message.text())) problems.push(`console ${message.text()}`); });
      page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
    };
    const page = await browser.newPage(); await preparePage(page, ['en-US', 'en']); watch(page);
    // Headless Chrome follows the machine's colour scheme; light and dark are each set explicitly.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    const draftRequests = [];
    page.on('request', request => { if (/\/concepts\/[^/]+\/(?:html|image)/u.test(request.url())) draftRequests.push([request.resourceType(), new URL(request.url()).pathname.split('/').at(-1)]); });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await waitForShadow(page, '.composer textarea', { enabled: true });
    // The mock's slot-filling turn earns the first milestone, so the request renders at once.
    await sendTurn(page, `We are a bakery and want a pre-order app. ${content}`);
    await waitForShadow(page, 'aside .notice', { text: 'Current assessment' });

    // Request: the rail says what happens in plain words and nothing moves under the pointer.
    const requestBefore = await rest(page, '.concept-request');
    assert.match(await inShadow(page, c => c.shadowRoot.querySelector('.concept-request').textContent), /^Request concept · No cost \(local fake\)$/u);
    await page.mouse.down(); await page.mouse.up();
    await waitForShadow(page, '.concept-activity-text', { text: 'Draft revision 1 is ready.' });
    sameBox(requestBefore, await box(page, '.concept-request'), 'concept request button');
    assert.deepEqual(await inShadow(page, c => {
      const preview = c.shadowRoot.querySelector('.concept-preview');
      return { label: preview.querySelector('.concept-preview-label').textContent, glyph: !preview.querySelector('.concept-preview-glyph').hidden, image: !preview.querySelector('img').hidden };
    }), { label: 'Open clickable draft', glyph: true, image: false }, 'the rail thumbnail is a draft glyph, never a live frame');
    await page.mouse.move(0, 0); await shot(page, 'en-light-1440-rail');

    // The viewer renders the draft in the sandboxed preview from fetched bytes.
    await inShadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
    await waitDraft(page, 1);
    assert.deepEqual(await draftView(page), { state: 'ready', hidden: false, revision: '1', sandbox: 'allow-scripts', title: 'Draft revision 1', count: '1 of 1',
      label: 'Draft — generated', image: false });
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.concept-download').textContent), 'Download draft');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.concept-disclosure').textContent), 'Fake draft — local deterministic click-dummy, no AI or provider network');
    await shot(page, 'en-light-1440-viewer');

    // A refresh after new turns arrives while the pointer rests on Like: the shown revision stays
    // and no control moves; the count, Next and a notice say a newer one is ready. The turns go in
    // behind the modal viewer.
    const notice = () => inShadow(page, c => c.shadowRoot.querySelector('.concept-viewer-message').textContent);
    const turns = async (first, second) => {
      const count = await inShadow(page, c => c.session.transcript.length);
      await sendTurn(page, first); await until(page, count => document.querySelector('aithema-session').session.transcript.length >= count + 2, count);
      await sendTurn(page, second);
    };
    const likeBefore = await rest(page, '.concept-up'), controlsBefore = await boxes(page);
    await turns('Customers pick a branch and a pickup time; staff see one list per morning.', 'Payment happens in the shop. The data is public opening hours and our product list.');
    await waitForShadow(page, '.concept-count', { text: '1 of 2' }); await waitForShadow(page, '.concept-next', { enabled: true });
    const waiting = await draftView(page);
    assert.equal(waiting.revision, '1'); assert.equal(waiting.title, 'Draft revision 1'); assert.equal(await notice(), 'A newer revision is ready. Select Next to see it.');
    (await boxes(page)).forEach((after, i) => sameBox(controlsBefore[i], after, VIEWER_CONTROLS[i]));
    assert.ok(await inShadow(page, (c, at) => c.shadowRoot.elementFromPoint(at.x, at.y)?.closest('.concept-up') !== null,
      { x: likeBefore.x + Math.min(likeBefore.width / 2, 40), y: likeBefore.y + Math.min(likeBefore.height / 2, 10) }), 'the pointer still rests on Like');

    // Like shows its effect at once under the pointer, on the revision shown; Next and Previous walk the revisions.
    await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-up').getAttribute('aria-pressed') === 'true');
    sameBox(likeBefore, await box(page, '.concept-up'), 'Like');
    assert.deepEqual(await inShadow(page, c => c.session.concepts.map(item => item.feedback.vote)), ['up', 'clear']);
    await page.keyboard.press('ArrowRight'); await waitDraft(page, 2);
    assert.equal((await draftView(page)).count, '2 of 2'); assert.equal(await notice(), '');
    await page.keyboard.press('ArrowLeft'); await waitDraft(page, 1);
    await page.keyboard.press('ArrowRight'); await waitDraft(page, 2);

    // With the pointer off the controls and focus on Close, the next revision (requested here without
    // moving focus) replaces the shown latest one in its fixed stage; focus stays on Close and no control moves.
    await page.mouse.move(0, 0); await inShadow(page, c => c.shadowRoot.querySelector('.concept-close').focus());
    const restingBefore = await boxes(page);
    await inShadow(page, c => c.shadowRoot.querySelector('.concept-regenerate').click());
    // A regenerated revision 2 (the fake's page text says so) is the viewer's third draft.
    await until(page, () => {
      const c = document.querySelector('aithema-session'), preview = c.shadowRoot.querySelector('.concept-html');
      return c.session.concepts.length === 3 && preview.state === 'ready' && preview.dataset.id === c.session.concepts.at(-1).id;
    });
    const replaced = await draftView(page);
    assert.equal(replaced.count, '3 of 3'); assert.equal(replaced.title, 'Draft revision 3'); assert.equal(await notice(), '');
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'concept-close', 'focus stays on Close');
    (await boxes(page)).forEach((after, i) => sameBox(restingBefore[i], after, VIEWER_CONTROLS[i]));

    // Keyboard: Tab reaches the width switch and then the draft itself; focus never leaves the viewer.
    await inShadow(page, c => c.shadowRoot.querySelector('.concept-close').focus());
    await page.keyboard.press('Tab');
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'concept-html', 'Tab moves from Close into the draft preview');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.concept-html').shadowRoot.activeElement?.dataset.width), 'wide');
    await page.keyboard.press('ArrowRight');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.concept-html').width), 'phone', 'arrow keys switch the width, not the revision');
    assert.equal((await draftView(page)).count, '3 of 3');
    await page.keyboard.press('Tab');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.concept-html').shadowRoot.activeElement?.tagName), 'IFRAME', 'Tab continues into the draft');
    await shot(page, 'en-light-1440-viewer-phone-width');
    await inShadow(page, c => { c.shadowRoot.querySelector('.concept-html').width = 'wide'; });

    // Dark: the viewer and preview follow the dark tokens.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    assert.equal(await inShadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.concept-viewer')).backgroundColor), 'rgb(20, 26, 27)');
    await shot(page, 'en-dark-1440-viewer');
    // 400 px: the viewer fits, the draft keeps a usable stage, the title is whole, nothing overflows sideways.
    await page.setViewport({ width: 400, height: 800 });
    const phone = await inShadow(page, c => {
      const r = c.shadowRoot, title = r.querySelector('#concept-title'), dialog = r.querySelector('.concept-viewer').getBoundingClientRect();
      return { stage: r.querySelector('.concept-html').shadowRoot.querySelector('.stage').getBoundingClientRect().height, width: dialog.width,
        titleClipped: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.ok(phone.stage >= 200, `draft stage ${phone.stage} px at 400 px`); assert.equal(phone.width, 400);
    assert.equal(phone.titleClipped, false, 'the viewer title is whole at 400 px');
    assert.deepEqual(await inShadow(page, viewerClipping), [], 'no clipped viewer button at 400 px, guidance chips wrap into rows');
    assert.equal(phone.pageOverflow, 0);
    await shot(page, 'en-dark-400-viewer');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shot(page, 'en-light-400-viewer');
    await page.setViewport({ width: 1440, height: 1000 });

    // Reject archives exactly the shown revision and returns to the conversation.
    const shown = await inShadow(page, c => c.session.concepts.at(-1).id);
    const rejectBefore = await rest(page, '.concept-reject'); void rejectBefore;
    await page.mouse.down(); await page.mouse.up();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.concept-viewer').open);
    assert.equal(await inShadow(page, (c, id) => c.session.concepts.find(item => item.id === id).archived, shown), true);
    await waitForShadow(page, '.concept-activity-text', { text: 'Draft revision 2 is ready.' });
    assert.ok(draftRequests.length > 0 && draftRequests.every(([type, route]) => type === 'fetch' && route === 'html'), `drafts load as fetched data only: ${JSON.stringify(draftRequests)}`);
    await page.mouse.move(0, 0); await shot(page, 'en-light-1440-after-reject');
    await page.setViewport({ width: 400, height: 800 }); await shot(page, 'en-light-400-rail');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await shot(page, 'en-dark-400-rail');
    await page.setViewport({ width: 1440, height: 1000 }); await shot(page, 'en-dark-1440-rail');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

    // German: one language on the page, formal and with "Entwurf".
    const context = await browser.createBrowserContext(), german = await context.newPage();
    await preparePage(german, ['de-DE', 'de']); watch(german);
    await german.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await german.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(german, '.composer textarea');
    await mockConsent(german); await waitForShadow(german, '.composer textarea', { enabled: true });
    await sendTurn(german, 'Wir sind eine Tischlerei. Betrieb: gehostet; Daten: öffentlich; Systeme: API; Reichweite: international');
    await waitForShadow(german, 'aside .notice', { text: 'Aktuelle Einschätzung' });
    assert.equal(await inShadow(german, c => c.shadowRoot.querySelector('.concept-request').textContent), 'Entwurf anfordern · Kostenlos (lokaler Test)');
    await inShadow(german, c => c.shadowRoot.querySelector('.concept-request').click());
    await waitForShadow(german, '.concept-activity-text', { text: 'Fassung 1 des Entwurfs ist fertig.' });
    await german.mouse.move(0, 0); await shot(german, 'de-light-1440-rail');
    await inShadow(german, c => c.shadowRoot.querySelector('.concept-tab').click()); await waitDraft(german, 1);
    assert.deepEqual(await draftView(german), { state: 'ready', hidden: false, revision: '1', sandbox: 'allow-scripts', title: 'Entwurf, Fassung 1', count: '1 von 1',
      label: 'Entwurf, generiert', image: false });
    assert.match(await inShadow(german, c => c.shadowRoot.querySelector('.concept-html').shadowRoot.querySelector('iframe').getAttribute('srcdoc')), /<p>Fassung 1<\/p>/u, 'the German draft says Fassung');
    assert.deepEqual(await inShadow(german, c => ['.concept-previous', '.concept-next', '.concept-download', '.concept-up', '.concept-reject', '.concept-close']
      .map(selector => c.shadowRoot.querySelector(selector).textContent)),
    ['Vorheriger', 'Nächster', 'Entwurf herunterladen', 'Gefällt mir', 'Ablehnen und ausblenden', 'Zurück zum Gespräch']);
    await shot(german, 'de-light-1440-viewer');
    await german.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await shot(german, 'de-dark-1440-viewer');
    await german.setViewport({ width: 400, height: 800 });
    assert.deepEqual(await inShadow(german, viewerClipping), [], 'no clipped German button at 400 px, guidance chips wrap into rows');
    await shot(german, 'de-dark-400-viewer');
    await german.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await shot(german, 'de-light-400-viewer');
    await context.close();
    assert.deepEqual(problems, []);
    t.diagnostic(`Drafts: requested, rendered sandboxed from fetched bytes (${draftRequests.length} GET /html), revision 2 waited under a resting pointer and revision 3 replaced revision 2 in place, 0 px movement of ${VIEWER_CONTROLS.length} controls; Like, Previous/Next, Tab into the draft, Reject; light, dark, 400 px and German.`);
  });

test('document uploads: a text file and a PDF through the real file picker, pending then accepted, understanding refresh, drop, withdraw; nothing moves; German, 400 px, light and dark (AIT-100 B2)',
  { timeout: 240_000 }, async t => {
    const executablePath = await browserPath(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-uploads-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async (target, name, row = '.upload') => {
      if (!evidence) return;
      await inShadow(target, (c, row) => { c.shadowRoot.querySelector('.conversation').scrollIntoView({ block: 'start' });
        // The transcript shows its first upload (or the row in question) near the top.
        const shell = c.shadowRoot.querySelector('.transcript-shell'), chip = shell.querySelector(row);
        shell.scrollTop = chip ? shell.scrollTop + chip.getBoundingClientRect().top - shell.getBoundingClientRect().top - 120 : shell.scrollHeight; }, row);
      await target.screenshot({ path: join(evidence, `uploads-${name}.png`) });
    };
    // Fixtures: a small text file, a real PDF, a refused type and a file to drop.
    const files = join(directory, 'files'); await mkdir(files);
    const paths = { text: join(files, 'notizen.txt'), pdf: join(files, 'angebot.pdf'), refused: join(files, 'skript.sh'), dropped: join(files, 'ablauf.md'), broken: join(files, 'kaputt.pdf') };
    const textBytes = Buffer.from('Betrieb: gehostet. Kundinnen bestellen Brot am Vortag und holen es in der Filiale ab.'), pdfBytes = pdf(['Preorder app for three branches: pickup list every morning.']);
    await writeFile(paths.text, textBytes); await writeFile(paths.pdf, pdfBytes);
    await writeFile(paths.refused, 'echo nein');
    await writeFile(paths.dropped, '# Ablauf\nBestellung, Abholung, Tagesliste.');
    await writeFile(paths.broken, '%PDF-1.7\n%nicht lesbar\n');
    browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
      userDataDir: join(directory, 'chrome'), timeout: waitTimeout,
      args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const problems = [];
    const page = await browser.newPage(); await preparePage(page, ['de-DE', 'de']);
    page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !/^Framing ''/u.test(message.text())) problems.push(`console ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
    const uploadRequests = [];
    page.on('request', request => { const url = new URL(request.url()); if (/\/uploads(?:\/|$)/u.test(url.pathname)) uploadRequests.push([request.method(), url.origin, url.pathname.endsWith('/uploads')]); });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'de');

    // Before consent, Attach stays reachable and says the server's reason in German.
    const attach = () => inShadow(page, c => { const a = c.shadowRoot.querySelector('.attach');
      return { label: a.querySelector('.attach__label').textContent, disabled: a.getAttribute('aria-disabled'), title: a.title,
        described: a.getAttribute('aria-describedby').split(' ').map(id => c.shadowRoot.getElementById(id).textContent) }; });
    // Its own description first, then the AI notice (AIT-119).
    assert.deepEqual(await attach(), { label: 'Dateien anhängen', disabled: 'true', title: 'Dateien können nicht angehängt werden: Einwilligung zur Verarbeitung erforderlich',
      described: ['Dateien können nicht angehängt werden: Einwilligung zur Verarbeitung erforderlich', `${AI_NOTICE.de.text} ${AI_NOTICE.de.voice}`] });
    await mockConsent(page); await waitForShadow(page, '.composer textarea', { enabled: true });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
    assert.equal((await attach()).title, 'Bis zu 8 Dateien, je höchstens 20 MB: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON oder XML. Die Originaldatei wird nicht aufbewahrt.');

    await sendTurn(page, 'Wir sind eine Bäckerei und wollen eine Vorbestell-App. Betrieb: gehostet; Daten: öffentlich; Systeme: API; Reichweite: international');
    await waitForShadow(page, 'aside .notice', { text: 'Aktuelle Einschätzung' });
    const firstRevision = await inShadow(page, c => c.session.understanding.inputRevision);

    // Record every chip state as it renders, so a fast extraction still shows its pending state.
    await inShadow(page, c => {
      const seen = window.uploadStates = {}, list = c.shadowRoot.querySelector('ol');
      const record = () => { for (const row of list.querySelectorAll('.upload')) {
        const states = seen[row.querySelector('.upload__name').textContent] ??= [];
        if (states.at(-1) !== row.dataset.state) states.push(row.dataset.state);
      } };
      new MutationObserver(record).observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
      const status = c.shadowRoot.querySelector('.status'), said = window.statusLog = [];
      new MutationObserver(() => { if (said.at(-1) !== status.textContent) said.push(status.textContent); }).observe(status, { subtree: true, childList: true, characterData: true });
    });

    // Keyboard: Attach is reachable and Enter opens the native picker (the real file input).
    // The pointer rests on the person's turn while files arrive, then on an arriving row while it is read.
    await hold(page, true);
    await inShadow(page, c => c.shadowRoot.querySelector('.attach').focus());
    const turnBefore = await rest(page, 'ol li.turn.user');
    const composerBefore = await box(page, '.composer'), sendBefore = await box(page, '.send');
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.keyboard.press('Enter')]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.accept([paths.text, paths.pdf]);
    await until(page, () => {
      const rows = [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')];
      return rows.length === 2 && rows.every(row => row.dataset.state === 'pending');
    });
    sameBox(turnBefore, await box(page, 'ol li.turn.user'), 'hovered turn while files arrived');
    const chipIds = () => inShadow(page, c => [...c.shadowRoot.querySelectorAll('ol li.upload')].map(row => row.dataset.id));
    const textChip = `ol li[data-id="${(await chipIds())[0]}"]`, pendingRow = await restOnRow(page, textChip);
    await hold(page, false);
    await until(page, () => {
      const rows = [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')];
      return rows.length === 2 && rows.every(row => row.dataset.state === 'accepted');
    });
    const states = await page.evaluate(() => window.uploadStates);
    assert.deepEqual(states, { 'notizen.txt': ['pending', 'accepted'], 'angebot.pdf': ['pending', 'accepted'] }, 'each chip shows pending, then accepted');
    sameRow(pendingRow, await rowBoxes(page, textChip), 'pending → accepted at 1440 px');
    sameBox(composerBefore, await box(page, '.composer'), 'composer'); sameBox(sendBefore, await box(page, '.send'), 'Send');
    const chips = () => inShadow(page, c => [...c.shadowRoot.querySelectorAll('.upload')].map(row => ({ name: row.querySelector('.upload__name').textContent,
      size: row.querySelector('.upload__size').textContent, state: row.querySelector('.upload__state').textContent,
      withdraw: row.querySelector('.upload-withdraw')?.textContent ?? null })));
    assert.deepEqual(await chips(), [
      { name: 'notizen.txt', size: formatBytes(textBytes.length, 'de'), state: 'Gelesen. Die Originaldatei wird nicht aufbewahrt.', withdraw: 'Datei zurückziehen' },
      { name: 'angebot.pdf', size: formatBytes(pdfBytes.length, 'de'), state: 'Gelesen. Die Originaldatei wird nicht aufbewahrt.', withdraw: 'Datei zurückziehen' }]);
    // The chips show names only: the file's text reaches the page only as the model's own words.
    assert.equal(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.upload')].some(row => row.innerHTML.includes('Kundinnen bestellen'))), false, 'extracted text never renders in a chip');
    // Uploading was announced through the existing status region; "reading them…" ends once both files are read.
    assert.ok((await page.evaluate(() => window.statusLog)).includes('2 Dateien werden hochgeladen …'), JSON.stringify(await page.evaluate(() => window.statusLog)));
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.status').textContent), 'Verbunden');

    // The understanding refreshes for the new input revision.
    await until(page, async () => {
      const { inputRevision } = await import('/packages/core/src/session.js'), c = document.querySelector('aithema-session');
      return c.session.understanding.inputRevision === inputRevision(c.session) && c.shadowRoot.querySelector('aside .notice').textContent === 'Aktuelle Einschätzung';
    });
    assert.notEqual(await inShadow(page, c => c.session.understanding.inputRevision), firstRevision);
    await page.mouse.move(0, 0); await shot(page, 'de-light-1440-accepted');

    // A refused type is named in plain words before anything is sent.
    const posts = () => uploadRequests.filter(([method, , upload]) => method === 'POST' && upload).length, requestsBefore = posts();
    await inShadow(page, c => c.shadowRoot.querySelector('.attach').focus());
    const [refusal] = await Promise.all([page.waitForFileChooser(), page.keyboard.press('Enter')]);
    await refusal.accept([paths.refused]);
    await waitForShadow(page, '.composer-reason', { text: 'Nicht angehängt: skript.sh (Dateityp wird nicht angenommen).' });
    assert.equal(posts(), requestsBefore, 'nothing sent for a refused file');
    await shot(page, 'de-light-1440-refused');

    // An unreadable file says why; withdrawing it under the pointer keeps its row's geometry.
    await unreadableThenWithdrawn(page, paths.broken, '1440 px', (name, row) => shot(page, name, row), 'de-light-1440-unreadable');

    // Drop: a real file drag over the transcript shows the overlay without moving layout, then uploads.
    const cdp = await page.createCDPSession(), shell = await box(page, '.transcript-shell');
    const at = { x: Math.round(shell.x + shell.width / 2), y: Math.round(shell.y + shell.height / 2) };
    const drag = { items: [], files: [paths.dropped], dragOperationsMask: 1 };
    const layout = () => Promise.all(['.transcript-shell', '.composer', '.send', '.attach'].map(selector => box(page, selector)));
    const layoutBefore = await layout();
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data: drag });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data: drag });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.conversation').hasAttribute('data-dropping'));
    assert.deepEqual(await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.drop-overlay strong, .drop-overlay span')].map(n => n.textContent)),
      ['Loslassen zum Anhängen', 'Bis zu 8 Dateien, je höchstens 20 MB']);
    (await layout()).forEach((after, i) => sameBox(layoutBefore[i], after, ['transcript', 'composer', 'Send', 'Attach'][i]));
    await shot(page, 'de-light-1440-drop');
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...at, data: drag });
    await until(page, () => {
      const row = [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')].find(r => r.querySelector('.upload__name').textContent === 'ablauf.md');
      return row?.dataset.state === 'accepted';
    });
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.conversation').hasAttribute('data-dropping')), false);
    await until(page, async () => {
      const { inputRevision } = await import('/packages/core/src/session.js'), c = document.querySelector('aithema-session');
      return c.session.understanding.inputRevision === inputRevision(c.session);
    });

    // Withdraw upload under the pointer: the chip stays where it is, focus stays on it, the understanding rebuilds.
    const chipSelector = textChip;
    // The pointer rests on the button and the keyboard presses it, so both anchoring and focus are checked.
    const rowBefore = await restOnRow(page, chipSelector, '.upload-withdraw');
    await inShadow(page, (c, selector) => c.shadowRoot.querySelector(`${selector} .upload-withdraw`).focus({ preventScroll: true }), chipSelector);
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.className), 'upload-withdraw');
    await page.keyboard.press('Enter');
    await until(page, selector => document.querySelector('aithema-session').shadowRoot.querySelector(selector).dataset.state === 'withdrawn', chipSelector);
    sameRow(rowBefore, await rowBoxes(page, chipSelector), 'accepted → withdrawn at 1440 px');
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.classList.contains('upload') && c.shadowRoot.activeElement.dataset.state), 'withdrawn', 'focus stays on the withdrawn row');
    assert.deepEqual((await chips())[0], { name: 'Datei zurückgezogen', size: '', state: '', withdraw: null });
    assert.equal(await inShadow(page, c => c.session.uploads.some(u => u.filename === 'notizen.txt')), false);
    await until(page, async () => {
      const { inputRevision } = await import('/packages/core/src/session.js'), c = document.querySelector('aithema-session');
      return c.session.understanding.inputRevision === inputRevision(c.session) && c.shadowRoot.querySelector('aside .notice').textContent === 'Aktuelle Einschätzung';
    });
    await page.mouse.move(0, 0); await shot(page, 'de-light-1440-withdrawn');

    // Dark and 400 px: tokens follow the theme, Attach becomes its icon, nothing overflows sideways.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    assert.equal(await inShadow(page, c => getComputedStyle(c.shadowRoot.querySelectorAll('ol li.upload')[1].querySelector('.upload__name')).color), 'rgb(226, 233, 230)');
    await shot(page, 'de-dark-1440-withdrawn');
    await page.setViewport({ width: 400, height: 800 });
    const phone = await inShadow(page, c => {
      const r = c.shadowRoot, a = r.querySelector('.attach').getBoundingClientRect(), shellBox = r.querySelector('.transcript-shell').getBoundingClientRect();
      return { attach: [Math.round(a.width), Math.round(a.height)], label: r.querySelector('.attach__label').textContent,
        chipsInside: [...r.querySelectorAll('.upload')].every(row => { const b = row.getBoundingClientRect(); return b.left >= shellBox.left - .5 && b.right <= shellBox.right + .5; }),
        reasonClipped: r.querySelector('.composer-reason').scrollWidth > r.querySelector('.composer-reason').clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.deepEqual(phone, { attach: [44, 44], label: 'Dateien anhängen', chipsInside: true, reasonClipped: false, pageOverflow: 0 });
    await shot(page, 'de-dark-400');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shot(page, 'de-light-400');
    // At 400 px a chip under the pointer also stays put while another file arrives, and the arriving
    // row keeps its geometry from pending to accepted under the pointer.
    await hold(page, true);
    await inShadow(page, c => c.shadowRoot.querySelector('.attach').focus());
    const lastChip = `ol li[data-id="${(await chipIds()).at(-1)}"]`, phoneChip = await rest(page, lastChip);
    const [phoneChooser] = await Promise.all([page.waitForFileChooser(), page.keyboard.press('Enter')]);
    await phoneChooser.accept([paths.text]);
    await until(page, () => [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')].some(r => r.dataset.state === 'pending'));
    sameBox(phoneChip, await box(page, lastChip), 'hovered chip at 400 px');
    const phoneNew = `ol li[data-id="${(await chipIds()).at(-1)}"]`, phonePending = await restOnRow(page, phoneNew);
    await hold(page, false);
    await until(page, () => [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload')].filter(r => r.dataset.state === 'accepted').length === 3);
    sameRow(phonePending, await rowBoxes(page, phoneNew), 'pending → accepted at 400 px');
    await page.mouse.move(0, 0); await shot(page, 'de-light-400-accepted');
    // Withdrawing the accepted file at 400 px, pointer resting on the button and the keyboard pressing it.
    const phoneAccepted = await restOnRow(page, phoneNew, '.upload-withdraw');
    await inShadow(page, (c, selector) => c.shadowRoot.querySelector(`${selector} .upload-withdraw`).focus({ preventScroll: true }), phoneNew);
    await page.keyboard.press('Enter');
    await until(page, selector => document.querySelector('aithema-session').shadowRoot.querySelector(selector).dataset.state === 'withdrawn', phoneNew);
    sameRow(phoneAccepted, await rowBoxes(page, phoneNew), 'accepted → withdrawn at 400 px');
    assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.dataset.state), 'withdrawn', 'accepted → withdrawn at 400 px: focus stays on the row');
    // The longest German state wraps at 400 px; pending → unreadable → withdrawn under the pointer keeps the row's height.
    await unreadableThenWithdrawn(page, paths.broken, '400 px', (name, row) => shot(page, name, row), 'de-light-400-unreadable');

    assert.ok(uploadRequests.length > 0 && uploadRequests.every(([, origin]) => origin === new URL(demo.url).origin), 'upload requests stay on the page origin');
    assert.deepEqual(problems, []);
    assert.equal(posts(), 5, 'two pickers and the drop at 1440 px, two pickers at 400 px, one request each');
    t.diagnostic(`Uploads: ${posts()} upload POSTs via picker and drop, pending→accepted for txt and PDF, understanding refreshed, withdraw kept the chip and focus, refusal before sending; the changing row's box, name and action unchanged under the pointer for pending→accepted, pending→unreadable, unreadable→withdrawn and accepted→withdrawn at 1440 and 400 px; German, light/dark, 1440 and 400 px.`);
  });

// AIT-119: wherever an interaction can begin, the AI notice is already in view. The page (and the start
// card's own pane) are scrolled only as a visitor would to reach each control; the notice itself is never
// scrolled to.
const COMPOSER = ['.composer textarea', '.attach', '.send'];
const ENTRY_POINTS = {
  chooser: [...['best', 'eu', 'device', 'custom'].map(preset => `.chooser-option[data-preset="${preset}"]`), '.chooser__continue', ...COMPOSER],
  // The ready card before consent is granted: Review consent opens the host's consent interface.
  'ready before consent': ['.ready__change', '.ready__consent', '.voice-start', ...COMPOSER],
  ready: ['.ready__change', '.voice-start', ...COMPOSER],
  conversation: ['.voice-start', ...COMPOSER],
  'failed call': ['.voice-retry', '.voice-start', ...COMPOSER],
};
const noticeView = (page, selector) => inShadow(page, (c, selector) => {
  const r = c.shadowRoot, line = r.querySelector('.ai-notice'), rect = line.getBoundingClientRect(), style = getComputedStyle(line);
  const inside = b => b.width > 0 && b.height > 0 && b.top >= -.5 && b.left >= -.5 && b.bottom <= innerHeight + .5 && b.right <= innerWidth + .5;
  // What a pointer at the line's centre would hit: the line itself, never the start card or a rail.
  const hit = r.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const control = selector ? r.querySelector(selector) : null, own = control?.getBoundingClientRect();
  const pane = control?.closest('.intro')?.getBoundingClientRect();
  return { notice: inside(rect) && style.visibility === 'visible' && style.display !== 'none' && line.contains(hit),
    control: own ? inside(own) && (!pane || own.top >= pane.top - .5 && own.bottom <= pane.bottom + .5) : null,
    below: own ? own.top >= rect.bottom - .5 : null, text: r.querySelector('#ai-notice').textContent };
}, selector);
// Scroll as a visitor would until the control shows at the viewport's bottom or top edge.
const reveal = (page, selector, edge) => inShadow(page, (c, selector, edge) => {
  const control = c.shadowRoot.querySelector(selector), intro = control.closest('.intro');
  if (intro) {
    const own = control.getBoundingClientRect(), pane = intro.getBoundingClientRect();
    intro.scrollTop += own.bottom > pane.bottom ? own.bottom - pane.bottom : Math.min(0, own.top - pane.top);
  }
  const own = control.getBoundingClientRect();
  window.scrollTo(0, scrollY + (edge === 'bottom' ? own.bottom - innerHeight : own.top));
}, selector, edge);
async function noticeAtEntryPoints(page, state, full, label) {
  const checked = [];
  for (const selector of ENTRY_POINTS[state]) {
    const shown = await inShadow(page, (c, selector) => { const n = c.shadowRoot.querySelector(selector); return Boolean(n?.getClientRects().length); }, selector);
    assert.ok(shown, `${label}: ${selector} is shown`);
    for (const edge of ['bottom', 'top']) {
      await reveal(page, selector, edge);
      const view = await noticeView(page, selector);
      assert.deepEqual([view.control, view.notice, view.text], [true, true, full], `${label}: notice with ${selector} at the viewport's ${edge}`);
    }
    // Keyboard: focusing a control scrolled far out of view brings it in below the notice, never under it.
    const focusable = await inShadow(page, (c, selector) => !c.shadowRoot.querySelector(selector).disabled, selector);
    if (focusable) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).focus(), selector);
      const view = await noticeView(page, selector);
      assert.deepEqual([view.control, view.notice, view.below], [true, true, true], `${label}: notice and focused ${selector}`);
    }
    checked.push(selector);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return checked;
}

test('the AI notice is in view wherever an interaction can begin, without scrolling to it: every chooser option, the ready card before and after consent, Start and Retry call and the composer, English and German, 1440 and 400 px (AIT-119)',
  { timeout: 240_000 }, async t => {
    const executablePath = await browserPath(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-notice-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    if (evidence) await mkdir(evidence, { recursive: true });
    const style = page => inShadow(page, c => {
      const r = c.shadowRoot, line = r.querySelector('.ai-notice'), text = r.querySelector('#ai-notice'), s = getComputedStyle(line);
      return { clipped: line.scrollHeight > line.clientHeight + 1 || text.scrollWidth > line.clientWidth + 1, color: s.color,
        background: s.backgroundColor, pane: getComputedStyle(r.querySelector('.conversation')).backgroundColor,
        border: [s.borderLeftWidth, s.borderRightWidth, s.borderTopWidth, s.borderTopLeftRadius, s.boxShadow],
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const quiet = async (page, label) => {
      const s = await style(page);
      assert.deepEqual([s.clipped, s.border, s.pageOverflow], [false, ['0px', '0px', '0px', '0px', 'none'], 0], label);
      assert.equal(s.background, s.pane, `${label}: GUI-27, its fill is the pane's own surface, no tint`);
      return s;
    };
    const shot = async (page, name) => { if (evidence) await page.screenshot({ path: join(evidence, `ai-notice-${name}.png`) }); };
    const sizes = [[1440, 1000], [400, 800]], tally = {};
    for (const [locale, languages] of [['en', ['en-GB', 'en']], ['de', ['de-AT', 'de']]]) {
      const full = `${AI_NOTICE[locale].text} ${AI_NOTICE[locale].voice}`;
      // Its own browser and profile: a fresh session, never the other language's saved one.
      browser = await puppeteer.launch({ executablePath, headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
        userDataDir: join(directory, `chrome-${locale}`), timeout: waitTimeout,
        args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
      const page = await browser.newPage(); await preparePage(page, languages);
      const problems = []; page.on('pageerror', error => problems.push(error.message));
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '#ai-notice', { text: full });
      assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.intro').dataset.mode), 'chooser');
      // As the page first paints at 1440 × 1000, nothing scrolled: the chooser's first options already show,
      // and so does the notice above them.
      assert.equal(await page.evaluate(() => scrollY), 0);
      const first = await noticeView(page, '.chooser-option[data-preset="best"]');
      assert.deepEqual([first.control, first.notice, first.text], [true, true, full], `${locale}: first paint at 1440 px`);
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('textarea').disabled), true, 'before consent, choice or typing');
      await quiet(page, `${locale} light 1440 px`); await shot(page, `${locale}-light-1440`);
      for (const [width, height] of sizes) {
        await page.setViewport({ width, height });
        tally[`chooser ${width}`] = await noticeAtEntryPoints(page, 'chooser', full, `${locale} chooser ${width} px`);
      }
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await reveal(page, '.chooser__continue', 'bottom'); await quiet(page, `${locale} dark 400 px`); await shot(page, `${locale}-dark-400-start`);
      await page.setViewport({ width: 1440, height: 1000 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

      // Nothing shifts under the pointer. At the page's end every part of the pane is in view and the notice
      // stands in its own place; resting on it, hovering the controls, granting consent (the composer opens),
      // a turn and its reply leave the notice and the composer exactly where they were.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      let before = { line: await box(page, '.ai-notice'), composer: await box(page, '.composer') };
      await page.mouse.move(before.line.x + 40, before.line.y + before.line.height / 2);
      sameBox(before.line, await box(page, '.ai-notice'), 'notice on hover');
      assert.equal((await style(page)).background, (await style(page)).pane, 'hover adds no tint');
      for (const selector of ['.chooser-option', '.attach', '.send']) {
        await rest(page, selector);
        sameBox(before.line, await box(page, '.ai-notice'), `notice while hovering ${selector}`);
        sameBox(before.composer, await box(page, '.composer'), `composer while hovering ${selector}`);
      }
      // Continue before consent: the ready card offers Review consent and the composer stays closed.
      await inShadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
      await waitForShadow(page, '.ready__consent');
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('textarea').disabled), true, `${locale}: ready card before consent`);
      for (const [width, height] of sizes) {
        await page.setViewport({ width, height });
        tally[`ready before consent ${width}`] = await noticeAtEntryPoints(page, 'ready before consent', full, `${locale} ready before consent ${width} px`);
      }
      await page.setViewport({ width: 1440, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      before = { line: await box(page, '.ai-notice'), composer: await box(page, '.composer') };
      await page.mouse.move(before.line.x + 40, before.line.y + before.line.height / 2);
      await mockConsent(page);
      await waitForShadow(page, '.composer textarea', { enabled: true });
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.ready__consent'));
      await waitForShadow(page, '.ready__change');
      sameBox(before.line, await box(page, '.ai-notice'), 'notice under the pointer while consent opens the composer');
      sameBox(before.composer, await box(page, '.composer'), 'composer while consent opens it');
      await rest(page, '.voice-start');
      sameBox(before.line, await box(page, '.ai-notice'), 'notice while hovering Start call');
      // Ready card after consent: Change, Start call and the composer, both sizes.
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, `${locale}-light-1440-ready`);
      for (const [width, height] of sizes) {
        await page.setViewport({ width, height });
        tally[`ready ${width}`] = await noticeAtEntryPoints(page, 'ready', full, `${locale} ready ${width} px`);
      }
      await page.setViewport({ width: 1440, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.mouse.move(before.line.x + 40, before.line.y + before.line.height / 2);
      await sendTurn(page, locale === 'de' ? 'Wir brauchen eine Vorbestell-App.' : 'We need a preorder app.');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('ol li.turn').length >= 2);
      sameBox(before.line, await box(page, '.ai-notice'), 'notice under the pointer while a turn and reply arrive');
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.intro').dataset.mode), '');
      await page.mouse.move(0, 0);
      // The conversation: Start call and the composer, both sizes, light and dark.
      for (const [width, height] of sizes) {
        await page.setViewport({ width, height });
        tally[`conversation ${width}`] = await noticeAtEntryPoints(page, 'conversation', full, `${locale} conversation ${width} px`);
      }
      // A failed call: the fake voice drops and every recovery is refused, so the call ends failed and
      // offers Retry call.
      await page.setViewport({ width: 1440, height: 1000 });
      await startCall(page);
      const refuseRecovery = request => {
        if (request.isInterceptResolutionHandled()) return;
        if (/\/voice\/[^/]+\/recover$/u.test(new URL(request.url()).pathname)) void request.respond({ status: 503, contentType: 'application/json', body: '{}' });
        else void request.continue();
      };
      await page.setRequestInterception(true); page.on('request', refuseRecovery);
      await page.evaluate(() => document.querySelector('#fake-disconnect').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'failed');
      page.off('request', refuseRecovery); await page.setRequestInterception(false);
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.voice-retry').disabled), false, `${locale}: Retry call is offered`);
      for (const [width, height] of sizes) {
        await page.setViewport({ width, height });
        tally[`failed call ${width}`] = await noticeAtEntryPoints(page, 'failed call', full, `${locale} failed call ${width} px`);
      }
      for (const theme of ['dark', 'light']) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await reveal(page, '.composer textarea', 'bottom');
        const view = await noticeView(page, '.composer textarea');
        assert.deepEqual([view.control, view.notice, view.text], [true, true, full], `${locale} ${theme} 400 px`);
        await quiet(page, `${locale} ${theme} 400 px`); await shot(page, `${locale}-${theme}-400`);
      }
      const lightColor = (await style(page)).color;
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      assert.notEqual((await style(page)).color, lightColor, 'dark mode uses its own muted token');
      const phoneLine = await box(page, '.ai-notice');
      await page.mouse.move(phoneLine.x + 40, phoneLine.y + phoneLine.height / 2);
      sameBox(phoneLine, await box(page, '.ai-notice'), 'notice on hover at 400 px');
      await page.setViewport({ width: 1440, height: 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
      await quiet(page, `${locale} dark 1440 px`); await shot(page, `${locale}-dark-1440`);
      assert.deepEqual(problems, []);
      await browser.close(); browser = null;
    }
    t.diagnostic(`AI notice in view without scrolling to it, en and de, at the viewport's bottom and top edge and on keyboard focus: ${
      Object.entries(tally).map(([state, selectors]) => `${state} px: ${selectors.length} entry points`).join('; ')}; first paint at 1440 px; nothing moves under the pointer.`);
  });
