import { overviewFadeCheck, compactStatusCheck, overviewStatusLayoutBudgetCheck } from './overview-fade-check.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';
import { settle } from './clarify-now-helpers.js';

// AIT-524 / D524(a2): every visible status is inert; only its native action acts.
test('AIT-524 status-only hit testing, real padding and stationary rows: EN/DE light/dark 390/1024/1440', { timeout: 480_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-retry-box-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [], errors = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  const ax = await page.createCDPSession(), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  const measure = () => shadow(page, c => {
    const root = c.shadowRoot, row = root.querySelectorAll('.open-question')[1];
    const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const button = row.querySelector('button'), status = row.querySelector('.question-status');
    const stable = Object.fromEntries(['.question-text', '.question-state'].map(s => [s, box(row.querySelector(s))]));
    stable.row = box(row);
    for (const s of ['.composer-shell', '.composer-actions', '.understanding > .foot', '.toolbar']) stable[s] = box(root.querySelector(s));
    const visible = { button: box(button), label: box(row.querySelector('.clarify-label')) };
    if (!status.hidden) {
      Object.assign(visible, { status: box(status), glyph: box(status.querySelector('svg')), separator: box(row.querySelector('.question-separator')) });
      const why = status.querySelector('.question-why'); visible.text = box(why);
    }
    const range=root.ownerDocument.createRange(); range.selectNodeContents(row.querySelector('.question-separator'));
    const dot=box({getBoundingClientRect:()=>range.getBoundingClientRect()});
    return { stable, visible, dot, state: row.dataset.state, disabled: button.getAttribute('aria-disabled'), busy: button.getAttribute('aria-busy'),
      paused: c.session.paused, dialogOpen: Boolean(root.querySelector('dialog[open]')), name: button.getAttribute('aria-label'), description: button.getAttribute('aria-describedby'), questionId: row.dataset.questionId,
      reservedHeight: row.querySelector('.question-status-reserve').getBoundingClientRect().height, statusHidden: status.hidden, sameNode: button === window.retry524Button, posts: window.retry524Posts,
      rowPaint: getComputedStyle(row).backgroundColor, paint: getComputedStyle(button).backgroundColor,
      pseudo: getComputedStyle(button, '::after').content,
      cursor: [status, row.querySelector('.question-separator')].map(n => getComputedStyle(n).cursor),
      neighbours: [0, 2].map(i => {
        const n = root.querySelectorAll('.open-question')[i], action = n.querySelector('button'), b = box(action), p = getComputedStyle(action, '::after');
        return { row: box(n), text: box(n.querySelector('.question-text')), action: { ...b, y: b.y + (parseFloat(p.top) || 0), bottom: b.bottom - (parseFloat(p.bottom) || 0) } };
      }) };
  });
  const positive = (group, context) => { for (const [name, b] of Object.entries(group)) assert.ok(b.width > 0 && b.height > 0, `${context}/${name}: positive measured box`); };
  const stationary = (a, b, context) => { positive(a, context); positive(b, context); assert.deepEqual(b, a, `${context}: exact 0 px movement`); };
  const overlap = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  const centre = b => [b.x + b.width / 2, b.y + b.height / 2];
  const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, 'shots', `${name}.png`), fullPage: false, captureBeyondViewport: false }); };
  for (const failure of ['refused-paused', 'refused-consent', 'retry', 'focus-retry']) await t.test(failure, async () => {
  try {
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const context = `${locale}-${theme}-${width}-${failure}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await shadow(page, async (c, locale, theme, failure) => {
      const { createSession, inputRevision } = await import('/packages/core/src/session.js');
      const { [locale]: defaults } = await import(`/packages/ui/src/i18n/${locale}.js`);
      // Root host overrides must win over the nested defaults, even when truncated.
      const failed = locale === 'de' ? 'Die Frage konnte gerade nicht gestellt werden; bitte versuchen Sie es später erneut.' : 'The question could not be asked just now; please try again when the service is available.';
      const copy = { ...defaults, clarifyFailed: failed, clarifyFailedShort: defaults.clarify.failedShort };
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      session.transcript = [{ id: 'u', role: 'user', content: 'Invoice approvals' }, { id: 'a', role: 'assistant', content: 'Which system?', inputRevision: inputRevision(session) }];
      Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false, summary: 'Invoice approvals',
        openQuestions: locale === 'de' ? ['Welches System ist im Einsatz?', 'Wer gibt Rechnungen frei?', 'Kommen Rechnungen als PDF?'] : ['Which system is in use?', 'Who approves invoices?', 'Do invoices arrive as PDF?'] });
      session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
      window.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
        if (init.method === 'POST') { window.retry524Posts.push({ url: String(url), body: JSON.parse(init.body ?? '{}') }); return window.retry524Post(); }
        return Response.json(c.session);
      };
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      window.retry524ExpectedName = `${failed}\u00a0· ${defaults.clarify.retry}`;
      window.retry524Reset = async () => {
        for (const dialog of c.shadowRoot.querySelectorAll('dialog[open]')) dialog.close();
        c.configure({ session, copy });
        const item = c.openQuestionItems[1], revision = inputRevision(c.session);
        window.retry524Posts = [];
        if (failure === 'retry') {
          window.retry524Post = () => Response.json({ event: { seq: c.session.seq + 1, type: 'question.focused', data: { ...item, questionId: item.id, requestId: 'retry524', chosenBy: 'user', inputRevision: revision } } }, { status: 202 });
          await c.focusQuestion(item.id);
          c.receive({ type: 'lane.failed', data: { lane: 'reaction', retryable: true, inputRevision: revision } });
        } else if (failure.startsWith('refused-')) {
          if (failure === 'refused-paused') c.receive({ type: 'session.paused', data: { paused: true } });
          window.retry524Post = () => Response.json({ reason: failure === 'refused-paused' ? 'paused' : 'consent-required' }, { status: 409 });
          await c.focusQuestion(item.id).catch(() => {});
        } else {
          const original = window.setTimeout;
          window.setTimeout = (fn, delay, ...args) => delay === 60_000 ? (window.retry524Expire = fn, 0) : original.call(window, fn, delay, ...args);
          try {
            window.retry524Post = () => { c.receive({ type: 'lane.status', data: { inputRevision: revision, running: ['reaction'], failures: [] } }); return Response.json({ reason: 'reply-in-flight' }, { status: 409 }); };
            await c.focusQuestion(item.id).catch(() => {}); window.retry524Expire();
            c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], failures: [] } });
          } finally { window.setTimeout = original; }
        }
        window.retry524Posts = [];
        window.retry524Post = () => new Promise(resolve => { window.retry524Release = resolve; });
        const row = c.shadowRoot.querySelectorAll('.open-question')[1];
        window.retry524Button = row.querySelector('button'); window.retry524Button.blur();
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
      };
      await window.retry524Reset();
    }, locale, theme, failure);
    await page.mouse.move(0, 0); await settle(page);
    const rest = await measure(); positive(rest.stable, context); positive(rest.visible, context);
    // AIT-540 M5: the dot bisects the status-to-label gap, not its 9px column.
    const gapCentre = (rest.visible.status.right + rest.visible.label.x) / 2;
    positive({dot:rest.dot},context);
    const dotCentre = rest.dot.x + rest.dot.width / 2;
    assert.ok(Math.abs(gapCentre - dotCentre) <= .5, `${context}: AIT-540 centred separator (${dotCentre} vs ${gapCentre})`);
    const expectedState = failure.startsWith('refused-') ? 'refused' : failure;
    assert.equal(rest.state, expectedState); assert.equal(rest.sameNode, true);
    // Start with the actual bug: native pointer hit testing on failure copy.
    for (const part of ['glyph', 'text', 'separator']) {
      await page.mouse.move(...centre(rest.visible[part])); await settle(page);
      const hover = await measure();
      await page.mouse.click(...centre(rest.visible[part])); await settle(page);
      const clicked = await measure(); assert.equal(clicked.posts.length, 0, `${context}/${part}: real click sends no request`); assert.equal(clicked.state, expectedState);
      assert.equal(clicked.paused, rest.paused, `${context}/${part}: pause state untouched`);
      assert.equal(clicked.dialogOpen, false, `${context}/${part}: no consent request opened`);
      assert.equal(hover.rowPaint, 'rgba(0, 0, 0, 0)', `${context}/${part}: no persistent row tint`);
      assert.equal(hover.paint, 'rgba(0, 0, 0, 0)', `${context}/${part}: inert hover does not tint Retry`);
      stationary(rest.stable, clicked.stable, context); stationary(rest.visible, clicked.visible, context);
    }
    assert.deepEqual(rest.cursor, ['default', 'default']);
    const b = rest.visible.button, line = rest.stable['.question-state'];
    assert.ok(b.width >= 44 && b.height >= 44, `${context}: native button box >= 44 x 44`);
    assert.equal(rest.pseudo, 'none', 'Retry has no pseudo-element target extension');
    assert.equal(line.height, Math.max(36, rest.reservedHeight), 'line exactly fits its permanent failure reserve'); assert.equal(b.y, line.y - 4); assert.equal(b.bottom, line.bottom + 4);
    assert.ok(b.x >= rest.visible.separator.right, 'inline padding stays inside column 3');
    assert.equal(overlap(b, rest.visible.status), false, 'button never overlaps status');
    for (const neighbour of rest.neighbours) {
      positive(neighbour, context);
      for (const part of ['text', 'action']) assert.equal(overlap(b, neighbour[part]), false, `${context}: padded target covers no neighbour ${part}`);
    }
    const blank = [b.right + (rest.stable.row.right - b.right) / 2, b.y + b.height / 2];
    assert.ok(blank[0] > b.right && blank[0] < rest.stable.row.right, 'positive blank space right of Retry');
    await page.mouse.move(...blank); await settle(page);
    assert.equal((await measure()).paint, 'rgba(0, 0, 0, 0)', 'blank space has no hover tint');
    await page.mouse.click(...blank); assert.equal((await measure()).posts.length, 0);
    for (const [index, neighbour] of rest.neighbours.entries()) {
      const point = [b.x + b.width / 2, index === 0 ? neighbour.row.bottom - 3 : neighbour.row.y + 3];
      const hit = await shadow(page, (c, point) => { const n = c.shadowRoot.elementFromPoint(...point); return n?.closest('button') === window.retry524Button; }, point);
      assert.equal(hit, false, '3 px inside neighbouring row does not land on Retry');
      await page.mouse.click(...point); await settle(page);
      const posts = (await measure()).posts;
      assert.equal(posts.some(p => p.url.endsWith('/retry') || p.body.questionId === rest.questionId), false, 'neighbour click never retries this question');
      await page.evaluate(() => window.retry524Reset()); await settle(page);
    }
    await page.mouse.move(...centre(b)); await settle(page);
    const hovered = await measure(); stationary(rest.stable, hovered.stable, context); stationary(rest.visible, hovered.visible, context);
    assert.notEqual(hovered.paint, 'rgba(0, 0, 0, 0)', 'Retry itself gets hover paint');
    assert.equal(hovered.rowPaint, 'rgba(0, 0, 0, 0)');
    if (width !== 1024) await shot(`${context}-hover`);
    await page.mouse.move(0, 0); await shadow(page, () => window.retry524Button.focus({ preventScroll: true })); await settle(page);
    const focused = await measure(); stationary(rest.stable, focused.stable, context); stationary(rest.visible, focused.visible, context);
    const tree = await ax.send('Accessibility.getFullAXTree');
    if (!failure.startsWith('refused-')) {
      assert.equal(focused.name, await page.evaluate(() => window.retry524ExpectedName));
      assert.ok(tree.nodes.some(n => n.role?.value === 'button' && n.name?.value === focused.name), 'Retry has the full failure plus Retry accessible name');
    }
    assert.ok(focused.description); assert.equal(focused.sameNode, true);
    if (width !== 1024) await shot(`${context}-focus`);
    if (failure.startsWith('refused-')) {
      for (const activation of ['centre', 'Enter', 'Space']) {
        await page.evaluate(() => window.retry524Reset()); await settle(page);
        if (activation === 'centre') await page.mouse.click(...centre(b));
        else { await shadow(page, () => window.retry524Button.focus({ preventScroll: true })); await page.keyboard.press(activation); }
        await settle(page);
        const activated = await measure(); stationary(rest.stable, activated.stable, `${context}/${activation}`);
        if (failure === 'refused-paused') {
          assert.equal(activated.posts.length, 1); assert.ok(activated.posts[0].url.endsWith('/pause'));
          assert.equal(activated.posts[0].body.paused, false);
          await shadow(page, c => window.retry524Release(Response.json({ event: { seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } } })));
          await settle(page);
          const cleared = await measure(); stationary(rest.stable, cleared.stable, `${context}/cleared`);
          assert.equal(cleared.statusHidden, true); assert.equal(cleared.paused, false);
          if (activation === 'centre') records.push({ locale, theme, width, failure, rest, hovered, focused, activated, cleared });
        } else {
          assert.equal(activated.posts.length, 0); assert.equal(activated.dialogOpen, true, 'Review opens consent only when activated');
          if (activation === 'centre') records.push({ locale, theme, width, failure, rest, hovered, focused, activated });
        }
      }
      await page.evaluate(() => window.retry524Reset()); await page.mouse.move(0, 0); await settle(page);
      if (width !== 1024) await shot(`${context}-rest`);
      continue;
    }
    const points = { centre: centre(b), top: [b.x + b.width / 2, b.y + 1], bottom: [b.x + b.width / 2, b.bottom - 1], left: [b.x + 1, b.y + b.height / 2], right: [b.right - 1, b.y + b.height / 2] };
    for (const activation of [...Object.keys(points), 'Enter', 'Space']) {
      await page.evaluate(() => window.retry524Reset()); await page.mouse.move(0, 0); await settle(page);
      if (activation in points) await page.mouse.click(...points[activation]);
      else { await shadow(page, () => window.retry524Button.focus({ preventScroll: true })); await page.keyboard.press(activation); }
      await settle(page);
      const pending = await measure(); positive(pending.visible, context);
      assert.equal(pending.posts.length, 1, `${context}/${activation}: exactly one request`);
      assert.ok(pending.posts[0].url.endsWith(failure === 'retry' ? '/retry' : '/focus-question'));
      assert.equal(pending.disabled, 'true'); assert.equal(pending.busy, 'true'); assert.equal(pending.statusHidden, false, 'requesting keeps the status and column-3 target until cleared');
      assert.equal(pending.visible.button.x, b.x, 'requesting keeps column-3 start');
      assert.equal(pending.visible.button.y, b.y, 'requesting keeps padded target top');
      assert.equal(pending.visible.button.height, b.height, 'requesting keeps real padded target height');
      assert.equal(pending.visible.button.width, b.width, 'requesting never grows the target under the pointer');
      stationary({ status: rest.visible.status }, { status: pending.visible.status }, `${context}/pending status`); assert.equal(pending.sameNode, true);
      stationary(rest.stable, pending.stable, `${context}/pending`);
      // A second native activation while pending must be fenced.
      await page.mouse.click(...centre(pending.visible.button)); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      assert.equal((await measure()).posts.length, 1, 'pending duplicate activation fence');
      if (activation === 'centre' && width !== 1024) await shot(`${context}-pending`);
      await shadow(page, c => {
        const item = c.openQuestionItems[1];
        window.retry524Release(Response.json({ accepted: true, event: { seq: c.session.seq + 1, type: 'question.focused', data: { ...item, questionId: item.id, requestId: 'retry524-cleared', chosenBy: 'user', inputRevision: c.session.operations.inputRevision } } }, { status: 202 }));
      });
      await settle(page);
      const cleared = await measure(); stationary(rest.stable, cleared.stable, `${context}/cleared`); positive(cleared.visible, context);
      assert.equal(cleared.statusHidden, true); assert.equal(cleared.sameNode, true);
      if (activation === 'centre') { records.push({ head: evidenceCommit, locale, theme, width, failure, rest, hovered, focused, pending, cleared }); if (width !== 1024) await shot(`${context}-cleared`); }
    }
    await page.evaluate(() => window.retry524Reset()); await page.mouse.move(0, 0); await settle(page);
    if (width !== 1024) await shot(`${context}-rest`);
  }
  } catch (error) {
    if (evidence) {
      await writeFile(join(evidence, `ait524-${failure}-failure.txt`), error.stack);
      const diagnostic = await shadow(page, c => {
        const row = c.shadowRoot.querySelectorAll('.open-question')[1], button = row.querySelector('button'), b = button.getBoundingClientRect();
        const hits = Object.fromEntries(Object.entries({ centre: [b.x + b.width / 2, b.y + b.height / 2], top: [b.x + b.width / 2, b.y + 1], bottom: [b.x + b.width / 2, b.bottom - 1] }).map(([name, point]) => {
          const hit = c.shadowRoot.elementFromPoint(...point);
          return [name, { point, tag: hit?.tagName, class: hit?.className?.baseVal ?? hit?.className, row: hit?.closest('.open-question')?.dataset.questionId, ownButton: hit?.closest('button') === button }];
        }));
        return { hits, hovered: [...c.shadowRoot.querySelectorAll(':hover')].map(n => n.className?.baseVal ?? n.className), panes: [...c.shadowRoot.querySelectorAll('.analysis-content,.understanding,.transcript-shell')].map(n => ({ class: n.className, scrollTop: n.scrollTop, slackTop: n.style.getPropertyValue('--aithema-slack-top'), slackBottom: n.style.getPropertyValue('--aithema-slack-bottom') })), operations: c.session.operations };
      });
      await writeFile(join(evidence, `ait524-${failure}-diagnostic.json`), JSON.stringify({ measured: await measure(), diagnostic }, null, 2));
      await shot(`${failure}-failure`);
    }
    throw error;
  }
  });
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait524-rects.json'), JSON.stringify(records, null, 2));
});

test('AIT-547 pinned contact: opaque heading and first signal above the fade, stable status EN/DE',
  { timeout: 480_000 }, async t => { await overviewFadeCheck(t); await compactStatusCheck(t); });

test('AIT-547 status measurement: bounded layout work for the complete catalog',
  { timeout: 60_000 }, overviewStatusLayoutBudgetCheck);
test('AIT-547 status measurement: isolated full remeasurement with classic scrollbars',
  { timeout: 60_000 }, t => overviewStatusLayoutBudgetCheck(t, true));
