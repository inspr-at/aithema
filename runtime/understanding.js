/**
 * Generic evolving understanding and one-at-a-time next-question pacing.
 * Question merge / overlap heuristics are a pattern port of START
 * `src/lib/guided-pass.ts` without agency slot names, copy, or offer routing.
 */

import { currentBaseline, proposeRequirement, proposeRequirementUpdate } from '../lib/stream.js';
import { validateProjectKinds, validateRequirement } from '../lib/validate.js';

export const MAX_TRACKED_QUESTIONS = 24;
export const MAX_GUIDED_ITEMS = 5;
export const MAX_QUESTION_CHARS = 500;
export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_FACT_CHARS = 1_000;
export const MAX_CANDIDATES = 12;

/**
 * @typedef {{
 *   summary: string,
 *   facts: readonly { key: string, value: string, evidence: string }[],
 *   open_questions: readonly string[],
 *   next_question: string,
 *   candidate_requirements: readonly {
 *     requirement_ref: string,
 *     statement: string,
 *     acceptance_criteria: readonly string[],
 *     constraint_refs: readonly string[],
 *   }[],
 *   project_kinds: readonly string[],
 * }} UnderstandingSnapshot
 */

/**
 * @param {readonly unknown[]} questions
 * @returns {string[]}
 */
export function cleanQuestions(questions) {
  const seen = new Set();
  const result = [];
  for (const value of questions) {
    if (typeof value !== 'string') continue;
    const question = value.replace(/\s+/gu, ' ').trim().slice(0, MAX_QUESTION_CHARS);
    if (question === '' || seen.has(question)) continue;
    seen.add(question);
    result.push(question);
    if (result.length >= MAX_TRACKED_QUESTIONS) break;
  }
  return result;
}

const questionWords = (question) => new Set(
  question
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length >= 3),
);

/** Prevents a harmless model rewording from creating a checked phantom copy. */
export function questionsLikelyMatch(left, right) {
  const a = questionWords(left);
  const b = questionWords(right);
  if (a.size === 0 || b.size === 0) return left.trim() === right.trim();
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / Math.min(a.size, b.size) >= 0.7;
}

/**
 * Keeps questions which disappeared from a later assessment as settled work.
 * @param {readonly string[]} history
 * @param {readonly string[]} openQuestions
 */
export function mergeQuestionHistory(history, openQuestions) {
  return cleanQuestions([...openQuestions, ...history]);
}

/**
 * One visitor answer advances to one next question, never a batch.
 * @param {readonly string[]} openQuestions
 * @param {string} [current]
 */
export function focusedNextQuestion(openQuestions, current) {
  const open = cleanQuestions(openQuestions).slice(0, MAX_GUIDED_ITEMS);
  if (open.length === 0) return '';
  if (!current) return open[0];
  const index = open.findIndex((item) => questionsLikelyMatch(item, current));
  if (index === -1) return open[0];
  return open[index + 1] ?? '';
}

/**
 * Provider output is untrusted. Invalid snapshots fail closed and must not
 * become proposals or durable understanding.
 * @param {unknown} value
 * @returns {UnderstandingSnapshot}
 */
export function validateUnderstanding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('understanding snapshot must be an object');
  }
  const summary = typeof value.summary === 'string'
    ? value.summary.replace(/\s+/gu, ' ').trim().slice(0, MAX_SUMMARY_CHARS)
    : '';
  if (!summary) throw new Error('understanding summary is required');

  if (!Array.isArray(value.facts)) throw new Error('understanding facts must be an array');
  const facts = [];
  for (const fact of value.facts.slice(0, MAX_CANDIDATES)) {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new Error('understanding fact must be an object');
    }
    const key = typeof fact.key === 'string' ? fact.key.trim().slice(0, 80) : '';
    const factValue = typeof fact.value === 'string' ? fact.value.trim().slice(0, MAX_FACT_CHARS) : '';
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim().slice(0, MAX_FACT_CHARS) : '';
    if (!key || !factValue) throw new Error('understanding fact key and value are required');
    facts.push(Object.freeze({ key, value: factValue, evidence }));
  }

  const openQuestions = cleanQuestions(Array.isArray(value.open_questions) ? value.open_questions : []);
  const nextQuestion = typeof value.next_question === 'string'
    ? value.next_question.replace(/\s+/gu, ' ').trim().slice(0, MAX_QUESTION_CHARS)
    : focusedNextQuestion(openQuestions);

  if (!Array.isArray(value.candidate_requirements)) {
    throw new Error('understanding candidate_requirements must be an array');
  }
  const candidates = [];
  for (const candidate of value.candidate_requirements.slice(0, MAX_CANDIDATES)) {
    validateRequirement(candidate);
    candidates.push(Object.freeze({
      requirement_ref: candidate.requirement_ref,
      statement: candidate.statement,
      acceptance_criteria: Object.freeze([...candidate.acceptance_criteria]),
      constraint_refs: Object.freeze([...(candidate.constraint_refs ?? [])]),
    }));
  }

  const projectKinds = Array.isArray(value.project_kinds) && value.project_kinds.length
    ? validateProjectKinds(value.project_kinds)
    : ['new_product'];

  return Object.freeze({
    summary,
    facts: Object.freeze(facts),
    open_questions: Object.freeze(openQuestions),
    next_question: nextQuestion,
    candidate_requirements: Object.freeze(candidates),
    project_kinds: Object.freeze([...projectKinds]),
  });
}

/**
 * Merge a newly validated snapshot with prior understanding. Prior facts and
 * settled questions remain; the focused next question is one open item.
 * @param {UnderstandingSnapshot | null} previous
 * @param {UnderstandingSnapshot} incoming
 */
export function mergeUnderstanding(previous, incoming) {
  const previousFacts = previous?.facts ?? [];
  const factKeys = new Set(incoming.facts.map((fact) => fact.key));
  const retainedFacts = previousFacts.filter((fact) => !factKeys.has(fact.key));
  const open = incoming.open_questions;
  const history = mergeQuestionHistory(previous?.open_questions ?? [], open);
  const settled = history.filter(
    (historic) => !open.some((question) => questionsLikelyMatch(historic, question)),
  );
  const next = incoming.next_question || focusedNextQuestion(open, previous?.next_question);
  return Object.freeze({
    ...incoming,
    facts: Object.freeze([...retainedFacts, ...incoming.facts]),
    open_questions: Object.freeze(open),
    settled_questions: Object.freeze(settled),
    next_question: next,
  });
}

/**
 * Convert validated understanding candidates into unapproved core proposals.
 * Never approves a baseline or starts delivery. Existing approved refs become
 * update proposals; new refs become add proposals. Duplicates are skipped.
 * @param {import('../lib/types.js').RequirementsStream} stream
 * @param {import('../lib/types.js').VerifiedAuthority} authority
 * @param {UnderstandingSnapshot} understanding
 */
export function proposeFromUnderstanding(stream, authority, understanding) {
  const snapshot = validateUnderstanding(understanding);
  const baseline = currentBaseline(stream);
  const approvedRefs = new Set((baseline?.requirements ?? []).map((item) => item.requirement_ref));
  let next = stream;
  const created = [];
  for (const candidate of snapshot.candidate_requirements) {
    try {
      next = approvedRefs.has(candidate.requirement_ref)
        ? proposeRequirementUpdate(next, authority, candidate)
        : proposeRequirement(next, authority, candidate);
      created.push(next.proposals.at(-1).proposal_ref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /pending add already exists|pending update already exists|already exists in approved baseline/.test(
          message,
        )
      ) {
        continue;
      }
      throw error;
    }
  }
  return { stream: next, proposal_refs: Object.freeze(created) };
}
