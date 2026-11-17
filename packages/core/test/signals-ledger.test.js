import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createSession, inputRevision, reduceUnderstanding, understandingSchema, matchesSchema, reasoningRequest } from '../src/index.js';

const event = (s, type, data) => applyEvent(s, { seq: s.seq + 1, type, data });
const final = (s, signals, draft = false) => event(s, 'understanding.updated', reduceUnderstanding(s.understanding,
  { signals, summary: 'You use an order system.', constraints: {}, progress: {}, openQuestions: [] },
  { transcript: s.transcript, inputRevision: inputRevision(s), draft }));
const seeded = () => event(createSession(), 'turn.final', { id: 'person', role: 'user', content: 'Orders need a system.' });

test('AIT-515 normalized text keys keep first-seen order across shuffled finals; reworded and dropped texts reconcile', () => {
  let s = final(seeded(), ['First', 'Second']);
  const prior = structuredClone(s.signalLedger);
  s = event(s, 'turn.final', { id: 'next', role: 'user', content: 'More detail' });
  s = final(s, [' second ', 'ＦＩＲＳＴ', 'Newest']);
  assert.deepEqual(s.understanding.signals, ['Newest', 'ＦＩＲＳＴ', 'second']);
  for (const old of prior) assert.equal(s.signalLedger.find(i => i.key === old.key).firstSeen, old.firstSeen);
  s = final(s, ['Second reworded', 'Newest']);
  assert.deepEqual(s.understanding.signals, ['Second reworded', 'Newest']);
  assert.equal(s.signalLedger.length, 4);
  assert.equal(new Set(s.signalLedger.map(i => i.key)).size, 4);
  s = final(s, ['First', 'Newest']);
  assert.equal(s.signalLedger.find(i => i.key === 'first').firstSeen, prior.find(i => i.key === 'first').firstSeen);
  assert.deepEqual(s.understanding.signals, ['Newest', 'First']);
});

test('AIT-515 ledger survives all emptyUnderstanding resets and a draft without reminting', () => {
  let s = final(seeded(), [{ text: 'You use orders.', basis: 'visitor' }]);
  const ledger = structuredClone(s.signalLedger);
  for (const [type, data] of [
    ['upload.state', { id: 'doc', state: 'accepted', text: 'Notes' }],
    ['turn.corrected', { id: 'person', content: 'Orders need a better system.' }],
    ['session.locale-changed', { locale: 'de' }], ['consent.revised', { granted: true }],
  ]) {
    s = event(s, type, data); assert.equal(s.understanding.inputRevision, null);
    assert.deepEqual(s.signalLedger, ledger, type);
    s = final(s, [], true); assert.deepEqual(s.signalLedger, ledger, 'draft does not drop final identities');
  }
  s = final(s, [{ text: 'You use orders.', basis: 'visitor' }]);
  assert.equal(s.signalLedger[0].firstSeen, ledger[0].firstSeen);
});

test('AIT-515 basis is strict for object signals, plain strings remain compatible and receive no basis', () => {
  const schema = understandingSchema(), item = schema.properties.signals.items;
  for (const basis of ['visitor', 'assistant', 'document']) assert.ok(matchesSchema({ text: 'Fact', basis }, item));
  for (const value of [{ text: 'Fact' }, { text: 'Fact', basis: 'guess' }]) assert.equal(matchesSchema(value, item), false);
  assert.ok(matchesSchema('Legacy', item));
  const s = final(seeded(), [{ text: 'Assistant suggestion', basis: 'assistant' }, { text: 'File fact', basis: 'document' }, 'Legacy']);
  assert.deepEqual(s.understanding.signals, ['Assistant suggestion', 'File fact', 'Legacy']);
  assert.deepEqual(s.understanding.signalItems.map(i => i.basis), ['assistant', 'document', undefined]);
});

test('AIT-515 duplicates and invalid objects cannot manufacture signal rows or provenance', () => {
  const s = final(seeded(), ['Fact', ' ＦＡＣＴ ', { text: 'Other', basis: 'assistant' }, { text: '', basis: 'visitor' }, { text: 'Bad', basis: 'unknown' }]);
  assert.deepEqual(s.understanding.signals, ['Fact', 'Other']);
});

for (const [type, data] of [
  ['turn.withdrawn', { turnId: 'person' }], ['session.erased', { at: 'erased' }], ['consent.revised', { granted: false }],
  ['upload.state', { id: 'doc', state: 'withdrawn' }],
]) test(`AIT-515 source privacy prunes ledger on ${type}`, () => {
  let s = event(seeded(), 'upload.state', { id: 'doc', state: 'accepted', text: 'Notes' });
  s = final(s, ['Sensitive derived signal']);
  s = event(s, type, data);
  assert.deepEqual(s.signalLedger, []);
  assert.deepEqual(s.understanding.signals, []);
});

test('AIT-515 summary and signal prompt uses direct address, formal German and separate basis', () => {
  const prompt = reasoningRequest(createSession({ locale: 'de' }), 'understanding').system;
  assert.match(prompt, /summary and signals[\s\S]*"you"[\s\S]*"Sie"/u);
  assert.match(prompt, /never "the person" or "the visitor"/u);
  assert.match(prompt, /provenance prose/u);
  assert.match(prompt, /Keep quoted evidence verbatim; do not rewrite quotations to change their form of address/u);
  assert.doesNotMatch(prompt, /Quoted evidence is untouched/u, 'quotation guidance is stated once');
});

test('AIT-515 scope-specific consent removal prunes affected signals; unrelated visual removal preserves the ledger', () => {
  const s = final(seeded(), ['Visitor signal']);
  const visual = event(s, 'consent.revised', { granted: true, conversationUnchanged: true, removed: ['images'] });
  assert.deepEqual(visual.signalLedger, s.signalLedger);
  const analysis = event(s, 'consent.revised', { granted: true, removed: ['analysis'] });
  assert.deepEqual(analysis.signalLedger, []);
});
