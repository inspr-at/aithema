import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
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
      const faulty = source.replace("await postJson('/api/sessions', { processingPreset })",
        "await fetch('/api/sessions', { method: 'POST', body: JSON.stringify({ processingPreset }) })");
      assert.notEqual(faulty, source, 'Regression injection must replace the demo session POST');
      await request.respond({ status: 200, contentType: 'text/javascript', body: faulty });
    })().catch(fail);
  });
}

test('demo works in a real browser: consent, turn, understanding, reload and ZIP export',
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
        // The UI defers transcript/aside changes while the pointer is over them.
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

        const restored = page.waitForResponse(`${url}/api/sessions/${id}`, { signal: controller.signal });
        let snapshot;
        reloading = true;
        try { [, snapshot] = await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), restored]); }
        finally { reloading = false; }
        assert.equal(snapshot.status(), 200);
        await waitForShadow(page, 'ol li.user span', { text: content });
        assert.equal(await page.$eval('aithema-session', component => component.session.id), id, 'Reload must restore the same session');
        await waitForShadow(page, 'aside .summary-text', { text: content });
        assert.equal(await page.$eval('#error', node => node.textContent), '');

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
        t.diagnostic(`Browser: ${await browser.version()}; session creation, consent grant/regrant (POST 200, "Mock processing allowed.", enabled composer), revocation (POST 200, disabled composer), shortcut, understanding, reload and ZIP download passed.`);
      })()]);
    } finally {
      controller.abort();
      page.off('console', consoleError); page.off('pageerror', fail); page.off('error', fail);
      page.off('response', responseError); page.off('requestfailed', requestError);
    }
  });
