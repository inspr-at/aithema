// START guided-pass.ts/readiness-view.ts display semantics, with host slot names.
import { START_PRESET, cleanQuestions, displayedReadinessPercent, isConstraintAnswered } from './understanding.js';
export function readinessStage(progress, preset = START_PRESET) {
  if (displayedReadinessPercent(progress.build.value) === 100) return 'build';
  return displayedReadinessPercent(progress.talk.value) >= preset.talkThreshold * 100 ? 'talk' : 'continue';
}
export function readinessScalePercent(progress, preset = START_PRESET) {
  const talk = displayedReadinessPercent(progress.talk.value);
  const build = displayedReadinessPercent(progress.build.value);
  if (build === 100) return 100;
  if (talk < preset.talkThreshold * 100) return Math.floor(talk / (preset.talkThreshold * 100) * preset.talkMarker);
  return Math.floor(preset.talkMarker + build / 100 * (100 - preset.talkMarker));
}
export function questionsLikelyMatch(a, b) {
  const words = q => new Set(q.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u).filter(w => w.length >= 3));
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return a.trim() === b.trim();
  return [...left].filter(w => right.has(w)).length / Math.min(left.size, right.size) >= 0.7;
}
export function questionEntries(history, questions) {
  const open = cleanQuestions(questions);
  return [...open.map(question => ({ question, answered: false })),
    ...cleanQuestions(history).filter(q => !open.some(o => questionsLikelyMatch(q, o)))
      .map(question => ({ question, answered: true }))];
}
export function readinessListItems(slots, history, questions, copy, preset = START_PRESET) {
  const items = preset.slots.map(s => ({ key: `constraint:${s}`, label: copy.names[s],
    detail: isConstraintAnswered(slots[s]) ? slots[s].value : copy.questions[s],
    evidence: slots[s]?.evidence, answered: isConstraintAnswered(slots[s]) }));
  items.push(...questionEntries(history, questions).map(q => ({ key: `question:${q.question}`,
    label: null, detail: q.question, answered: q.answered })));
  return { open: items.filter(i => !i.answered), cleared: items.filter(i => i.answered) };
}
export function readinessListWindow(items) {
  return { rows: items.slice(0, 5), remainder: Math.max(0, items.length - 5) };
}
export function newlyClearedFirst(previousOpen, previousCleared, next) {
  const byKey = new Map(next.map(i => [i.key, i]));
  return [...new Set([...previousOpen, ...previousCleared, ...byKey.keys()])]
    .filter(k => byKey.has(k)).map(k => byKey.get(k));
}
