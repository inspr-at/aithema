import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingReason, EU_COUNTRIES, publicReasoningManifest } from '../src/index.js';
import { binding } from '../../../test/plugin-fixtures.js';

const now = Date.UTC(2026, 9, 16);
const plugin = { manifest: publicReasoningManifest('fixture', 'Fixture', 'https://example.test') };
function qualified() {
  const b = binding('fixture', 'https://example.test/chat');
  return { ...b, legal: { approved: true, countries: ['FR'], training: false, retention: 'fixture',
    purpose: 'requirements', recipient: 'fixture-provider', processors: [], dataCategories: ['conversation'],
    consentVersion: 'v1', evidence: { qualified: true, accountRef: b.accountRef, secretRef: b.secretRef,
      model: b.model, endpoint: b.endpoint, routing: {}, verifiedAt: now - 1000, expiresAt: now + 1000 } } };
}
const reason = (b, preset, policy = {}) => bindingReason({ binding: b, plugin, preset, now,
  policy: { endpoints: [b.endpoint], ...policy } });

test('AIT-387: core exports exactly its binding evidence refusal codes', async () => {
  const { BINDING_REASON_CODES } = await import('../src/presets.js');
  assert.ok(Array.isArray(BINDING_REASON_CODES));
  assert.ok(Object.isFrozen(BINDING_REASON_CODES));
  const mutations = [
    b => { b.legal.evidence.qualified = false; },
    b => { b.legal.evidence.endpoint = 'https://other.test'; },
    b => { b.legal.evidence.verifiedAt = now + 1; },
    b => { b.legal.evidence.expiresAt = now; },
  ];
  const observed = mutations.map(mutate => { const b = qualified(); mutate(b); return reason(b, 'best'); });
  const expired = structuredClone(plugin); expired.manifest.models[0].expiresAt = new Date(now).toISOString();
  observed.push(bindingReason({ binding: qualified(), plugin: expired, preset: 'best', now }));
  assert.deepEqual(observed.sort(), [...BINDING_REASON_CODES].sort());
});

test('AIT-271 eu requires both EU recipient seats and guaranteed EU processing', () => {
  const b = qualified();
  assert.equal(reason(b, 'eu'), 'processing countries missing', 'EU seats alone do not qualify');
  b.legal.countries = [...EU_COUNTRIES];
  b.legal.processingCountries = [...EU_COUNTRIES];
  assert.equal(reason(b, 'eu'), null, 'every EU country is admitted for both seats and processing');
  for (const country of ['US', 'GB', 'CH', 'NO']) {
    b.legal.countries = ['FR', country];
    assert.equal(reason(b, 'eu'), 'recipient seat outside eu', country);
    assert.equal(reason(b, 'eu', { countries: ['FR'] }), 'recipient seat outside eu', 'EU seat refusals name the seat');
  }
  b.legal.countries = ['FR'];
  for (const country of ['US', 'GB', 'CH', 'NO']) {
    b.legal.processingCountries = ['FR', country];
    assert.equal(reason(b, 'eu'), 'processing residency denied', country);
  }
  b.legal.processingCountries = ['FR'];
  b.legal.training = true;
  assert.equal(reason(b, 'eu'), 'training policy denied', 'the EU training rule is unchanged');
});

test('AIT-271 undefined processing countries are absent under every preset', () => {
  for (const preset of ['best', 'eu', 'device', 'custom']) {
    const b = qualified();
    const expected = preset === 'eu' ? 'processing countries missing' : null;
    assert.equal(reason(b, preset), expected, `${preset}: omitted field`);
    b.legal.processingCountries = undefined;
    assert.equal(Object.hasOwn(b.legal, 'processingCountries'), true);
    assert.equal(reason(b, preset), expected, `${preset}: explicit undefined`);
  }
});

test('AIT-271 non-eu presets retain seat-country and training policies with or without processing countries', () => {
  for (const preset of ['best', 'custom']) {
    for (const processingCountries of [undefined, ['FR'], ['US']]) {
      const b = qualified();
      if (processingCountries) b.legal.processingCountries = processingCountries;
      assert.equal(reason(b, preset), null);
      assert.equal(reason(b, preset, { countries: ['FR'] }), null);
      assert.equal(reason(b, preset, { countries: ['US'] }), 'processing residency denied');
      b.legal.training = true;
      assert.equal(reason(b, preset), null);
      assert.equal(reason(b, preset, { noTraining: true }), 'training policy denied');
    }
  }
  const b = qualified(); b.legal.processingCountries = ['DE'];
  assert.equal(reason(b, 'eu', { countries: ['FR'] }), null, 'host country policy still filters seats');
  assert.equal(reason(b, 'eu', { countries: ['DE'] }), 'processing residency denied');
});

test('AIT-271 malformed processing countries refuse every server preset with a stable reason', () => {
  for (const preset of ['best', 'eu', 'custom']) {
    for (const processingCountries of [null, [], new Array(1), 'FR', {}, ['FRA'], ['fr'], ['FR', ''],
      [12], [null], [['FR']], ['FR', 'US', false]]) {
      const b = qualified(); b.legal.processingCountries = processingCountries;
      assert.equal(reason(b, preset), 'processing residency unverified', `${preset}: ${JSON.stringify(processingCountries)}`);
    }
  }
});
