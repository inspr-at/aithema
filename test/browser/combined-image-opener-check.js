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
            visitor: rect([...(shell?.querySelectorAll('.turn.user') ?? [])].at(-1)), font: row ? getComputedStyle(row).fontFamily : null,
            // r5 (TICK): Latest and the composer controls, recorded for the look.
            latest: rect(root.querySelector('.transcript-latest')), latestShown: getComputedStyle(root.querySelector('.transcript-latest')).visibility !== 'hidden',
            composer: rect(root.querySelector('textarea')), mic: rect(root.querySelector('.composer-mic')), send: rect(root.querySelector('.send')) };
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
      // r5 (TICK): no follow at the hand-off; the transcript stays at its top.
      if (after.scrollers.shell.scrollTop > .5) failures.push(`the live shell does not follow: scrollTop ${after.scrollers.shell.scrollTop}`);
      for (const key of ['composer', 'send']) positive(`${label}/live/${key}`, after[key]);
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

// AIT-601 r5: no hand-off state. The image layout's transcript reserves 40 px at
// its end for the render label. Before the first assistant reply no render can
// run, so that idle reserve cannot turn fitting content into a follow (the
// welcome keeps its place). Content that really overflows follows to its end
// as before (TICK L1: the welcome may move then). Once a reply exists, the
// reserve counts again.
const longWelcome = {
  en: `${welcome.en} We keep what you share private, and you decide what is stored. The assistant asks short follow-up questions when something is unclear and summarises the project as you go. When the summary is right, you can confirm it and continue, or correct any part of it in your own words. Images and documents you add are read only for this project. You can pause the conversation and come back later, and you can withdraw anything you said. If you prefer, start with a rough idea; the details can follow later, and every answer helps the assistant ask better questions. A short list of goals, a sketch or an example of something you like is a good start. Nothing is sent before you start.`,
  de: `${welcome.de} Was Sie teilen, bleibt vertraulich, und Sie bestimmen, was gespeichert wird. Die Assistenz stellt kurze Rückfragen, wenn etwas unklar ist, und fasst das Vorhaben laufend zusammen. Stimmt die Zusammenfassung, bestätigen Sie sie und machen weiter, oder Sie korrigieren einzelne Teile in eigenen Worten. Bilder und Dokumente werden nur für dieses Vorhaben gelesen. Sie können pausieren und später zurückkommen, und alles, was Sie gesagt haben, wieder zurückziehen. Beginnen Sie ruhig mit einer groben Idee; Einzelheiten können später folgen, und jede Antwort hilft der Assistenz, bessere Fragen zu stellen. Eine kurze Liste von Zielen ist ein guter Anfang.`,
};
const shortTurn = { en: 'An invoice system.', de: 'Ein Rechnungssystem.' };
const shortReply = { en: 'Gladly. Who will use it day to day?', de: 'Gern. Wer nutzt es im Alltag?' };
const wishTurn = { en: 'Show me a first picture of it.', de: 'Zeig mir ein erstes Bild davon.' };
// The image layout's end reserve for the render label (styles.js, .concept-thread .transcript-shell).
const RESERVE = 40;

async function openCombined(browser, server, { locale, theme, width, height, text, shorter = 0 }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
    ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
  await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
  await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
  await page.evaluate((text, locale, shorter) => {
    const host = document.querySelector('aithema-session');
    host.style.setProperty('--aithema-height', `${innerHeight - shorter}px`);
    const snapshot = JSON.parse(JSON.stringify(host.session));
    snapshot.opener = { text, locale }; snapshot.visualsBound = true;
    mount(snapshot);
  }, text, locale, shorter);
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
    const pane = shell.getBoundingClientRect(), list = shell.querySelector('ol').getBoundingClientRect();
    return { stage: root.querySelector('.workspace').dataset.stage, layout: root.querySelector('.workspace').dataset.conceptLayout,
      shell: rect(shell), scrollTop: shell.scrollTop, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight,
      // D511a's fit inputs: the list's end in scroll coordinates and the end padding (reserve + slack).
      contentEnd: list.bottom + shell.scrollTop - pane.top, paddingBottom: parseFloat(getComputedStyle(shell).paddingBottom),
      opener: rect(row), firstLine: first ? { x: first.x, y: first.y, width: first.width, height: first.height } : null,
      visitor: rect(visitor), visitorLabel: rect(visitor?.querySelector('strong')),
      reply: rect([...shell.querySelectorAll('.turn:not(.user)')].filter(turn => turn.dataset.id !== 'host:opener').at(-1)),
      latest: rect(latest), latestShown: getComputedStyle(latest).visibility !== 'hidden',
      // r6: the render label (desktop: inside the thread) and whether it shows.
      label: rect(shell.parentElement.querySelector(':scope > .concept-bottom')),
      labelState: shell.parentElement.querySelector(':scope > .concept-bottom')?.dataset.state ?? null,
      composer: rect(root.querySelector('textarea')), mic: rect(root.querySelector('.composer-mic')), send: rect(root.querySelector('.send')) };
  });
}
// r6 (gate4c): the concept lane's own steps. Recording a visual wish keeps the
// concept status (ConceptLane.recordIntent: idle stays idle); a render then
// marks the wish pending and shows the render label (state "gen").
const recordWish = page => page.evaluate(() => {
  const s = c.session, turn = s.transcript.filter(item => item.role === 'user').at(-1);
  c.receive({ seq: s.seq + 1, type: 'concept.state', data: { intent: { ...s.conceptIntent, visualIntent: { id: 'wish-1', sourceTurnId: turn?.id ?? null } },
    status: s.conceptStatus ?? { phase: 'idle' } } });
});
async function renderStarts(page) {
  await page.evaluate(() => {
    const s = c.session, turnIds = s.transcript.filter(item => item.role === 'user').map(item => item.id);
    c.receive({ seq: s.seq + 1, type: 'concept.state', data: { intent: { ...s.conceptIntent, pending: { id: 'render-1', trigger: 'progress', turnIds, referenceIds: [] } },
      status: { phase: 'pending', requestId: 'render-1', startedAt: Date.now(), estimateMs: 45_000, turnIds, referenceIds: [] } } });
  });
  await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.transcript-shell')
    .parentElement.querySelector(':scope > .concept-bottom')?.dataset.state === 'gen');
}
// The visitor's last turn sits whole in the pane and above the render label's reserve.
const clearOfLabel = (state, box = state.visitor) => whole(state, box) && box.y + box.height <= state.shell.y + state.shell.height - RESERVE + 1 &&
  !intersects(box, state.label);
const whole = (state, box = state.visitor) => box.y >= state.shell.y - .5 && box.y + box.height <= state.shell.y + state.shell.height + .5;
// Size the host so the pane's client height lies inside the reserve: the
// content fits without the 40 px reserve and overflows with it.
async function intoReserve(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await foldState(page), delta = Math.round(state.contentEnd + state.paddingBottom - RESERVE / 2 - state.clientHeight);
    if (Math.abs(delta) <= 2) return state;
    await page.evaluate(d => {
      const host = document.querySelector('aithema-session');
      host.style.setProperty('--aithema-height', `${parseFloat(host.style.getPropertyValue('--aithema-height')) + d}px`);
    }, delta);
  }
  return foldState(page);
}
const followRequest = page => page.$eval('aithema-session', c => c.shadowRoot.querySelector('.transcript-latest').click());

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
    // TICK L1 / r5 acceptance: real overflow. A welcome near the 1,000-character
    // limit in a shorter host pane (the host 120 px shorter than the 1366x768
    // page) leaves the first turn below the fold, so the transcript follows to
    // its end (the welcome may move here): the turn fully visible, Latest hidden.
    await t.test(`real overflow: ${locale}/${theme}/${width}x${height}`, async () => {
      assert.ok(longWelcome[locale].length > 900 && longWelcome[locale].length <= 1000, `near the limit: ${longWelcome[locale].length}`);
      const page = await openCombined(browser, server, { locale, theme, width, height, text: longWelcome[locale], shorter: 120 }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        const before = await foldState(page);
        await record(page, `overflow-${locale}-${theme}-prelive`, before);
        await handOff(page, shortTurn[locale]);
        const after = await foldState(page);
        await record(page, `overflow-${locale}-${theme}-live`, after);
        assert.equal(after.layout, 'image');
        for (const key of ['shell', 'opener', 'firstLine', 'visitor', 'visitorLabel', 'composer', 'send']) positive(`overflow/${key}`, after[key]);
        // Even without the idle reserve, the content overflows the pane.
        assert.ok(after.contentEnd + after.paddingBottom - RESERVE > after.clientHeight + .5, `real overflow: ${JSON.stringify(after)}`);
        assert.ok(after.scrollTop > .5, `the transcript follows to the first turn: ${JSON.stringify(after)}`);
        assert.ok(whole(after), `the first turn is fully visible: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `Latest is hidden at the end: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  for (const [locale, theme] of [['de', 'light'], ['en', 'dark']]) {
    // The 7 px over-count (agm2 DE 1366: 276 + 40 > 309), made deterministic on
    // every platform: the pane is sized into the reserve. Before the first
    // reply, a follow request leaves the transcript at its top.
    await t.test(`idle reserve, before the first reply: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await handOff(page, shortTurn[locale]);
        const sized = await intoReserve(page);
        assert.ok(sized.paddingBottom >= RESERVE, `the image layout reserves the render label: ${sized.paddingBottom}`);
        assert.ok(sized.contentEnd + sized.paddingBottom - RESERVE <= sized.clientHeight - 5 && sized.contentEnd + sized.paddingBottom > sized.clientHeight + 5,
          `the pane lies inside the reserve: ${JSON.stringify(sized)}`);
        await followRequest(page);
        const after = await foldState(page);
        await record(page, `idle-${locale}-${theme}`, after);
        for (const key of ['shell', 'opener', 'firstLine', 'visitor', 'composer', 'send']) positive(`idle/${key}`, after[key]);
        assert.ok(after.scrollTop <= .5, `no follow before the first reply: ${JSON.stringify(after)}`);
        assert.ok(whole(after), `the first turn is fully visible: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `nothing unread: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
    // Once a reply exists, the reserve counts again: the same geometry follows
    // to the end, so the reply stays clear of the render label.
    await t.test(`reserve counts after the first reply: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await handOff(page, shortTurn[locale]);
        await page.evaluate(text => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply-1', role: 'assistant', content: text } }), shortReply[locale]);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('[data-id="reply-1"]'));
        const sized = await intoReserve(page);
        assert.ok(sized.paddingBottom >= RESERVE, `the image layout reserves the render label: ${sized.paddingBottom}`);
        assert.ok(sized.contentEnd + sized.paddingBottom - RESERVE <= sized.clientHeight - 5 && sized.contentEnd + sized.paddingBottom > sized.clientHeight + 5,
          `the pane lies inside the reserve: ${JSON.stringify(sized)}`);
        await followRequest(page);
        const after = await foldState(page);
        await record(page, `reply-${locale}-${theme}`, after);
        for (const key of ['shell', 'reply', 'composer', 'send']) positive(`reply/${key}`, after[key]);
        assert.ok(after.scrollTop > .5, `the reply follows: ${JSON.stringify(after)}`);
        assert.ok(whole(after, after.reply) && after.reply.y + after.reply.height <= after.shell.y + after.shell.height - RESERVE + 1,
          `the reply stays clear of the render label: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `Latest is hidden at the end: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
    // r6 (gate4c Medium, a): a recorded visual wish makes a render possible
    // before the first reply, so the reserve is no longer idle. Following
    // content makes room for the label before it shows, and the label's
    // appearance then moves nothing.
    await t.test(`a wish before the first reply, following: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await handOff(page, wishTurn[locale]);
        const sized = await intoReserve(page);
        assert.ok(sized.contentEnd + sized.paddingBottom - RESERVE <= sized.clientHeight - 5 && sized.contentEnd + sized.paddingBottom > sized.clientHeight + 5,
          `the pane lies inside the reserve: ${JSON.stringify(sized)}`);
        assert.ok(sized.scrollTop <= .5, `idle before the wish: ${JSON.stringify(sized)}`);
        await recordWish(page);
        const wished = await foldState(page);
        await record(page, `wish-follow-${locale}-${theme}-wish`, wished);
        assert.notEqual(wished.labelState, 'gen', `the wish alone shows no label: ${JSON.stringify(wished)}`);
        assert.ok(wished.scrollTop > .5, `the recorded wish counts the reserve: ${JSON.stringify(wished)}`);
        await renderStarts(page);
        const after = await foldState(page);
        await record(page, `wish-follow-${locale}-${theme}-pending`, after);
        for (const key of ['shell', 'visitor', 'label', 'composer', 'send']) positive(`wish-follow/${key}`, after[key]);
        assert.ok(Math.abs(after.scrollTop - wished.scrollTop) <= .5 && Math.abs(after.visitor.y - wished.visitor.y) <= .5,
          `the label's appearance moves nothing: ${JSON.stringify({ wished, after })}`);
        assert.ok(clearOfLabel(after), `the visitor turn is clear of the render label: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `Latest is hidden at the end: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
    // r6 (gate4c Low): a streamed first reply counts the reserve from its first
    // partial, so its finalization moves nothing.
    await t.test(`a streamed first reply finalizes in place: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await handOff(page, shortTurn[locale]);
        await page.evaluate(async text => {
          const { inputRevision } = await import('/packages/core/src/session.js');
          c.receive({ type: 'turn.partial', data: { id: 'reply-1', delta: text, inputRevision: inputRevision(c.session) } });
        }, shortReply[locale]);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('[data-id="reply-1"]'));
        const sized = await intoReserve(page);
        assert.ok(sized.contentEnd + sized.paddingBottom - RESERVE <= sized.clientHeight - 5 && sized.contentEnd + sized.paddingBottom > sized.clientHeight + 5,
          `the pane lies inside the reserve: ${JSON.stringify(sized)}`);
        await followRequest(page);
        const streamed = await foldState(page);
        await record(page, `stream-${locale}-${theme}-partial`, streamed);
        positive('stream/reply', streamed.reply);
        assert.ok(streamed.scrollTop > .5, `the partial reply counts the reserve: ${JSON.stringify(streamed)}`);
        await page.evaluate(text => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply-1', role: 'assistant', content: text } }), shortReply[locale]);
        await page.waitForFunction(() => document.querySelector('aithema-session').session.transcript.some(turn => turn.id === 'reply-1'));
        const after = await foldState(page);
        await record(page, `stream-${locale}-${theme}-final`, after);
        for (const key of ['shell', 'reply', 'composer', 'send']) positive(`stream/${key}`, after[key]);
        // A final reply gains its listen / read actions (one 44 px row); that
        // growth is the only movement: the reply's end keeps its place, and the
        // reserve adds no jump of its own.
        const growth = after.reply.height - streamed.reply.height, end = box => box.y + box.height;
        assert.ok(Math.abs(end(after.reply) - end(streamed.reply)) <= .5 && Math.abs(after.scrollTop - streamed.scrollTop - growth) <= 1,
          `the reply finalizes in place: ${JSON.stringify({ growth, streamed, after })}`);
        assert.ok(clearOfLabel(after, after.reply), `the reply stays clear of the render label: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `Latest is hidden at the end: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    // r6 (gate4c Medium, b): the gate's case. The pointer leaves Send for the
    // transcript (follow suspends), the wish is recorded, then the render
    // starts. Once its label shows, the visitor's turn must not sit under it.
    await t.test(`a wish, then a render, pointer in the transcript: ${locale}/${theme}/${width}x${height}`, async () => {
      const page = await openCombined(browser, server, { locale, theme, width, height, text: welcome[locale] }), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await handOff(page, wishTurn[locale]);
        const sized = await intoReserve(page);
        assert.ok(sized.contentEnd + sized.paddingBottom - RESERVE <= sized.clientHeight - 5 && sized.contentEnd + sized.paddingBottom > sized.clientHeight + 5,
          `the pane lies inside the reserve: ${JSON.stringify(sized)}`);
        assert.ok(sized.scrollTop <= .5, `idle before the wish: ${JSON.stringify(sized)}`);
        await page.mouse.move(sized.firstLine.x + 20, sized.firstLine.y + sized.firstLine.height / 2, { steps: 4 });
        await recordWish(page);
        const wished = await foldState(page);
        await record(page, `wish-pointer-${locale}-${theme}-wish`, wished);
        assert.ok(wished.scrollTop <= .5, `while no label shows, the pointer keeps its reading place: ${JSON.stringify(wished)}`);
        await renderStarts(page);
        const after = await foldState(page);
        await record(page, `wish-pointer-${locale}-${theme}-pending`, after);
        for (const key of ['shell', 'opener', 'visitor', 'label', 'composer', 'send']) positive(`wish-pointer/${key}`, after[key]);
        assert.ok(clearOfLabel(after), `the visitor turn is clear of the render label: ${JSON.stringify(after)}`);
        assert.equal(after.latestShown, false, `Latest is hidden at the end: ${JSON.stringify(after)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  assert.equal(tables.length, 4 * 2 + 2 * 2 + 2 * 4 + 4 * 2);
}
