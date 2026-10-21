import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { withDemoConsentCopy } from '../../../demo/consent-copy.js';
import { reasonText, catalogLabel } from '../src/settings-dialog.js';
import { reasonText as hostReasonText } from '../../../demo/reason-text.js';
import { demoPresets } from '../../../demo/choices.js';
import { FEATURES } from '../../core/src/presets.js';
import { manifest as voiceManifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../../demo/processing-consent.js';
import { START_GERMAN_CONSENT, FEATURE_REASON_CODES, VOICE_REASON_CODES, BINDING_REASON_CODES } from '../../../test/fixtures/german-server-texts.js';

for (const [locale, copy, dailyCap, dailyCapReset] of [
  ['de', de, 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.', 'Ab {time} gilt für diese E‑Mail-Adresse ein neues Tageslimit.'],
  ['en', en, "This email address has reached today's limit.", 'This email address gets a new daily limit from {time}.'],
]) test(`AIT-443: ${locale} daily cap and reset match Tick v1.1 exactly`, () => {
  assert.equal(copy.hostSurface.credits.dailyCap, dailyCap);
  assert.equal(copy.hostSurface.credits.dailyCapReset, dailyCapReset);
});

for (const [locale, copy] of [['de', de], ['en', en]]) for (const key of ['withConfirmed', 'afterConfirm']) {
  test(`AIT-435: ${locale}.hostSurface.credits.${key} keeps the number and credits together in the catalog`, () => {
    const amounts = [...copy.hostSurface.credits[key].matchAll(/\{\w+\}(\s*)credits\b/giu)];
    assert.ok(amounts.length > 0, 'the catalog string contains numeric credits copy');
    for (const [, space] of amounts) assert.equal(space, '\u00a0', 'number and credits use exactly one NBSP');
  });
}

// AIT-435 r2 item 0: inspect every leaf; only strings without a numeric
// amount immediately before Credits/credits are outside this copy rule.
const catalogLeaves = (value, path = []) => typeof value === 'string' ? [[path.join('.'), value]]
  : Object.entries(value).flatMap(([key, child]) => catalogLeaves(child, [...path, key]));
for (const [locale, copy] of Object.entries({ de, en })) for (const [key, text] of catalogLeaves(copy)) {
  const amounts = [...text.matchAll(/(?:\{\w+\}|\d[\d.,]*)(\s*)credits\b/giu)];
  if (amounts.length) test(`AIT-435 universal NBSP: ${locale}.${key}`, () => {
    for (const [, space] of amounts) assert.equal(space, '\u00a0', `${locale}.${key}: exactly one NBSP between number and credits`);
  });
}

test('AIT-445 Tick v1.1: every DE catalog string keeps E‑Mail together with U+2011', () => {
  for (const [key, text] of catalogLeaves(de)) {
    assert.doesNotMatch(text, /E-Mail/u, `de.${key}: use E‑Mail with U+2011, including compounds`);
  }
});

for (const [locale, copy, expected] of [
  ['de', de, 'Mit E‑Mail-Adresse: {n}\u00a0Credits'],
  ['en', en, 'With an email address: {n}\u00a0credits'],
]) test(`AIT-435 item 3: ${locale} withEmail matches Tick exactly`, () => {
  assert.equal(copy.hostSurface.credits.withEmail, expected);
});

test('AIT-411 round 7 and AIT-435: confirmed tier copy matches Tick exactly', () => {
  assert.equal(en.hostSurface.credits.withConfirmed, 'With a confirmed email address: {n}\u00a0credits');
  assert.equal(de.hostSurface.credits.withConfirmed, 'Mit bestätigter E‑Mail-Adresse: {tier}\u00a0Credits');
});

test('AIT-411 round 7: every added or changed numeric credits catalog string uses NBSP', () => {
  const entries = [
    ['en', 'afterConfirm', en.hostSurface.credits.afterConfirm],
    ['en', 'withConfirmed', en.hostSurface.credits.withConfirmed],
    ['en', 'ended.sessionUpgrade', en.hostSurface.credits.ended.sessionUpgrade],
    ['de', 'ended.sessionUpgrade', de.hostSurface.credits.ended.sessionUpgrade],
  ];
  for (const [locale, key, text] of entries) {
    const amounts = [...text.matchAll(/(?:\{\w+\}|\d[\d.,]*)(\s+)credits\b/giu)];
    assert.ok(amounts.length > 0, `${locale}.${key}: numeric credits copy is inventoried`);
    for (const [, space] of amounts) assert.equal(space, '\u00a0', `${locale}.${key}: number and credits stay together`);
  }
});

test('demo German consent stays verbatim START copy; all item versions and English server copy match', () => {
  const consent = locale => voiceManifest.presentation.translations.find(item => item.locale === locale).consentItem;
  const { items: genericItems, ...legal } = withDemoConsentCopy(de).processingConsent;
  const { id: voiceId, ...voiceGerman } = consent('de');
  const items = { ...genericItems, [voiceId]: voiceGerman };
  const { id: englishId, ...voiceEnglish } = consent('en');
  const englishItems = { ...en.processingConsent.items, [englishId]: voiceEnglish };
  const { 'drafts-anthropic': drafts, ...startItems } = items;
  assert.ok(drafts, 'AIT-113 adds a separate host-authored draft item');
  assert.deepEqual({ ...legal, items: Object.fromEntries(Object.entries(startItems).map(([id, { version, ...copy }]) => [id, copy])) }, START_GERMAN_CONSENT);
  assert.equal(withDemoConsentCopy(en).processingConsent.intro, CONSENT_INTRO);
  assert.equal(withDemoConsentCopy(en).processingConsent.withdrawal, CONSENT_WITHDRAWAL);
  assert.deepEqual(CONSENT_ITEMS.map(item => item.id).sort(), Object.keys(items).sort());
  assert.equal(new Set(CONSENT_ITEMS.map(item => item.id)).size, CONSENT_ITEMS.length);
  for (const { id, version, ...item } of CONSENT_ITEMS) {
    assert.ok(id && version > 0);
    assert.equal(items[id].version, version, id);
    assert.deepEqual(englishItems[id], { version, ...item }, id);
  }
});

test('every inventoried feature, HTML, voice and provider reason has English and German copy', () => {
  for (const code of [...FEATURE_REASON_CODES, ...VOICE_REASON_CODES]) {
    for (const bundle of [en, de]) {
      assert.ok(Object.hasOwn(bundle.reasons, code), code);
      assert.equal(typeof bundle.reasons[code], 'string', code);
      assert.ok(bundle.reasons[code].length > 0, code);
      assert.equal(reasonText(bundle, code), BINDING_REASON_CODES.includes(code) || code === 'binding invalid' ? bundle.chooser.unavailable : bundle.reasons[code]);
    }
    assert.notEqual(de.reasons[code], en.reasons[code], code);
  }
});

test('compound voice reasons translate known codes and preserve unknown server text', () => {
  for (const bundle of [en, de]) {
    for (const code of FEATURE_REASON_CODES) {
      assert.equal(reasonText(bundle, `delegated reasoning: ${code}`), BINDING_REASON_CODES.includes(code) || code === 'binding invalid'
        ? bundle.chooser.unavailable : bundle.reasons.delegated.replace('{reason}', bundle.reasons[code]));
    }
    for (const method of ['get', 'post', 'patch']) {
      assert.equal(reasonText(bundle, `agent-api-${method}-403`), bundle.chooser.unavailable);
    }
    for (const unknown of ['future reason from host', '__proto__', 'constructor', 'agent-api-delete-403']) {
      assert.equal(reasonText(bundle, unknown), unknown);
    }
    assert.equal(reasonText(bundle, 'delegated reasoning: future host reason'), bundle.reasons.delegated.replace('{reason}', 'future host reason'));
  }
  assert.equal(reasonText({}, 'not configured'), 'not configured');
});

test('a German page names the demo catalog in German; product names stay (AIT-118, GUI-27 one language)', () => {
  const { models, voices, visuals } = demoPresets({}).best.choices, products = new Set(['ElevenLabs', 'OpenAI GPT Image 2']);
  for (const { label } of [...models, ...voices, ...visuals]) assert.ok(products.has(label) || Object.hasOwn(de.catalogLabels, label), label);
  assert.equal(catalogLabel(de, 'Fake voice (local agent)'), 'Nur Demo: simulierte Sprache');
  assert.equal(catalogLabel(en, 'Fake voice (local agent)'), 'Demo only: simulated voice'); assert.equal(catalogLabel(de, 'ElevenLabs'), 'ElevenLabs');
  assert.deepEqual(Object.keys(de.gauges.operations), Object.keys(en.gauges.operations));
});

test('the demo header and mock consent name each visual kind in both languages; the local plugin labels are translated (AIT-118)', async () => {
  const { createLocalHTML } = await import('../../server/src/local-html.js'), { createLocalImages } = await import('../../server/src/local-images.js');
  const labels = { html: createLocalHTML().label, images: createLocalImages().label };
  assert.deepEqual([en.host.labels[labels.html], en.host.labels[labels.images], en.host.visualsOff], ['Demo only: clickable draft', 'Test images (local PNG)', 'No visual concepts']);
  assert.deepEqual([de.host.labels[labels.html], de.host.labels[labels.images], de.host.visualsOff], ['Nur Demo: klickbarer Entwurf', 'Testbilder (lokales PNG)', 'Keine visuellen Entwürfe']);
  for (const copy of [en, de]) {
    assert.deepEqual(Object.keys(copy.host.consentUse).sort(), ['html', 'images', 'off']);
    assert.match(copy.host.consentUse.html, /draft clickable concepts|klickbare Entwürfe zu erstellen/u);
    assert.match(copy.host.consentUse.images, /draw concepts|Entwürfe zu zeichnen/u);
    assert.doesNotMatch(copy.host.consentUse.html, /image|bild/iu);
    assert.doesNotMatch(copy.host.consentUse.off, /image|bild|draft|entw/iu);
  }
  for (const copy of [en, de].map(withDemoConsentCopy)) {
    assert.deepEqual(Object.keys(copy.host.consentUse).sort(), ['html', 'images', 'off']);
    assert.match(copy.host.consentUse.html, /clickable demo drafts|Testentwürfe \(lokaler Klick-Entwurf\)/u);
    assert.match(copy.host.consentUse.images, /test images \(local PNG\)|Testbilder \(lokales PNG\)/u);
    assert.doesNotMatch(copy.host.consentUse.html, /image|bild/iu); assert.doesNotMatch(copy.host.consentUse.off, /image|bild|draft|entw/iu);
  }
});

test('upload copy exists in English and German with the same keys and placeholders, every German string formal and distinct (AIT-100 B2)', () => {
  const leaves = (value, path = []) => typeof value === 'string' ? [[path.join('.'), value]] : Object.entries(value).flatMap(([key, v]) => leaves(v, [...path, key]));
  const english = Object.fromEntries(leaves(en.uploads)), german = Object.fromEntries(leaves(de.uploads));
  assert.deepEqual(Object.keys(german).sort(), Object.keys(english).sort());
  for (const [key, text] of Object.entries(english)) {
    assert.ok(text.length > 0 && german[key].length > 0, key);
    assert.notEqual(german[key], text, key);
    assert.deepEqual(german[key].match(/\{\w+\}/gu)?.sort() ?? [], text.match(/\{\w+\}/gu)?.sort() ?? [], `${key} placeholders`);
    assert.doesNotMatch(german[key], /\b(?:du|dein|deine|dich|dir)\b/iu, `${key} uses formal Sie`);
  }
});

test('AIT-173 round 3: generic budget denial never assumes a live call', () => {
  for (const copy of [de, en]) assert.equal(reasonText(copy, 'budget denied'), copy.voiceStates.usedUp);
});

test('AIT-173 round 4: reconciling denial copy is exact and remains a temporary choice refusal', async () => {
  const { isDynamicReason } = await import('../../core/src/settings.js');
  assert.equal(reasonText(de, 'budget reconciling'), 'Einen Moment, die Kosten des Anrufs werden noch abgeglichen.');
  assert.equal(reasonText(en, 'budget reconciling'), "One moment, the call's costs are still being reconciled.");
  assert.equal(isDynamicReason('budget reconciling'), true);
});


test('AIT-215: each C1 feature uses one consent sentence in both locales', async () => {
  const { featureConsentText } = await import('../src/consent-line.js');
  assert.deepEqual([de.featureConsent.text, en.featureConsent.text], ['Nachrichten brauchen Ihre Einwilligung', 'Messages need your consent']);
  assert.deepEqual([de.featureConsent.uploads, en.featureConsent.uploads], ['Dateien brauchen Ihre Einwilligung', 'Files need your consent']);
  for (const copy of [de, en]) for (const feature of ['text', 'analysis', 'voice', 'transcription', 'images', 'html', 'uploads']) {
    const expected = copy.featureConsent[feature === 'transcription' ? 'voice' : feature];
    assert.equal(typeof expected, 'string');
    assert.ok(expected.length > 0);
    assert.equal(featureConsentText(copy, feature), expected);
    for (const reason of ['current processing consent required', 'delegated reasoning: current processing consent required']) {
      assert.equal(reasonText(copy, reason, feature), featureConsentText(copy, feature));
    }
    assert.equal(reasonText(copy, 'not configured', feature), copy.reasons['not configured']);
  }
});

// Legacy lookup keys and internal ids may keep their names; visitor-facing values may not.
test('AIT-246 DE/EN visitor copy uses plain demo language throughout', () => {
  const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  for (const copy of [en, de, withDemoConsentCopy(en), withDemoConsentCopy(de)]) {
    for (const text of strings(copy)) assert.doesNotMatch(text, /Klick-Dummy|click-dummy|\bfake\b|\bmock\b|Mock-/iu);
  }
});


for (const [copy, generic, voice, drafts] of [
  [de, 'Derzeit nicht verfügbar', 'Sprache ist derzeit nicht verfügbar', 'Visuelle Entwürfe sind gerade nicht verfügbar.'],
  [en, 'Currently unavailable', 'Voice is currently unavailable', 'Visual drafts are not available right now.'],
]) {
  test(`AIT-380 Tick v2 ${copy.display.locale}: each feature × binding reason is exactly in its neutral allow-list`, () => {
    const allow = { voice, images: drafts, html: drafts };
    const jargon = /provider|contract|evidence|anbieter|vertrag|nachweis/iu;
    for (const code of [...BINDING_REASON_CODES, 'binding invalid', 'agent-api', 'agent-api-get-401', 'agent-api-post-403', 'agent-api-patch-503']) for (const reason of [code, `delegated reasoning: ${code}`]) {
      for (const feature of [undefined, ...FEATURES]) {
        const expected = allow[feature] ?? generic;
        const visible = reasonText(copy, reason, feature);
        assert.equal(visible, expected, `${feature}: ${reason}`);
        assert.doesNotMatch(visible, jargon);
        assert.equal(hostReasonText(copy, reason, feature), expected, `host ${feature}: ${reason}`);
      }
    }
  });
}

test('AIT-387: the visitor inventory uses the core evidence reason set and excludes the unused voice key', async () => {
  const core = await import('../../core/src/presets.js');
  assert.equal(BINDING_REASON_CODES, core.BINDING_REASON_CODES, 'the fixture must share the core export');
  for (const copy of [en, de]) assert.equal(Object.hasOwn(copy.host, 'voiceUnavailable'), false);
});

test('AIT-429: agent-api-unavailable keeps its diagnostic code and renders Tick’s neutral voice copy', async () => {
  const { narrowVoiceStatus } = await import('../src/voice-status.js');
  const code = 'agent-api-unavailable';
  assert.ok(VOICE_REASON_CODES.includes(code));
  for (const [copy, expected] of [[de, 'Sprache gerade nicht verfügbar'], [en, 'Voice unavailable right now']]) {
    assert.ok(Object.hasOwn(copy.reasons, code));
    for (const render of [reasonText, hostReasonText]) for (const feature of [undefined, 'voice']) {
      assert.equal(render(copy, code, feature), expected);
      assert.equal(render(copy, `delegated reasoning: ${code}`, feature), copy.reasons.delegated.replace('{reason}', expected));
    }
    const compact = narrowVoiceStatus(copy, expected, { reason: code });
    assert.doesNotMatch(compact, /provider|anbieter/iu);
    assert.equal(compact, copy.voiceReasonsNarrow.unavailable);
    assert.ok([...compact].length <= 22);
  }
});
