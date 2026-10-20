import { test } from 'node:test';
import assert from 'node:assert/strict';
import { de } from '../src/i18n/de.js';

// Tick AIT-426 v1: Aithema's own UI voice is impersonal: no wir/uns/unser
// or ich/mich/mein. Exempt voices are the assistant speaking as itself
// (including demo dialogue) and the visitor's own option labels.
// Allow by i18n key only, never by matching the text.
const personalVoice = new Set([
  'voiceStates.listening', // Assistant voice: listening state.
  'voiceStatesNarrow.listening', // Assistant voice: compact listening state.
  'purposeRedirects.0', // Assistant voice: off-topic reply.
  'purposeRedirects.1', // Assistant voice: off-topic reply.
  'purposeRedirects.2', // Assistant voice: off-topic reply.
  'fakeVoiceReply', // Assistant voice: demo dialogue reply.
  'fakeVoiceStatement', // Visitor voice: demo dialogue statement.
  'presets.device', // Visitor voice: own device option label.
  'settings.toDevice', // Visitor voice: own device option label quoted in guidance.
  'help.device', // Visitor voice: own device option label in help.
  'local.useForConversation', // Visitor voice: own device option label quoted in guidance.
  'deviceConversation', // Visitor voice: own device option label in conversation status.
]);
const firstPerson = /\b(wir|uns|unser\w*|ich|mich|mein\w*)\b/iu;
const leaves = (value, path = []) => typeof value === 'string'
  ? [[path.join('.'), value]]
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key])) : [];

test('AIT-426: German defaults use an impersonal UI voice outside Tick’s key allowlist', () => {
  const strings = new Map(leaves(de));
  for (const key of personalVoice) {
    assert.ok(strings.has(key), `allowlisted i18n key exists: ${key}`);
    assert.match(strings.get(key), firstPerson, `allowlist remains necessary: ${key}`);
  }
  const violations = [...strings].filter(([key, text]) => !personalVoice.has(key) && firstPerson.test(text));
  assert.deepEqual(violations, [], 'Aithema’s German UI voice must be impersonal');
});
