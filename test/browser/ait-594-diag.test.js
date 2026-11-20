// AIT-594 temporary diagnostic (removed again on this branch): repeat the AIT-569 400 DE chooser
// setup and record what changes in the chooser cards when the held identity/credits reads land,
// with a control that never releases them.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';

const waitTimeout = 45_000;
async function startDemo(directory, env = {}) {
  const child = fork(new URL('../../demo/server.js', import.meta.url), [], {
    env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: join(directory, 'session.sqlite'), ...env }, silent: true,
  });
  child.stdout.resume(); child.stderr.resume();
  const [message] = await once(child, 'message');
  return { child, url: message.url };
}
async function stopDemo(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
}
const inShadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: waitTimeout }, arg);
const visible = (page, selector) => until(page, selector => {
  const node = document.querySelector('aithema-session')?.shadowRoot?.querySelector(selector);
  return node && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible' && !node.closest('[hidden]');
}, selector);
const snap = page => inShadow(page, c => {
  const root = c.shadowRoot, r = n => { const b = n.getBoundingClientRect(); return [+b.x.toFixed(2), +b.y.toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)]; };
  const cards = [...root.querySelectorAll('.chooser-option')].map(card => ({
    preset: card.dataset.preset, rect: r(card), disabled: card.getAttribute('aria-disabled'), pressed: card.getAttribute('aria-pressed'),
    parts: [...card.children].map(n => ({ cls: n.className || n.tagName, text: n.textContent, rect: r(n), lines: n.getClientRects().length,
      spans: [...n.querySelectorAll(':scope > span')].map(s => ({ text: s.textContent, rect: r(s), lines: s.getClientRects().length,
        font: getComputedStyle(s).font })) })),
    font: getComputedStyle(card.querySelector('.chooser-option__detail')).font,
  }));
  const chooser = root.querySelector('.chooser'), list = root.querySelector('.chooser__list');
  return { cards, chooser: r(chooser), list: r(list), cols: getComputedStyle(list).gridTemplateColumns, rows: getComputedStyle(list).gridTemplateRows,
    innerWidth, clientWidth: document.documentElement.clientWidth, scrollY, lang: document.documentElement.lang, locale: c.session?.locale,
    stage: root.querySelector('.workspace')?.dataset.stage, fonts: [...document.fonts].map(f => `${f.family}/${f.weight}/${f.status}`),
    fontsStatus: document.fonts.status, rem: getComputedStyle(document.documentElement).fontSize, hostFont: getComputedStyle(c).fontSize };
});

test('AIT-594 diagnostic: what moves the device card when identity/credits land', { timeout: 900_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-594-'));
  const demo = await startDemo(directory, { AITHEMA_DEMO_VERIFY: '1' });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, env: { PATH: process.env.PATH, HOME: homedir() },
    userDataDir: join(directory, 'p'), timeout: waitTimeout, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
  const runs = [], selector = '.chooser-option[data-preset="device"]';
  const plan = [...Array(16)].map((_, i) => ({ i, release: i % 4 !== 3, theme: i % 2 ? 'dark' : 'light' }));
  for (const { i, release, theme } of plan) {
    const page = await browser.newPage();
    try {
      page.setDefaultTimeout(waitTimeout);
      await page.evaluateOnNewDocument(() => {
        if (window !== window.top) return;
        Object.defineProperty(navigator, 'languages', { get: () => ['de'] });
        Object.defineProperty(navigator, 'language', { get: () => 'de' });
        try { localStorage.setItem('aithema-demo-locale', 'de'); } catch { /* denied */ }
        const probe = window.chooserFitProbe = { reads: [], landed: [], log: [], timeline: [] };
        let last = '';
        const sample = () => {
          const root = document.querySelector('aithema-session')?.shadowRoot;
          const cards = root ? [...root.querySelectorAll('.chooser-option')] : [];
          if (cards.length) {
            const lines = n => { const range = document.createRange(); range.selectNodeContents(n); return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size; };
            const key = cards.map(card => `${card.dataset.preset}:${card.getBoundingClientRect().height.toFixed(2)}:${card.getBoundingClientRect().width.toFixed(2)}`
              + `[${[...card.querySelectorAll('strong, .chooser-option__detail > span, .chooser-option__note')].map(n => `${lines(n)}${n.textContent.slice(0, 12)}`).join('|')}]`
              + `${card.getAttribute('aria-disabled')}`).join(' ') + ` w=${document.documentElement.clientWidth} fonts=${document.fonts.size}/${document.fonts.status}`;
            if (key !== last) { probe.timeline.push(`${performance.now().toFixed(0)} ${key}`); last = key; }
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        let release; probe.lateReads = new Promise(resolve => { release = resolve; }); probe.releaseReads = () => { probe.timeline.push(`${performance.now().toFixed(0)} release`); release(); };
        const fetch = window.fetch.bind(window);
        window.fetch = async (url, init) => {
          const response = await fetch(url, init), path = new URL(url, location.href).pathname;
          probe.log.push(`${performance.now().toFixed(0)} fetch ${init?.method ?? 'GET'} ${path}`);
          if (/\/api\/sessions\/[^/]+\/(identity|credits)$/u.test(path) && (!init?.method || init.method === 'GET')) {
            probe.reads.push(path); probe.timeline.push(`${performance.now().toFixed(0)} held ${path.split('/').pop()}`); await probe.lateReads; probe.landed.push(path); probe.timeline.push(`${performance.now().toFixed(0)} landed ${path.split('/').pop()}`);
          }
          return response;
        };
      });
      await page.setViewport({ width: 400, height: 800 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await visible(page, '.chooser__continue');
      await until(page, () => ['identity', 'credits'].every(kind => window.chooserFitProbe.reads.some(path => path.endsWith(`/${kind}`))));
      const early = await snap(page);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await inShadow(page, (c, selector) => c.shadowRoot.querySelector(selector).scrollIntoView({ block: 'nearest' }), selector);
      const before = await snap(page);
      await inShadow(page, c => {
        const log = window.chooserFitProbe.mutations = [], t0 = performance.now();
        const name = n => n.nodeType === 3 ? `#text<${n.parentElement?.className || n.parentElement?.tagName}>` : `${n.tagName}.${n.className}`;
        new MutationObserver(list => { for (const m of list) if (log.length < 2000) log.push(`${(performance.now() - t0).toFixed(0)} ${m.type} ${name(m.target)} ${m.attributeName ?? ''} old=${String(m.oldValue).slice(0, 80)} now=${m.type === 'characterData' ? m.target.data.slice(0, 80) : m.type === 'attributes' ? m.target.getAttribute(m.attributeName) : [...m.addedNodes].map(name).join(',') + '/-' + [...m.removedNodes].map(name).join(',')}`); })
          .observe(c.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
        new ResizeObserver(entries => { for (const e of entries) log.push(`${(performance.now() - t0).toFixed(0)} resize ${e.target.dataset.preset} ${e.contentRect.height.toFixed(2)}`); })
          .observe(c.shadowRoot.querySelector('.chooser-option[data-preset="device"]'));
      });
      if (release) {
        await page.evaluate(() => window.chooserFitProbe.releaseReads());
        await until(page, () => ['identity', 'credits'].every(kind => window.chooserFitProbe.landed.some(path => path.endsWith(`/${kind}`))));
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await snap(page);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
      const late = await snap(page);
      const probe = await page.evaluate(() => ({ log: window.chooserFitProbe.log, mutations: window.chooserFitProbe.mutations.filter(m => /chooser|resize/u.test(m)), timeline: window.chooserFitProbe.timeline }));
      const h = s => s.cards.find(card => card.preset === 'device').rect[3];
      runs.push({ i, release, theme, heights: { early: h(early), before: h(before), after: h(after), late: h(late) }, early, before, after, late, probe });
      t.diagnostic(`${i} release=${release} ${theme} device h early=${h(early)} before=${h(before)} after=${h(after)} late=${h(late)} mutations=${probe.mutations.length}`);
      t.diagnostic(probe.timeline.join('\n'));
    } finally { await page.close(); }
  }
  const out = process.env.AITHEMA_EVIDENCE_DIR;
  if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, 'ait-594-diag.json'), JSON.stringify(runs, null, 1)); }
  assert.ok(runs.length === plan.length);
});
