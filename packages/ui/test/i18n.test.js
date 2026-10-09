import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { reasonText } from '../src/settings-dialog.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../../../demo/processing-consent.js';
import { START_GERMAN_CONSENT, FEATURE_REASON_CODES, VOICE_REASON_CODES } from '../../../test/fixtures/german-server-texts.js';

test('German processing consent is verbatim START legal copy; English equals the server fallback', () => {
  assert.deepEqual(de.processingConsent, START_GERMAN_CONSENT);
  assert.equal(en.processingConsent.intro, CONSENT_INTRO);
  assert.equal(en.processingConsent.withdrawal, CONSENT_WITHDRAWAL);
  assert.deepEqual(CONSENT_ITEMS.map(item => item.id).sort(), Object.keys(START_GERMAN_CONSENT.items).sort());
  assert.equal(new Set(CONSENT_ITEMS.map(item => item.id)).size, CONSENT_ITEMS.length);
  for (const { id, version, ...item } of CONSENT_ITEMS) {
    assert.ok(id && version > 0);
    assert.deepEqual(en.processingConsent.items[id], item, id);
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
