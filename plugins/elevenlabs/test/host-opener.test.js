import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../src/callbacks.js';
const opener = { en: 'Welcome. Your AI assistant is ready.', de: 'Willkommen. Ihre KI-Assistenz ist bereit.' };
const bind = options => elevenLabsCallbackPort.bindCallbacks({ secrets: createFacadeSecrets(), getCall() {}, buildRequest() {}, admitReasoning() {}, ...options });
test('AIT-505: disclosure validation fails closed at callback startup', () => {
  assert.throws(() => bind({ opener: { en: 'Welcome from a human.' } }), TypeError);
  assert.throws(() => bind({ opener: { de: opener.en } }), TypeError);
});
for (const locale of ['en', 'de']) test(`AIT-505: ${locale} host opener is fresh-only; custom presentation wins`, () => {
  const callback = bind({ opener });
  const prepare = options => callback.prepareCallback({ callId: 'fixture', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale, ...options });
  assert.equal(prepare({ hostOpener: opener[locale], hasPriorTurns: false }).request.overrides.agent.firstMessage, opener[locale]);
  assert.equal(prepare({ hostOpener: opener[locale], hasPriorTurns: false }).hostOpener, true);
  assert.notEqual(prepare({ hasPriorTurns: true }).request.overrides.agent.firstMessage, opener[locale]);
  assert.equal(prepare({ continuation: true }).request.overrides.agent.firstMessage, '');
  const presentation = () => ({ agent: { language: locale, firstMessage: 'Custom presentation.' } });
  const custom = bind({ opener: { en: 'Text only; no disclosure required.' }, presentation });
  const result = custom.prepareCallback({ callId: 'fixture', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale, hostOpener: opener[locale] });
  assert.deepEqual(result.request.overrides, presentation());
  assert.notEqual(result.hostOpener, true);
});
