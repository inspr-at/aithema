import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const GERMAN_ADDRESS_RULE = 'When the conversation language is German, address the person with the polite Sie form consistently (never du or ihr); use idiomatic German.';

for (const draft of [false, true]) for (const assistantFinal of [false, true]) {
  test(`AIT-198 ${draft ? 'draft' : 'final'} analysis ends in user role with ${assistantFinal ? 'assistant' : 'user'}-final transcript`, () => {
    let session = core.applyEvent(core.createSession(), { seq: 1, type: 'turn.final',
      data: { id: 'person', role: 'user', content: 'We need a booking system.' } });
    if (assistantFinal) session = core.applyEvent(session, { seq: 2, type: 'turn.final',
      data: { id: 'reply', role: 'assistant', content: 'Who needs access?' } });
    const request = core.reasoningRequest(session, 'understanding', draft);
    assert.equal(request.messages.at(-1).role, 'user');
    assert.match(request.messages.at(-1).content, /structured read-back/u);
    assert.ok(request.messages.some(message => message.role === 'user' && message.content === 'We need a booking system.'));
    if (assistantFinal) assert.ok(request.messages.some(message => message.role === 'assistant' && message.content === 'Who needs access?'));
    assert.equal(core.activeTurns(session).at(-1).role, assistantFinal ? 'assistant' : 'user', 'prompt construction does not mutate the session');
  });
}

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

for (const locale of ['en', 'de']) for (const draft of [false, true]) {
  test(`AIT-503 ${locale} ${draft ? 'draft' : 'final'} understanding reconciliation prompt snapshot`, () => {
    const session = core.createSession({ locale });
    const { system } = core.reasoningRequest(session, 'understanding', draft);
    const expected = `Reconcile every prior open question against all later visitor answers in the canonical transcript.
Drop answered questions; reword partly answered questions to ask only what is still open. Keep genuinely ambiguous questions.
Address the visitor directly in visitor-facing question text: use "you" in English and "Sie" in German, never "the person".`;
    const start = system.indexOf('Reconcile every prior open question');
    assert.notEqual(start, -1, 'understanding needs its own reconciliation rule');
    assert.equal(system.slice(start, start + expected.length), expected);
    assert.match(system, /Return the requested structured read-back/u);
    assert.doesNotMatch(system, /Never open formulaically/u);
  });
}

for (const locale of ['en', 'de']) for (const draft of [false, true]) {
  test(`AIT-514 ${locale} ${draft ? 'draft' : 'final'} summary and signals address the visitor without editing evidence`, () => {
    const session = core.createSession({ locale });
    session.transcript = [{ id: 'quote', role: 'user', content: 'The quote says "the person".' }];
    const request = core.reasoningRequest(session, 'understanding', draft);
    assert.match(request.system, /Address the visitor directly in summary and signals: use "you" in English and "Sie" in German, never "the person" or "the visitor"/u);
    assert.match(request.system, /Keep quoted evidence verbatim; do not rewrite quotations to change their form of address/u);
    assert.equal(request.messages.find(m => m.content === session.transcript[0].content)?.content, session.transcript[0].content);
  });
}
