// Synthetic fixtures only. All transports run in process; no sockets or DNS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { canonicalJson, loadContractFile, sha256Hex, validate } from '../../../contracts/validate.js';
import { createTextSession } from '../../../workspace/text-session.js';
import { createWorkspaceServer } from '../../../workspace/server.js';
import { SqliteProjectStore } from '../../../runtime/store.js';
import { appendProposal } from '../../../lib/stream.js';
import { projectSubmission } from '../../../lib/working-spec.js';
import { JournalClient } from '../../../runtime/journal/client.js';
import { BudgetClient } from '../../../runtime/budget/client.js';
import { BudgetError } from '../../../runtime/budget/port.js';
import { AuthorizationSession } from '../../../runtime/authz/session.js';
import { TextEngine } from '../../../runtime/engine/engine.js';
import { AeonHttp, AeonJournal, AeonIntake } from '../../../runtime/hosts/aeon/index.js';
import { fixture as mockFixture } from '../../host-kit/fixtures.js';
import { routePath } from '../../host-kit/host.js';
import { fixture, FakeClock, authorizationFor, bytes, record, snapshot, sid } from '../../engine-helpers.test.js';
import { source } from '../journal/helpers.mjs';

export { fixture, FakeClock, authorizationFor, bytes, record, snapshot, sid };
export const binding = (item) => `${item.item_ref}@${item.version}@${item.content_sha256}`;
export const actor = { subject: 'synthetic-reviewer', party_ref: 'party:synthetic-reviewer', actor_kind: 'human',
  roles: ['requirements_approver', 'delivery_party'], projects: [], can_create_projects: true };
export const contributor = { party_ref: 'party:synthetic-builder', roles: ['delivery_party'] };
export const at = '2026-09-30T07:00:00Z';
export const designBytes = readFileSync(new URL('./design-input.json', import.meta.url));
assert.equal(sha256Hex(designBytes), '04890aa3addd7d659881a0833be239c26be71c0086e52feab2b5cba9f469ef40');
export const design = JSON.parse(designBytes);
export const designData = { ...design, screen_ir_sha256: sha256Hex(canonicalJson(design.screen_ir)),
  tokens_sha256: sha256Hex(canonicalJson(design.tokens)) };
export const designRecord = () => record('design.input', designData, { client_event_id: '44444444-4444-4444-8444-444444444444' });
export const renderFixture = ({ screen_ir_bytes, tokens_bytes }) => Buffer.concat([
  Buffer.from('controlled-renderer/1\n'), screen_ir_bytes, Buffer.from('\n'), tokens_bytes,
]);

export function valid(document) {
  const result = validate(document.contract, document);
  assert.equal(result.ok, true, JSON.stringify(result));
  return document;
}

// Drafts cite both a source segment and the earliest person turn. The second
// pass deliberately retains those citations below the replay watermark.
export function output(lane, payload) {
  if (lane === 'reaction') return { say: 'Recorded.', question_id: null, tools: [{ name: 'design_intent' }] };
  if (payload.spec.items.length) return { base_rev: payload.base_rev, items: [] };
  const person = payload.events.find((r) => r.kind === 'turn' && r.data.speaker === 'person');
  const document = payload.events.find((r) => r.kind === 'source');
  const ordinal = payload.turn_ordinals.find(([seq]) => seq === person.seq)[1];
  const citations = [{ record_seq: person.seq, locator: `turn:${ordinal}`, quote: 'export' }];
  if (document) citations.push({ record_seq: document.seq, locator: 'seg:leaf', quote: 'CSV' });
  return { base_rev: payload.base_rev, items: [{ op: 'add', item: {
    item_ref: 'REQ-export', kind: 'requirement',
    content: { statement: 'Export entries as CSV.', acceptance_criteria: ['Exports all selected entries.'], constraint_refs: [] },
    citations, provenance: { intent: 'requested', derived_from: citations.map((c) => c.record_seq) },
  } }] };
}

/** Host integration writes a full snapshot, using the host's current CAS. */
export async function save(f, changes = {}) {
  const auth = f.client.authority;
  const cursor = await f.port.cursor(auth);
  const { seq, ...state } = cursor.snapshot.document;
  const doc = valid({ ...state, ...changes, client_event_id: randomUUID(), worker_generation: auth.gen,
    working_rev: cursor.working_rev + 1, expected_prev_rev: cursor.working_rev });
  return (await f.client.append(Buffer.from(canonicalJson(doc)))).document;
}

export async function bootstrap(f) {
  await f.client.append(bytes(source()));
  const input = await f.client.append(bytes(designRecord()));
  await f.engine.start();
  const session = textSession(f);
  await session.submitTurn({ text: 'Please export entries as CSV.' });
  await session.idle();
  await f.clock.advance(30_000);
  const state = f.engine.state;
  await save(f, { spec: { ...state.spec, screens: [{ screen_ref: 'export', design_input_seq: input.document.seq }] } });
  await f.engine.transcript(); // Reload the trusted screen binding.
  return session;
}

export function textSession(f, submitConfirmed) {
  return createTextSession({ engine: f.engine, journal: f.client, journalPort: f.port,
    principalRef: 'fixture-person', now: f.clock.wallNow, submitConfirmed });
}

/** Reference-host submission hook: actual domain projection and SQLite CAS.
 * This is test wiring for the optional AIT-43 hook, not a new runtime adapter.
 */
export function referenceSubmission(f, checkpoint = () => {}) {
  const store = new SqliteProjectStore(f.path);
  const projectRef = 'project:e2e';
  if (!store.listProjects(actor).length) store.createProject({ projectRef, title: 'Synthetic export', projectKinds: ['new_product'], actor });
  const execute = async (op, auth) => {
    assert.equal(auth.gen, f.journal.cursor(auth).worker_generation);
    assert.deepEqual(Buffer.from(op.payload), op.payload_bytes ?? Buffer.from(op.payload));
    const state = valid(JSON.parse(op.payload));
    const confirmed = state.spec.items.filter((row) => row.state === 'confirmed');
    const projection = projectSubmission({ host_mode: state.host_mode, items: state.spec.items }, contributor, {
      bindings: confirmed.map((row) => ({ item_ref: row.item_ref, version: row.version,
        host: { op_key: op.op_key, proposal_ref: `proposal:e2e-${row.item_ref}-${row.version}` } })), contributed_at: at,
    });
    const current = store.getProject(projectRef, actor);
    const prior = current.stream.proposals.find((p) => p.op_key === op.op_key);
    if (prior) assert.deepEqual(prior, projection.proposals[0]);
    else store.apply({ projectRef, actor, expectedRevision: current.revision,
      mutate: (project) => ({ ...project, stream: projection.proposals.reduce((stream, proposal) => appendProposal(stream, contributor, proposal), project.stream) }) });
    checkpoint('op.after_ack');
    return { proposal_ref: projection.proposals[0].proposal_ref };
  };
  return { store, projectRef, execute, async submitConfirmed() {
    await f.engine.transcript();
    const state = f.engine.state;
    if (!state.spec.items.some((row) => row.state === 'confirmed')) return;
    const existing = store.getProject(projectRef, actor).stream.proposals;
    const confirmed = state.spec.items.filter((row) => row.state === 'confirmed');
    const bindings = confirmed.map((row) => {
      const proposal = existing.find((p) => p.requirement?.requirement_ref === row.item_ref && p.content_sha256 === row.content_sha256);
      return proposal && { item_ref: row.item_ref, version: row.version, host: { op_key: proposal.op_key, proposal_ref: proposal.proposal_ref } };
    });
    if (bindings.every(Boolean)) {
      // Recover the host projection from its acknowledged immutable proposals.
      const projected = projectSubmission({ host_mode: state.host_mode, items: state.spec.items }, contributor, { bindings, contributed_at: at });
      await save(f, { spec: { ...state.spec, items: projected.spec.items }, pending_ops: [] });
      await f.engine.transcript(); return;
    }
    const { seq, ...document } = state;
    const original = `\n${JSON.stringify(document, null, 2)}\n`;
    const op = { op_key: `${sid}:submit:${state.working_rev}`, op: 'submit', payload: original, payload_sha256: sha256Hex(original) };
    await save(f, { pending_ops: [op] });
    checkpoint('op.pending');
    const ids = await execute(op, f.client.authority);
    await f.client.append(bytes(record('op.result', { op_key: op.op_key, host_ids: ids }, { writer: { kind: 'worker', generation: f.client.authority.gen } })));
    checkpoint('op.result');
    const projected = projectSubmission({ host_mode: state.host_mode, items: state.spec.items }, contributor, {
      bindings: state.spec.items.filter((row) => row.state === 'confirmed').map((row) => ({ item_ref: row.item_ref, version: row.version,
        host: { op_key: op.op_key, proposal_ref: ids.proposal_ref } })), contributed_at: at,
    });
    await save(f, { spec: { ...state.spec, items: projected.spec.items }, pending_ops: [] });
    await f.engine.transcript();
  } };
}

/** Feed the real server request listener via Node streams, without listen(). */
export function requestWorkspace(workspace, path, { method = 'GET', form, body, cookie, headers = {}, json = true } = {}) {
  const original = body ?? (form === undefined ? '' : new URLSearchParams(form).toString());
  const req = Readable.from(original ? [Buffer.from(original)] : []);
  Object.assign(req, { method, url: path, headers: { host: '127.0.0.1', origin: 'http://127.0.0.1',
    ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    ...(cookie ? { cookie } : {}), ...(json ? { accept: 'application/json' } : {}), ...headers } });
  return new Promise((resolve) => {
    const res = new EventEmitter();
    Object.assign(res, { headersSent: false, writableEnded: false, destroyed: false,
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; this.headersSent = true; },
      end(value = '') { this.writableEnded = true; resolve({ status: this.status, headers: this.headers, text: String(value),
        json: () => JSON.parse(String(value)) }); },
    });
    assert.equal(workspace.server.emit('request', req, res), true);
  });
}

export async function workspaceFixture(t, port, extra = {}) {
  const ports = new Map();
  const workspace = createWorkspaceServer({ mode: 'test', dataDir: ':memory:', listenHost: '127.0.0.1', listenPort: 0,
    defaultProvider: 'mock', identity: { kind: 'demo', demoHmacSecret: 'synthetic-test-only', defaultSubject: actor.subject,
      memberships: [{ ...actor }] }, providers: { mock: { kind: 'mock' } }, ...extra }, {
    fetchImpl: () => { throw new Error('Outbound network is forbidden'); },
    textSessions: { get: ({ projectRef }) => ports.get(projectRef) },
  });
  t.after(() => workspace.close({ gracePeriodMs: 0 }));
  const login = await requestWorkspace(workspace, '/session/demo', { method: 'POST', form: { subject: actor.subject } });
  assert.equal(login.status, 303, login.text);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const project = workspace.controller.createProject(actor, { title: 'Synthetic export', projectKinds: ['new_product'] });
  ports.set(project.project_ref, port);
  return { workspace, project, cookie, ports, path: `/projects/${encodeURIComponent(project.project_ref)}`,
    request: (path, options = {}) => requestWorkspace(workspace, path, { cookie, ...options }) };
}

/** Real Aeon adapter + JWT verifier + mock host, with an injected fetch. */
export function mockAdapter(options = {}) {
  const f = mockFixture(options);
  const requests = [];
  let liveGrant = f.liveGrant;
  const auth = { sid: f.sid, tid: f.authz.tid, pid: f.authz.pid, gen: 1, auth_epoch: 1,
    writer_kind: 'worker', capabilities: [...loadContractFile('capabilities.json').delegated_allowed], exp: f.now() + 900 };
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://host.example');
    assert.equal(request.redirect, 'error');
    const headers = request.headers;
    const call = { method: request.method, path: new URL(url).pathname + new URL(url).search,
      token: headers.authorization.slice(7), liveGrant: headers['x-live-grant'], opKey: headers['idempotency-key'],
      intakeMetadata: headers['x-aithema-intake'], ...(request.body === undefined ? {} : { body: request.body.toString() }) };
    requests.push(call);
    const response = f.host.request(call);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
  };
  const http = new AeonHttp({ baseUrl: 'https://host.example', scope: auth, fetchImpl,
    credentials: (a) => ({ token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch }), liveGrant }) });
  const journal = new AeonJournal({ http, recordFormat: 'projection', takeoverAuthority: (a) => {
    const gen = f.host.takeover(f.sid); liveGrant = f.host.liveGrant(f.sid); return { ...a, gen };
  } });
  const intake = new AeonIntake({ http, supportsReplace: true });
  return { f, auth, http, journal, intake, requests };
}

export function mockEngine(t) {
  const adapter = mockAdapter();
  const { f, auth, journal } = adapter;
  const clock = new FakeClock(); clock.wallNow = () => f.now() * 1000 + clock.value;
  const budgetPort = Object.fromEntries(['admit', 'claim', 'settle', 'recover'].map((method) => [method, (original, a) => {
    const response = f.request('ledger', method, original.toString(), { token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch }) });
    if (response.status !== 200) throw new BudgetError(response.status, response.body.code ?? response.body.message, response.body.code);
    return response.body;
  }]));
  budgetPort.listOpen = (query, a) => {
    const params = new URLSearchParams({ state: 'open', limit: String(query.limit ?? 1000) });
    if (query.cursor) params.set('cursor', query.cursor);
    const response = f.request('ledger', 'holds', undefined, { path: `${routePath('ledger', f.sid, 'holds')}?${params}`,
      token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch }) });
    if (response.status !== 200) throw new BudgetError(response.status, response.body.code, response.body.code);
    return response.body;
  };
  budgetPort.isCurrent = (a) => {
    const response = f.request('journal', 'authority', undefined, { token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch }) });
    return response.status === 200 && response.body.worker_generation === a.gen && response.body.auth_epoch === a.auth_epoch && !response.body.tombstone;
  };
  const client = new JournalClient({ port: journal, authority: auth, now: clock.wallNow });
  const budget = new BudgetClient({ port: budgetPort, journal, authority: auth, now: clock.wallNow });
  const authorizationFor = (a) => new AuthorizationSession({ authorization: f.authz, settingsSha256: f.authz.settings_sha256,
    scope: { ...a, worker_generation: a.gen } });
  const calls = [];
  const reasoning = { async *streamChat(request) {
    const lane = request.system.startsWith('Return only JSON {say') ? 'reaction' : 'spec';
    const payload = JSON.parse(request.messages[0].content); calls.push({ lane, payload });
    request.onUsage({ input_tokens: 1, output_tokens: 1 }); yield JSON.stringify(output(lane, payload));
  }, understand() { throw new Error('Unexpected provider path'); } };
  const makeEngine = (journalClient = client) => new TextEngine({ journal: journalClient, journalPort: journal, budget, authorization: authorizationFor(journalClient.authority),
    reasoning, clock, maxMicro: { reaction: 100, spec: 100, design: 100 }, priceUsage: () => 7 });
  const engine = makeEngine(); t.after(() => engine.close());
  return { ...adapter, port: journal, client, budget, clock, engine, makeEngine, authorizationFor, calls };
}
