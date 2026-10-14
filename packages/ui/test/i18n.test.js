import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { reasonText, catalogLabel } from '../src/settings-dialog.js';
import { demoPresets } from '../../../demo/choices.js';
import { manifest as voiceManifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../../demo/processing-consent.js';
import { START_GERMAN_CONSENT, FEATURE_REASON_CODES, VOICE_REASON_CODES } from '../../../test/fixtures/german-server-texts.js';

test('existing German consent stays verbatim START copy; all item versions and English server copy match', () => {
  const consent = locale => voiceManifest.presentation.translations.find(item => item.locale === locale).consentItem;
  const { items: genericItems, ...legal } = de.processingConsent;
  const { id: voiceId, ...voiceGerman } = consent('de');
  const items = { ...genericItems, [voiceId]: voiceGerman };
  const { id: englishId, ...voiceEnglish } = consent('en');
  const englishItems = { ...en.processingConsent.items, [englishId]: voiceEnglish };
  const { 'drafts-anthropic': drafts, ...startItems } = items;
  assert.ok(drafts, 'AIT-113 adds a separate host-authored draft item');
  assert.deepEqual({ ...legal, items: Object.fromEntries(Object.entries(startItems).map(([id, { version, ...copy }]) => [id, copy])) }, START_GERMAN_CONSENT);
  assert.equal(en.processingConsent.intro, CONSENT_INTRO);
  assert.equal(en.processingConsent.withdrawal, CONSENT_WITHDRAWAL);
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
      assert.equal(reasonText(bundle, code), bundle.reasons[code]);
    }
    assert.notEqual(de.reasons[code], en.reasons[code], code);
  }
});

test('compound voice reasons translate known codes and preserve unknown server text', () => {
  for (const bundle of [en, de]) {
    for (const code of FEATURE_REASON_CODES) {
      assert.equal(reasonText(bundle, `delegated reasoning: ${code}`), bundle.reasons.delegated.replace('{reason}', bundle.reasons[code]));
    }
    for (const method of ['get', 'post', 'patch']) {
      assert.equal(reasonText(bundle, `agent-api-${method}-403`), bundle.reasons['agent-api'].replace('{status}', '403'));
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
  assert.equal(catalogLabel(de, 'Fake voice (local agent)'), 'Test-Sprache (lokaler Agent)');
  assert.equal(catalogLabel(en, 'Fake voice (local agent)'), 'Fake voice (local agent)'); assert.equal(catalogLabel(de, 'ElevenLabs'), 'ElevenLabs');
  assert.deepEqual(Object.keys(de.gauges.operations), Object.keys(en.gauges.operations));
});

test('the demo header and mock consent name each visual kind in both languages; the local plugin labels are translated (AIT-118)', async () => {
  const { createLocalHTML } = await import('../../server/src/local-html.js'), { createLocalImages } = await import('../../server/src/local-images.js');
  const labels = { html: createLocalHTML().label, images: createLocalImages().label };
  assert.deepEqual([en.host.labels[labels.html], en.host.labels[labels.images], en.host.visualsOff], ['Test drafts (local click-dummy)', 'Test images (local PNG)', 'No visual concepts']);
  assert.deepEqual([de.host.labels[labels.html], de.host.labels[labels.images], de.host.visualsOff], ['Testentwürfe (lokaler Klick-Entwurf)', 'Testbilder (lokales PNG)', 'Keine visuellen Entwürfe']);
  for (const copy of [en, de]) {
    assert.deepEqual(Object.keys(copy.host.consentUse).sort(), ['html', 'images', 'off']);
    assert.match(copy.host.consentUse.html, /test drafts \(local click-dummy\)|Testentwürfe \(lokaler Klick-Entwurf\)/u);
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
