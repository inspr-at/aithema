import { randomUUID } from 'node:crypto';
import { canonicalJson, loadContractFile } from '../contracts/validate.js';
import { TextUiError, TEXT_REF_PATTERN, parseBindings, planConfirmation } from './text-ui.js';

/**
 * The workspace talks to one engine session through this port. The reference
 * adapter below uses only public TextEngine / JournalClient entry points:
 * turns are journaled through the client, confirmations through
 * engine.confirmItem (the write-ahead ui.confirm path), never by writing a
 * ui.confirm record from here.
 *
 * @typedef {{
 *   principalRef: string,
 *   view(): Promise<import('./text-ui.js').TextSessionView>,
 *   submitTurn(turn: {text: string}): Promise<{turn_seq: number, reaction: {status: string}}>,
 *   confirmItem(confirmation: {item_ref: string, version: number, content_sha256: string, principal_ref: string}): Promise<object>,
 *   submitConfirmed?(): Promise<unknown>,
 * }} TextSessionPort
 * @typedef {{ get(request: {actor: object, projectRef: string}): TextSessionPort | null | undefined }} TextSessionProvider
 */

const MAX_TURN_CHARS = 8000;
const hostModes = loadContractFile('transitions.json').modes;

/** @param {unknown} provider */
export function assertTextSessionProvider(provider) {
  if (!provider || typeof provider.get !== 'function') {
    throw new Error('textSessions must provide get({actor, projectRef})');
  }
  return provider;
}

/** @param {unknown} port */
export function assertTextSessionPort(port) {
  if (!port || !['view', 'submitTurn', 'confirmItem'].every((method) => typeof port[method] === 'function')
      || typeof port.principalRef !== 'string' || !TEXT_REF_PATTERN.test(port.principalRef)) {
    throw new TextUiError('invalid_session', 'Text session port needs view, submitTurn, confirmItem and a principalRef', 500);
  }
  return port;
}

/** Person text turn bound for the journal: trimmed, non-empty, bounded. */
export function normalizeTurnText(value) {
  if (typeof value !== 'string') throw new TextUiError('invalid_turn', 'A message is required.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new TextUiError('invalid_turn', 'A message is required.');
  if ([...text].length > MAX_TURN_CHARS) throw new TextUiError('invalid_turn', `A message may have at most ${MAX_TURN_CHARS} characters.`);
  return text;
}

const tails = new WeakMap();

/** Serialise UI confirmations per session so plan and journal write cannot interleave. */
function exclusive(port, operation) {
  const previous = tails.get(port) ?? Promise.resolve();
  const result = previous.then(operation);
  tails.set(port, result.catch(() => {}));
  return result;
}

/**
 * Confirm a batch of exact item versions. The browser supplies only bindings
 * (ref, version, digest); the principal is the port's server-side identity.
 * All-or-nothing planning against the current working spec, then one write-ahead
 * confirmation per item through the engine's public entry.
 *
 * @param {TextSessionPort} port
 * @param {unknown} rawBindings form value(s) in item_ref@version@sha256 form
 * @param {{einreichen?: boolean}} [options] Einreichen also runs the optional host submission hook
 *   when the contract's host mode permits submission. Older host ports may
 *   omit host_mode; their configured hook remains the submission boundary.
 *   The hook must be idempotent: a retry with already confirmed bindings runs
 *   it again without writing another ui.confirm, including after submit_failed.
 */
export async function confirmBatch(port, rawBindings, { einreichen = false } = {}) {
  assertTextSessionPort(port);
  const bindings = parseBindings(rawBindings);
  return exclusive(port, async () => {
    const before = (await port.view()).state;
    const plan = planConfirmation(before, bindings);
    if (!plan.ok) throw new TextUiError(plan.reason, plan.message, 409);
    const confirmed = [];
    for (const binding of plan.confirm) {
      let state;
      try {
        state = await port.confirmItem({ ...binding, principal_ref: port.principalRef });
      } catch (error) {
        throw Object.assign(new TextUiError('confirm_failed',
          `Confirmed ${confirmed.length} of ${plan.confirm.length} item(s) before a failure (${error?.reason ?? error?.message ?? 'error'}); the rest stay unconfirmed.`,
          Number.isInteger(error?.status) && error.status >= 500 ? 503 : 409), { confirmed, cause: error });
      }
      const row = state?.spec?.items?.find((item) => item.item_ref === binding.item_ref && item.version === binding.version);
      if (row?.state !== 'confirmed') {
        throw Object.assign(new TextUiError('changed_while_confirming',
          `${binding.item_ref} version ${binding.version} changed while confirming and was not confirmed; review it again.`, 409), { confirmed });
      }
      confirmed.push(binding);
    }
    let submitted = null;
    if (einreichen && hostModes[before.host_mode]?.submits === false) submitted = false;
    if (einreichen && submitted !== false && typeof port.submitConfirmed === 'function') {
      try {
        await port.submitConfirmed();
        submitted = true;
      } catch (error) {
        throw Object.assign(new TextUiError('submit_failed',
          `Items are confirmed but the submission to the host failed (${error?.reason ?? error?.code ?? error?.message ?? 'error'}); it can be retried.`,
          Number.isInteger(error?.status) && error.status >= 500 ? 503 : 409), { confirmed, cause: error });
      }
    }
    return { confirmed, already: plan.already, submitted };
  });
}

const ACTIONABLE_PERSON = (document) => document.contract === 'aithema.journal.record'
  && (document.kind === 'source' || (document.kind === 'turn' && document.data.speaker === 'person'));

/**
 * Reference adapter over a started TextEngine and its JournalClient.
 * @param {{
 *   engine: import('../runtime/engine/engine.js').TextEngine,
 *   journal: import('../runtime/journal/client.js').JournalClient,
 *   journalPort: {cursor: Function, recordsAfter: Function},
 *   principalRef: string,
 *   lang?: string,
 *   uuid?: () => string,
 *   now?: () => number,
 *   onError?: (error: unknown) => void,
 *   submitConfirmed?: () => Promise<unknown>,
 * }} options
 * @returns {TextSessionPort & {idle(): Promise<void>}}
 */
export function createTextSession({ engine, journal, journalPort, principalRef, lang = 'en', uuid = randomUUID,
  now = Date.now, onError = () => {}, submitConfirmed }) {
  if (!TEXT_REF_PATTERN.test(principalRef ?? '')) throw new Error('text session needs a contract-valid principalRef');
  let specPass = Promise.resolve();

  async function durability() {
    const unacknowledged = journal.exportUnacknowledged();
    const state = engine.state;
    let hostReachable = true;
    let lastSeq = 0;
    let unreflected = 0;
    try {
      const authority = journal.authority;
      const cursor = await journalPort.cursor(authority);
      lastSeq = cursor.last_seq;
      if (state) {
        const after = await journalPort.recordsAfter(state.consumed_seq, authority, cursor.last_seq);
        unreflected = after.filter((record) => ACTIONABLE_PERSON(record.document)).length;
      }
    } catch {
      hostReachable = false;
    }
    return {
      journal_state: journal.state,
      host_reachable: hostReachable,
      unacknowledged: unacknowledged.unacknowledged.length,
      captured_turns: unacknowledged.captured_turns.length,
      working_rev: state?.working_rev ?? 0,
      journal_last_seq: lastSeq,
      unreflected_records: unreflected,
    };
  }

  return {
    principalRef,
    async view() {
      const state = engine.state;
      return { state, transcript: state ? await engine.transcript() : [], durability: await durability() };
    },
    async submitTurn({ text }) {
      const body = normalizeTurnText(text);
      const authority = journal.authority;
      const document = {
        contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: authority.sid, client_event_id: uuid(), writer: { kind: 'worker', generation: authority.gen },
        recorded_at: new Date(now()).toISOString(), kind: 'turn',
        data: { speaker: 'person', participant_ref: principalRef, channel: 'text', trust: 'authenticated_person', lang, body },
      };
      let stored;
      try {
        stored = await journal.append(Buffer.from(canonicalJson(document)));
      } catch (error) {
        // JournalClient retains unacknowledged bytes and retries them; say so.
        if (!Number.isInteger(error?.status) || error.status >= 500) {
          throw new TextUiError('journal_unavailable',
            'The journal host did not acknowledge your message. It is retained and will be retried; the durability indicator shows its state.', 503);
        }
        throw new TextUiError('journal_refused', `The journal host refused your message (${error.code ?? error.status}).`, error.status);
      }
      const turnSeq = stored.document.seq;
      // The turn is durable once acknowledged; a failed reply must not hide that.
      let reaction;
      try {
        reaction = await engine.react(turnSeq);
      } catch (error) {
        onError(error);
        reaction = { status: 'failed', reason: error?.reason ?? error?.code ?? 'error' };
      }
      // Lane B is single-flight and may take long; the page shows "pending"
      // until it has consumed this turn. Failures surface through onError and
      // the durability indicator, never as a silent success.
      specPass = specPass.then(() => engine.passSpec()).then(() => {}, (error) => { onError(error); });
      return { turn_seq: turnSeq, reaction };
    },
    confirmItem: (confirmation) => engine.confirmItem(confirmation),
    ...(typeof submitConfirmed === 'function' ? { submitConfirmed } : {}),
    /** Resolves once the last scheduled spec pass finished (tests, shutdown). */
    idle: () => specPass,
  };
}
