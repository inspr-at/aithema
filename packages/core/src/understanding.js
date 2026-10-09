// Adapted from START qualification.ts and api/analyze.ts; rights held by INSPR (D3).
export const START_PRESET = Object.freeze({
  slots: Object.freeze(['operations', 'data', 'systems', 'reach', 'requirements']),
  requiredSlots: Object.freeze(['operations', 'data', 'systems', 'reach']),
  actors: Object.freeze(['private', 'company', 'representative', 'agency']),
  engagements: Object.freeze(['process', 'product', 'both']),
  talkThreshold: 0.75,
  talkMarker: 30,
  anonymousTurns: 3,
});

export function createPreset(overrides = {}) {
  const preset = { ...START_PRESET, ...overrides };
  if (!Array.isArray(preset.slots) || !preset.slots.length || preset.slots.length > 24 ||
      new Set(preset.slots).size !== preset.slots.length ||
      preset.slots.some(s => typeof s !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/u.test(s)) ||
      !preset.requiredSlots.length || preset.requiredSlots.some(s => !preset.slots.includes(s)) ||
      !Number.isFinite(preset.talkThreshold) || preset.talkThreshold <= 0 || preset.talkThreshold > 1 ||
      !Number.isFinite(preset.talkMarker) || preset.talkMarker <= 0 || preset.talkMarker >= 100 ||
      !Number.isInteger(preset.anonymousTurns) || preset.anonymousTurns < 1) {
    throw new TypeError('Invalid understanding preset');
  }
  return structuredClone(preset);
}

export const safeReadiness = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(1, Math.max(0, value)) : 0;
export const displayedReadinessPercent = value => Math.floor(safeReadiness(value) * 100);
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const nonAnswers = new Set(['keine angabe', 'nicht angegeben', 'offen', 'unklar', 'unbekannt',
  'no answer', 'not provided', 'not specified', 'open', 'unclear', 'unknown']);
const nonEvidence = /\b(?:keine angabe|nicht (?:bekannt|angegeben)|(?:weiß|weiss) ich nicht|no (?:answer|information)|not (?:known|specified|provided)|i (?:do not|don't) know)\b/u;
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function cleanQuestions(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string')
    .map(v => v.replace(/\s+/gu, ' ').trim().slice(0, 500)).filter(Boolean))].slice(0, 24);
}
export function constraintAnswer(raw) {
  if (!raw || typeof raw.value !== 'string' || typeof raw.evidence !== 'string') return null;
  const value = raw.value.replace(/\s+/gu, ' ').trim().slice(0, 240);
  const evidence = raw.evidence.replace(/\s+/gu, ' ').trim().slice(0, 500);
  return !value || !evidence || nonAnswers.has(normalize(value)) || nonEvidence.test(normalize(evidence))
    ? null : { value, evidence };
}
export const isConstraintAnswered = raw => constraintAnswer(raw) !== null;
export function corroborateConstraintSlots(slots, transcript, preset = START_PRESET) {
  const statements = transcript.filter(t => t.role === 'user' && !t.erased && !t.withdrawn).map(t => normalize(t.content));
  return Object.fromEntries(preset.slots.map(slot => {
    const answer = constraintAnswer(slots?.[slot]);
    return [slot, answer && statements.some(s => s.includes(normalize(answer.evidence))) ? answer : null];
  }));
}
export function capBuildReadiness(raw, transcript, preset = START_PRESET) {
  const constraints = transcript ? corroborateConstraintSlots(raw.constraints, transcript, preset)
    : Object.fromEntries(preset.slots.map(s => [s, constraintAnswer(raw.constraints?.[s])]));
  const share = preset.requiredSlots.filter(s => constraints[s]).length / preset.requiredSlots.length;
  const reading = (value, key, taxonomy) => value && taxonomy.includes(value[key]) &&
    ['stated', 'inferred', 'selected'].includes(value.evidence)
    ? { [key]: value[key], evidence: value.evidence, reasoning: text(value.reasoning, 500) } : null;
  return {
    summary: text(raw.summary), signals: cleanQuestions(raw.signals), openQuestions: cleanQuestions(raw.openQuestions),
    constraints,
    progress: {
      talk: { value: safeReadiness(raw.progress?.talk?.value), reasoning: text(raw.progress?.talk?.reasoning, 500) },
      build: { value: Math.min(safeReadiness(raw.progress?.build?.value), share), reasoning: text(raw.progress?.build?.reasoning, 500) },
    },
    actor: reading(raw.actor, 'type', preset.actors),
    engagement: reading(raw.engagement, 'kind', preset.engagements),
    readinessAssessed: raw.readinessAssessed ?? (raw.progress !== undefined && raw.constraints !== undefined),
  };
}

export function reduceUnderstanding(previous, raw, { transcript, inputRevision, locale = 'en', draft = false,
  actor = null, preset = START_PRESET }) {
  let next = capBuildReadiness(raw, transcript, preset);
  if (draft && previous?.readinessAssessed) {
    next = capBuildReadiness({
      ...previous, summary: previous.summary, signals: previous.signals, openQuestions: next.openQuestions,
      constraints: Object.fromEntries(preset.slots.map(s => [s, next.constraints[s] ?? previous.constraints[s] ?? null])),
      progress: {
        talk: { ...next.progress.talk, value: Math.max(previous.progress.talk.value, next.progress.talk.value) },
        build: { ...next.progress.build, value: Math.max(previous.progress.build.value, safeReadiness(raw.progress?.build?.value)) },
      },
    }, transcript, preset);
  }
  if (actor?.evidence === 'selected') next.actor = structuredClone(actor);
  return { ...next, version: 1, inputRevision, locale, draft,
    questionHistory: cleanQuestions([...next.openQuestions, ...(previous?.questionHistory ?? [])]) };
}

export function understandingSchema(preset = START_PRESET) {
  const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const string = { type: 'string' };
  const answer = { anyOf: [object({ value: string, evidence: string }), { type: 'null' }] };
  const reading = (key, values) => ({ anyOf: [object({ [key]: { type: 'string', enum: values },
    evidence: { type: 'string', enum: ['stated', 'inferred'] }, reasoning: string }), { type: 'null' }] });
  const readiness = object({ value: { type: 'number', minimum: 0, maximum: 1 }, reasoning: string });
  return object({ summary: string, signals: { type: 'array', items: string }, openQuestions: { type: 'array', items: string },
    constraints: object(Object.fromEntries(preset.slots.map(s => [s, answer]))),
    progress: object({ talk: readiness, build: readiness }), actor: reading('type', preset.actors),
    engagement: reading('kind', preset.engagements) });
}
