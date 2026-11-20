// AIT-601: the combined entrance with a real image concept layout. A host whose
// visuals bind an image provider (the server's visualsBound) puts the workspace
// into data-concept-layout="image"; the demo's mock visuals bind HTML drafts and
// never reach it. Before live, the welcome must own its intrinsic height above
// readiness, and it must not move when readiness gives way to the conversation.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';

// A realistic multi-sentence host welcome; it wraps to several lines on desktop.
const welcome = {
  en: 'Welcome. Your AI assistant is ready to help you describe your project. Tell it what you want to build, who will use it and what matters most to you. You can type or speak, add images or documents, and change the processing settings at any time before you start.',
  de: 'Willkommen. Ihre KI-Assistenz hilft Ihnen, Ihr Vorhaben zu beschreiben. Erzählen Sie, was Sie bauen möchten, wer es nutzen wird und was Ihnen am wichtigsten ist. Sie können schreiben oder sprechen, Bilder oder Dokumente hinzufügen und die Verarbeitung jederzeit vor dem Start ändern.',
};
const viewports = [[1366, 768], [1440, 900], [1920, 1080]];
const keys = ['x', 'y', 'width', 'height'];
const positive = (label, box) => assert.ok(box && box.width > 0 && box.height > 0, `${label} positive box: ${JSON.stringify(box)}`);
const contains = (outer, inner) => inner.x >= outer.x - .5 && inner.y >= outer.y - .5 &&
  inner.x + inner.width <= outer.x + outer.width + .5 && inner.y + inner.height <= outer.y + outer.height + .5;
const intersects = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > .5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > .5;

export async function combinedImageOpenerCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-combined-image-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  // The file's shared Chrome (no ambient CI read); its fixture resets storage on close.
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, tables = [];
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of viewports) await t.test(`${locale}/${theme}/${width}x${height}`, async () => {
    const page = await browser.newPage(), problems = [];
    try {
      page.on('pageerror', error => problems.push(error.message));
      await page.setViewport({ width, height });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setRequestInterception(true);
      page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
        ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
      await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
      await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
      // The host fills the viewport. Its image visual is bound and not off, so
      // the concept view enters the real image layout (no mock draft kind).
      await page.evaluate((text, locale) => {
        const host = document.querySelector('aithema-session');
        host.style.setProperty('--aithema-height', `${innerHeight}px`);
        const snapshot = JSON.parse(JSON.stringify(host.session));
        snapshot.opener = { text, locale }; snapshot.visualsBound = true;
        mount(snapshot);
      }, welcome[locale], locale);
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      const measure = async state => {
        await settle();
        const boxes = await page.$eval('aithema-session', c => {
          const root = c.shadowRoot, workspace = root.querySelector('.workspace'), row = root.querySelector('[data-id="host:opener"]');
          const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const thread = row?.closest('.concept-thread'), shell = thread?.querySelector('.transcript-shell'), ready = root.querySelector('.ready');
          // The welcome's first line box: the first client rect of its text.
          const range = document.createRange(); if (row) range.selectNodeContents(row.querySelector('.turn-text'));
          const first = row ? range.getClientRects()[0] : null;
          return { stage: workspace.dataset.stage, layout: workspace.dataset.conceptLayout, entrance: workspace.dataset.entrance,
            containerType: thread ? getComputedStyle(thread).containerType : null, openerRows: root.querySelectorAll('[data-id="host:opener"]').length,
            thread: rect(thread), shell: rect(shell), opener: rect(row), firstLine: first ? { x: first.x, y: first.y, width: first.width, height: first.height } : null,
            ready: ready?.checkVisibility() ? rect(ready) : null, backdrop: rect(thread?.querySelector('.concept-backdrop')),
            scroll: rect(root.querySelector('.conversation-scroll')) };
        });
        tables.push({ locale, theme, width, height, state, boxes });
        if (evidence) {
          await writeFile(join(evidence, 'ait-601-boxes.json'), JSON.stringify(tables, null, 2));
          await page.screenshot({ path: join(evidence, 'shots', `ait-601-${locale}-${theme}-${width}x${height}-${state}.png`), fullPage: false });
        }
        return boxes;
      };
      const label = `${locale}/${theme}/${width}x${height}`, failures = [];
      const before = await measure('prelive');
      assert.equal(before.entrance, 'combined');
      assert.equal(before.layout, 'image', `${label}: a bound image visual enters the real image concept layout`);
      assert.notEqual(before.stage, 'live');
      assert.equal(before.openerRows, 1);
      for (const key of ['thread', 'shell', 'opener', 'firstLine', 'ready', 'backdrop', 'scroll']) positive(`${label}/prelive/${key}`, before[key]);
      // Defer the geometry verdicts so the live hand-off is still measured and captured.
      if (!contains(before.thread, before.shell)) failures.push(`the opener thread contains its transcript-shell: ${JSON.stringify(before)}`);
      if (!contains(before.thread, before.opener)) failures.push(`the opener thread contains the welcome: ${JSON.stringify(before)}`);
      if (intersects(before.thread, before.ready)) failures.push(`the opener thread does not intersect readiness: ${JSON.stringify(before)}`);
      if (before.ready.y < before.opener.y + before.opener.height - .5) failures.push(`readiness starts below the welcome: ${JSON.stringify(before)}`);
      if (before.backdrop.width > before.thread.width + .5) failures.push(`the backdrop stays within the thread width: ${JSON.stringify(before)}`);
      // Readiness → live: the first visitor turn, after the processing consent.
      await page.type('aithema-session >>> textarea', locale === 'de' ? 'Ein Rechnungssystem.' : 'An invoice system.');
      await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => trace.includes('consent'));
      // The server persists the render-only welcome with the first turn; this
      // fixture's /turns returns only the visitor turn. As in the AIT-506 check:
      // the grant (which invalidates earlier turns) comes first, its automatic
      // send fails, the welcome is persisted, then the visitor sends again.
      await page.evaluate(() => { failSend = true; grant(); });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
      await page.evaluate(() => {
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: c.session.opener.text } });
        failSend = false;
      });
      await page.click('aithema-session >>> .send');
      await page.waitForFunction(() => sent.length === 1 && document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
      const after = await measure('live');
      assert.equal(after.layout, 'image'); assert.equal(after.openerRows, 1);
      for (const key of ['thread', 'shell', 'opener', 'firstLine', 'backdrop', 'scroll']) positive(`${label}/live/${key}`, after[key]);
      for (const key of keys) {
        if (Math.abs(before.firstLine[key] - after.firstLine[key]) > .5) failures.push(`welcome first line ${key} moved: ${before.firstLine[key]} -> ${after.firstLine[key]}`);
        if (key !== 'height' && Math.abs(before.opener[key] - after.opener[key]) > .5) failures.push(`welcome ${key} moved: ${before.opener[key]} -> ${after.opener[key]}`);
      }
      // The live stage keeps its size container and the backdrop's cqw/cqh sizing.
      if (after.containerType !== 'size') failures.push(`the live thread stays a size container: ${after.containerType}`);
      if (!contains(after.thread, after.shell)) failures.push(`the live thread contains its transcript-shell: ${JSON.stringify(after)}`);
      const backdrop = Math.min(after.thread.width * .66, after.thread.height * .66 * 1.7778);
      if (Math.abs(after.backdrop.width - backdrop) > 1) failures.push(`the live backdrop is min(66cqw, 66cqh × 16/9): ${after.backdrop.width} vs ${backdrop}`);
      assert.deepEqual(failures, [], label);
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  });
  assert.equal(tables.length, 24);
}
