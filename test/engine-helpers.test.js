// Shared deterministic fixtures. No sockets, provider processes, or remote hosts.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal, JournalClient } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger } from '../runtime/budget/index.js';
import { AuthorizationSession } from '../runtime/authz/index.js';
import { ControlledRenderer, TextEngine } from '../runtime/engine/index.js';
import { sha256Hex } from '../contracts/validate.js';
import { authority, bytes, item, now, record, session, sid, snapshot, time, turn } from './fixtures/journal/helpers.mjs';

export { authority, bytes, item, now, record, session, sid, snapshot, time, turn };

export const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
export class FakeClock {
  value = 0;
  #next = 0;
  #timers = new Map();
  now = () => this.value;
  wallNow = () => time + this.value;
  setTimeout = (fn, ms) => {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.value + ms, fn });
    return id;
  };
  clearTimeout = (id) => { this.#timers.delete(id); };
  async advance(ms) {
    const end = this.value + ms;
    await flush();
    for (let count = 0; count < 10_000; count++) {
      const next = [...this.#timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) { this.value = end; await flush(); return; }
      this.value = next[1].at;
      this.#timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    throw new Error('Fake clock timer loop did not converge');
  }
}

export function authorizationFor(auth) {
  const digest = sha256Hex('fixture-settings');
  const authorization = { contract: 'aithema.authz', major: 1, minor: 0, min_reader: 0,
    tid: auth.tid, pid: auth.pid, sid: auth.sid, epoch: auth.auth_epoch,
    participants: [{ participant_ref: 'fixture-person', role: 'owner', notice_ref: 'fixture-notice' }],
    purposes: ['intake', 'specification', 'design'], processors: [], settings_sha256: digest,
    basis_label: 'fixture', created_at: new Date(time).toISOString(), withdrawn_at: null };
  return new AuthorizationSession({ authorization, settingsSha256: digest,
    scope: { ...auth, worker_generation: auth.gen } });
}

export function defaultOutput(lane, payload) {
  if (lane === 'reaction') return { say: 'Recorded.', question_id: payload.questions.find((q) => q.state === 'open')?.question_id ?? null, tools: [] };
  const person = payload.events.find((r) => r.kind === 'turn' && r.data.speaker === 'person');
  const ordinal = person && payload.turn_ordinals.find(([seq]) => seq === person.seq)[1];
  const input = person && item({ citations: [{ record_seq: person.seq, locator: `turn:${ordinal}`, quote: 'export' }], leaves: [person.seq] });
  if (input) for (const key of ['version', 'content_sha256', 'state', 'supersedes_item_version', 'host']) delete input[key];
  return { base_rev: payload.base_rev, items: person && !payload.spec.items.length ? [{ op: 'add', item: input }] : [] };
}

export function fixture(t, { path, initialize = true, clock = new FakeClock(), handler = defaultOutput,
  checkpoint, cap = 100_000, journalOverrides = {}, ledgerOverrides = {}, priceUsage, renderer, designWaitMs, hostMode = 'review', onError } = {}) {
  path ??= join(mkdtempSync(join(tmpdir(), 'aithema-engine-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now: clock.wallNow });
  if (initialize) journal.createSession(bytes(session({ host_mode: hostMode })));
  const ledger = new SqliteBudgetLedger(path, { now: clock.wallNow });
  ledger.registerSession({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
    session_cap_micro: cap, principal_day_cap_micro: cap, tenant_day_cap_micro: cap, evidence: true });
  const auth = authority({ capabilities: ['aithema.journal.read', 'aithema.journal.write', 'aithema.ledger'] });
  const port = Object.fromEntries(['append', 'cursor', 'recordsByIds', 'recordsAfter', 'takeover']
    .map((method) => [method, journalOverrides[method] ?? journal[method].bind(journal)]));
  const budgetPort = Object.fromEntries(['admit', 'claim', 'settle', 'recover', 'listOpen', 'isCurrent']
    .map((method) => [method, ledgerOverrides[method] ?? ledger[method].bind(ledger)]));
  const client = new JournalClient({ port, authority: auth, now: clock.wallNow });
  const budget = new BudgetClient({ port: budgetPort, journal: port, authority: auth, now: clock.wallNow });
  const authz = authorizationFor(auth);
  const calls = [];
  const reasoning = {
    async *streamChat(request) {
      const lane = request.system.startsWith('Return only JSON {say') ? 'reaction' : 'spec';
      const payload = JSON.parse(request.messages[0].content);
      calls.push({ lane, payload, signal: request.signal });
      const output = await handler(lane, payload, request);
      request.onUsage({ input_tokens: 1, output_tokens: 1 });
      yield typeof output === 'string' ? output : JSON.stringify(output);
    },
    understand() { throw new Error('Engine must use the structured stream path'); },
  };
  const errors = [];
  const engine = new TextEngine({ journal: client, journalPort: port, budget, authorization: authz, reasoning,
    maxMicro: { reaction: 100, spec: 100, design: 100 }, priceUsage: priceUsage ?? (() => 7), clock, checkpoint,
    renderer: renderer ?? new ControlledRenderer({ clock }), designWaitMs, hostMode, onError: (error) => { errors.push(error); return onError?.(error); } });
  const close = () => { engine.close(); ledger.close(); journal.close(); };
  t?.after(close);
  return { engine, journal, ledger, client, budget, auth, authz, clock, calls, errors, path, close, port,
    records: (kind) => journal.recordsAfter(0, client.authority).filter((r) => kind === undefined || r.document.kind === kind),
    personTurn: () => journal.append(bytes(turn({ recorded_at: new Date(clock.wallNow()).toISOString(),
      writer: { kind: 'worker', generation: client.authority.gen } })), client.authority).document.seq };
}
