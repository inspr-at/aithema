import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

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
      env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite'), AITHEMA_PROVIDER: 'mock' },
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
        await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); });
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
          const [, saved] = await Promise.all([page.click(selector), consent]);
          assert.equal(saved.status(), 200, `${selector} must save consent through the demo UI`);
          if (enabled) {
            await page.waitForFunction(() => document.querySelector('#consent-status').textContent === 'Mock processing allowed.',
              { polling: 'mutation' });
          }
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
    // These steps drive the image concept viewer; HTML concepts (the demo default since AIT-113 B1) have their own viewer.
    env: { PATH: process.env.PATH, PORT: port, AITHEMA_DB: join(directory, 'session.sqlite'), AITHEMA_PROVIDER: 'mock', AITHEMA_HTML_MODE: 'off' }, silent: true,
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
async function preparePage(page, languages) {
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(waitTimeout);
  await page.evaluateOnNewDocument(languages => {
    Object.defineProperty(navigator, 'languages', { get: () => languages });
    Object.defineProperty(navigator, 'language', { get: () => languages[0] });
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
    await page.click('#grant'); await waitForShadow(page, '.composer textarea', { enabled: true });
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
        && r.querySelector('.concept-activity-text').textContent === 'Your concept is ready.';
    });
    sameBox(requestBefore, await box(page, '.concept-request'), 'concept request button');

    // D3: Like, a guidance chip and Regenerate show their effect while the pointer rests on them.
    await inShadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
    await waitForShadow(page, '.concept-count', { text: '1 of 1' });
    const likeBefore = await rest(page, '.concept-up'); await page.mouse.down(); await page.mouse.up();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-up').getAttribute('aria-pressed') === 'true');
    sameBox(likeBefore, await box(page, '.concept-up'), 'Like');
    const chipBefore = await rest(page, '.concept-guidance-options button'); await page.mouse.down(); await page.mouse.up();
    await waitForShadow(page, '.concept-guidance-selected button', { text: 'Remove: Simpler layout' });
    sameBox(chipBefore, await box(page, '.concept-guidance-options button'), 'guidance chip');
    const regenerateBefore = await rest(page, '.concept-regenerate'); await page.mouse.down(); await page.mouse.up();
    await waitForShadow(page, '.concept-count', { text: '1 of 2' });
    await waitForShadow(page, '.concept-next', { enabled: true });
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
    assert.equal(await page.$eval('#consent-status', node => node.textContent), 'Mock processing allowed.', 'D8: the consent line shows the active grant');
    await startCall(page);
    await endCall(page);

    // D6: a host restart drops in-memory grants; the open page shows that without a reload.
    const port = new URL(demo.url).port;
    restarting = true; await stopDemo(demo.child); demo = await startDemo(directory, port);
    await waitForShadow(page, '.composer textarea', { enabled: false });
    await until(page, () => document.querySelector('#consent-status').textContent === 'Grant consent before mock processing.');
    await waitForShadow(page, '.status', { text: 'Connected' });
    restarting = false;

    // D1: a German browser gets a German page and German replies; a new choice applies to the next conversation.
    const context = await browser.createBrowserContext(), german = await context.newPage();
    await preparePage(german, ['de-DE', 'de']); watch(german);
    await german.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(german, '.composer textarea');
    assert.equal(await inShadow(german, c => c.session.locale), 'de');
    assert.equal(await german.evaluate(() => document.documentElement.lang), 'de');
    assert.equal(await german.$eval('#new', node => node.textContent), 'Neues Gespräch beginnen');
    await german.click('#grant'); await waitForShadow(german, '.composer textarea', { enabled: true });
    assert.equal(await german.$eval('#consent-status', node => node.textContent), 'Mock-Verarbeitung erlaubt.');
    await sendTurn(german, 'Wir sind eine Tischlerei. Betrieb: wir hosten selbst; Daten: nur intern');
    await waitForShadow(german, 'aside .notice', { text: 'Aktuelle Einschätzung' });
    assert.equal(await inShadow(german, c => c.session.transcript.at(-1).content), 'Was sollte sich als Erstes verbessern?');
    assert.deepEqual(await inShadow(german, c => [...c.shadowRoot.querySelectorAll('.cleared summary')].map(n => n.textContent).sort()), ['Betrieb', 'Daten']);
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

    const page = await browser.newPage(); await preparePage(page, ['en-US', 'en']); watch(page);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await page.click('#grant'); await waitForShadow(page, '.composer textarea', { enabled: true });
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
    t.diagnostic(`D2 0±1 px with scroll room, spare space and 5 grow/shrink rounds, no residual padding; D4 foreign pause kept, auxiliary window left the call alone; D9 dark tokens; D14 transcript ${phone.transcript} px at 400 px.`);
  });
