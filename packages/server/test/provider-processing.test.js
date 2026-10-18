import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerProcessingFacts } from '../src/provider-processing.js';
const now = Date.parse('2026-10-19T00:00:00Z');
const plugin = { manifest: { placement: 'server', vendor: { name: 'xAI' }, models: [{ id: 'grok-voice', efforts: ['none'] }] } };
const binding = { plugin: 'grok-voice', model: 'grok-voice', effort: 'none', accountRef: 'fixture', secretRef: 'fixture', endpoint: 'https://eu.us.example.test',
  legal: { approved: true, countries: ['US'], training: false, retention: 'fixture', purpose: 'voice-xai', recipient: 'SpaceXAI LLC', processors: [], dataCategories: ['speech'], consentVersion: 1,
    evidence: { qualified: true, accountRef: 'fixture', secretRef: 'fixture', model: 'grok-voice', endpoint: 'https://eu.us.example.test', routing: {}, verifiedAt: now - 1000, expiresAt: now + 1000 } } };
const project = b => providerProcessingFacts(b, { plugin, preset: 'best', policy: { endpoints: [b?.endpoint] }, now });
test('AIT-350: recipient seat is separate from unknown processing geography; endpoint and nationality imply no guarantee', () => {
  assert.deepEqual(project(binding), { vendor: 'xAI', recipientCountries: ['US'], processingCountries: null, verification: 'current' });
  const eu = structuredClone(binding); eu.legal.countries = ['DE'];
  assert.deepEqual(project(eu), { vendor: 'xAI', recipientCountries: ['DE'], processingCountries: null, verification: 'current' });
  assert.equal(JSON.stringify(project(binding)).includes('SpaceXAI'), false, 'legal entity not exposed for one provider only');
});
for (const state of ['absent', 'expired', 'mismatched']) test(`AIT-350: ${state} evidence cannot advertise regional guarantees`, () => {
  const b = structuredClone(binding); b.legal.processingCountries = ['US'];
  if (state === 'absent') delete b.legal.evidence;
  if (state === 'expired') b.legal.evidence.expiresAt = now;
  if (state === 'mismatched') b.legal.evidence.accountRef = 'other';
  assert.deepEqual(project(b), { vendor: 'xAI', recipientCountries: [], processingCountries: null, verification: 'unverified' });
});
test('AIT-350: only current binding-backed processing countries are projected', () => {
  const b = structuredClone(binding); b.legal.processingCountries = ['DE', 'FR'];
  assert.deepEqual(project(b).processingCountries, ['DE', 'FR']);
});
