import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const selectors = ['.notice', '.summary', '.signals-section', '.open-questions', '.questions', '.missing', '.understanding > .foot', '.composer-shell', '.band'];
async function geometry(page) {
  return shadow(page, (c, selectors) => selectors.map(selector => {
    const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, r.x, r.y, r.width, r.height];
  }), selectors);
}
function same(before, after, context) {
  for (let i = 0; i < before.length; i++) {
    assert.ok(before[i][3] > 0 && before[i][4] > 0 && after[i][3] > 0 && after[i][4] > 0, `${context}: positive ${before[i][0]}`);
    for (let j = 1; j < 5; j++) assert.equal(after[i][j] - before[i][j], 0, `${context}: ${before[i][0]} rect ${j}`);
  }
}
async function setup(page, locale, theme) {
  await shadow(page, async (c, locale, theme) => {
    const { createSession, inputRevision } = await import('/packages/core/src/session.js');
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const session = createSession({ demo: true, locale });
    session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
    session.transcript = [{ id: 'u', role: 'user', content: 'We reconcile invoices by hand.' }, { id: 'a', role: 'assistant', content: 'Which system do you use?', inputRevision: inputRevision(session) }];
    Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
      summary: 'Three people reconcile invoices by hand.', signals: ['400 invoices monthly'], openQuestions: ['Which system do you use?', 'Who approves invoices?'] });
    session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
    window.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      return Response.json(c.session);
    };
    c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ copy, session });
  }, locale, theme);
  await page.mouse.move(0, 0); await settle(page);
}
test('AIT-504 RC24: constant overview slot, positive boxes and five consecutive answers without tab changes', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), rows = [], errors = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  // One injected clock drives every synthetic event and each assessment in this UI fixture.
  await page.evaluate(() => { window.rc24Now = 100_000; const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [window.rc24Now])); } static now() { return window.rc24Now; } }; });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await setup(page, locale, theme);
    const baseline = await geometry(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice-text').textContent), locale === 'en' ? 'Up to date' : 'Auf dem neuesten Stand');
    for (const state of ['pending', 'updating', 'idle', 'current']) {
      await shadow(page, async (c, state) => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        const emit = (type, data) => c.receive({ seq: c.session.seq + 1, type, data, at: new Date().toISOString() });
        if (state === 'pending') { emit('turn.final', { id: 'next', role: 'user', content: 'Another detail' }); emit('turn.final', { id: 'next-reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) }); }
        else if (state === 'current') emit('understanding.updated', { ...c.session.understanding, inputRevision: inputRevision(c.session) });
        if (state !== 'pending') emit('lane.status', { inputRevision: inputRevision(c.session), running: state === 'updating' ? ['understanding'] : [], failures: [], lastFailure: null });
      }, state);
      await settle(page); const boxes = await geometry(page); same(baseline, boxes, `${locale}/${theme}/${width}/${state}`);
      rows.push({ locale, theme, width, state, boxes, maxDelta: 0 });
    }
    for (let i = 1; i <= 5; i++) {
      const result = await shadow(page, async (c, i) => {
        window.rc24Now += 1000;
        const { inputRevision } = await import('/packages/core/src/session.js');
        const emit = (type, data) => c.receive({ seq: c.session.seq + 1, type, data, at: new Date().toISOString() });
        emit('turn.final', { id: `answer-${i}`, role: 'user', content: `Answer ${i}` });
        emit('lane.status', { inputRevision: inputRevision(c.session), running: ['reaction', 'understanding'], failures: [], lastFailure: null });
        emit('turn.final', { id: `reply-${i}`, role: 'assistant', content: 'Thank you', inputRevision: inputRevision(c.session) });
        emit('understanding.updated', { ...c.session.understanding, summary: `Overview ${i}`, progress: { talk: { value: i / 10 }, build: { value: i / 20 } }, inputRevision: inputRevision(c.session) });
        emit('lane.status', { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null });
        return { summary: c.shadowRoot.querySelector('.summary-text').textContent, readiness: c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'), current: c.shadowRoot.querySelector('.understanding').dataset.overview };
      }, i);
      assert.equal(result.summary, `Overview ${i}`); assert.match(result.readiness, new RegExp(`${i * 10}`)); assert.equal(result.current, 'current');
    }
    if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `rc24-overview-${locale}-${theme}-${width}.png`), fullPage: true }); }
  }
  assert.deepEqual(errors, []);
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'rc24-overview-rects.json'), JSON.stringify(rows, null, 2));
});

test('AIT-504 real handler/SSE: five typed answers repaint overview and readiness on one focused page', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-sequence-'));
  const fixture = await startChild(new URL('../fixtures/rc24-sequence.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  await page.evaluate(() => { window.rc24Now = 1_800_000_000_000; const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [window.rc24Now])); } static now() { return window.rc24Now; } }; });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await shadow(page, async (c, locale, theme) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = await (await fetch(`/sequence?locale=${locale}`)).json();
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ copy, session });
    }, locale, theme);
    await page.mouse.move(0, 0); await settle(page);
    let previous = await shadow(page, c => c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'));
    for (let answer = 1; answer <= 5; answer++) {
      await shadow(page, async (c, answer) => {
        window.rc24Now = (await (await fetch('/clock')).json()).now;
        const textarea = c.shadowRoot.querySelector('textarea'); textarea.value = `Our project needs workflow step ${answer}.`;
        textarea.dispatchEvent(new Event('input', { bubbles: true })); c.shadowRoot.querySelector('.send').click();
      }, answer);
      await until(page, answer => { const c = document.querySelector('aithema-session'); return c.shadowRoot.querySelector('.summary-text').textContent.includes(`workflow step ${answer}`) && c.shadowRoot.querySelector('.understanding').dataset.overview === 'current'; }, answer);
      const result = await shadow(page, c => ({ summary: c.shadowRoot.querySelector('.summary-text').textContent,
        readiness: c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'),
        revision: c.session.understanding.inputRevision, operations: c.session.operations }));
      assert.notEqual(result.readiness, previous, `readiness advances after answer ${answer}`); previous = result.readiness;
      assert.equal(result.revision, result.operations.inputRevision); assert.deepEqual(result.operations.running, []);
      records.push({ locale, theme, width, answer, ...result });
    }
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'rc24-five-answers.json'), JSON.stringify(records, null, 2)); }
});
