// Evidence-only entrypoint. Run via remote-browser.sh WORKTREE browser scripts/ait-278-capture.mjs.
// Deliberately outside test/browser/*.test.js: no CI/shard/product changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserForFile } from '../test/browser/shared-browser.js';
import { startChild } from '../test/helpers.js';
import { shadow, until, boxes, captureEvidence, settleEvidenceFrame, evidenceBrowserArgs } from '../test/browser/start2-display-helpers.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { en } from '../packages/ui/src/i18n/en.js';

const mainHead = 'e9ab64d92474d1b984778ea05b6e19ef557f891a';
const out = process.env.AITHEMA_EVIDENCE_DIR;
assert.ok(out && /\/aithema-runs\//u.test(process.cwd()), 'Remote evidence runner required');

async function gaugeTable() {
  // Use TypeScript only as a source parser, preserving exact source line locations.
  const ts = (await import('typescript')).default;
  const locations = {};
  for (const locale of ['de', 'en']) {
    const file = `packages/ui/src/i18n/${locale}.js`, source = await readFile(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node, path = []) => {
      if (ts.isPropertyAssignment(node)) {
        const key = node.name.text, next = [...path, key];
        if (ts.isObjectLiteralExpression(node.initializer)) for (const property of node.initializer.properties) visit(property, next);
        else if (next[0] === 'gauges') locations[`${locale}:${next.join('.')}`] = `${file}:${ast.getLineAndCharacterOfPosition(node.name.getStart(ast)).line + 1}`;
        return;
      }
      ts.forEachChild(node, child => visit(child, path));
    };
    visit(ast);
  }
  const rows = [], escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const walk = (value, english, path) => {
    for (const [key, text] of Object.entries(value)) {
      const p = `${path}.${key}`;
      if (typeof text === 'object') walk(text, english[key], p);
      else { assert.ok(locations[`de:${p}`] && locations[`en:${p}`], p); rows.push(`| ${p} | ${escape(text)} | ${escape(english[key])} | ${locations[`de:${p}`]}; ${locations[`en:${p}`]} |`); }
    }
  };
  walk(de.gauges, en.gauges, 'gauges');
  await writeFile(join(out, 'gauge-keys.md'), `# Gauge copy on main ${mainHead}\n\nAll ${rows.length} leaf keys under \`gauges\`; placeholders are preserved. Wording remains Tick's decision.\n\n| i18n key | DE text | EN text | file:line |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  return rows.length;
}

test('AIT-278 consolidated release evidence (remote only, no providers)', { timeout: 600_000 }, async t => {
  await mkdir(out, { recursive: true });
  const report = { mainHead, captureHead: /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1], startedAt: new Date().toISOString(),
    runner: 'mbp2606', capture: 'viewport', reducedMotion: true, fonts: 'Chrome baseline UI/display stacks pinned', blurredControls: true,
    fixtureSources: ['start2-display.test.js (265/267/270)', 'host-surface.test.js (261)', 'packages/ui/test/settings.test.js (262/271)', 'host-chrome-check.js', 'host-polish-check.js', 'clarify-now.test.js', 'html-preview.test.js (282)', 'footer-width-sweep.test.js (281)'],
    shots: [], items: [], unreachable: [
      { item: 'Integration-a', state: '390 footer role', reason: 'Main hides .actor-role below 600px (packages/ui/src/actor-role-styles.js:76); noch offen is captured at 1440.' },
      { item: 'Integration-a', state: '390 large concept backdrop', reason: 'Main hides the large backdrop on phones (packages/ui/src/styles.js:283); the ready composer thumbnail is captured instead.' },
    ], errors: [] };
  const save = () => writeFile(join(out, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
  report.gaugeKeyCount = await gaugeTable(); await save();
  const directory = await mkdtemp(join(tmpdir(), 'aithema-278-'));
  const demo = await startChild(new URL('../test/fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: mainHead,
  });
  const browser = await browserForFile({ args: evidenceBrowserArgs }), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  page.setDefaultTimeout(12_000);
  const externalRequests = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== demo.url) { externalRequests.push(url.origin); return request.abort(); }
    return request.continue();
  });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, async c => {
    window.qaSeed = structuredClone(c.session);
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f4f2ec'; ctx.fillRect(0, 0, 1600, 900);
    ctx.fillStyle = '#d6e8e5'; ctx.fillRect(0, 0, 250, 900);
    for (let i = 0; i < 8; i++) { ctx.fillStyle = '#91aaa9'; ctx.fillRect(35, 80 + i * 85, 160, 18); }
    for (let i = 0; i < 4; i++) { ctx.fillStyle = '#fff'; ctx.fillRect(285 + i * 322, 120, 290, 150); ctx.fillStyle = '#1d3c54'; ctx.fillRect(310 + i * 322, 165, 140, 24); }
    ctx.fillStyle = '#fff'; ctx.fillRect(285, 310, 820, 520); ctx.fillRect(1130, 310, 430, 520);
    for (let i = 0; i < 11; i++) { ctx.fillStyle = '#14918c'; ctx.fillRect(315 + i * 69, 740 - (i % 4) * 65, 42, 90 + (i % 4) * 65); }
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const native = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path.endsWith('/image')) return new Response(image, { headers: { 'content-type': 'image/png' } });
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        if (init.signal?.aborted) controller.close(); else init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (path.endsWith('/features')) return Response.json(c.session.featureMatrix);
      if (path.endsWith('/identity')) return Response.json({ identity: null, roleChoice: c.session.roleChoice });
      if (path.endsWith('/settings') && (init.method ?? 'GET') === 'GET') {
        const catalog = await (await native(url, init)).json();
        const gate = window.qaCatalogGate; if (gate) await gate;
        const facts = { vendor: 'Mock reasoning', plugin: 'mock', model: 'default', qualification: 'unverified', processingLocations: ['unverified'],
          streaming: true, structured: true, germanQuality: 'unverified', efforts: ['none'], operations: ['stream', 'structured'], formats: ['text'],
          free: false, cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null },
          hostQualified: true, hostPriceReviewed: true, hostCountries: ['US'], hostTraining: true };
        Object.assign(catalog, { processingPreset: 'best', settings: c.session.settings, engine: c.session.engine });
        Object.assign(catalog.presets.best, { offered: true, status: 'available', reason: null, defaults: { model: 'default', effort: 'none', voice: 'off', visuals: 'off' },
          models: [{ id: 'default', label: 'Anthropic via OpenRouter', configured: true, efforts: ['none'], effort: 'none', facts, status: 'available', reason: null }], voices: [], visuals: [] });
        catalog.presets.eu = { offered: true, status: 'unavailable', reason: 'recipient seat outside eu' };
        return Response.json(catalog);
      }
      if (path.endsWith('/turns') && init.method === 'POST') return Response.json({}, { status: 503 });
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      return native(url, init);
    };
  });
  const cdp = await page.createCDPSession();
  let context;
  const scene = async ({ locale = 'de', theme = 'light', width = 1440, live = false, voice = false, concept = false, consent = false, known = false, loading = false } = {}) => {
    context = { locale, theme, width, height: width === 390 ? 844 : 1000 };
    await page.setViewport({ width, height: context.height });
    await page.select('#theme', theme);
    await shadow(page, async (c, options) => {
      const { locale, theme, live, voice, concept, consent, known, loading } = options;
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { inputRevision } = await import('/packages/core/src/session.js');
      const s = structuredClone(window.qaSeed);
      s.locale = locale; s.paused = false; s.pauseReason = null; s.credits = null; s.processingPreset = 'best';
      s.settings = { ...s.settings, origin: 'chosen', model: 'default', effort: 'none', voice: 'off', visuals: concept ? 'auto' : 'off' };
      s.engine = { preset: 'best', model: { id: 'default', label: 'Anthropic via OpenRouter', reply: known ? 'anthropic/claude-haiku-5.5' : 'host/private-reply', understanding: known ? 'anthropic/claude-opus-5.5' : 'host/private-understanding' }, effort: 'none', voice: 'off', visuals: 'off' };
      s.transcript = live ? [{ id: 'source', role: 'user', content: locale === 'de' ? 'Wir gleichen rund 400 Rechnungen im Monat von Hand ab.' : 'We reconcile about 400 invoices a month by hand.' },
        { id: 'reply', role: 'assistant', content: locale === 'de' ? 'Wer gleicht die Rechnungen heute ab?' : 'Who reconciles the invoices today?' }] : [];
      s.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true }])), eu: { text: { available: false, reason: 'recipient seat outside eu' } } };
      if (consent) s.featureMatrix.best.text = { available: false, reason: 'current processing consent required' };
      s.visualsBound = concept; s.conceptVisualKind = concept ? 'image' : undefined; s.conceptCost = { maxMicro: 30000 };
      s.concepts = []; s.conceptStatus = { phase: 'idle' };
      for (const turn of s.transcript) if (turn.role === 'assistant') turn.inputRevision = inputRevision(s);
      s.operations = { inputRevision: inputRevision(s), running: [], failures: [], lastFailure: null };
      if (live) Object.assign(s.understanding, { readinessAssessed: true, draft: false, inputRevision: inputRevision(s),
        summary: locale === 'de' ? 'Drei Personen gleichen rund 400 Rechnungen im Monat von Hand ab; die Freigabe dauert oft eine Woche.' : 'Three people reconcile about 400 invoices a month by hand; approval often takes a week.',
        signals: locale === 'de' ? ['Rund 400 Eingangsrechnungen pro Monat'] : ['About 400 incoming invoices per month'],
        openQuestions: locale === 'de' ? ['Welches Buchhaltungssystem ist im Einsatz?', 'Wer gibt Rechnungen frei, und ab welchem Betrag?', 'Kommen die Rechnungen als PDF oder auf Papier?'] : ['Which accounting system is in use?', 'Who approves invoices, and above what amount?', 'Do invoices arrive as PDF or on paper?'] });
      s.actor = null; s.roleChoice = { available: true, role: null, source: 'inferred', reasoning: null, revision: s.seq };
      const labels = { de: { private: 'Privat', company: 'Unternehmen', representative: 'Vertretung', agency: 'Agentur' }, en: { private: 'Private', company: 'Company', representative: 'Representative', agency: 'Agency' } };
      c.querySelectorAll('[slot="legal"], [slot="footer"], [slot="brand"]').forEach(n => n.remove());
      const brand = document.createElement('h1'); brand.slot = 'brand'; brand.textContent = 'START'; c.append(brand);
      const legal = document.createElement('nav'); legal.slot = 'legal'; legal.style.cssText = 'display:flex;gap:0';
      for (const [href, text] of [['/imprint', locale === 'de' ? 'Impressum' : 'Imprint'], ['/privacy', locale === 'de' ? 'Datenschutz' : 'Privacy']]) {
        const a = document.createElement('a'); a.href = href; a.textContent = text;
        if (href === '/privacy') a.setAttribute('data-aithema-privacy', '');
        a.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:inherit;text-decoration:underline;text-underline-offset:3px'; legal.append(a);
      }
      c.append(legal);
      window.qaCatalogGate = loading ? new Promise(resolve => { window.qaReleaseCatalog = resolve; }) : null;
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ copy, session: s, voiceClient: voice ? {} : undefined, host: { library: true, credits: false, actorRole: { labels } } });
      if (concept) c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: {
        id: 'qa-concept', mediaType: 'image/png', width: 1600, height: 900, turnIds: ['source'], referenceIds: [], archived: false, feedback: { vote: 'clear', chips: [] },
        provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } },
      } } });
      document.documentElement.lang = locale; scrollTo(0, 0);
    }, { locale, theme, live, voice, concept, consent, known, loading });
    await settleEvidenceFrame(page);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    if (concept) await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-backdrop img[data-on], .concept-preview img[data-on]')?.complete);
  };
  const shot = async (item, state, { hover, target } = {}) => {
    if (target) await shadow(page, (c, target) => c.shadowRoot.querySelector(target).scrollIntoView({ block: 'center', behavior: 'instant' }), target);
    const frame = await settleEvidenceFrame(page);
    if (hover) {
      await page.hover(`aithema-session >>> ${hover}`);
      await shadow(page, async c => { await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    }
    const file = `${item}-${state}-${context.locale}-${context.theme}-${context.width}.png`;
    const captureAt = new Date().toISOString();
    const png = await page.screenshot({ fullPage: false, captureBeyondViewport: false });
    await writeFile(join(out, file), png);
    const diagnostics = await shadow(page, c => ({ horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      activeControl: c.shadowRoot.activeElement?.tagName ?? null, theme: getComputedStyle(c).colorScheme,
      pageScrollY: scrollY, runningAnimations: c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length }));
    assert.equal(diagnostics.horizontalOverflowPx, 0, file); assert.equal(diagnostics.activeControl, null, file); assert.equal(diagnostics.theme, context.theme, file);
    report.shots.push({ file, item, state, ...context, captureAt, mainHead, sha256: createHash('sha256').update(png).digest('hex'), frame, ...diagnostics, hover: hover ?? null });
    await save(); console.log(`CAPTURE ${file}`);
  };
  const item = async (name, fn) => {
    const before = report.shots.length;
    try { const pass = await fn(); report.items.push({ item: name, status: 'pass', pass, shots: report.shots.length - before }); }
    catch (error) { report.items.push({ item: name, status: 'failed', error: error.stack, shots: report.shots.length - before }); console.error(`${name}: ${error.stack}`); }
    await save();
  };
  const matrix = [{ locale: 'de', theme: 'light', width: 1440 }, { locale: 'de', theme: 'dark', width: 1440 }, { locale: 'de', theme: 'light', width: 390 }, { locale: 'de', theme: 'dark', width: 390 }];
  await item('AIT-265/267', async () => {
    for (const cfg of [...matrix, { locale: 'en', theme: 'light', width: 1440 }]) {
      const copy = { de, en }[cfg.locale];
      await scene({ ...cfg, loading: true });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('[data-ready="model"] dd > span:last-child').textContent), copy.catalogLabels['Anthropic via OpenRouter']);
      await shot('ait265-267', 'ready', { target: '.ready' });
      for (const known of [false, true]) {
        if (known) await scene({ ...cfg, known, loading: true });
        const before = await boxes(page, ['.display-foot', '.engine-info']);
        await shot('ait265-267', known ? 'footer-known' : 'footer-unknown', { hover: '.engine-info' });
        assert.deepEqual(await boxes(page, ['.display-foot', '.engine-info']), before);
        const text = await shadow(page, c => c.shadowRoot.querySelector('.engine__detail').textContent);
        assert.ok(text.includes(known ? 'Claude Haiku 5.5' : copy.display.modelUnknown), text);
        assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility), 'visible');
      }
      await page.mouse.move(-1, -1); await shadow(page, c => c.openSettings());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('[data-select="model"] .select__value').textContent), copy.settings.loadingOption);
      await shot('ait265-267', 'settings-loading', { target: '[data-select="model"]' });
      const controls = ['.settings__frame', '[data-select="model"] .select__button', '.effort-area', '.settings-context', '.done'];
      const before = await boxes(page, controls);
      await page.evaluate(() => window.qaReleaseCatalog());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-select="model"] .select__button').disabled === false);
      await settleEvidenceFrame(page); assert.deepEqual(await boxes(page, controls), before, 'catalog arrival: 0 px');
      await page.click('aithema-session >>> [data-select="model"] .select__button');
      await shot('ait265-267', 'settings-loaded');
    }
    return 'PASS: curated ready/select labels; loading and loaded; known/unknown served model hover; catalog and footer shift 0 px; DE 1440/390 light/dark and EN 1440 light.';
  });
  await item('AIT-261', async () => {
    for (const cfg of matrix) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
      await scene({ ...cfg, live: true, voice: true });
      await shadow(page, (c, reason) => {
        for (const [type, data] of [['credits.limit-reached', { reason }], ['conversation.end-requested', { reason, preserveTranscript: true, settleOutstanding: true }], ['credits.state', { status: 'ending', endReason: reason, remainingMs: 0 }]]) c.receive({ seq: c.session.seq + 1, type, data });
      }, reason);
      const state = await shadow(page, c => { const r = c.shadowRoot, link = r.querySelector('.composer-out__export'); return { inert: r.querySelector('form.composer').inert, voiceDisabled: r.querySelector('.voice-start').disabled, exportVisible: link.checkVisibility(), href: link.href }; });
      assert.ok(state.inert && state.voiceDisabled && state.exportVisible);
      assert.equal(await page.evaluate(async href => (await fetch(href)).status, state.href), 200);
      await shot('ait261', reason, { target: '.composer-out__export' });
    }
    return 'PASS: all four shutdown reasons disable text/voice; transcript retained and visible export returns HTTP 200; DE 1440/390 light/dark.';
  });
  const settings = async cfg => {
    await scene(cfg); await shadow(page, c => c.openSettings());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-gauge="quality"]').dataset.state === 'hostQualified');
  };
  await item('AIT-262', async () => {
    for (const cfg of matrix) {
      await settings(cfg);
      const text = await shadow(page, c => ['quality', 'cost'].map(kind => { const n = c.shadowRoot.querySelector(`[data-gauge="${kind}"]`); return [n.querySelector('.gauge__value').textContent, n.querySelector('.gauge__detail').textContent]; }));
      assert.deepEqual(text, [['Qualifiziert', 'Vom Host geprüft'], ['Geprüft', 'Betreiberpreis']]);
      await shot('ait262', 'gauges', { target: '.gauges' });
      for (const kind of ['quality', 'cost']) {
        await page.hover(`aithema-session >>> [data-gauge="${kind}"]`);
        assert.ok((await shadow(page, c => c.shadowRoot.querySelector('.context-message').textContent)).endsWith(de.gauges.details[kind][kind === 'quality' ? 'hostQualified' : 'hostPriceReviewed']));
        await shot('ait262', `${kind}-detail`, { target: '.settings-context', hover: `[data-gauge="${kind}"]` });
      }
    }
    return `PASS: all four provisional values/captions and both full detail lines; ${report.gaugeKeyCount} gauge keys with DE/EN and exact source lines in gauge-keys.md.`;
  });
  await item('AIT-270', async () => {
    for (const cfg of [...matrix, ...matrix.map(cfg => ({ ...cfg, locale: 'en' }))]) {
      await settings(cfg);
      await page.focus('aithema-session >>> [data-gauge="privacy"]');
      const caption = await shadow(page, c => c.shadowRoot.querySelector('[data-gauge="privacy"] .gauge__detail').textContent);
      assert.equal(caption, cfg.locale === 'de' ? 'Anbieter mit Sitz in USA' : 'Providers based in the US');
      await shot('ait270', 'legal-countries-US', { target: '.settings-context' });
    }
    return 'PASS: hostCountries [US] renders the host legal-country wording in DE/EN at 1440/390 light/dark.';
  });
  await item('AIT-271', async () => {
    for (const cfg of matrix) {
      await settings(cfg);
      await page.click('aithema-session >>> .preset-option[data-preset="eu"]');
      assert.equal(await shadow(page, c => c.session.processingPreset), 'best');
      assert.match(await shadow(page, c => c.shadowRoot.querySelector('.context-message').textContent), /Empfängersitz außerhalb der EU/u);
      await shot('ait271', 'eu-refusal', { target: '.settings-context' });
    }
    return 'PASS: EU recipient-seat refusal displayed; selection remains best; DE 1440/390 light/dark.';
  });
  await item('Integration-a-b', async () => {
    for (const cfg of matrix) {
      await scene({ ...cfg, live: true, concept: true });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.clarify-action').length), 3);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.actor-trigger .actor-value').textContent), 'noch offen');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-access').dataset.state), 'ready');
      assert.equal(await shadow(page, c => c.querySelectorAll('[slot="legal"] a').length), 2);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.understanding').dataset.overview), 'current');
      await shot('integration-a', 'overview-concept-ready');
      if (cfg.width === 390) {
        await shadow(page, c => {
          const r = c.shadowRoot, aside = r.querySelector('.understanding'), pane = r.querySelector('.analysis-content'), questions = r.querySelector('.open-questions');
          aside.scrollIntoView({ block: 'start', behavior: 'instant' });
          scrollBy({ top: aside.getBoundingClientRect().top - r.querySelector('.band').getBoundingClientRect().bottom - 12, behavior: 'instant' });
          pane.scrollTop += questions.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
        });
        await shot('integration-a', 'overview-three-items');
        const visible = await shadow(page, c => {
          const r = c.shadowRoot, pane = r.querySelector('.analysis-content').getBoundingClientRect();
          return [...r.querySelectorAll('.clarify-action')].filter(n => { const b = n.getBoundingClientRect(); return b.top >= pane.top && b.bottom <= Math.min(pane.bottom, innerHeight); }).length;
        });
        assert.equal(visible, 3, 'all three phone clarify actions visible after scrolling overview');
      }
      await shadow(page, c => { const input = c.shadowRoot.querySelector('textarea'); input.value = 'Bitte helfen Sie uns bei der Freigabe.'; c.shadowRoot.querySelector('form').requestSubmit(); });
      await until(page, expected => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent === expected, de.failed);
      const { result: component } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("aithema-session")' });
      const { privateProperties } = await cdp.send('Runtime.getProperties', { objectId: component.objectId });
      await cdp.send('Runtime.callFunctionOn', { objectId: privateProperties.find(p => p.name === '#retryFiles').value.objectId,
        functionDeclaration: 'function() { this.push(new File(["x"], "retained.txt")); }' });
      await cdp.send('Runtime.releaseObject', { objectId: component.objectId });
      await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
      assert.ok(await shadow(page, c => c.shadowRoot.querySelector('.upload-retry') && c.shadowRoot.querySelector('.upload-discard')));
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await shot('integration-b', 'send-failure-retained-upload');
    }
    return 'PASS: one conversation combines 3 Jetzt klären actions, current overview, ready concept, noch offen desktop role, connected/legal; phone overview scrolled to expose all 3 actions; send failure keeps retained upload retry/discard.';
  });
  await item('Integration-c', async () => {
    for (const theme of ['light', 'dark']) {
      await scene({ locale: 'de', width: 390, theme, live: true, consent: true });
      assert.ok(await shadow(page, c => c.shadowRoot.querySelector('.composer-reason .consent-action')));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.send').disabled), true);
      await shot('integration-c', 'phone-consent-required', { target: '.composer' });
    }
    return 'PASS: phone consent action visible and Send disabled at 390 light/dark.';
  });
  await item('Integration-d', async () => {
    for (const theme of ['light', 'dark']) for (const width of [1440, 700]) {
      await scene({ width, theme, live: true, voice: true });
      const fit = await shadow(page, c => { const r = c.shadowRoot, rail = r.querySelector('.audio-rail').getBoundingClientRect(); return { row: r.querySelector('.band').hasAttribute('data-rail-row'), left: rail.left, right: rail.right, width: rail.width }; });
      assert.equal(fit.row, width === 700); assert.ok(fit.width >= 208 && fit.left >= 0 && fit.right <= width);
      await shot('integration-d', width === 700 ? 'voice-header-rail-row' : 'voice-header');
    }
    return 'PASS: voice-bound header fits at 1440 and uses the rail row at 700, light/dark; page/rail overflow 0 px.';
  });
  report.externalRequests = externalRequests; report.finishedAt = new Date().toISOString();
  await save();
  assert.deepEqual(externalRequests, []); assert.deepEqual(report.errors, []);
  assert.ok(report.items.every(item => item.status === 'pass'), JSON.stringify(report.items.filter(item => item.status !== 'pass')));
});
