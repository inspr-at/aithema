import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, invocationOptions, flush } from './fixtures.js';
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

test('AIT-505: SDK greeting received while paused is dropped before persistence', async t => {
  const instant=1800000000000;t.mock.timers.enable({apis:['Date'],now:instant});
  const local=fixture({now:()=>instant});
  const session=await local.client.start({callId:'paused-host-opener'},invocationOptions());
  t.after(()=>session.close());
  await session.pause();
  local.sdk.starts[0].onMessage({role:'agent',event_id:0,message:opener.en});await flush();
  assert.equal(local.persisted.some(event=>event.type==='final'),false);
  await session.resume();
  local.sdk.starts[0].onMessage({role:'agent',event_id:1,message:'A real reply.'});await flush();
  const finals=local.persisted.filter(event=>event.type==='final');
  assert.equal(finals.length,1);assert.equal(finals[0].text,'A real reply.');
});

for (const locale of ['en', 'de']) test(`AIT-538: ${locale} presentation receives and returns the exact host opener`, () => {
  const contexts = [], callback = bind({ opener, presentation(language, ctx) {
    contexts.push(ctx); return { agent: { language, firstMessage: ctx.hostOpener } };
  } });
  const prepare = options => callback.prepareCallback({ callId: 'fixture', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale, ...options });
  const result = prepare({ hostOpener: opener[locale] });
  assert.deepEqual(contexts[0], { hasPriorTurns: false, hostOpener: opener[locale] });
  assert.equal(result.request.overrides.agent.firstMessage, opener[locale]);
  assert.equal(result.hostOpener, true);
  prepare({ continuation: true, explicitResume: true, hasPriorTurns: true, hostOpener: opener[locale] });
  assert.deepEqual(contexts.at(-1), { hasPriorTurns: true });
});
for (const transform of ['trim', 'wrap', 'language']) test(`AIT-538: ${transform} cannot claim verbatim host speech`, () => {
  const text = ` ${opener.en} `;
  const callback = bind({ opener: { en: text }, presentation(locale, ctx) {
    return { agent: { language: transform === 'language' ? 'de' : locale,
      firstMessage: transform === 'trim' ? ctx.hostOpener?.trim() : transform === 'wrap' ? `Hello. ${ctx.hostOpener}` : ctx.hostOpener } };
  } });
  const result = callback.prepareCallback({ callId: 'fixture', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale: 'en', hostOpener: text });
  assert.equal(result.hostOpener, false);
});
test('AIT-538: disclosure is checked per locale at startup and per exact forwarded string', () => {
  const logs = [], contexts = [];
  const callback = bind({ opener: { en: opener.en, de: 'Willkommen.' }, log: value => logs.push(value),
    presentation(locale, ctx) { contexts.push(ctx); return { agent: { language: locale, firstMessage: ctx.hostOpener ?? opener[locale] } }; } });
  assert.deepEqual(logs, [{ event: 'voice.host-opener-fallback', locale: 'de' }]);
  const prepare = (locale, text) => callback.prepareCallback({ callId: 'fixture', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale, hostOpener: text });
  const passing = prepare('en', opener.en); assert.equal(passing.hostOpener, true);
  const failing = prepare('de', 'Willkommen.');
  assert.equal(failing.request.overrides.agent.firstMessage, opener.de);
  assert.equal(failing.hostOpener, false); assert.deepEqual(contexts.at(-1), { hasPriorTurns: false });
  const changed = prepare('en', 'A human is ready.');
  assert.equal(changed.request.overrides.agent.firstMessage, opener.en);
  assert.equal(changed.hostOpener, false);
  assert.equal(JSON.stringify(logs).includes('Willkommen'), false);
});
