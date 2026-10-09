import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_PRESET, capBuildReadiness, reduceUnderstanding, createPreset, displayedReadinessPercent,
  readinessStage, readinessScalePercent, readinessListItems, readinessListWindow, questionEntries,
  newlyClearedFirst, matchesSchema, understandingSchema, createSession, inputRevision, GENERIC_POLICY } from '../src/index.js';

const answer = value => ({ value, evidence: value });
const transcript = ['Hosting permitted', 'Public data', 'SAP', 'International'].map(content => ({ role: 'user', content }));
const raw = (overrides = {}) => ({ summary: 'Known picture', signals: ['SAP is available'], openQuestions: ['What is the deadline?'],
  constraints: { operations: answer('Hosting permitted'), data: answer('Public data'), systems: answer('SAP'),
    reach: answer('International'), requirements: null },
  progress: { talk: { value: .9, reasoning: '' }, build: { value: .9, reasoning: '' } }, actor: null, engagement: null, conceptIntent: null, ...overrides });
const reduce = (previous, value, options = {}) => reduceUnderstanding(previous, value, { transcript, inputRevision: '1:0:0:en', ...options });

test('START defaults: four required slots, optional requirements and 0.75 talk threshold', () => {
  assert.equal(START_PRESET.slots.length, 5); assert.equal(START_PRESET.requiredSlots.length, 4);
  assert.equal(START_PRESET.talkThreshold, .75);
  const qualified = capBuildReadiness(raw({ progress: { talk: { value: .75 }, build: { value: 1 } } }), transcript);
  assert.equal(qualified.progress.build.value, 1);
  assert.equal(qualified.constraints.requirements, null);
  assert.equal(readinessStage(qualified.progress), 'build');
});
test('START qualification: model build judgment is capped by person-supported required slots', () => {
  const qualified = capBuildReadiness(raw({ progress: { talk: { value: .9 }, build: { value: 1 } } }), transcript.slice(0, 2));
  assert.equal(qualified.progress.talk.value, .9); assert.equal(qualified.progress.build.value, .5);
  assert.equal(qualified.constraints.systems, null);
});
test('assistant statements and uploaded material cannot corroborate a slot', () => {
  const qualified = capBuildReadiness(raw(), [{ role: 'assistant', content: 'SAP' }, { role: 'document', content: 'SAP' }]);
  assert.equal(qualified.constraints.systems, null); assert.equal(qualified.progress.build.value, 0);
});
test('START qualification normalizes Unicode, whitespace and case and bounds slot prose', () => {
  const qualified = capBuildReadiness(raw({ constraints: { systems: { value: '  ＳＡＰ  ', evidence: ' SAP  ' } } }),
    [{ role: 'user', content: 'We use ＳＡＰ.' }]);
  assert.equal(qualified.constraints.systems.value, 'ＳＡＰ');
  const long = 'a'.repeat(600);
  const bounded = capBuildReadiness(raw({ constraints: { systems: answer(long) } }), [{ role: 'user', content: long }]);
  assert.equal(bounded.constraints.systems.value.length, 240); assert.equal(bounded.constraints.systems.evidence.length, 500);
});
test('START nonanswers stay open and invalid readiness becomes zero', () => {
  for (const value of ['unknown', 'offen', 'no answer']) {
    assert.equal(capBuildReadiness(raw({ constraints: { systems: answer(value) } })).constraints.systems, null);
  }
  const invalid = capBuildReadiness(raw({ constraints: { systems: { value: 'SAP', evidence: "I don't know" } },
    progress: { talk: { value: NaN }, build: { value: Infinity } } }));
  assert.equal(invalid.progress.talk.value, 0); assert.equal(invalid.progress.build.value, 0);
});
test('START hydrate: older assessments are explicitly unassessed', () => {
  assert.equal(capBuildReadiness({ summary: 'Legacy' }).readinessAssessed, false);
  assert.equal(capBuildReadiness(raw({ readinessAssessed: false })).readinessAssessed, false);
});
test('START incremental draft nulls preserve corroborated answers, summary, signals and readiness', () => {
  const previous = reduce(null, raw());
  const draft = reduce(previous, raw({ summary: 'Preliminary', signals: [], constraints: {}, openQuestions: [],
    progress: { talk: { value: .2 }, build: { value: .2 } } }), { draft: true });
  assert.equal(draft.draft, true); assert.equal(draft.summary, previous.summary); assert.deepEqual(draft.signals, previous.signals);
  assert.equal(draft.constraints.systems.value, 'SAP'); assert.equal(draft.progress.talk.value, .9);
  assert.equal(draft.progress.build.value, .9); assert.deepEqual(draft.openQuestions, []);
});
test('START draft merge re-caps the raw judgment against merged slots', () => {
  const previous = reduce(null, raw({ constraints: { operations: answer('Hosting permitted') },
    progress: { talk: { value: .9 }, build: { value: 1 } } }));
  const draft = reduce(previous, raw({ constraints: { systems: answer('SAP') },
    progress: { talk: { value: .2 }, build: { value: 1 } } }), { draft: true });
  assert.equal(draft.progress.build.value, .5);
});
test('START final synthesis may reopen facts and lower readiness', () => {
  const previous = reduce(null, raw());
  const final = reduce(previous, raw({ constraints: {}, summary: 'Corrected', progress: { talk: { value: .2 }, build: { value: .2 } } }));
  assert.equal(final.constraints.systems, null); assert.equal(final.summary, 'Corrected'); assert.equal(final.progress.talk.value, .2);
  assert.equal(final.progress.build.value, 0); assert.equal(final.draft, false);
});
test('START incremental merge cannot resurrect evidence removed from transcript', () => {
  const previous = reduce(null, raw());
  const draft = reduce(previous, raw({ constraints: {} }), { draft: true, transcript: transcript.slice(0, 1) });
  assert.equal(draft.constraints.systems, null); assert.equal(draft.progress.build.value, .25);
});
test('START human-selected actor wins over model; engagement remains separate', () => {
  const actor = { type: 'agency', evidence: 'selected', reasoning: 'Human choice' };
  const result = reduce(null, raw({ actor: { type: 'company', evidence: 'inferred', reasoning: 'Guess' },
    engagement: { kind: 'both', evidence: 'stated', reasoning: 'Both' } }), { actor });
  assert.deepEqual(result.actor, actor); assert.equal(result.engagement.kind, 'both');
});
test('START readiness never rounds incomplete values to 100 and talk maps to the 30% marker', () => {
  assert.equal(displayedReadinessPercent(.9999), 99);
  for (const [talk, build, scale, stage] of [[.74, 0, 29, 'continue'], [.75, 0, 30, 'talk'], [.9, .5, 65, 'talk'], [.9, .999, 99, 'talk'], [0, 1, 100, 'build']]) {
    const progress = { talk: { value: talk }, build: { value: build } };
    assert.equal(readinessScalePercent(progress), scale); assert.equal(readinessStage(progress), stage);
  }
});
test('host preset changes slots, taxonomy and thresholds without brand policy', () => {
  const preset = createPreset({ slots: ['one', 'two'], requiredSlots: ['one'], talkThreshold: .5, actors: ['team'] });
  const result = capBuildReadiness(raw({ constraints: { one: answer('SAP') }, progress: { talk: { value: .5 }, build: { value: 1 } } }), transcript, preset);
  assert.equal(result.progress.build.value, 1); assert.equal(readinessScalePercent(result.progress, preset), 100);
  assert.throws(() => createPreset({ talkThreshold: 0 }));
});
test('START question history settles disappeared items without phantom rewordings', () => {
  const entries = questionEntries(['Which ERP interface handles orders?', 'When is the deadline?'], ['Which ERP interface handles customer orders?']);
  assert.equal(entries.length, 2); assert.equal(entries[0].answered, false); assert.equal(entries[1].answered, true);
});
test('START missing rows show at most five plus overflow and cleared rows retain ordering', () => {
  const copy = { names: Object.fromEntries(START_PRESET.slots.map(s => [s, s])), questions: Object.fromEntries(START_PRESET.slots.map(s => [s, s + '?'])) };
  const items = readinessListItems({}, [], ['Deadline?', 'Budget?'], copy);
  assert.equal(readinessListWindow(items.open).rows.length, 5); assert.equal(readinessListWindow(items.open).remainder, 2);
  const next = [{ key: 'b' }, { key: 'a' }]; assert.deepEqual(newlyClearedFirst(['a'], ['b'], next), [{ key: 'a' }, { key: 'b' }]);
});
test('reasoning schema rejects wrong or extra fields and policy contains only generic rules', () => {
  const schema = understandingSchema(); assert.equal(matchesSchema(raw(), schema), true);
  assert.equal(matchesSchema({ ...raw(), unexpected: 'x' }, schema), false);
  assert.equal(matchesSchema(raw({ constraints: {} }), schema), false);
  assert.doesNotMatch(GENERIC_POLICY, /Augmentoring|Austria|offer/iu);
});
test('input revision includes consent/withdrawal and locale changes', () => {
  const s = createSession(); const original = inputRevision(s); s.consentRevision++;
  assert.notEqual(inputRevision(s), original); s.withdrawalRevision++;
  assert.equal(inputRevision(s), '0:1:1:en:0:false');
  s.sessionRevision++; assert.notEqual(inputRevision(s), '0:1:1:en:0:false');
  s.tombstone = 'erased'; assert.match(inputRevision(s), /:true$/u);
});

test('a German session prompts German replies and the mock reads German slot markers (AIT-116 D1)', async () => {
  const { createMockReasoning, reasoningRequest, applyEvent } = await import('../src/index.js');
  let session = createSession({ locale: 'de' });
  session = applyEvent(session, { seq: 1, type: 'turn.final', data: { id: 'u1', role: 'user',
    content: 'Wir sind eine Tischlerei. Betrieb: wir hosten selbst; Daten: nur intern; Systeme: SAP; Reichweite: Österreich' } });
  const request = reasoningRequest(session, 'understanding');
  assert.match(request.system, /Write in German \(locale de\)/u); assert.equal(request.locale, 'de');
  const mock = createMockReasoning(), result = await mock.structured(request, {});
  assert.deepEqual(['operations', 'data', 'systems', 'reach'].map(slot => result.constraints[slot]?.value),
    ['wir hosten selbst', 'nur intern', 'SAP', 'Österreich']);
  assert.deepEqual(result.openQuestions, ['Welches Ergebnis wäre für Sie nützlich?']);
  let reply = ''; for await (const chunk of mock.stream(reasoningRequest(session, 'reaction'), {})) reply += chunk;
  assert.equal(reply, 'Was sollte sich als Erstes verbessern?');
  assert.match(reasoningRequest(createSession(), 'reaction').system, /Write in English \(locale en\)/u);
});
