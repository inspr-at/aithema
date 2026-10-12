import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const GERMAN_ADDRESS_RULE = 'When the conversation language is German, address the person with the polite Sie form consistently (never du or ihr); use idiomatic German.';

for (const [locale, language, answer] of [
  ['de', 'German', 'Ein bis zwei Polster insgesamt.'],
  ['en', 'English', 'One or two cushions total.'],
]) {
  const session = core.applyEvent(core.createSession({ locale }), { seq: 1, type: 'turn.final',
    data: { id: 'answer', role: 'user', content: answer } });

  test(`AIT-148: ${locale} text replies reject stock openings and respect confirmed answers`, () => {
    const { system } = core.reasoningRequest(session, 'reaction');
    assert.ok(system.includes(`Write in ${language} (locale ${locale})`));
    assert.match(system, /Ask at most one question per reply/u);
    assert.match(system, /canonical person turns and the latest callback answer take precedence/u);
    assert.match(system, /Never open formulaically with "Danke", "Vielen Dank", "Thanks" or "Thank you"/u);
    assert.match(system, /Do not replace these with another repeated stock opener or praise/u);
    assert.match(system, /Vary acknowledgements and engage directly/u);
    assert.match(system, /Never re-ask[^\n]*canonical person turns[^\n]*already answer, confirm or decline/u);
    assert.match(system, /Reopen a confirmed fact only when/u);
  });

  test(`AIT-148: ${locale} text replies do not inherit voice-only rules`, () => {
    const { system } = core.reasoningRequest(session, 'reaction');
    assert.doesNotMatch(system, /two or three short sentences|at most 60 words/iu);
    assert.doesNotMatch(system, /Do not read back[^\n]*summary|without lists or reasoning aloud/iu);
    assert.doesNotMatch(system, /stale or draft, ignore its open questions|focused question is only a suggestion/iu);
  });
}

test('AIT-148: core exports the shared reply policy and includes it once in text replies', () => {
  assert.equal(typeof core.REPLY_POLICY, 'string');
  assert.ok(core.REPLY_POLICY.length > 0);
  const { system } = core.reasoningRequest(core.createSession(), 'reaction');
  assert.equal(system.split(core.REPLY_POLICY).length, 2);
});

test('AIT-148: the understanding lane retains structured read-back without reply guidance', () => {
  const { system } = core.reasoningRequest(core.createSession(), 'understanding');
  assert.match(system, /Return the requested structured read-back/u);
  assert.doesNotMatch(system, /Never open formulaically/u);
});

for (const [locale, language, answer] of [
  ['de', 'German', 'We need a booking system.'],
  ['en', 'English', 'Wir brauchen ein Buchungssystem.'],
]) {
  // Output language follows the session's conversation locale, even when a
  // person turn uses another language. The German address rule is conditional.
  const session = core.applyEvent(core.createSession({ locale }), { seq: 1, type: 'turn.final',
    data: { id: 'answer', role: 'user', content: answer } });

  test(`AIT-150: ${locale} text replies inherit the conditional German address rule once`, () => {
    const { system } = core.reasoningRequest(session, 'reaction');
    assert.ok(core.GENERIC_POLICY.includes(GERMAN_ADDRESS_RULE));
    assert.ok(system.includes(GERMAN_ADDRESS_RULE));
    assert.equal(system.split('polite Sie form').length, 2);
    assert.ok(system.includes(`Write in ${language} (locale ${locale})`));
    assert.doesNotMatch(system, /when the locale is German/u);
  });

  for (const draft of [false, true]) {
    test(`AIT-150: ${locale} ${draft ? 'draft' : 'final'} understanding inherits the conditional German address rule`, () => {
      const { system } = core.reasoningRequest(session, 'understanding', draft);
      assert.ok(system.includes(GERMAN_ADDRESS_RULE));
      assert.equal(system.split('polite Sie form').length, 2);
      assert.ok(system.includes(`Write in ${language} (locale ${locale})`));
      assert.match(system, /Return the requested structured read-back/u);
    });
  }
}
