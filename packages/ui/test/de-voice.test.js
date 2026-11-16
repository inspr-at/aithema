import { test } from 'node:test';
import assert from 'node:assert/strict';
import { de } from '../src/i18n/de.js';

// Tick AIT-426 v1: Aithema's own UI voice is impersonal: no wir/uns/unser
// or ich/mich/mir/mein. Exempt voices are the assistant speaking as itself
// (including demo dialogue) and the visitor's own option labels.
// Allow by i18n key only, never by matching the text.
const personalVoice = new Set([
  'voiceStates.listening', // Assistant voice: listening state.
  'voiceStatesNarrow.listening', // Assistant voice: compact listening state.
  'purposeRedirects.0', // Assistant voice: off-topic reply.
  'purposeRedirects.1', // Assistant voice: off-topic reply.
  'purposeRedirects.2', // Assistant voice: off-topic reply.
  'fakeVoiceGreeting', // Assistant voice: demo dialogue greeting.
  'fakeVoiceReply', // Assistant voice: demo dialogue reply.
  'fakeVoiceStatement', // Visitor voice: demo dialogue statement.
  'conceptUp', // Visitor voice: like option label.
  'conceptDown', // Visitor voice: dislike option label.
  'presets.device', // Visitor voice: own device option label.
  'settings.toDevice', // Visitor voice: own device option label quoted in guidance.
  'help.device', // Visitor voice: own device option label in help.
  'local.useForConversation', // Visitor voice: own device option label quoted in guidance.
  'deviceConversation', // Visitor voice: own device option label in conversation status.
]);
const firstPerson = /\b(wir|uns|unser\w*|ich|mich|mir|mein\w*)\b/iu;
const leaves = (value, path = []) => typeof value === 'string'
  ? [[path.join('.'), value]]
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key])) : [];

test('AIT-436: the impersonal UI guard catches mir outside the key allowlist', () => {
  const fixture = { contactPrompt: 'Schreiben Sie mir' };
  const violations = leaves(fixture).filter(([key, text]) => !personalVoice.has(key) && firstPerson.test(text));
  assert.deepEqual(violations, [['contactPrompt', fixture.contactPrompt]]);
});

test('AIT-426: German defaults use an impersonal UI voice outside Tick’s key allowlist', () => {
  const strings = new Map(leaves(de));
  for (const key of personalVoice) {
    assert.ok(strings.has(key), `allowlisted i18n key exists: ${key}`);
    assert.match(strings.get(key), firstPerson, `allowlist remains necessary: ${key}`);
  }
  const violations = [...strings].filter(([key, text]) => !personalVoice.has(key) && firstPerson.test(text));
  assert.deepEqual(violations, [], 'Aithema’s German UI voice must be impersonal');
});

test('AIT-426: Tick v1 wording and the 90-day nonbreaking space stay exact', () => {
  const strings = new Map(leaves(de));
  for (const [key, expected] of Object.entries({
    signals: 'Was konkret erkennbar war',
    'hostSurface.verify.sent': 'Der Bestätigungslink wurde gesendet. Öffnen Sie Ihr Postfach und bestätigen Sie den Link.',
    'hostSurface.verify.saved': 'Ihre E‑Mail-Adresse ist gespeichert. Bestätigen Sie sie über den Link in der Bestätigungsmail, um die Einschätzung anzusehen.',
    'hostSurface.email.notice': 'Ihre E‑Mail-Adresse wird nur für Ihr Guthaben und später für eine Bestätigungsmail verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.',
    'hostSurface.email.noticeSave': 'Ihre E‑Mail-Adresse wird nur für Ihr Guthaben verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.',
    'hostSurface.email.noticeMail': 'Ihre E‑Mail-Adresse wird nur für Ihr Guthaben und die Bestätigungsmail verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.',
    'hostSurface.email.noticeHandover': 'Für eine persönliche Weiterführung werden Sie gesondert gefragt.',
    'hostSurface.handover.sent': 'Ihre Anfrage wurde gesendet. Sie erhalten eine persönliche Rückmeldung.',
    'constraints.questions.requirements': 'Gibt es Auflagen, die zu beachten sind?',
  })) assert.equal(strings.get(key), expected, key);
});
