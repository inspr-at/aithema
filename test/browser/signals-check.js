// AIT-515: overview geometry shares the understanding-failure browser shard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';
import { manifest as voiceManifest } from '../../plugins/elevenlabs/src/manifest.js';
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

test('AIT-515 signals: newest five, expanded, assistant basis, deferred pointer/focus and stable frame EN/DE light/dark 390/1024/1440', { timeout: 480_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-signals-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [], rects = [], reachability = [], toggles = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', e => errors.push(e.message));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  const capture = async (name, { held = false } = {}) => {
    if (!evidence || page.viewport().width === 1024) return;
    await page.screenshot({ path: join(evidence, 'shots', `${name}.png`) });
    if (held || page.viewport().width > 600) return;
    // The primary view keeps the held row and basis visible. A second phone
    // view records the toggle above the dock, including on short phones.
    await shadow(page, c => {
      const root = c.shadowRoot;
      window.signalCaptureOrigins = [document.scrollingElement, ...root.querySelectorAll('*')]
        .filter(n => n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)
        .map(n => [n, n.scrollTop, n.scrollLeft]);
      const toggle = root.querySelector('.signals-toggle');
      toggle.scrollIntoView({ block: 'center', behavior: 'instant' });
      const box = toggle.getBoundingClientRect(), dock = root.querySelector('.composer-shell').getBoundingClientRect();
      if (box.bottom > dock.top - 12) window.scrollBy({ top: box.bottom - dock.top + 12, behavior: 'instant' });
    });
    try { await settle(page); await page.screenshot({ path: join(evidence, 'shots', `${name}-toggle.png`) }); }
    finally {
      await page.evaluate(() => { for (const [n, top, left] of window.signalCaptureOrigins) n.scrollTo({ top, left, behavior: 'instant' }); delete window.signalCaptureOrigins; });
      await settle(page);
    }
  };
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  await page.evaluate(() => {
    // One paused clock owns every signal deadline, including screenshot time.
    const NativeDate = Date, nativeClearTimeout = clearTimeout, nativeClearInterval = clearInterval;
    let time = 1_800_000_000_000, next = -1;
    const timers = new Map();
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [time])); }
      static now() { return time; }
    };
    const schedule = (fn, delay = 0, interval = false, args = []) => {
      const id = next--, ms = Math.max(0, Number(delay) || 0);
      timers.set(id, { fn, at: time + ms, interval: interval ? Math.max(1, ms) : 0, args }); return id;
    };
    window.setTimeout = (fn, ms, ...args) => schedule(fn, ms, false, args);
    window.setInterval = (fn, ms, ...args) => schedule(fn, ms, true, args);
    window.clearTimeout = window.clearInterval = id => {
      if (!timers.delete(id)) { nativeClearTimeout(id); nativeClearInterval(id); }
    };
    window.signalTick = ms => {
      const end = time + ms;
      for (;;) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, t] = entry; time = t.at; timers.delete(id);
        if (t.interval) timers.set(id, { ...t, at: time + t.interval });
        t.fn(...t.args);
      }
      time = end;
    };
  });
  await shadow(page, c => {
    window.fetch = async (url, init = {}) => String(url).endsWith('/events')
      ? new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }))
      : Response.json(c.session);
  });
  const frame = async () => {
    const result = await shadow(page, c => Object.fromEntries(['.band', '.audio-rail', '.understanding', '.understanding > .foot', '.composer-shell',
      c.shadowRoot.querySelector('.workspace').dataset.entrance === 'combined' ? '.composer-mic' : '.attach', '.send', '.voice-state'].map(selector => {
      const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
      return [selector, { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }];
    })));
    for (const [selector, r] of Object.entries(result)) assert.ok(r.width > 0 && r.height > 0, `${selector} positive box`);
    const aside = result['.understanding'], composer = result['.composer-shell'], attach = result['.attach'], mic = result['.composer-mic'], send = result['.send'];
    if (attach) assert.ok(attach.x + attach.width <= send.x + .5, 'Attach and Send never overlap');
    else assert.ok(mic.x + mic.width <= send.x + .5, 'Mic and Send never overlap');
    const separated = aside.x + aside.width <= composer.x + .5 || composer.x + composer.width <= aside.x + .5
      || aside.bottom <= composer.y + .5 || composer.bottom <= aside.y + .5;
    if (!separated && evidence && page.viewport().width > 600) {
      await writeFile(join(evidence, 'signals-overlap.json'), JSON.stringify({ viewport: page.viewport(), result }, null, 2));
      await page.screenshot({ path: join(evidence, 'shots', 'signals-overlap.png') });
    }
    if (page.viewport().width > 600) {
      assert.ok(separated, `sidebar and composer never overlap: ${JSON.stringify({ aside, composer })}`);
    } else {
      // The shared phone dock intentionally overlays the scrolling document.
      // R2: prove each control reachable above it, rather than card separation.
      const reachable = await shadow(page, c => {
        const root = c.shadowRoot, workspace = root.querySelector('.workspace');
        const origins = [document.scrollingElement, ...root.querySelectorAll('*')]
          .filter(n => n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)
          .map(n => [n, n.scrollTop, n.scrollLeft]);
        const controls = [...root.querySelectorAll('.understanding :is(button,a,input,textarea,select,[role="button"],[role="link"])')]
          .filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
        const checks = controls.map(n => {
          n.scrollIntoView({ block: 'center', behavior: 'instant' });
          const dock = root.querySelector('.composer-shell').getBoundingClientRect();
          const before = n.getBoundingClientRect();
          if (before.bottom > dock.top - 12) window.scrollBy({ top: before.bottom - dock.top + 12, behavior: 'instant' });
          const box = n.getBoundingClientRect(), hit = root.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { control: n.className, box: box.toJSON(), dock: dock.toJSON(), hit: hit === n || n.contains(hit) };
        });
        const inset = parseFloat(getComputedStyle(workspace).paddingBottom);
        for (const [n, top, left] of origins) n.scrollTo({ top, left, behavior: 'instant' });
        return { checks, inset };
      });
      assert.ok(reachable.checks.length > 0, 'phone overview has reachable controls');
      for (const { control, box, dock, hit } of reachable.checks) {
        assert.ok(box.width > 0 && box.height > 0, `${control} positive reachable box`);
        assert.ok(box.top >= 0 && box.bottom <= dock.top + .5, `${control} scrolls fully above the composer: ${JSON.stringify({ box, dock })}`);
        assert.equal(hit, true, `${control} receives the pointer above the composer`);
        assert.ok(reachable.inset >= dock.height, 'phone bottom inset reserves at least the composer height');
      }
      reachability.push({ viewport: page.viewport(), ...reachable });
      await settle(page);
    }
    return result;
  };
  const stable = (before, after, name) => {
    for (const selector of Object.keys(before)) for (const key of selector === '.composer-shell' ? ['bottom'] : ['x', 'y', 'width', 'height'])
      assert.ok(Math.abs(before[selector][key] - after[selector][key]) <= .5, `${name} ${selector}/${key} shifted`);
    rects.push({ name, before, after });
  };
  for (const entrance of ['separate', 'combined']) for (const locale of ['en', 'de'])
    for (const [width, height] of [[390, 844], [1024, 900], [1440, 900], [390, 620], [390, 568]]) for (const theme of ['light', 'dark']) {
    const name = `${entrance}-${locale}-${theme}-${width}x${height}`;
    const newest = locale === 'de' ? 'Sie ergänzen einen neuen Ablauf.' : 'You add a new workflow.';
    await page.setViewport({ width, height });
    await page.mouse.move(-1, -1);
    await shadow(page, async (c, locale, theme, manifest, entrance) => {
      const { createSession, inputRevision, reduceUnderstanding } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const s = createSession({ demo: true, locale });
      s.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true }, uploads: { available: true } } };
      s.transcript = [{ id: 'host:opener', role: 'assistant', origin: 'host', content: 'Welcome.' }, { id: 'person', role: 'user', content: 'We use orders.' }, { id: 'reply', role: 'assistant', content: 'Which orders?', inputRevision: inputRevision(s) }];
      s.operations = { inputRevision: inputRevision(s), running: [], failures: [], lastFailure: null };
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      c.configure({ session: s, copy, ...(entrance === 'combined' ? { entrance } : {}), voiceClient: { manifest, async start() { throw new Error('No provider calls'); } } });
      window.signalValues = Array.from({ length: 7 }, (_, i) => ({ text: locale === 'de' ? `Sie nutzen den Ablauf ${i + 1}.` : `You use workflow ${i + 1}.`, basis: i === 0 ? 'assistant' : i === 1 ? 'document' : 'visitor' }));
      window.signalFinal = values => {
        const s = c.session;
        c.receive({ seq: s.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(s.understanding,
          { signals: values, summary: locale === 'de' ? 'Sie möchten Abläufe vereinfachen.' : 'You want simpler workflows.', constraints: {}, progress: {}, openQuestions: [] },
          { transcript: s.transcript, inputRevision: inputRevision(s), locale }) });
      };
      window.signalFinal(window.signalValues);
    }, locale, theme, voiceManifest, entrance);
    await settle(page);
    await shadow(page, c => {
      const row = c.shadowRoot.querySelector('.signals li');
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (innerWidth <= 600) {
        const box = row.getBoundingClientRect(), dock = c.shadowRoot.querySelector('.composer-shell').getBoundingClientRect();
        if (box.bottom > dock.top - 24) window.scrollBy({ top: box.bottom - dock.top + 24, behavior: 'instant' });
      }
    });
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.signal-text').length), 5);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.signal-basis').length), 1);
    const toggleGeometry = () => shadow(page, c => {
      const root = c.shadowRoot, button = root.querySelector('.signals-toggle');
      const rect = button.getBoundingClientRect(), questions = root.querySelector('#open-questions-title').getBoundingClientRect();
      const style = getComputedStyle(button), content = root.querySelector('.analysis-content').getBoundingClientRect();
      return { box: rect.toJSON(), questions: questions.toJSON(), content: content.toJSON(),
        outline: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
        hit: root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.signals-toggle') === button };
    });
    const collapsedToggle = await toggleGeometry();
    const baseline = await frame();
    await capture(`${name}-collapsed`);
    await shadow(page, c => { c.shadowRoot.querySelector('.signals-toggle').focus({ preventScroll: true }); c.shadowRoot.querySelector('.signals-toggle').click(); });
    await settle(page); stable(baseline, await frame(), `${name}-expand`);
    const expandedToggle = await toggleGeometry();
    for (const [state, geometry] of [['collapsed', collapsedToggle], ['expanded', expandedToggle]]) {
      assert.ok(geometry.box.width > 0 && geometry.box.height > 0, `${name} ${state} toggle positive box`);
      assert.ok(geometry.questions.width > 0 && geometry.questions.height > 0, `${name} ${state} questions heading positive box`);
      assert.ok(geometry.questions.top >= geometry.box.bottom, `${name} questions heading stays below the toggle click target`);
    }
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(collapsedToggle.box[key] - expandedToggle.box[key]) <= .5,
      `${name} toggle/${key} stays fixed across expansion: ${JSON.stringify({ collapsedToggle, expandedToggle })}`);
    // The focus ring must fit inside the clipping pane. An inset ring also
    // works when a phone has scrolled the heading above the viewport.
    const ring = expandedToggle, outward = Math.max(0, ring.outline + ring.offset);
    assert.ok(ring.outline > 0, `${name} expanded toggle has a focus ring`);
    assert.ok(ring.box.left - outward >= ring.content.left - .5 && ring.box.right + outward <= ring.content.right + .5,
      `${name} Show less focus ring is not clipped horizontally`);
    toggles.push({ name, collapsed: collapsedToggle, expanded: expandedToggle });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.signal-text').length), 7);
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('.signals-toggle')), true);
    await capture(`${name}-expanded`);
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); c.shadowRoot.querySelector('.signals-toggle').click(); });
    await settle(page);
    const row = await shadow(page, c => { const r = c.shadowRoot.querySelector('.signals li').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    assert.ok(row.width > 0 && row.height > 0);
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    const before = await frame();
    await shadow(page, (_c, text) => window.signalFinal([...window.signalValues, { text, basis: 'visitor' }]), newest);
    await settle(page); stable(before, await frame(), `${name}-deferred`);
    const deferred = await shadow(page, c => ({ text: c.shadowRoot.querySelector('.signal-text').textContent, r: c.shadowRoot.querySelector('.signals li').getBoundingClientRect().toJSON() }));
    assert.equal(deferred.text, locale === 'de' ? 'Sie nutzen den Ablauf 1.' : 'You use workflow 1.');
    assert.ok(deferred.r.width > 0 && deferred.r.height > 0);
    assert.ok(Math.abs(deferred.r.y - row.y) <= .5);
    for (const key of ['x', 'width', 'height']) assert.ok(Math.abs(deferred.r[key] - row[key]) <= .5, `${name} pointer row/${key} shifted`);
    await capture(`${name}-deferred`, { held: true });
    await page.mouse.move(-1, -1); await settle(page);
    stable(before, await frame(), `${name}-apply`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.signal-text').textContent), newest);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.signals-toggle').textContent), locale === 'de' ? 'Alle anzeigen (8)' : 'Show all (8)');
    const mark = await shadow(page, c => { const n = c.shadowRoot.querySelector('[data-signal-new]'); return n && { animation: getComputedStyle(n).animationName, background: getComputedStyle(n).backgroundColor, shadow: getComputedStyle(n).boxShadow }; });
    assert.ok(mark); assert.equal(mark.shadow, 'none', 'arrival tint has no edge stripe'); assert.equal(mark.animation, 'none', 'reduced motion uses a static mark');
    await capture(`${name}-new-static`);
    await page.evaluate(() => window.signalTick(1999));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('[data-signal-new]').length), 1);
    await page.evaluate(() => window.signalTick(1));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('[data-signal-new]').length), 0);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'signals-rects.json'), JSON.stringify({ rects, reachability, toggles, errors }, null, 2));
});
