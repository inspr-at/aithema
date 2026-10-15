// Tick C1: isolated consent verdicts; viewport evidence, remote browser only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { CONSENT_ITEMS } from '../../demo/processing-consent.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const features = { text: ['models-international'], html: ['drafts-anthropic'], voice: ['voice-elevenlabs'], analysis: ['models-international'] };
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
async function fixture(t, real = false) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-lines-'));
  const demo = await startChild(new URL(real ? '../fixtures/consent-lines-server.js' : '../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    const json = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (page.forceAnalysisBlocked && path.endsWith('/features')) return json({ featureMatrix: { best: { analysis: { available: false, reason: 'current processing consent required' } } } });
    if (page.state && path.endsWith('/consent')) {
      if (request.method() === 'GET') return json({ contract: 'fixture-contract', items: CONSENT_ITEMS, features, selected: page.state.selected });
      const body = JSON.parse(request.postData()); page.posts.push(body);
      assert.equal(body.processing.contract, 'fixture-contract');
      page.state.selected = body.processing.items;
      for (const [feature, ids] of Object.entries(features)) if (ids.every(id => page.state.selected.includes(id))) page.state.matrix.best[feature] = { available: true, reason: null };
      return json({ granted: true, event: { seq: ++page.state.seq, type: 'consent.revised', data: { granted: true, consentRevision: 2, conversationUnchanged: true } } });
    }
    if (page.state?.snapshot && request.method() === 'GET' && path === `/api/sessions/${page.state.snapshot.id}`) return json({ ...page.state.snapshot, seq: page.state.seq, featureMatrix: page.state.matrix });
    if (path.endsWith('/features')) return json(page.state ? { featureMatrix: page.state.matrix } : {});
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
    seq: 100, matrix: { best: Object.fromEntries(['text', 'analysis', 'voice', 'html'].map(f => [f,
      missing.includes(f) ? { available: false, reason: 'current processing consent required' } : { available: true, reason: null }])) } };
  await page.evaluate(async ({ locale, matrix }) => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.consentSeed);
    session.locale = locale; session.seq = 100; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs'; session.conceptVisualKind = 'html';
    session.conceptCost = { maxMicro: 10000 }; session.featureMatrix = matrix;
    session.transcript = [{ id: 'c1-user', role: 'user', content: locale === 'de' ? 'Wir verlieren Zeit beim Schreiben von Angeboten.' : 'We lose time writing quotes.' }];
    c.configure({ copy, session, host: { library: true }, voicePresentation: manifest.presentation, voiceClient: { manifest } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    globalThis.c1Nodes = [...c.shadowRoot.querySelectorAll('.concept-activity-text, .voice-state, .notice, textarea')];
    globalThis.c1Document = globalThis.documentToken;
    for (const [selector, text] of [['#demo-account-label', copy.host.slots.account], ['#demo-account-note', copy.host.slots.accountNote], ['#demo-account-source', copy.host.slots.source]]) {
      const node = document.querySelector(selector); if (node) node.textContent = text;
    }
    scrollTo(0, 0);
  }, { locale, matrix: page.state.matrix });
  page.state.snapshot = await shadow(page, c => structuredClone(c.session));
  await frame(page);
}
const geometry = ['.band', '.concept-bar', '.understanding', '.notice', '.composer'];
for (const locale of ['de', 'en']) test(`AIT-197 C1 ${locale}: each consent, focused Settings and in-place save, 390/1440 L/D`, { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const feature of ['html', 'voice', 'analysis']) {
    const label = `${locale}-${theme}-${width}-${feature}`;
    await scene(page, locale, theme, width, [feature]);
    const selector = places[feature], expected = `${words[locale][feature]} · ${words[locale].action}`;
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
    const account = await page.$eval('#demo-account-label', n => n.textContent);
    assert.equal(account, locale === 'de' ? 'Konto (Demo)' : 'Account (demo)', 'host slot uses the screen language');
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
    await record(t, page, label + '-settings', { focused, item });
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
    await record(t, page, label + '-saved', { ...saved, shiftPx: 0 });
  }
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
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), 'Entwürfe brauchen Ihre Einwilligung · Einwilligen…');
  await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
  const before = await boxes(page, geometry);
  await page.locator('aithema-session >>> .notice button').click();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'models-international');
  await page.keyboard.press('Space'); await page.locator('aithema-session >>> .consent-save').click();
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open); await frame(page);
  assert.equal(await shadow(page, c => c.session.paused), true, 'giving consent preserves the purpose pause');
  assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), 'Nach dem ersten Satz entsteht hier Ihr Überblick.', 'a person turn cannot regain the first-sentence placeholder during a purpose pause');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), 'Entwürfe brauchen Ihre Einwilligung · Einwilligen…', 'drafts keep their separate refusal');
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
  const targets = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.consent-action')].map(button => {
    const style = getComputedStyle(button, '::after');
    return { height: parseFloat(style.height), width: parseFloat(style.width), text: button.getBoundingClientRect().width,
      description: c.shadowRoot.getElementById(button.getAttribute('aria-describedby'))?.textContent };
  }));
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
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), locale === 'de' ? 'Bilder brauchen Ihre Einwilligung · Einwilligen…' : 'Images need your consent · Give consent…');
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
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    page.forceAnalysisBlocked = true;
    await shadow(page, async (c, locale) => {
      await fetch(`/api/sessions/${c.session.id}/consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }) });
      const session = await fetch(`/api/sessions/${c.session.id}`).then(r => r.json());
      session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`); c.configure({ session, copy });
    }, locale);
    await page.locator('aithema-session >>> .notice button').click();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.value === 'mock-processing');
    await frame(page); const before = await boxes(page, ['.done', '.settings__footer', '.settings__body']);
    await page.keyboard.press('Space'); await frame(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.done-label').textContent), locale === 'de' ? 'Widerrufen und Gespräch beenden' : 'Withdraw and end conversation');
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.done svg')).display), 'none', 'withdraw has no check icon');
    assert.deepEqual(await boxes(page, ['.done', '.settings__footer', '.settings__body']), before, 'label swap shifts 0 px');
    await record(t, page, `${locale}-${width}-withdraw-label`, { shiftPx: 0 });
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    assert.equal(await shadow(page, c => c.session.consentWithdrawn), true, 'the real server ends the conversation');
  }
});
