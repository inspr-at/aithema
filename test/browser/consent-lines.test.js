// Tick C1: isolated consent verdicts; viewport evidence, remote browser only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import audit from '../fixtures/consent-copy-audit.json' with { type: 'json' };
import { CONSENT_ITEMS } from '../../demo/processing-consent.js';
import { shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const features = { uploads: ['models-international'], transcription: ['voice-elevenlabs'], images: ['models-international'], text: ['models-international'], html: ['drafts-anthropic'], voice: ['voice-elevenlabs'], analysis: ['models-international'] };
const places = { html: '.concept-activity-text', voice: '.voice-state', analysis: '.notice' };
const words = {
  de: { html: 'Entwürfe brauchen Ihre Einwilligung', voice: 'Sprache braucht Ihre Einwilligung', analysis: 'Der Überblick braucht Ihre Einwilligung', action: 'Einwilligen…' },
  en: { html: 'Drafts need your consent', voice: 'Voice needs your consent', analysis: 'The overview needs your consent', action: 'Give consent…' },
};
const frame = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
async function record(t, page, label, values) {
  const line = `PASS C1 ${evidenceCommit} ${label}: ${JSON.stringify(values)}`;
  t.diagnostic(line);
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'C1'); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, label + '.png'), fullPage: false, captureBeyondViewport: false });
  await writeFile(join(dir, label + '.json'), JSON.stringify({ head: evidenceCommit, viewportOnly: true, label, ...values, pass: true }, null, 2));
  await appendFile(join(dir, 'pass-lines.txt'), line + '\n');
}
async function fixture(t, real = false, purpose = false) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-lines-'));
  const demo = await startChild(new URL(real ? '../fixtures/consent-lines-server.js' : '../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    ...(purpose ? { AITHEMA_PURPOSE_FIXTURE: '1' } : {}), AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile();
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await browser.close(); await demo.kill(); };
  t.after(close);
  const page = await browser.newPage(); page.closeFixture = close;
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    const json = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (page.consentCatalog && request.method() === 'GET' && path.endsWith('/settings')) return json(page.consentCatalog);
    if (page.forceSnapshot && request.method() === 'GET' && path === `/api/sessions/${page.forceSnapshot.id}`) return json(page.forceSnapshot);
    // Keep the intentionally held consent verdict coherent with its snapshot.
    if (page.forceSnapshot && request.method() === 'GET' && path.endsWith('/features')) return json({ featureMatrix: page.forceSnapshot.featureMatrix });
    if (page.state && path.endsWith('/consent')) {
      if (request.method() === 'GET') return json(page.state.document ?? { contract: 'fixture-contract', items: CONSENT_ITEMS, features, selected: page.state.selected });
      const body = JSON.parse(request.postData()); page.posts.push(body);
      assert.equal(body.processing.contract, 'fixture-contract');
      page.state.selected = body.processing.items;
      if (page.state.document) page.state.document = { ...page.state.document, selected: page.state.selected };
      for (const [feature, ids] of Object.entries(page.state.document?.features ?? features)) if (ids.every(id => page.state.selected.includes(id))) page.state.matrix.best[feature] = { available: true, reason: null };
      return json({ granted: true, event: { seq: ++page.state.seq, type: 'consent.revised', data: { granted: true, consentRevision: 2, conversationUnchanged: true } } });
    }
    if (page.state?.snapshot && request.method() === 'GET' && path === `/api/sessions/${page.state.snapshot.id}`) return json({ ...page.state.snapshot, seq: page.state.seq, featureMatrix: page.state.matrix });
    if (path.endsWith('/features') && !real) return json(page.state ? { featureMatrix: page.state.matrix } : {});
    if (path.endsWith('/retry') && page.state) return json({});
    if (path.endsWith('/events')) return request.continue({ headers: { ...request.headers(), 'last-event-id': '0' } });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.consentSeed = structuredClone(c.session); globalThis.documentToken = {}; });
  return page;
}
async function scene(page, locale, theme, width, missing) {
  await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
  page.posts = [];
  page.state = { selected: CONSENT_ITEMS.map(i => i.id).filter(id => !missing.flatMap(f => features[f]).includes(id)),
    seq: 100, matrix: { best: Object.fromEntries(Object.keys(features).map(f => [f,
      missing.includes(f) ? { available: false, reason: 'current processing consent required' } : { available: true, reason: null }])) } };
  await page.evaluate(async ({ locale, matrix }) => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const { inputRevision } = await import('/packages/core/src/session.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.consentSeed);
    c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
    c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
    document.documentElement.style.setProperty('--ui', 'ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif');
    session.visualsBound = true; // These in-page consent scenes simulate a bound draft renderer.
    session.locale = locale; session.seq = 100; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs'; session.conceptVisualKind = 'html';
    session.conceptCost = { maxMicro: 10000 }; session.featureMatrix = matrix;
    session.transcript = [{ id: 'c1-user', role: 'user', content: locale === 'de' ? 'Wir verlieren Zeit beim Schreiben von Angeboten.' : 'We lose time writing quotes.' }];
    session.operations = { inputRevision: inputRevision(session), running: ['reaction', 'understanding'], lastFailure: null };
    c.configure({ copy, session, host: { library: true }, voicePresentation: manifest.presentation, voiceClient: { manifest } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    globalThis.c1Nodes = [...c.shadowRoot.querySelectorAll('.concept-activity-text, .voice-state, .notice, textarea')];
    globalThis.c1Document = globalThis.documentToken;
    scrollTo(0, 0);
  }, { locale, matrix: page.state.matrix });
  page.state.snapshot = await shadow(page, c => structuredClone(c.session));
  await frame(page);
}
async function consentEvidenceReady(page) {
  await shadow(page, c => {
    c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
    const body = c.shadowRoot.querySelector('.settings__body'), intro = c.shadowRoot.querySelector('.consent-intro');
    body.scrollTop += intro.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
  });
  await page.mouse.move(-10, -10); await frame(page);
  await shadow(page, async c => {
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
  });
  return shadow(page, c => {
    const r = c.shadowRoot, intro = r.querySelector('.consent-intro').getBoundingClientRect(), body = r.querySelector('.settings__body').getBoundingClientRect();
    return { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      blurred: !r.activeElement && !document.activeElement?.matches('button, input, select, textarea, a[href]'),
      introVisible: intro.top >= body.top && intro.bottom <= body.bottom,
      introBounds: { top: intro.top, bottom: intro.bottom, paneTop: body.top, paneBottom: body.bottom } };
  });
}
async function pauseHeader(page, locale) {
  const header = await page.evaluate(() => {
    const control = document.querySelector('aithema-session').shadowRoot.querySelector('.conversations-toggle');
    return { screen: document.documentElement.lang, label: document.querySelector('#language-value').textContent,
      selected: document.querySelector('#locale').value, conversations: control?.textContent.trim(),
      conversationsVisible: Boolean(control?.checkVisibility()) };
  });
  assert.equal(header.screen, locale);
  assert.equal(header.label, header.screen.toUpperCase(), 'language control label matches the screen');
  assert.equal(header.selected, header.screen, 'language control selection matches the screen');
  assert.equal(header.conversations, locale === 'de' ? 'Gespräche' : 'Conversations');
  assert.equal(header.conversationsVisible, true, 'Conversations control is present on the host');
  return header;
}
const geometry = ['.band', '.concept-bar', '.understanding', '.notice', '.composer'];
for (const locale of ['de', 'en']) test(`AIT-197 C1 ${locale}: each consent, focused Settings and in-place save, 390/1440 L/D`, { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const feature of ['html', 'voice', 'analysis']) {
    const label = `${locale}-${theme}-${width}-${feature}`;
    await scene(page, locale, theme, width, [feature]);
    const selector = places[feature], expected = `${words[locale][feature]}\u00a0· ${words[locale].action}`;
    const state = await shadow(page, (c, { selector, expected }) => {
      const r = c.shadowRoot, line = r.querySelector(selector);
      return { text: line.textContent, lines: [...r.querySelectorAll('[data-consent-feature]')].filter(n => n.textContent === expected).length,
        action: line.querySelector('button')?.textContent, placeholder: r.querySelector('.notice').textContent,
        italic: getComputedStyle(line).fontStyle,
        actionWrap: getComputedStyle(line.querySelector('button')).whiteSpace,
        actionWidth: line.querySelector('button').clientWidth,
        actionScrollWidth: line.querySelector('button').scrollWidth };
    }, { selector, expected });
    assert.equal(state.text, expected, label); assert.equal(state.lines, 1, label + ': once in its own place');
    assert.equal(state.action, words[locale].action); assert.equal(state.italic, 'normal'); assert.equal(state.actionWrap, 'nowrap');
    assert.ok(state.actionWidth >= state.actionScrollWidth, 'action text fits without splitting the word');
    if (feature === 'analysis') assert.equal(state.placeholder, expected, 'blocked overview never promises the placeholder');
    if (feature === 'analysis') {
      await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
    }
    assert.equal(await page.$('[slot="account"]'), null, 'no person icon for visitors');
    assert.equal(await page.$eval('#theme-label', n => n.textContent), locale === 'de' ? 'Darstellung' : 'Appearance', 'host utilities use the screen language');
    if (feature === 'voice') {
      const ink = await shadow(page, c => {
        const r = c.shadowRoot, range = document.createRange(); range.selectNodeContents(r.querySelector('.voice-state'));
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        const width = Math.max(...rects.map(rect => rect.right)) - Math.min(...rects.map(rect => rect.left));
        return { half: Number.parseFloat(r.querySelector('.voice-wave').style.getPropertyValue('--voice-label-half')), expected: width / 2 };
      });
      assert.equal(ink.half, ink.expected, 'waveform mask covers sentence and action together');
    }
    const before = await boxes(page, geometry);
    await record(t, page, label + '-missing', { feature, item: features[feature][0], ...state });
    await page.locator(`aithema-session >>> ${selector} button`).click();
    const item = features[feature][0];
    try {
      await until(page, item => {
        const r = document.querySelector('aithema-session').shadowRoot;
        return r.querySelector('dialog.settings').open && r.activeElement?.matches(`input[value="${item}"]`);
      }, item);
    } catch (error) {
      t.diagnostic(JSON.stringify(await shadow(page, c => ({ open: c.shadowRoot.querySelector('dialog.settings').open, focused: c.shadowRoot.activeElement?.outerHTML, status: c.shadowRoot.querySelector('.consent-status').textContent }))));
      throw error;
    }
    const labels = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.consent-item label')].map(n => n.textContent));
    if (locale === 'de') assert.ok(labels.includes('Sprache mit ElevenLabs'), 'voice legal document uses the screen language');
    const primary = await shadow(page, c => ({ label: c.shadowRoot.querySelector('.done-label').textContent, saves: c.shadowRoot.querySelector('.done').classList.contains('consent-save') }));
    assert.deepEqual(primary, { label: locale === 'de' ? 'Einwilligung speichern' : 'Save consent', saves: true }, 'the fixed Settings primary action explicitly saves consent');
    const focused = await shadow(page, c => c.shadowRoot.activeElement.value);
    assert.equal(focused, item);
    const tint = await shadow(page, (c, item) => {
      const rows = [...c.shadowRoot.querySelectorAll('.consent-item')], target = rows.find(n => n.querySelector('input').value === item);
      const rects = () => rows.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
      const before = rects(), tinted = rows.filter(n => getComputedStyle(n, '::before').content !== 'none').map(n => n.querySelector('input').value);
      target.classList.remove('consent-item--target'); const after = rects(); target.classList.add('consent-item--target');
      return { tinted, before, after };
    }, item);
    assert.deepEqual(tint.tinted, [item]); assert.deepEqual(tint.after, tint.before, 'target tint shifts 0 px');
    await record(t, page, label + '-settings', { focused, item, tinted: tint.tinted, shiftPx: 0 });
    await page.keyboard.press('Space');
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    await until(page, feature => document.querySelector('aithema-session').session.featureMatrix.best[feature].available, feature);
    await frame(page);
    const after = await boxes(page, geometry);
    assert.deepEqual(after, before, label + ': save shifts 0 px');
    assert.equal(page.posts.length, 1); assert.deepEqual([...page.posts[0].processing.items].sort(), CONSENT_ITEMS.map(i => i.id).sort(), 'preserves other grants');
    const saved = await shadow(page, c => ({ sameDocument: globalThis.documentToken === globalThis.c1Document,
      sameNodes: globalThis.c1Nodes.every(n => n.isConnected), consentLines: c.shadowRoot.querySelectorAll('[data-consent-feature]').length,
      overview: c.shadowRoot.querySelector('.notice').textContent }));
    assert.equal(saved.sameDocument, true); assert.equal(saved.sameNodes, true); assert.equal(saved.consentLines, 0);
    const copyEmpty = await page.evaluate(async locale => (await import(`/packages/ui/src/i18n/${locale}.js`))[locale].empty, locale);
    assert.equal(saved.overview, locale === 'de' ? 'Ihr Überblick wird erstellt …' : 'Preparing your overview …', 'a person turn never shows the first-sentence placeholder');
    assert.notEqual(saved.overview, copyEmpty);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.retry').hidden), true, 'running analysis has no bare retry');
    await record(t, page, label + '-saved', { ...saved, shiftPx: 0 });
  }
});

for (const locale of ['de', 'en']) test(`AIT-231 ${locale}: real and mock Settings editors, 1440/1024/390 light/dark`, { timeout: 120_000 }, async t => {
  const page = await fixture(t), passes = [];
  for (const mock of [false, true]) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
    await scene(page, locale, theme, width, ['analysis']);
    const selected = mock ? [] : ['voice-elevenlabs', 'drafts-anthropic'];
    const mapping = mock ? Object.fromEntries(Object.keys(features).map(feature => [feature, ['mock-processing']])) : features;
    page.state.selected = selected;
    page.state.document = { contract: 'fixture-contract', ...(mock ? { mock: true } : { items: CONSENT_ITEMS }), features: mapping, selected };
    await shadow(page, c => c.shadowRoot.querySelector('.notice button').focus());
    await page.keyboard.press('Enter');
    const target = mock ? 'mock-processing' : 'models-international';
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.consent-editor input'));
    const state = await shadow(page, async (c, { target, mock }) => {
      const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
      const r = c.shadowRoot, editor = r.querySelector('.consent-editor'), body = r.querySelector('.settings__body');
      globalThis.ait231Focus = r.activeElement;
      return { target: r.activeElement?.value, checked: [...editor.querySelectorAll('input')].filter(n => n.checked).map(n => n.value),
        intro: editor.querySelector('.consent-intro').textContent, withdrawal: editor.querySelector('.consent-withdrawal').textContent,
        expectedIntro: mock ? copy.host.consentPage.intro : copy.processingConsent.intro,
        expectedWithdrawal: mock ? copy.host.consentPage.mockTerms : copy.processingConsent.withdrawal,
        rows: editor.querySelectorAll('input').length, status: editor.querySelector('.consent-status').textContent,
        enabled: !r.querySelector('.consent-save').disabled,
        mockLabel: editor.textContent.includes(copy.host.consentTitle),
        font: getComputedStyle(c).getPropertyValue('--aithema-font').trim(),
        horizontalOverflow: body.scrollWidth > body.clientWidth, expectedTarget: target };
    }, { target, mock });
    assert.equal(state.target, target); assert.equal(state.rows, mock ? 1 : CONSENT_ITEMS.length);
    assert.deepEqual(state.checked, selected); assert.equal(state.status, ''); assert.equal(state.enabled, true);
    assert.equal(state.horizontalOverflow, false); assert.equal(state.mockLabel, mock);
    assert.equal(state.intro, state.expectedIntro); assert.equal(state.withdrawal, state.expectedWithdrawal);
    assert.doesNotMatch(state.intro, /twelve|zwölf|Monat|month|browser|stored|gespeichert|until|bis/iu);
    const before = await boxes(page, ['.done', '.settings__footer', '.settings__body']);
    const ready = await consentEvidenceReady(page);
    assert.equal(ready.reducedMotion, true); assert.equal(ready.blurred, true); assert.equal(ready.introVisible, true, JSON.stringify(ready));
    const label = `${locale}-${theme}-${width}-${mock ? 'mock' : 'real'}`;
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-231'); await mkdir(dir, { recursive: true });
      await page.screenshot({ path: join(dir, label + '.png'), fullPage: false, captureBeyondViewport: false });
    }
    // Save the focused node, blur for evidence, then restore it mid-sequence.
    await shadow(page, () => globalThis.ait231Focus.focus({ preventScroll: true }));
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === globalThis.ait231Focus), true);
    await page.keyboard.press('Space'); await frame(page);
    assert.deepEqual(await boxes(page, ['.done', '.settings__footer', '.settings__body']), before, 'selection shifts 0 px');
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    assert.deepEqual(page.posts[0].processing.items, mock ? ['mock-processing'] : CONSENT_ITEMS.map(item => item.id));
    const pass = { head: evidenceCommit, label, locale, theme, width, mock, ...state, ...ready,
      focusRestored: true, saved: true, layoutShiftPx: 0, viewportOnly: true, baselineFonts: true, pass: true };
    passes.push(pass); t.diagnostic(`PASS AIT-231 ${JSON.stringify(pass)}`);
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-231');
      await writeFile(join(dir, label + '.json'), JSON.stringify(pass, null, 2));
      await writeFile(join(dir, `pass-lines-${locale}.json`), JSON.stringify(passes, null, 2));
      await writeFile(join(dir, `index-${locale}.json`), JSON.stringify({ head: evidenceCommit, shots: passes.map(p => `${p.label}.png`) }, null, 2));
    }
  }
});

test('AIT-231: demo host keeps its twelve-month mock wording at 1440 DE light', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 1440, ['analysis']);
  // Use the demo's real mock-consent endpoint and its host copy overlay.
  page.state = null;
  await shadow(page, async c => {
    const { de } = await import('/packages/ui/src/i18n/de.js');
    const { withDemoConsentCopy } = await import('/demo/consent-copy.js');
    c.configure({ copy: withDemoConsentCopy(de), session: c.session });
  });
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.consent-editor input'));
  const wording = await shadow(page, c => ({ intro: c.shadowRoot.querySelector('.consent-intro').textContent,
    terms: c.shadowRoot.querySelector('.consent-withdrawal').textContent }));
  assert.equal(wording.intro, 'Wählen Sie, welche Verarbeitung Sie für dieses Gespräch erlauben. Nicht ausgewählte Punkte sind nicht freigegeben.');
  assert.equal(wording.terms, 'Das umfasst Gesprächsdaten, Fassung 1, für zwölf Monate. Einwilligungen liegen nur im Arbeitsspeicher; erteilen Sie sie nach einem Serverneustart erneut.');
  const ready = await consentEvidenceReady(page);
  assert.equal(ready.reducedMotion, true); assert.equal(ready.blurred, true); assert.equal(ready.introVisible, true, JSON.stringify(ready));
  const label = 'de-light-1440-demo', pass = { head: evidenceCommit, label, ...wording, ...ready, viewportOnly: true, baselineFonts: true, pass: true };
  t.diagnostic(`PASS AIT-231 ${JSON.stringify(pass)}`);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-231'); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: join(dir, label + '.png'), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(dir, label + '.json'), JSON.stringify(pass, null, 2));
  }
});

test('AIT-231: a full mock document preserves described items and an invalid one fails closed in Settings', async t => {
  const page = await fixture(t); await scene(page, 'en', 'light', 1024, ['analysis']);
  page.state.document = { mock: true, contract: 'fixture-contract', items: CONSENT_ITEMS, features, selected: [] };
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.consent-editor input'));
  assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.consent-editor input')].map(n => n.value)), CONSENT_ITEMS.map(i => i.id));
  assert.match(await shadow(page, c => c.shadowRoot.querySelector('.consent-intro').textContent), /^This is demo processing\./u);
  await page.keyboard.press('Escape');
  page.state.document = { contract: 'fixture-contract', items: [{ ...CONSENT_ITEMS[0], text: '' }], features, selected: [] };
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.consent-status').textContent === 'Could not save consent. Try again.');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.consent-save').disabled), true);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.consent-editor input').length), 0);
});
test('AIT-197 C1: all three refusals have one action each; stage survives a paused reload', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, ['html', 'voice', 'analysis']);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('[data-consent-feature]').length), 3);
  await shadow(page, async c => {
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const session = structuredClone(c.session); session.paused = true; session.pauseReason = 'purpose';
    session.featureMatrix.best.html = { available: false, reason: 'session paused', unpaused: { available: false, reason: 'current processing consent required' } };
    c.configure({ session, copy });
  });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), 'Entwürfe brauchen Ihre Einwilligung\u00a0· Einwilligen…');
  await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
  const before = await boxes(page, geometry);
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'models-international');
  await page.keyboard.press('Space'); await page.locator('aithema-session >>> .consent-save').click();
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open); await frame(page);
  assert.equal(await shadow(page, c => c.session.paused), true, 'giving consent preserves the purpose pause');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'Ihr Überblick wird erstellt …', 'a person turn cannot regain the first-sentence placeholder during a purpose pause');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), 'Entwürfe brauchen Ihre Einwilligung\u00a0· Einwilligen…', 'drafts keep their separate refusal');
  assert.deepEqual(await boxes(page, geometry), before, 'paused consent save shifts 0 px');
});

test('AIT-197 C1: the local host consent editor saves through the real endpoint without navigating', async t => {
  const page = await fixture(t); await page.setViewport({ width: 390, height: 844 });
  await shadow(page, async c => {
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const session = structuredClone(globalThis.consentSeed);
    session.locale = 'de'; session.transcript = [{ id: 'local-user', role: 'user', content: 'Wir brauchen eine Website.' }];
    c.configure({ session, copy });
  });
  const doc = await shadow(page, async c => fetch(`/api/sessions/${c.session.id}/consent`).then(r => r.json()));
  assert.deepEqual(doc.features.analysis, ['mock-processing']);
  await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'mock-processing');
  await page.keyboard.press('Space'); await page.locator('aithema-session >>> .consent-save').click();
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  assert.equal(await shadow(page, c => c.session.featureMatrix.best.analysis.available), true);
});

test('AIT-197 R2 B: only the target is tinted, with unchanged boxes; normal Settings has no tint', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, ['voice']);
  await page.locator('aithema-session >>> .voice-state button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'voice-elevenlabs');
  const tint = await shadow(page, c => {
    const rows = [...c.shadowRoot.querySelectorAll('.consent-item')], target = rows.find(n => n.querySelector('input').value === 'voice-elevenlabs');
    const rects = () => rows.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    const before = rects(), count = rows.filter(n => getComputedStyle(n, '::before').content !== 'none').length;
    const style = getComputedStyle(target, '::before'), painted = { content: style.content, inset: parseFloat(style.top), color: style.backgroundColor };
    target.classList.remove('consent-item--target'); const after = rects(); target.classList.add('consent-item--target');
    return { count, painted, before, after };
  });
  assert.equal(tint.count, 1); assert.ok(tint.painted.inset < 0); assert.notEqual(tint.painted.color, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(tint.after, tint.before, 'full tint shifts 0 px');
  await page.locator('aithema-session >>> .done').click();
  await page.locator('aithema-session >>> .settings-open').click();
  assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.consent-item--target').length), 0);
  await record(t, page, 'normal-settings-no-tint', { tinted: 0 });
});

test('AIT-197 R2 C: all three actions have a 24px hit area and described feature sentence', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, ['html', 'voice', 'analysis']);
  const before = await boxes(page, Object.values(places));
  const targets = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.consent-action')].map(button => {
    const style = getComputedStyle(button, '::after');
    return { height: parseFloat(style.height), width: parseFloat(style.width), text: button.getBoundingClientRect().width,
      description: c.shadowRoot.getElementById(button.getAttribute('aria-describedby'))?.textContent };
  }));
  await shadow(page, c => { const style = document.createElement('style'); style.textContent = '.consent-action::after { display:none !important; }'; c.shadowRoot.append(style); });
  assert.deepEqual(await boxes(page, Object.values(places)), before, 'hit areas shift 0 px');
  assert.equal(targets.length, 3);
  for (const target of targets) { assert.ok(target.height >= 24); assert.ok(target.width >= target.text + 8); assert.match(target.description, /braucht|brauchen/); }
});

test('AIT-197 R2 D: only an empty transcript uses the new English placeholder', async t => {
  const page = await fixture(t); await scene(page, 'en', 'light', 1440, []);
  await shadow(page, async c => { const { en: copy } = await import('/packages/ui/src/i18n/en.js'); const session = structuredClone(c.session); session.transcript = []; c.configure({ session, copy }); });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'Your overview appears here after the first sentence.');
});

test('AIT-197 R2 images: the stage uses image consent words', async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) {
    await scene(page, locale, 'light', 390, ['html']);
    await shadow(page, async (c, locale) => { const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`); const session = structuredClone(c.session);
      session.conceptVisualKind = 'image'; session.featureMatrix.best.images = session.featureMatrix.best.html; c.configure({ session, copy }); }, locale);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), locale === 'de' ? 'Bilder brauchen Ihre Einwilligung\u00a0· Einwilligen…' : 'Images need your consent\u00a0· Give consent…');
    await record(t, page, `${locale}-image-line`, { images: true });
  }
});

test('AIT-197 R2 A and real save: consent starts overview and missing reply exactly once, with 0px invalidation', async t => {
  const page = await fixture(t, true); await page.setViewport({ width: 390, height: 844 });
  await shadow(page, async c => {
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const session = await fetch('/fixture/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: c.session.id, content: 'Wir verlieren Zeit beim Schreiben von Angeboten.' }) }).then(r => r.json());
    c.configure({ session, copy });
    globalThis.r2Nodes = [...c.shadowRoot.querySelectorAll('.concept-activity-text, .voice-state, .notice, textarea')];
  });
  await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
  const before = await boxes(page, geometry);
  let retries = 0, posts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/retry')) retries++; if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/consent')) posts++; });
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'mock-processing');
  await page.keyboard.press('Space'); await page.locator('aithema-session >>> .consent-save').click();
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  await until(page, () => document.querySelector('aithema-session').session.operations?.running.length === 2);
  await frame(page);
  const stats = await page.evaluate(() => fetch('/fixture/stats').then(r => r.json()));
  assert.deepEqual(stats, { reaction: 1, understanding: 1 }, 'both pending lanes start once without a retry click');
  assert.equal(posts, 1); assert.equal(retries, 0);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'Ihr Überblick wird erstellt …');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.retry').hidden), true);
  assert.equal(await shadow(page, c => globalThis.r2Nodes.every(n => n.isConnected)), true);
  assert.deepEqual(await boxes(page, geometry), before, 'real consent.revised invalidation shifts 0 px');
  await record(t, page, 'real-analysis-saved-preparing', { stats, retries, shiftPx: 0 });
  await page.evaluate(() => fetch('/fixture/release'));
  await until(page, () => document.querySelector('aithema-session').session.understanding.readinessAssessed);
  assert.equal(await shadow(page, c => c.session.transcript.filter(t => t.role === 'assistant' && !t.withdrawn).length), 1);
  assert.deepEqual(await page.evaluate(() => fetch('/fixture/stats').then(r => r.json())), stats);
});

test('AIT-197 R2 High: real withdrawal label reserves 0px at 390/1440 in DE/EN', async t => {
  const page = await fixture(t, true);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.select('#theme', theme);
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    const session = await shadow(page, async (c, locale) => {
      // Withdrawal ends a conversation; each case needs a fresh owner conversation.
      const created = await fetch('/api/library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }) });
      if (!created.ok) throw new Error('Cannot create withdrawal fixture conversation');
      const { session: fresh } = await created.json();
      await fetch(`/api/sessions/${fresh.id}/consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }) });
      const session = await fetch(`/api/sessions/${fresh.id}`).then(r => r.json());
      session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
      session.transcript = [{ id: 'withdraw-person', role: 'user', content: 'Wir brauchen eine Website.' }];
      return session;
    }, locale);
    page.forceSnapshot = session;
    await shadow(page, async (c, { session, locale }) => { const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`); session.locale = locale; c.configure({ session, copy }); }, { session, locale });
    await frame(page);
    await page.waitForSelector('aithema-session >>> .notice .consent-action', { visible: true });
    await page.keyboard.press('Tab');
    await shadow(page, c => c.shadowRoot.querySelector('.notice .consent-action').focus());
    await page.keyboard.press('Enter');
    try { await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'mock-processing'); }
    catch (error) { t.diagnostic(JSON.stringify(await shadow(page, c => ({ active: c.shadowRoot.activeElement?.outerHTML, editor: c.shadowRoot.querySelector('.consent-editor').outerHTML, open: c.shadowRoot.querySelector('dialog.settings').open })))); throw error; }
    await frame(page); const before = await boxes(page, ['.done', '.settings__footer', '.settings__body']);
    assert.notEqual(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.done svg')).display), 'none', 'save has the check icon');
    await record(t, page, `r3-${locale}-${theme}-${width}-save-check`, { check: true });
    await page.keyboard.press('Space'); await frame(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.done-label').textContent), locale === 'de' ? 'Widerrufen und Gespräch beenden' : 'Withdraw and end conversation');
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.done svg')).display), 'none', 'withdraw has no check icon');
    assert.deepEqual(await boxes(page, ['.done', '.settings__footer', '.settings__body']), before, 'label swap shifts 0 px');
    await record(t, page, `${locale}-${theme}-${width}-withdraw-label`, { shiftPx: 0 });
    page.forceSnapshot = null;
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    assert.equal(await shadow(page, c => c.session.consentWithdrawn), true, 'the real server ends the conversation');
  }
});

test('AIT-197 R2 B keyboard: the tinted target also retains the usual focus ring', async t => {
  const page = await fixture(t); await scene(page, 'en', 'dark', 1440, ['html']);
  await page.keyboard.press('Tab');
  await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text button').focus());
  await page.keyboard.press('Enter');
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'drafts-anthropic');
  const focus = await shadow(page, c => { const n = c.shadowRoot.activeElement, style = getComputedStyle(n); return { visible: n.matches(':focus-visible'), outline: parseFloat(style.outlineWidth), tinted: n.closest('.consent-item').classList.contains('consent-item--target') }; });
  assert.equal(focus.visible, true); assert.ok(focus.outline > 0); assert.equal(focus.tinted, true);
});

for (const feature of ['voice', 'html']) test(`AIT-197 R2 High: removing only ${feature} keeps save wording and restores its consent line`, async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, [feature]);
  page.state.selected = CONSENT_ITEMS.map(i => i.id);
  await page.locator(`aithema-session >>> ${places[feature]} button`).click();
  await until(page, item => document.querySelector('aithema-session').shadowRoot.activeElement?.value === item, features[feature][0]);
  const before = await boxes(page, ['.done', '.settings__footer']);
  await page.keyboard.press('Space'); await frame(page);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.done-label').textContent), 'Einwilligung speichern');
  assert.deepEqual(await boxes(page, ['.done', '.settings__footer']), before, 'partial removal shifts 0 px');
  await page.locator('aithema-session >>> .consent-save').click();
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  assert.equal(page.posts[0].granted, true); assert.equal(await shadow(page, c => c.session.consentWithdrawn), false);
  assert.equal(await shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).textContent, places[feature]), `${words.de[feature]}\u00a0· ${words.de.action}`);
});

for (const locale of ['de', 'en']) for (const project of [false, true]) test(`AIT-197 R3 ${locale}: paused consent with ${project ? 'earlier project' : 'only off-topic turns'}, 390/1440 L/D`, { timeout: 120_000 }, async t => {
  for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    const page = await fixture(t, true, true);
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async ({ locale, project }) => {
      const { localeKey } = await import('/demo/page-preferences.js');
      // Reload the real host with a different next-conversation preference:
      // a paused conversation keeps its own screen language and host controls.
      localStorage.setItem(localeKey, locale === 'de' ? 'en' : 'de');
      const response = await fetch('/fixture/pause', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: document.querySelector('aithema-session').session.id, locale, project }) });
      if (!response.ok) throw new Error('Pause fixture failed');
    }, { locale, project });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, locale => document.querySelector('aithema-session')?.session?.pauseReason === 'purpose'
      && document.documentElement.lang === locale, locale);
    const header = await pauseHeader(page, locale);
    await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
    const before = await boxes(page, geometry);
    let posts = 0, retries = 0;
    page.on('request', request => { const path = new URL(request.url()).pathname; if (request.method() === 'POST' && path.endsWith('/consent')) posts++; if (path.endsWith('/retry')) retries++; });
    await page.locator('aithema-session >>> .notice button').click();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'mock-processing');
    const save = await shadow(page, c => { const n = c.shadowRoot.querySelector('.done svg'); return { present: Boolean(n?.querySelector('path')), display: getComputedStyle(n).display, width: n.getBoundingClientRect().width }; });
    assert.equal(save.present, true); assert.notEqual(save.display, 'none'); assert.ok(save.width > 0, 'Save consent has its check icon');
    await record(t, page, `r3-${locale}-${theme}-${width}-${project ? 'project' : 'off'}-save-check`, { save, shiftPx: 0 });
    const buttonBefore = await boxes(page, ['.done', '.settings__footer', '.settings__body']);
    await page.keyboard.press('Space'); await frame(page);
    assert.deepEqual(await boxes(page, ['.done', '.settings__footer', '.settings__body']), buttonBefore, 'save label stays at 0 px');
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    await until(page, project => { const s = document.querySelector('aithema-session').session; return s.operations?.running.length === (project ? 1 : 0) && s.featureMatrix.best.analysis.unpaused?.available; }, project);
    // Closing Settings can leave the pointer over the real host's credits rail.
    // Park it outside controls so the viewport evidence has no incidental tooltip.
    await page.mouse.move(1, 1); await frame(page);
    const notice = await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent);
    assert.equal(notice, project ? locale === 'de' ? 'Ihr Überblick wird erstellt …' : 'Preparing your overview …' : locale === 'de' ? 'Noch keine Angaben zu Ihrem Vorhaben.' : 'No details about your project yet.');
    assert.deepEqual(await boxes(page, geometry), before, 'paused real consent save shifts 0 px');
    assert.equal(posts, 1); assert.equal(retries, 0);
    const stats = await page.evaluate(() => fetch('/fixture/stats').then(r => r.json()));
    assert.deepEqual(stats, { reaction: 0, understanding: project ? 1 : 0 });
    assert.equal(await shadow(page, c => c.session.pauseReason), 'purpose');
    assert.deepEqual(await pauseHeader(page, locale), header, 'consent save preserves true header controls');
    await record(t, page, `r4-${locale}-${theme}-${width}-${project ? 'project-preparing' : 'off-no-details'}`, { notice, stats, retries, header, shiftPx: 0 });
    await page.evaluate(() => fetch('/fixture/release'));
    if (project) {
      await until(page, () => document.querySelector('aithema-session').session.understanding.readinessAssessed && !document.querySelector('aithema-session').session.operations.running.length);
      assert.match(await shadow(page, c => c.session.understanding.summary), /website|Website/);
      const messages = await page.evaluate(() => fetch('/fixture/assessment-messages').then(r => r.json()));
      assert.doesNotMatch(JSON.stringify(messages), /soup/);
    }
    assert.deepEqual(await page.evaluate(() => fetch('/fixture/stats').then(r => r.json())), stats, 'settles exactly once');
    await page.closeFixture();
  }
});

test('AIT-197 R3: idle person turns never claim preparing; empty transcript outranks missing consent', async t => {
  const page = await fixture(t); await scene(page, 'en', 'light', 1440, []);
  await shadow(page, async c => { const { en: copy } = await import('/packages/ui/src/i18n/en.js'); const session = structuredClone(c.session); session.operations.running = []; session.transcript.push({ id: 'reply', role: 'assistant', content: 'What should improve?', inputRevision: session.operations.inputRevision }); c.configure({ session, copy }); });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'No details about your project yet.');
  await scene(page, 'en', 'light', 1440, ['analysis']);
  await shadow(page, async c => { const { en: copy } = await import('/packages/ui/src/i18n/en.js'); const session = structuredClone(c.session); session.transcript = []; session.operations.running = []; c.configure({ session, copy }); });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'Your overview appears here after the first sentence.');
});

test('AIT-197 R3: save consent visibly retains the check icon', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, ['voice']);
  await page.locator('aithema-session >>> .voice-state button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'voice-elevenlabs');
  assert.notEqual(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.done svg')).display), 'none');
});


const genericConsent = /(?:Einwilligung zur )?Verarbeitung erforderlich|(?:Current )?Processing consent required|current processing consent required/iu;
async function noGenericConsent(page, label) {
  const tree = await page.accessibility.snapshot({ interestingOnly: false });
  assert.ok(tree, label + ': accessibility snapshot exists');
  assert.doesNotMatch(JSON.stringify(tree), genericConsent, label + ': full accessibility tree, including shadow content');
  const exposed = await page.evaluate(() => {
    const results = [];
    const walk = root => {
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) walk(n.shadowRoot);
        if (!n.checkVisibility({ visibilityProperty: true }) || n.closest('[inert], [hidden], dialog:not([open])')) continue;
        results.push({ tag: n.tagName, class: n.className, title: n.getAttribute('title'), label: n.getAttribute('aria-label'),
          tooltip: n.matches('[role="tooltip"]') ? n.textContent : null,
          text: n.children.length ? null : n.textContent,
          described: (n.getAttribute('aria-describedby') ?? '').split(/\s+/u).map(id => n.getRootNode().getElementById?.(id)?.textContent).filter(Boolean) });
      }
    };
    walk(document); return results;
  });
  assert.doesNotMatch(JSON.stringify(exposed), genericConsent, label + ': visible text, titles, labels and referenced descriptions');
  const shadowText = await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open
    ? c.shadowRoot.querySelector('.settings__title').textContent : c.shadowRoot.querySelector('.features li').firstChild.nodeValue);
  assert.ok(JSON.stringify(tree).includes(shadowText), label + ': snapshot includes shadow-root content');
  return { accessibility: true, exposedCopy: true };
}

async function capture215(t, page, label, values, interaction = null) {
  if (interaction !== 'focus') await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
  // A requested hover/focus shot retains that interaction; all other shots have the pointer outside.
  if (interaction !== 'hover') await page.mouse.move(-10, -10);
  await frame(page);
  await shadow(page, async c => {
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
      .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
  });
  const ready = await shadow(page, c => ({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    blurred: !c.shadowRoot.activeElement && !document.activeElement?.matches('button, input, select, textarea, a[href]'),
    font: getComputedStyle(c).getPropertyValue('--aithema-font').trim() }));
  assert.equal(ready.reducedMotion, true);
  if (interaction !== 'focus') assert.equal(ready.blurred, true);
  const pass = { head: evidenceCommit, label, ...values, ...ready, interaction, viewportOnly: true, baselineFonts: true, pass: true };
  t.diagnostic(`PASS AIT-215 ${JSON.stringify(pass)}`);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-215'); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: join(dir, label + '.png'), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(dir, label + '.json'), JSON.stringify(pass, null, 2));
  }
}

for (const locale of ['de', 'en']) test(`AIT-215 ${locale}: composer consent action opens the text item and saves in place, 320/340/390/1440`, async t => {
  const page = await fixture(t);
  for (const width of [320, 340, 390, 1440]) {
    await scene(page, locale, 'light', width, ['text']);
    await shadow(page, c => c.shadowRoot.querySelector('.composer').scrollIntoView({ block: 'center' }));
    await frame(page);
    const state = await shadow(page, async c => {
      const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
      const r = c.shadowRoot, line = r.querySelector('.composer-reason');
      const range = document.createRange(); range.selectNodeContents(line);
      const ink = range.getBoundingClientRect(), slot = line.getBoundingClientRect();
      const action = line.querySelector('.consent-action'), button = action.getBoundingClientRect();
      const pseudo = getComputedStyle(action, '::after'), transform = new DOMMatrixReadOnly(pseudo.transform);
      const used = (value, size) => parseFloat(value) * (value.endsWith('%') ? size / 100 : 1);
      const target = { left: button.left + used(pseudo.left, button.width) + transform.m41,
        top: button.top + used(pseudo.top, button.height) + transform.m42,
        width: parseFloat(pseudo.width), height: parseFloat(pseudo.height) };
      target.right = target.left + target.width; target.bottom = target.top + target.height;
      const overlap = selector => {
        const box = r.querySelector(selector).getBoundingClientRect();
        return Math.max(0, Math.min(target.right, box.right) - Math.max(target.left, box.left))
          * Math.max(0, Math.min(target.bottom, box.bottom) - Math.max(target.top, box.top));
      };
      const fontSize = parseFloat(getComputedStyle(line).fontSize), lineHeight = parseFloat(getComputedStyle(line).lineHeight);
      const visibleText = n => [...n.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent
        : getComputedStyle(child).display === 'none' ? '' : visibleText(child)).join('');
      const narrow = innerWidth <= 340;
      return { text: visibleText(line), expected: `${narrow ? copy.featureConsent.textNarrow : copy.featureConsent.text}\u00a0· ${narrow ? copy.featureConsent.actionNarrow : copy.featureConsent.action}`,
        accessibleName: action.getAttribute('aria-label'), expectedName: `${copy.featureConsent.text}. ${copy.featureConsent.textReview}`,
        underlined: getComputedStyle(action).textDecorationLine.includes('underline'),
        lineCount: Math.round(ink.height / lineHeight), fontSize, target,
        overlapAttach: overlap('.attach'), overlapSend: overlap('.send'),
        action: visibleText(action), expectedAction: narrow ? copy.featureConsent.actionNarrow : copy.featureConsent.action,
        inputDisabled: r.querySelector('textarea').disabled, sendDisabled: r.querySelector('.send').disabled,
        reasonFits: ink.top >= slot.top - 1 && ink.bottom <= slot.bottom + 1 && ink.left >= slot.left - 1 && ink.right <= slot.right + 1,
        inkBox: [ink.x, ink.y, ink.width, ink.height], reasonBox: [slot.x, slot.y, slot.width, slot.height] };
    });
    assert.equal(state.text, state.expected); assert.equal(state.action, state.expectedAction);
    assert.equal(state.accessibleName, state.expectedName); assert.equal(state.underlined, true);
    const tree = await page.accessibility.snapshot({ interestingOnly: false });
    const findButton = n => n.role === 'button' && n.name === state.expectedName || n.children?.some(findButton);
    assert.ok(findButton(tree), `${locale}/${width}: full consent sentence is the accessible button name`);
    assert.equal(state.inputDisabled, true); assert.equal(state.sendDisabled, true);
    const selectors = ['.composer-shell', '.composer', 'textarea', '.send'];
    const before = await boxes(page, selectors);
    if (width <= 340) assert.equal(state.lineCount, 1, `${locale}/${width}: consent stays on one line`);
    assert.ok(state.lineCount <= 2, `${locale}/${width}: at most two lines: ${JSON.stringify(state)}`);
    assert.ok(state.fontSize >= 12, `${locale}/${width}: 12px font floor`);
    if (width <= 390) {
      assert.ok(state.target.height >= 44, `${locale}/${width}: 44px consent hit area`);
      assert.equal(state.overlapAttach, 0, `${locale}/${width}: Attach intersection is 0 px²`);
      assert.equal(state.overlapSend, 0, `${locale}/${width}: Send intersection is 0 px²`);
    }
    assert.equal(state.reasonFits, true, `sentence and action fit the two-line reason: ${JSON.stringify(state)}`);
    await capture215(t, page, `${locale}-light-${width}-composer-action`, { locale, width, ...state, composerBox: before[1] });
    await page.locator('aithema-session >>> .composer-reason .consent-action').click();
    await until(page, () => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return r.querySelector('dialog.settings').open && r.activeElement?.value === 'models-international';
    });
    const target = await shadow(page, c => {
      const r = c.shadowRoot, rows = [...r.querySelectorAll('.consent-item')];
      return { focused: r.activeElement.value,
        tinted: rows.filter(n => getComputedStyle(n, '::before').content !== 'none').map(n => n.querySelector('input').value) };
    });
    assert.equal(target.focused, 'models-international'); assert.deepEqual(target.tinted, ['models-international'], 'AIT-197 B tint is on the text consent item only');
    await page.keyboard.press('Space');
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return !r.querySelector('dialog.settings').open && !r.querySelector('textarea').disabled && !r.querySelector('.send').disabled;
    });
    await frame(page);
    const saved = await shadow(page, c => ({ sameDocument: globalThis.documentToken === globalThis.c1Document,
      sameNodes: globalThis.c1Nodes.every(n => n.isConnected), inputEnabled: !c.shadowRoot.querySelector('textarea').disabled,
      sendEnabled: !c.shadowRoot.querySelector('.send').disabled, actionRemoved: !c.shadowRoot.querySelector('.composer-reason .consent-action') }));
    assert.deepEqual(saved, { sameDocument: true, sameNodes: true, inputEnabled: true, sendEnabled: true, actionRemoved: true });
    assert.equal(page.posts.length, 1);
    assert.deepEqual([...page.posts[0].processing.items].sort(), CONSENT_ITEMS.map(i => i.id).sort());
    assert.deepEqual(await boxes(page, selectors), before, 'composer, input and send move 0 px after saving consent');
    if (width === 390) await capture215(t, page, `${locale}-light-${width}-composer-enabled`, { locale, width, ...saved, ...target, layoutShiftPx: 0 });
    if (width === 1440) {
      await shadow(page, async c => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        const session = structuredClone(c.session);
        session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
        session.transcript.push({ id: 'overview-reply', role: 'assistant', content: session.locale === 'de' ? 'Wer schreibt die Angebote heute?' : 'Who writes the quotes today?', inputRevision: inputRevision(session) });
        Object.assign(session.understanding, { readinessAssessed: true, draft: false, inputRevision: inputRevision(session),
          summary: session.locale === 'de' ? 'Das Team verliert Zeit beim Schreiben von Angeboten.' : 'The team loses time writing quotes.',
          signals: [session.locale === 'de' ? 'Angebote werden von Hand geschrieben' : 'Quotes are written by hand'] });
        c.configure({ session });
      });
      await frame(page);
      const overviewSelectors = ['.understanding', '.notice', '.summary', '.summary-text', '.understanding > .foot', '.composer', '.send'];
      const overviewBefore = await boxes(page, overviewSelectors);
      const overview = await shadow(page, c => {
        const r = c.shadowRoot, section = r.querySelector('.summary'), heading = r.getElementById(section.getAttribute('aria-labelledby'));
        return { noticeVisible: getComputedStyle(r.querySelector('.notice-text')).visibility !== 'hidden',
          regionName: heading.textContent, summaryVisible: !section.hidden, summary: r.querySelector('.summary-text').textContent };
      });
      assert.equal(overview.noticeVisible, false, 'completed overview has no visible current-assessment label');
      assert.equal(overview.summaryVisible, true);
      const ax = await page.accessibility.snapshot({ interestingOnly: false });
      const namedRegion = n => n.role === 'region' && n.name === overview.regionName || n.children?.some(namedRegion);
      assert.ok(namedRegion(ax), 'summary keeps its accessible region name');
      for (const draft of [true, false]) {
        await shadow(page, (c, draft) => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...structuredClone(c.session.understanding), draft } }), draft);
        await frame(page);
        assert.deepEqual(await boxes(page, overviewSelectors), overviewBefore, 'draft/current label change moves summary and surrounding layout 0 px');
        assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.notice-text')).visibility !== 'hidden'), draft);
      }
      if (locale === 'de') await capture215(t, page, 'de-light-1440-overview-no-label', { locale, width, ...overview, layoutShiftPx: 0, accessibleRegion: true });
    }
  }
});

for (const locale of ['de', 'en']) test(`AIT-215 ${locale}: no generic consent in AT, intake, Settings, hover or focus`, { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  const passes = [];
  for (const width of [1440, 390]) {
    await scene(page, locale, 'light', width, Object.keys(features));
    await noGenericConsent(page, `${locale}/${width}/conversation`);
    const featureReasons = await shadow(page, async c => {
      const locale = c.session.locale, { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      return [...c.shadowRoot.querySelectorAll('.features li')].map((n, i) => {
        const feature = ['text', 'analysis', 'voice', 'transcription', 'images', 'html', 'uploads'][i];
        return { feature, actual: n.querySelector('span')?.textContent, expected: copy.featureConsent[feature === 'transcription' ? 'voice' : feature] };
      });
    });
    assert.equal(featureReasons.length, 7);
    for (const { feature, actual, expected } of featureReasons) {
      assert.equal(typeof expected, 'string', feature + ': canonical feature sentence exists');
      assert.ok(expected.length > 0); assert.equal(actual, expected, feature + ': AT-only row reuses C1');
    }
    await shadow(page, async (c, locale) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(c.session); session.transcript = []; session.settings.origin = 'default';
      c.configure({ copy, session });
    }, locale);
    page.state.snapshot = await shadow(page, c => structuredClone(c.session));
    await frame(page);
    for (const preset of ['best', 'eu', 'device', 'custom']) {
      const option = await page.$(`aithema-session >>> .chooser-option[data-preset="${preset}"]`);
      assert.ok(option, 'each intake option exists');
      await option.hover(); await noGenericConsent(page, `${locale}/${width}/intake/${preset}/hover`);
      await page.mouse.move(-10, -10); await option.focus();
      assert.equal(await option.evaluate(n => n.getRootNode().activeElement === n), true);
      await noGenericConsent(page, `${locale}/${width}/intake/${preset}/focus`);
      await option.dispose();
    }
    page.consentCatalog = await shadow(page, c => fetch(`/api/sessions/${c.session.id}/settings`).then(r => r.json()));
    for (const info of Object.values(page.consentCatalog.presets)) {
      if (!info.offered) continue;
      info.status = 'consent'; info.reason = 'current processing consent required';
      for (const [index, option] of [...info.models ?? [], ...info.voices ?? [], ...info.visuals ?? []].entries()) {
        option.status = ['consent', 'limited', 'unavailable'][index % 3]; option.reason = index % 2 ? 'delegated reasoning: current processing consent required' : 'current processing consent required';
      }
    }
    await shadow(page, c => c.openSettings());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-select="voice"] [role="option"][data-reason]'));
    let helpCaptured = false;
    for (const selector of ['.preset-option', '[data-select="model"] [role="option"]', '[data-select="voice"] [role="option"]', '[data-select="visuals"] [role="option"]']) {
      const name = /data-select="([^"]+)"/u.exec(selector)?.[1];
      if (name) await page.locator(`aithema-session >>> [data-select="${name}"] .select__button`).click();
      const rows = await page.$$(`aithema-session >>> ${selector}`);
      assert.ok(rows.length > 0, selector + ': rows exist');
      const geometryBefore = await boxes(page, ['dialog.settings', '.settings__header', '.settings__footer']);
      for (const [index, row] of rows.entries()) {
        const expected = await row.evaluate(async n => {
          if (!n.dataset.reason?.includes('current processing consent required')) return null;
          const locale = document.documentElement.lang, { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          return copy.help.consentNeeded.replace('{reason}', copy.featureConsent[n.dataset.feature ?? 'text']);
        });
        await row.hover(); await noGenericConsent(page, `${locale}/${width}/${selector}/${index}/hover`);
        if (expected) assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.context-message').textContent), expected, 'hover help uses the feature C1 sentence and the unchanged explanation');
        if (expected && width === 1440 && !helpCaptured) {
          await capture215(t, page, `${locale}-light-1440-settings-help-hover`, { locale, width, help: expected }, 'hover');
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.context-message').textContent), expected);
        }
        await page.mouse.move(-10, -10); await row.focus();
        await noGenericConsent(page, `${locale}/${width}/${selector}/${index}/focus`);
        if (expected) assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.context-message').textContent), expected, 'focus help uses the feature C1 sentence and the unchanged explanation');
        if (expected && width === 1440 && !helpCaptured) {
          await capture215(t, page, `${locale}-light-1440-settings-help-focus`, { locale, width, help: expected }, 'focus');
          helpCaptured = true;
        }
        assert.deepEqual(await boxes(page, ['dialog.settings', '.settings__header', '.settings__footer']), geometryBefore, 'hover/focus help shifts layout by 0 px');
        await row.dispose();
      }
      if (name) await page.keyboard.press('Escape');
    }
    if (width === 1440) assert.equal(helpCaptured, true, 'captured a consent-status row on hover and focus');
    await page.keyboard.press('Escape');
    page.consentCatalog = null;
    const pass = { head: evidenceCommit, locale, width, accessibilityTree: 'interestingOnly:false; shadow-root content asserted', intakeOptions: 4,
      settings: ['presets', 'models', 'voice', 'visuals'], states: ['consent', 'limited', 'unavailable'], interactions: ['hover', 'focus'], genericReasonAbsent: true, layoutShiftPx: 0, pass: true };
    passes.push(pass); t.diagnostic(`PASS AIT-215 ${JSON.stringify(pass)}`);
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-215'); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `interaction-pass-lines-${locale}.json`), JSON.stringify(passes, null, 2));
    }
  }
});


for (const locale of ['de', 'en']) test(`AIT-215 ${locale}: consent-missing viewport evidence, 1440/1024/400/390 light/dark`, { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  const passes = [];
  for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 400, 390]) {
    await scene(page, locale, theme, width, Object.keys(features));
    const state = await shadow(page, async (c, locale) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.style.setProperty('--ui', 'ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif');
      const lines = Object.fromEntries(['text', 'html', 'voice', 'analysis'].map(feature => {
        const selector = { text: '.composer-reason', html: '.concept-activity-text', voice: '.voice-state', analysis: '.notice' }[feature];
        const element = c.shadowRoot.querySelector(selector), line = element.textContent;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), glyphs = [];
        while (walker.nextNode()) {
          const text = walker.currentNode;
          for (let i = 0; i < text.length; i++) {
            if (/\s/u.test(text.data[i])) continue;
            const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
            for (const rect of range.getClientRects()) if (rect.width && rect.height)
              glyphs.push({ glyph: text.data[i], top: rect.top, left: rect.left });
          }
        }
        const starts = [];
        for (const glyph of glyphs.sort((a, b) => a.top - b.top || a.left - b.left)) {
          const start = starts.find(start => Math.abs(start.top - glyph.top) < 2);
          if (!start) starts.push(glyph);
          else if (glyph.left < start.left) Object.assign(start, glyph);
        }
        if (!starts.length || starts.some(start => start.glyph === '·')) throw new Error(`${feature}: separator starts a line`);
        if (line !== `${copy.featureConsent[feature]}\u00a0· ${copy.featureConsent.action}`) throw new Error(`${feature}: ${line}`);
        return [feature, line];
      }));
      const label = c.shadowRoot.querySelector('.voice-state .consent-line-copy').firstChild;
      const dot = label.textContent.indexOf('·'), range = document.createRange();
      range.setStart(label, dot - 2); range.setEnd(label, dot - 1); const letterBox = range.getBoundingClientRect();
      range.setStart(label, dot); range.setEnd(label, dot + 1); const dotBox = range.getBoundingClientRect();
      if (letterBox.y !== dotBox.y || dotBox.x < letterBox.right) throw new Error('Rail separator starts a line');
      const r = c.shadowRoot;
      r.activeElement?.blur(); document.activeElement?.blur(); scrollTo(0, 0);
      return { lines, separatorStartsLine: false, locale: document.documentElement.lang, font: getComputedStyle(c).getPropertyValue('--aithema-font').trim() };
    }, locale);
    await page.mouse.move(-10, -10); await frame(page);
    await shadow(page, async c => {
      await Promise.all(c.shadowRoot.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
    });
    const ready = await shadow(page, c => ({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      blurred: !c.shadowRoot.activeElement && !document.activeElement?.matches('button, input, select, textarea, a[href]') }));
    assert.equal(ready.reducedMotion, true); assert.equal(ready.blurred, true);
    const checked = await noGenericConsent(page, `${locale}/${theme}/${width}/capture`);
    // The reason's existing slot must keep its geometry when the longer legacy text is replaced.
    const before = await boxes(page, geometry);
    const legacy = await shadow(page, async c => {
      const r = c.shadowRoot, line = r.querySelector('.composer-reason'); globalThis.composerConsentNodes = [...line.childNodes];
      const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
      line.textContent = copy.reasons['current processing consent required'];
      return { boxes: ['.band', '.concept-bar', '.understanding', '.notice', '.composer'].map(selector => {
        const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
      }) };
    });
    await shadow(page, c => { c.shadowRoot.querySelector('.composer-reason').replaceChildren(...globalThis.composerConsentNodes); });
    assert.deepEqual(legacy.boxes, before, 'feature copy changes layout by 0 px');
    assert.deepEqual(await boxes(page, geometry), before);
    const pass = { head: evidenceCommit, label: `${locale}-${theme}-${width}-consent-missing`, ...state, width, theme,
      ...checked, ...ready, viewportOnly: true, baselineFonts: true, layoutShiftPx: 0, pass: true };
    passes.push(pass); t.diagnostic(`PASS AIT-215 ${JSON.stringify(pass)}`);
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'AIT-215'); await mkdir(dir, { recursive: true });
      // Blur again immediately before every viewport capture.
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-10, -10); await frame(page);
      await page.screenshot({ path: join(dir, pass.label + '.png'), fullPage: false, captureBeyondViewport: false });
      await writeFile(join(dir, pass.label + '.json'), JSON.stringify(pass, null, 2));
      await writeFile(join(dir, pass.label + '.ax.json'), JSON.stringify(await page.accessibility.snapshot({ interestingOnly: false }), null, 2));
      await writeFile(join(dir, `pass-lines-${locale}.json`), JSON.stringify(passes, null, 2));
      await writeFile(join(dir, 'audit.json'), JSON.stringify({ head: evidenceCommit, ...audit }, null, 2));
    }
  }
});
