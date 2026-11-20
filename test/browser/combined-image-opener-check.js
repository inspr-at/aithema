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
            scroll: rect(root.querySelector('.conversation-scroll')),
            // Both scrollers' state: the welcome's viewport y moves when either scrolls.
            scrollers: Object.fromEntries([['conversation', root.querySelector('.conversation-scroll')], ['shell', shell]]
              .map(([name, node]) => [name, node ? { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
                scrollbar: node.offsetWidth - node.clientWidth, paddingBottom: getComputedStyle(node).paddingBottom } : null])),
            // What fills the live shell: the welcome's wrapped lines, the visitor turn and the font that wraps them.
            welcomeLines: row ? new Set([...range.getClientRects()].map(r => Math.round(r.y))).size : null,
            visitor: rect([...(shell?.querySelectorAll('.turn.user') ?? [])].at(-1)), font: row ? getComputedStyle(row).fontFamily : null };
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
      if (failures.length) failures.push(`scrollers prelive ${JSON.stringify(before.scrollers)} live ${JSON.stringify(after.scrollers)}`,
        `live fill: welcome ${JSON.stringify(after.opener)} lines ${before.welcomeLines}->${after.welcomeLines} visitor ${JSON.stringify(after.visitor)} shell ${JSON.stringify(after.shell)} font ${after.font}`);
      assert.deepEqual(failures, [], label);
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  });
  assert.equal(tables.length, 24);
}

// AIT-601 r4: the hand-off hold is narrow (TICK ruling + L1). It holds the welcome
// only while the visitor's first turn still shows its first line in the pane;
// a first turn entirely below the fold follows to the end instead. Latest always
// reaches the end, and nothing re-arms the hold: not a reload, not a resize,
// not a visitor scroll back to the top.
const longWelcome = {
  en: `${welcome.en} We keep what you share private, and you decide what is stored. The assistant asks short follow-up questions when something is unclear and summarises the project as you go. When the summary is right, you can confirm it and continue, or correct any part of it in your own words. Images and documents you add are read only for this project. You can pause the conversation and come back later, and you can withdraw anything you said. If you prefer, start with a rough idea; the details can follow later, and every answer helps the assistant ask better questions. A short list of goals, a sketch or an example of something you like is a good start. Nothing is sent before you start.`,
  de: `${welcome.de} Was Sie teilen, bleibt vertraulich, und Sie bestimmen, was gespeichert wird. Die Assistenz stellt kurze Rückfragen, wenn etwas unklar ist, und fasst das Vorhaben laufend zusammen. Stimmt die Zusammenfassung, bestätigen Sie sie und machen weiter, oder Sie korrigieren einzelne Teile in eigenen Worten. Bilder und Dokumente werden nur für dieses Vorhaben gelesen. Sie können pausieren und später zurückkommen, und alles, was Sie gesagt haben, wieder zurückziehen. Beginnen Sie ruhig mit einer groben Idee; Einzelheiten können später folgen, und jede Antwort hilft der Assistenz, bessere Fragen zu stellen. Eine kurze Liste von Zielen ist ein guter Anfang.`,
};
const longTurn = {
  en: 'An invoice system for a small workshop: customers, quotes, invoices and reminders, with a simple overview of what is open and overdue, exports for the tax adviser, and access for two colleagues who work on the road and need it on their phones.',
  de: 'Ein Rechnungssystem für eine kleine Werkstatt: Kunden, Angebote, Rechnungen und Mahnungen, mit einer einfachen Übersicht über Offenes und Überfälliges, Exporten für die Steuerberatung und Zugang für zwei Kolleginnen, die unterwegs arbeiten und es am Telefon brauchen.',
};

async function openCombined(browser, server, { locale, theme, width, height, text }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
    ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
  await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
  await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
  await page.evaluate((text, locale) => {
    const host = document.querySelector('aithema-session');
    host.style.setProperty('--aithema-height', `${innerHeight}px`);
    const snapshot = JSON.parse(JSON.stringify(host.session));
    snapshot.opener = { text, locale }; snapshot.visualsBound = true;
    mount(snapshot);
  }, text, locale);
  return page;
}
// The AIT-506/601 hand-off: consent, the persisted welcome, then the first turn.
async function handOff(page, text) {
  await page.type('aithema-session >>> textarea', text);
  await page.click('aithema-session >>> .send');
  await page.waitForFunction(() => trace.includes('consent'));
  await page.evaluate(() => { failSend = true; grant(); });
  await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
  await page.evaluate(() => {
    c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: c.session.opener.text } });
    failSend = false;
  });
  await page.click('aithema-session >>> .send');
  await page.waitForFunction(() => sent.length === 1 && document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
}
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
async function foldState(page) {
  await settled(page);
  return page.$eval('aithema-session', c => {
    const root = c.shadowRoot, shell = root.querySelector('.transcript-shell'), row = root.querySelector('[data-id="host:opener"]');
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const range = document.createRange(); range.selectNodeContents(row.querySelector('.turn-text'));
    const first = range.getClientRects()[0], visitor = [...shell.querySelectorAll('.turn.user')].at(-1), latest = root.querySelector('.transcript-latest');
    return { stage: root.querySelector('.workspace').dataset.stage, layout: root.querySelector('.workspace').dataset.conceptLayout,
      shell: rect(shell), scrollTop: shell.scrollTop, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight,
      opener: rect(row), firstLine: first ? { x: first.x, y: first.y, width: first.width, height: first.height } : null,
      visitor: rect(visitor), visitorLabel: rect(visitor?.querySelector('strong')),
      latest: rect(latest), latestShown: getComputedStyle(latest).visibility !== 'hidden' };
  });
}
const below = state => state.visitor.y + state.visitor.height > state.shell.y + state.shell.height + .5;
const whole = state => state.visitor.y >= state.shell.y - .5 && state.visitor.y + state.visitor.height <= state.shell.y + state.shell.height + .5;

export async function combinedImageOpenerFoldCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-combined-fold-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, tables = [];
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  const record = async (page, name, state) => {
    tables.push({ name, state });
    if (!evidence) return;
    await writeFile(join(evidence, 'ait-601-fold-boxes.json'), JSON.stringify(tables, null, 2));
    await page.screenshot({ path: join(evidence, 'shots', `ait-601-fold-${name}.png`), fullPage: false });
  };
  const [width, height] = [1366, 768];
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    // TICK L1: a welcome near the 1,000-character limit pushes the first turn
    // entirely below the fold, so the transcript follows to it (the welcome may move here only).
    await t.test(`entirely below: ${locale}/${theme}/${width}x${height}`, async () => {
      assert.ok(longWelcome[locale].length > 900 && longWelcome[locale].length <= 1000, `near the limit: ${longWelcome[locale].length}`);
      const page = await openCombined(browser, server, { locale, theme, width, height, text: longWelcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        const before = await foldState(page);
        await record(page, `below-${locale}-${theme}-prelive`, before);
        await handOff(page, locale === 'de' ? 'Ein Rechnungssystem.' : 'An invoice system.');
        const after = await foldState(page);
        await record(page, `below-${locale}-${theme}-live`, after);
        assert.equal(after.layout, 'image');
        for (const key of ['shell', 'opener', 'firstLine', 'visitor', 'visitorLabel']) positive(`below/${key}`, after[key]);
        // At offset 0 the visitor's turn would start below the pane.
        assert.ok(after.opener.y + after.scrollTop + after.opener.height > after.shell.y + after.shell.height, `the welcome alone fills the pane: ${JSON.stringify(after)}`);
        assert.ok(after.scrollTop > .5, `the transcript follows to the first turn: ${JSON.stringify(after)}`);
        assert.ok(whole(after), `the first turn is fully visible: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
    // TICK: a first turn that lands partly below holds the welcome, with Latest
    // shown; a click on Latest always reaches the end (gate2c 2).
    await t.test(`partly below, Latest: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        const before = await foldState(page);
        await record(page, `partly-${locale}-${theme}-prelive`, before);
        await handOff(page, longTurn[locale]);
        const held = await foldState(page);
        await record(page, `partly-${locale}-${theme}-held`, held);
        for (const key of ['shell', 'opener', 'firstLine', 'visitor', 'visitorLabel', 'latest']) positive(`partly/${key}`, held[key]);
        for (const key of keys) assert.ok(Math.abs(before.firstLine[key] - held.firstLine[key]) <= .5, `welcome first line ${key}: ${before.firstLine[key]} -> ${held.firstLine[key]}`);
        assert.ok(held.scrollTop <= .5, `held: ${held.scrollTop}`);
        assert.ok(held.visitorLabel.y + held.visitorLabel.height <= held.shell.y + held.shell.height + .5 && below(held), `the first turn is partly below: ${JSON.stringify(held)}`);
        assert.ok(held.latestShown, 'Latest announces the turn below');
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.transcript-latest').click());
        const latest = await foldState(page);
        await record(page, `partly-${locale}-${theme}-latest`, latest);
        assert.ok(latest.scrollTop > .5, `Latest scrolls: ${latest.scrollTop}`);
        assert.ok(whole(latest), `Latest shows the whole turn: ${JSON.stringify(latest)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  // gate2c 3: a visitor scroll ends the hold. Back at the top, a resize follows
  // as before instead of holding again.
  await t.test('no re-arm: scroll away, back to the top, resize', async () => {
    const page = await openCombined(browser, server, { locale: 'de', theme: 'light', width, height, text: welcome.de });
    try {
      await handOff(page, longTurn.de);
      const held = await foldState(page);
      assert.ok(held.scrollTop <= .5 && below(held), `held, partly below: ${JSON.stringify(held)}`);
      await page.$eval('aithema-session', c => { const shell = c.shadowRoot.querySelector('.transcript-shell'); shell.scrollTop = shell.scrollHeight; });
      await settled(page);
      await page.$eval('aithema-session', c => { c.shadowRoot.querySelector('.transcript-shell').scrollTop = 0; });
      await settled(page);
      await page.evaluate(() => document.querySelector('aithema-session').style.setProperty('--aithema-height', `${innerHeight - 24}px`));
      const resized = await foldState(page);
      await record(page, 'rearm-resize', resized);
      positive('rearm/visitor', resized.visitor);
      assert.ok(resized.scrollTop > .5 && whole(resized), `a resize after the hand-off follows to the end: ${JSON.stringify(resized)}`);
    } finally { await page.close(); }
  });
  // gate2c 3: a restored welcome + one-turn conversation follows as before.
  await t.test('no re-arm: reload of a welcome + one-turn conversation', async () => {
    const page = await openCombined(browser, server, { locale: 'de', theme: 'light', width, height, text: welcome.de });
    try {
      await handOff(page, longTurn.de);
      await page.evaluate(() => sessionStorage.setItem('combined-fixture-session', JSON.stringify(c.session)));
      await page.reload();
      await page.waitForFunction(() => globalThis.ready);
      await page.evaluate(() => {
        const host = document.querySelector('aithema-session');
        host.style.setProperty('--aithema-height', `${innerHeight}px`);
      });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
      const restored = await foldState(page);
      await record(page, 'rearm-reload', restored);
      assert.equal(restored.layout, 'image', 'the restored conversation keeps the image layout');
      positive('reload/visitor', restored.visitor);
      assert.ok(restored.scrollTop > .5 && whole(restored), `a restored conversation follows to its end: ${JSON.stringify(restored)}`);
    } finally { await page.close(); }
  });
  assert.equal(tables.length, 4 * 5 + 2);
}
