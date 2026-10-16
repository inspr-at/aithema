import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

const waitTimeout = 45_000;
const content = 'operations: hosted; data: public; systems: API; reach: international';

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
          || (expected.enabled !== undefined && !node.disabled !== expected.enabled)
          || (expected.states !== undefined && !expected.states.includes(node.dataset.state))) return;
        observer.disconnect(); clearTimeout(timer); resolve();
      }
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      check();
    });
  }, selector, expected, waitTimeout);
}

const shadowFocus = page => page.$eval('aithema-session', component => {
  const active = component.shadowRoot.activeElement; return active ? active.className || active.id || active.tagName : null;
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

async function preparePage(page, languages) {
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(waitTimeout);
  await page.evaluateOnNewDocument(languages => {
    // Puppeteer injects this into srcdoc policy probes and draft sandboxes too.
    if (window !== window.top) return;
    Object.defineProperty(navigator, 'languages', { get: () => languages });
    Object.defineProperty(navigator, 'language', { get: () => languages[0] });
    try { localStorage.setItem('aithema-demo-locale', languages[0].startsWith('de') ? 'de' : 'en'); } catch { /* Storage can be denied. */ }
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

const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: waitTimeout }, arg);
async function uploadChooser(page, timeout = waitTimeout) {
  // The input is deliberately hidden behind Attach. Wait for its attachment
  // and the visible, available button, then keep focus through geometry probes.
  await page.waitForSelector('aithema-session >>> .attach-input');
  await page.waitForSelector('aithema-session >>> .attach', { visible: true });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
  await inShadow(page, c => c.shadowRoot.querySelector('.attach').focus({ preventScroll: true }));
  assert.equal(await inShadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('.attach')), true, 'Attach owns keyboard focus');
  // waitForFileChooser starts interception asynchronously. Its own CDP session
  // must acknowledge interception before Enter can open the native picker.
  await page._client().send('Page.setInterceptFileChooserDialog', { enabled: true });
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout }), page.keyboard.press('Enter')]);
  return chooser;
}
// AIT-128: the composer opens with START's explicit start: Continue (from the entrance), Text input, Start.
async function startTyping(page) {
  const stage = () => inShadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage);
  if (await stage() === 'live') return;
  if (await stage() === 'entrance') {
    await inShadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'ready');
  }
  await inShadow(page, c => { c.shadowRoot.querySelector('.ready__mode[data-mode="type"]').click(); c.shadowRoot.querySelector('.ready__start').click(); });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
}
const sendTurn = (page, text) => inShadow(page, (c, text) => {
  c.shadowRoot.querySelector('textarea').value = text; c.shadowRoot.querySelector('form').requestSubmit();
}, text);
// AIT-128: the first input opens the understanding with START's one-time reveal (the column slides in over
// ~560 ms). It is the visitor's own action, not a live update; checks under a resting pointer start after it.
const revealed = page => until(page, () => {
  const workspace = document.querySelector('aithema-session').shadowRoot.querySelector('.workspace');
  return workspace.dataset.understanding === 'present' && !workspace.hasAttribute('data-reveal');
});

export {
  waitTimeout, content, waitForShadow, shadowFocus, startDemo, stopDemo, preparePage,
  inShadow, box, until, uploadChooser, startTyping, sendTurn, revealed,
};
