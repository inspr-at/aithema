import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import { escapeHtml } from './config.js';

/**
 * Server-rendered text UI for one engine session (AIT-43, v5 §5.1-§5.3, §9.4).
 * Pure functions only: a view snapshot in, escaped HTML or a verdict out. Every
 * value that came from a person, a document or the model is untrusted text.
 *
 * @typedef {{
 *   journal_state: 'ACTIVE'|'CAPTURE_ONLY'|'ENDED',
 *   host_reachable: boolean,
 *   unacknowledged: number,
 *   captured_turns: number,
 *   working_rev: number,
 *   journal_last_seq: number,
 *   unreflected_records: number,
 * }} DurabilityInput
 * @typedef {{
 *   state: object | null,
 *   transcript: readonly { record: any, segments: readonly any[] }[],
 *   durability: DurabilityInput,
 * }} TextSessionView
 * @typedef {{ item_ref: string, version: number, content_sha256: string }} ConfirmationBinding
 */

const esc = escapeHtml;

export const INTERACTION_DISCLOSURE = Object.freeze({
  badge: 'You are talking to an AI system, not a person.',
  opening: 'AI interaction notice (EU AI Act Art. 50(1)): this conversation is with an AI system. '
    + 'Its replies, questions and the requirement items it drafts are AI-generated and can be wrong. '
    + 'Nothing is confirmed by what you say or type here; you confirm each item yourself below.',
  confirmation: 'Nothing you say or type in the conversation confirms an item, not even “ja” or “yes”. '
    + 'Only the buttons in this section do, bound to the exact version and content digest shown.',
});

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})@([1-9][0-9]{0,8})@([0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_BINDINGS = 200;
const STATE_ORDER = ['draft', 'confirmed', 'proposed', 'accepted', 'rejected', 'invalidated', 'superseded'];
const STATE_LABEL = Object.freeze({
  draft: 'Draft — awaiting your confirmation',
  confirmed: 'Confirmed by you',
  proposed: 'Submitted to the host as a proposal',
  accepted: 'Accepted in the host',
  rejected: 'Rejected in the host',
  invalidated: 'Invalidated by the host',
  superseded: 'Superseded by a newer version',
});
const INTENT_LABEL = Object.freeze({
  requested: 'requested — you asked for this',
  extracted_instruction: 'extracted instruction — found in quoted or uploaded text; you did not necessarily ask for it',
  inferred: 'inferred — derived by the AI; check it carefully',
});

export class TextUiError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TextUiError';
    this.code = code;
    this.status = status;
  }
}

/** @param {ConfirmationBinding} binding */
export function formatBinding(binding) {
  return `${binding.item_ref}@${binding.version}@${binding.content_sha256}`;
}

/**
 * Strict parse of the browser's binding fields. The principal is never read
 * from the browser; only the exact version and digest the person was shown.
 * @param {unknown} value a string or an array of strings from the form body
 * @returns {ConfirmationBinding[]}
 */
export function parseBindings(value) {
  const list = Array.isArray(value) ? value : (value === undefined || value === '' ? [] : [value]);
  if (!list.length) throw new TextUiError('invalid_binding', 'Nothing to confirm: no item binding was submitted.');
  if (list.length > MAX_BINDINGS) throw new TextUiError('invalid_binding', 'Too many items in one confirmation.');
  const seen = new Set();
  return list.map((entry) => {
    const match = typeof entry === 'string' ? BINDING.exec(entry) : null;
    if (!match) throw new TextUiError('invalid_binding', 'Each confirmation must name one item version and its content digest.');
    const binding = { item_ref: match[1], version: Number(match[2]), content_sha256: match[3] };
    if (!Number.isSafeInteger(binding.version)) throw new TextUiError('invalid_binding', 'Invalid item version.');
    const key = `${binding.item_ref}@${binding.version}`;
    if (seen.has(key)) throw new TextUiError('invalid_binding', 'The same item version was listed twice.');
    seen.add(key);
    return binding;
  });
}

/** Items a person can still confirm: a draft with no newer version. */
export function confirmableItems(state) {
  const items = state?.spec?.items ?? [];
  return items.filter((item) => item.state === 'draft'
    && !items.some((other) => other.item_ref === item.item_ref && other.version > item.version));
}

/** Recomputed digest of the shown content, independent of the stored field. */
export function contentDigest(item) {
  return sha256Hex(canonicalJson(item.content));
}

/**
 * One verdict per binding against the CURRENT working spec. Any refusal refuses
 * the whole batch (nothing is journaled); already-confirmed exact versions are
 * idempotent no-ops so a double click or retry is harmless.
 * @param {object | null} state
 * @param {readonly ConfirmationBinding[]} bindings
 * @returns {{ok: true, confirm: ConfirmationBinding[], already: ConfirmationBinding[]} | {ok: false, reason: string, message: string, binding: ConfirmationBinding}}
 */
export function planConfirmation(state, bindings) {
  const items = state?.spec?.items ?? [];
  const confirm = [];
  const already = [];
  const refuse = (binding, reason, message) => ({ ok: false, reason, message, binding });
  for (const binding of bindings) {
    const item = items.find((row) => row.item_ref === binding.item_ref && row.version === binding.version);
    if (!item) return refuse(binding, 'unknown_item', `${binding.item_ref} version ${binding.version} is not in the working spec.`);
    if (item.content_sha256 !== binding.content_sha256) {
      return refuse(binding, 'hash_mismatch', `${binding.item_ref} version ${binding.version} does not match the content digest you were shown.`);
    }
    if (contentDigest(item) !== item.content_sha256) {
      return refuse(binding, 'integrity', `${binding.item_ref} version ${binding.version} fails its own content digest; refusing to confirm.`);
    }
    if (item.state === 'superseded' || items.some((row) => row.item_ref === item.item_ref && row.version > item.version)) {
      return refuse(binding, 'superseded', `${binding.item_ref} version ${binding.version} has been replaced by a newer version; review it again.`);
    }
    if (item.state === 'confirmed') already.push(binding);
    else if (item.state === 'draft') confirm.push(binding);
    else return refuse(binding, 'not_draft', `${binding.item_ref} version ${binding.version} is ${item.state} and cannot be confirmed.`);
  }
  return { ok: true, confirm, already };
}

/**
 * Durability of what the page shows. Never claims "durable" on malformed or
 * missing input: the indicator fails toward "pending".
 * @param {DurabilityInput | null | undefined} input
 * @param {{started?: boolean}} [options]
 * @returns {{level: 'durable'|'pending'|'capture_only'|'ended'|'not_started', headline: string, reasons: string[], working_rev: number | null}}
 */
export function describeDurability(input, { started = true } = {}) {
  if (!started) {
    return { level: 'not_started', headline: 'Not started', reasons: ['The session worker has not started; nothing is journaled yet.'], working_rev: null };
  }
  const counts = ['unacknowledged', 'captured_turns', 'working_rev', 'journal_last_seq', 'unreflected_records'];
  const valid = input && typeof input === 'object'
    && ['ACTIVE', 'CAPTURE_ONLY', 'ENDED'].includes(input.journal_state)
    && typeof input.host_reachable === 'boolean'
    && counts.every((key) => Number.isSafeInteger(input[key]) && input[key] >= 0);
  if (!valid) {
    return { level: 'pending', headline: 'Pending', reasons: ['Durability could not be determined; treat the working spec as not yet saved.'], working_rev: null };
  }
  const rev = input.working_rev;
  if (input.journal_state === 'ENDED') {
    return { level: 'ended', headline: 'Session ended by a journal outage', working_rev: rev,
      reasons: ['The journal host stayed unavailable. Export the unacknowledged records before leaving.'] };
  }
  if (input.journal_state === 'CAPTURE_ONLY') {
    return { level: 'capture_only', headline: 'Not durable', working_rev: rev,
      reasons: [`The journal host is unavailable; ${input.captured_turns + input.unacknowledged} record(s) are held only in this worker and are lost if it restarts.`] };
  }
  const reasons = [];
  if (!input.host_reachable) reasons.push('The journal host could not be reached, so the latest changes cannot be confirmed as saved.');
  if (input.unacknowledged > 0) reasons.push(`${input.unacknowledged} record(s) were sent but the journal host has not acknowledged them yet; they are retained and retried.`);
  if (input.captured_turns > 0) reasons.push(`${input.captured_turns} message(s) are held by the worker and not yet journaled.`);
  if (input.unreflected_records > 0) reasons.push(`${input.unreflected_records} journaled message(s) or source(s) are not yet reflected in the working spec shown here.`);
  if (reasons.length) return { level: 'pending', headline: 'Pending', reasons, working_rev: rev };
  return { level: 'durable', headline: 'Durably journaled', working_rev: rev,
    reasons: [`Working spec revision ${rev} is acknowledged by the journal host (journal record ${input.journal_last_seq}).`] };
}

function itemId(item) {
  return `item-${item.item_ref}-v${item.version}`;
}

function renderList(values, empty) {
  if (!values?.length) return `<span class="meta">${esc(empty)}</span>`;
  return `<ul>${values.map((value) => `<li class="wrap">${esc(value)}</li>`).join('')}</ul>`;
}

function renderRefs(values) {
  if (!values?.length) return '<span class="meta">None</span>';
  return `<ul>${values.map((value) => `<li class="wrap"><code>${esc(value)}</code></li>`).join('')}</ul>`;
}

function renderIntent(provenance) {
  const intent = provenance?.intent;
  const text = Object.hasOwn(INTENT_LABEL, intent) ? INTENT_LABEL[intent] : 'unknown label — treat as inferred';
  return `<span class="intent" data-intent="${esc(intent)}"><strong>${esc(intent)}</strong> <span class="meta">${esc(text)}. This label is the AI's own advisory label; it is not verified.</span></span>`;
}

function renderCitations(citations) {
  if (!citations?.length) return '<span class="meta">No citations.</span>';
  return `<ul>${citations.map((citation) => `<li class="wrap">journal record ${esc(String(citation.record_seq))} · ${esc(citation.locator)}${
    citation.quote ? ` · <q>${esc(citation.quote)}</q>` : ''}</li>`).join('')}</ul>`;
}

function renderHost(host) {
  if (!host) return '';
  const identity = host.proposal_ref ? `proposal ${host.proposal_ref}` : `draft ${host.draft_id}`;
  return `<dt>Host identity</dt><dd class="wrap">${esc(identity)} · operation <code>${esc(host.op_key)}</code></dd>`;
}

/**
 * The item in full: statement, acceptance criteria, constraint references and
 * intent label, plus evidence and the digest the confirmation binds to.
 * @param {object} item
 * @param {{level: number, form?: string}} options
 */
export function renderItemFull(item, { level, form = '' }) {
  const id = itemId(item);
  const heading = `h${level}`;
  const kind = item.kind === 'constraint' ? 'Constraint' : 'Requirement';
  const content = item.content ?? {};
  const extensions = item.extensions && Object.keys(item.extensions).length
    ? `<dt>Extensions (not covered by the content digest)</dt><dd><pre class="wrap">${esc(canonicalJson(item.extensions))}</pre></dd>`
    : '';
  return `<article class="text-item" id="${esc(id)}" data-item-ref="${esc(item.item_ref)}" data-version="${esc(String(item.version))}" data-state="${esc(item.state)}" aria-labelledby="${esc(id)}-h">
    <${heading} id="${esc(id)}-h">${esc(kind)} ${esc(item.item_ref)} · version ${esc(String(item.version))}</${heading}>
    <p class="meta"><span class="ai-generated">AI-generated</span> · state <strong>${esc(item.state)}</strong> — ${esc(STATE_LABEL[item.state] ?? item.state)}${
  item.supersedes_item_version ? ` · replaces version ${esc(String(item.supersedes_item_version.version))}` : ''}</p>
    <dl class="item-fields">
      <dt>Statement</dt><dd><pre class="wrap">${esc(content.statement ?? '')}</pre></dd>
      <dt>Acceptance criteria</dt><dd>${renderList(content.acceptance_criteria, 'None')}</dd>
      <dt>Constraint references</dt><dd>${renderRefs(content.constraint_refs)}</dd>
      ${content.constraint_kind ? `<dt>Constraint kind</dt><dd>${esc(content.constraint_kind)}</dd>` : ''}
      <dt>Intent label (advisory)</dt><dd>${renderIntent(item.provenance)}</dd>
      <dt>Evidence (not authorization)</dt><dd>${renderCitations(item.citations)}</dd>
      <dt>Content digest (sha256)</dt><dd class="wrap"><code class="digest">${esc(item.content_sha256)}</code></dd>
      ${extensions}${renderHost(item.host)}
    </dl>
    ${form}
  </article>`;
}

function renderTranscriptEntry(entry) {
  const { record, segments } = entry;
  const data = record.data ?? {};
  const seq = record.seq;
  if (record.kind === 'turn') {
    const person = data.speaker === 'person';
    const label = person ? 'You' : 'AI assistant (AI-generated)';
    return `<article class="turn ${person ? 'person' : 'assistant'}" id="text-seq-${esc(String(seq))}" data-seq="${esc(String(seq))}" data-speaker="${esc(data.speaker)}">
      <p class="speaker"><strong>${esc(label)}</strong></p>
      <pre class="wrap"${data.lang ? ` lang="${esc(data.lang)}"` : ''}>${esc(data.body ?? '')}</pre>
    </article>`;
  }
  const text = typeof data.text === 'string' ? data.text : '';
  const interrupted = data.complete === false ? ' <span class="meta">(reply interrupted)</span>' : '';
  const parts = (segments ?? []).length
    ? segments.map((segment) => {
      const body = esc(text.slice(segment.start, segment.end));
      if (segment.kind === 'question') {
        return `<p class="segment question" data-canonical-question="true" data-question-id="${esc(segment.question_id)}"><strong class="segment-label">Canonical question:</strong> ${body}</p>`;
      }
      if (segment.kind === 'correction') {
        return `<p class="segment correction" data-correction-id="${esc(segment.correction_id)}"><strong class="segment-label">Correction:</strong> ${body}</p>`;
      }
      return `<p class="segment say">${body}</p>`;
    }).join('')
    : `<p class="segment say">${esc(text)}</p>`;
  return `<article class="turn assistant" id="text-seq-${esc(String(seq))}" data-seq="${esc(String(seq))}" data-speaker="assistant">
      <p class="speaker"><strong>AI assistant (AI-generated)</strong>${interrupted}</p>
      ${parts}
    </article>`;
}

/** The open canonical question the next answer addresses, if any. */
export function currentQuestion(state) {
  const questions = state?.spec?.questions ?? [];
  const asked = questions.filter((q) => q.state === 'asked')
    .sort((a, b) => (b.asked_in_reaction_seq ?? 0) - (a.asked_in_reaction_seq ?? 0));
  return asked[0] ?? questions.find((q) => q.state === 'open') ?? null;
}

/**
 * @param {{view: TextSessionView, canAct: boolean}} model
 */
export function renderTextStatus(model) {
  const { view } = model;
  const durability = describeDurability(view.durability, { started: Boolean(view.state) || Boolean(view.unavailable) });
  const detail = durability.reasons.map((reason) => esc(reason)).join(' ');
  return `<div class="text-status" id="text-status">
    <p class="ai-badge" id="text-ai-badge" data-ai-disclosure="art50-1"><strong>AI system</strong> — ${esc(INTERACTION_DISCLOSURE.badge)}</p>
    <p class="durability" id="text-durability" role="status" data-durability="${esc(durability.level)}"><strong>${esc(durability.headline)}</strong>${
  durability.working_rev === null ? '' : ` · working spec revision ${esc(String(durability.working_rev))}`} — ${detail}</p>
    <div id="text-live" class="visually-hidden" role="status" aria-live="polite"></div>
  </div>`;
}

/**
 * @param {{view: TextSessionView, turnAction: string, canAct: boolean, draftMessage?: string}} model
 */
export function renderTextConversation(model) {
  const { view, turnAction, canAct } = model;
  const question = currentQuestion(view.state);
  const entries = view.transcript.map(renderTranscriptEntry).join('');
  const questionBlock = question
    ? `<div class="next-question" id="text-current-question" data-question-id="${esc(question.question_id)}"><strong>Canonical question:</strong> <span class="wrap">${esc(question.text)}</span></div>`
    : '<div class="next-question" id="text-current-question"><span class="meta">No open question right now.</span></div>';
  const compose = !view.state
    ? '<p class="meta">The session is not running, so messages cannot be sent right now.</p>'
    : (canAct ? `<form method="post" action="${esc(turnAction)}" id="text-turn-form" data-text-turn-form>
      <label for="text-turn-input">Your message to the AI assistant</label>
      <textarea id="text-turn-input" name="message" required maxlength="8000" rows="4" aria-describedby="text-current-question text-turn-help">${esc(model.draftMessage ?? '')}</textarea>
      <p id="text-turn-help" class="meta">Sending a message never confirms an item. Typing “ja” or “yes” is not a confirmation; use the confirmation buttons.</p>
      <button type="submit">Send message</button>
    </form>` : '<p class="meta">Only a signed-in human participant can send messages in this session.</p>');
  return `<section class="primary" id="text-conversation" aria-labelledby="text-conversation-h">
    <h2 id="text-conversation-h">Conversation with the AI assistant</h2>
    <p class="disclosure" id="text-opening-disclosure">${esc(INTERACTION_DISCLOSURE.opening)}</p>
    <div class="transcript" id="text-transcript" role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions" tabindex="0">${
  entries || '<p class="meta" data-empty>No messages yet.</p>'}</div>
    ${questionBlock}
    ${compose}
  </section>`;
}

/**
 * Full-item confirmation: every draft shown in full, confirmed one by one or
 * batched at "Einreichen". The forms carry only item_ref@version@digest.
 * @param {{view: TextSessionView, confirmAction: string, canAct: boolean}} model
 */
export function renderTextConfirmation(model) {
  const { view, confirmAction, canAct } = model;
  const drafts = confirmableItems(view.state);
  const modeNote = view.state?.host_mode === 'working_spec_only'
    ? '<p class="meta">This host keeps the working spec only; confirmed items are not sent onward.</p>'
    : '<p class="meta">Confirmed items are submitted to the host as immutable proposals at submission.</p>';
  let body;
  if (!drafts.length) {
    body = '<p class="meta" id="text-no-drafts">No items are waiting for your confirmation.</p>';
  } else {
    const single = (item) => (canAct
      ? `<form method="post" action="${esc(confirmAction)}" data-text-confirm-form>
        <input type="hidden" name="binding" value="${esc(formatBinding(item))}">
        <button type="submit">Confirm ${esc(item.item_ref)} version ${esc(String(item.version))} as shown</button>
      </form>` : '');
    const batch = canAct
      ? `<form method="post" action="${esc(confirmAction)}" id="text-einreichen-form" data-text-confirm-form>
        <input type="hidden" name="action" value="einreichen">
        ${drafts.map((item) => `<input type="hidden" name="binding" value="${esc(formatBinding(item))}">`).join('')}
        <button type="submit"><span lang="de">Einreichen</span> — confirm all ${esc(String(drafts.length))} item${drafts.length === 1 ? '' : 's'} as shown</button>
      </form>`
      : '<p class="meta">Only a signed-in human participant can confirm items.</p>';
    body = `<ol class="text-items" id="text-drafts">${drafts.map((item) => `<li>${renderItemFull(item, { level: 3, form: single(item) })}</li>`).join('')}</ol>${batch}`;
  }
  return `<section id="text-confirmation" aria-labelledby="text-confirmation-h">
    <h2 id="text-confirmation-h">Confirm items before submission</h2>
    <p class="disclosure">${esc(INTERACTION_DISCLOSURE.confirmation)}</p>
    ${modeNote}
    ${body}
  </section>`;
}

/**
 * Read-only review of the working spec at its current revision.
 * @param {{view: TextSessionView}} model
 */
export function renderTextReview(model) {
  const state = model.view.state;
  if (!state) {
    return `<section id="text-review" aria-labelledby="text-review-h"><h2 id="text-review-h">Working spec review</h2>
    <p class="meta">No working spec yet.</p></section>`;
  }
  const { items, questions, brief, screens } = state.spec;
  const drafts = new Set(confirmableItems(state));
  const groups = STATE_ORDER.map((name) => ({ name, rows: items.filter((item) => item.state === name) }))
    .filter((group) => group.rows.length)
    .map((group) => {
      const rows = group.rows.map((item) => (drafts.has(item)
        ? `<li class="wrap">${esc(item.kind)} ${esc(item.item_ref)} · version ${esc(String(item.version))} — waiting for confirmation; <a href="#${esc(itemId(item))}">see the full item above</a>.</li>`
        : `<li>${renderItemFull(item, { level: 5 })}</li>`)).join('');
      const closed = ['superseded', 'rejected', 'invalidated'].includes(group.name);
      const inner = `<ul class="text-items">${rows}</ul>`;
      return `<section class="item-group" data-state="${esc(group.name)}" aria-labelledby="text-group-${esc(group.name)}-h">
        <h4 id="text-group-${esc(group.name)}-h">${esc(STATE_LABEL[group.name])} (${esc(String(group.rows.length))})</h4>
        ${closed ? `<details class="secondary"><summary>Show ${esc(String(group.rows.length))} item version(s)</summary>${inner}</details>` : inner}
      </section>`;
    }).join('');
  const questionList = questions.length
    ? `<ul>${questions.map((q) => `<li class="wrap" data-question-id="${esc(q.question_id)}"><strong>${esc(q.state)}</strong> — ${esc(q.text)}</li>`).join('')}</ul>`
    : '<p class="meta">No questions recorded.</p>';
  const correctionList = state.corrections?.length
    ? `<h3>Corrections</h3><ul>${state.corrections.map((c) => `<li class="wrap"><strong>${esc(c.state)}</strong> — ${esc(c.text)}</li>`).join('')}</ul>`
    : '';
  const screenList = screens.length
    ? `<h3>Screens</h3><ul>${screens.map((s) => `<li class="wrap"><code>${esc(s.screen_ref)}</code> · design input record ${esc(String(s.design_input_seq))}</li>`).join('')}</ul>`
    : '';
  return `<section id="text-review" aria-labelledby="text-review-h">
    <h2 id="text-review-h">Working spec review</h2>
    <p class="meta">Revision ${esc(String(state.working_rev))} · host mode ${esc(state.host_mode)} · ${esc(String(items.length))} item version(s). Everything here is AI-generated unless you wrote it.</p>
    <h3>Brief</h3>
    ${brief ? `<pre class="wrap">${esc(brief)}</pre>` : '<p class="meta">No brief yet.</p>'}
    <h3>Questions</h3>
    ${questionList}
    <h3>Items</h3>
    ${groups || '<p class="meta">No items yet.</p>'}
    ${correctionList}${screenList}
  </section>`;
}

/**
 * @param {{view: TextSessionView, turnAction: string, confirmAction: string, canAct: boolean}} model
 */
export function renderTextSession(model) {
  return {
    status: renderTextStatus(model),
    conversation: renderTextConversation(model),
    confirmation: renderTextConfirmation(model),
    review: renderTextReview(model),
  };
}

export { REF as TEXT_REF_PATTERN, SHA256 as TEXT_SHA256_PATTERN };
