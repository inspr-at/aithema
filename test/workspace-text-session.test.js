import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../contracts/validate.js';
import { createWorkspaceServer } from '../workspace/index.js';
import { confirmBatch, createTextSession, normalizeTurnText } from '../workspace/text-session.js';
import { TextUiError } from '../workspace/text-ui.js';
import { authorizationFor, fixture, item } from './engine-helpers.test.js';
import { auditAccessibility, find, parseHtml, textOf } from './workspace-dom.test.js';

const memberships = ['demo-reviewer', 'demo-agent', 'demo-outsider'].map((name) => ({
  subject: name, party_ref: `party:${name}`, actor_kind: name === 'demo-agent' ? 'agent' : 'human',
  roles: name === 'demo-reviewer' ? ['requirements_approver', 'delivery_party'] : ['delivery_party'], projects: [],
}));
const demoConfig = (extra = {}) => ({
  mode: 'test', listenHost: '127.0.0.1', listenPort: 0, defaultProvider: 'mock',
  identity: { kind: 'demo', demoHmacSecret: 'demo-hmac-secret-not-for-production', defaultSubject: 'demo-reviewer', memberships },
  providers: { mock: { kind: 'mock' } }, ...extra,
});

const EXPORT_TURN = 'We need an export for admins';
const QUOTE = 'export';
const STRIP = ['version', 'content_sha256', 'state', 'supersedes_item_version', 'host'];

function newItem(person, ordinal, ref, statement) {
  const row = item({ citations: [{ record_seq: person.seq, locator: `turn:${ordinal}`, quote: QUOTE }], leaves: [person.seq] });
  row.item_ref = ref;
  row.content = { ...row.content, statement };
  for (const key of STRIP) delete row[key];
  return row;
}

/** Lane A names the open question; lane B drafts two items from the first person turn. */
function handler(lane, payload) {
  if (lane === 'reaction') {
    return { say: 'Noted.', question_id: payload.questions.find((q) => ['open', 'asked'].includes(q.state))?.question_id ?? null, tools: [] };
  }
  const person = payload.events.find((r) => r.kind === 'turn' && r.data.speaker === 'person');
  if (!person || payload.spec.items.length) return { base_rev: payload.base_rev, items: [] };
  const ordinal = payload.turn_ordinals.find(([seq]) => seq === person.seq)[1];
  return { base_rev: payload.base_rev,
    items: [{ op: 'add', item: newItem(person, ordinal, 'REQ-A', person.data.body.slice(0, 500)) },
      { op: 'add', item: newItem(person, ordinal, 'REQ-B', 'Second drafted item.') }],
    questions: [{ question_id: 'Q-1', text: 'Who may export?', state: 'open' }] };
}

async function setup(t, { handler: lane = handler, principalRef = 'fixture-person', config = {}, fixtureOptions = {}, sessionOptions = {} } = {}) {
  // Overrides may need the fixture's own journal, which exists only afterwards.
  const holder = { f: null };
  const f = fixture(t, { handler: lane, ...(typeof fixtureOptions === 'function' ? fixtureOptions(holder) : fixtureOptions) });
  holder.f = f;
  await f.engine.start();
  const errors = [];
  const session = createTextSession({ engine: f.engine, journal: f.client, journalPort: f.port, principalRef,
    onError: (error) => errors.push(error), ...sessionOptions });
  const ports = new Map();
  const workspace = createWorkspaceServer(demoConfig(config), { textSessions: { get: ({ projectRef }) => ports.get(projectRef) ?? null } });
  const { url } = await workspace.listen();
  t.after(() => workspace.close({ gracePeriodMs: 0 }));
  const mount = config.publicBasePath ?? '';
  const origin = new URL(url).origin;

  async function login(subject) {
    const response = await fetch(`${url}${mount}/session/demo`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams({ subject }) });
    assert.equal(response.status, 303);
    return response.headers.getSetCookie().find((line) => line.startsWith('aithema_demo=')).split(';')[0];
  }
  async function createProject(cookie, attach = true) {
    const response = await fetch(`${url}${mount}/projects`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin },
      body: new URLSearchParams({ title: 'Text project', project_kinds: 'new_product' }) });
    assert.equal(response.status, 303);
    const path = new URL(response.headers.get('location'), url).pathname.slice(mount.length);
    if (attach) ports.set(decodeURIComponent(path.split('/')[2]), session);
    return path;
  }
  const request = (path, { cookie, method = 'GET', form, json, origin: from = origin, headers = {} } = {}) => fetch(`${url}${mount}${path}`, {
    method, redirect: 'manual',
    headers: { cookie, ...(from ? { origin: from } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(json ? { accept: 'application/json' } : {}), ...headers },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const page = async (path, cookie) => (await request(path, { cookie })).text();
  const cookie = await login('demo-reviewer');
  const projectPath = await createProject(cookie);
  const records = (kind) => f.records(kind).map((row) => row.document);
  return { f, session, errors, workspace, url, origin, mount, login, createProject, request, page, cookie, projectPath, records, ports,
    send: async (text, extra = {}) => {
      const response = await request(`${projectPath}/text/turns`, { cookie, method: 'POST', form: { message: text, ...extra } });
      await session.idle();
      return response;
    } };
}

const byId = (html, id) => find(parseHtml(html), (n) => n.attrs.id === id)[0];
const bindingsIn = (html, formId) => find(byId(html, formId), (n) => n.tag === 'input' && n.attrs.name === 'binding').map((n) => n.attrs.value);
const durability = (html) => byId(html, 'text-durability').attrs['data-durability'];

describe('text session page (real engine, real journal)', () => {
  it('shows the disclosure badge and the durability indicator and replaces the legacy composer', async (t) => {
    const w = await setup(t);
    const html = await w.page(w.projectPath, w.cookie);
    assert.match(textOf(byId(html, 'text-ai-badge')), /You are talking to an AI system/);
    assert.equal(durability(html), 'durable');
    assert.ok(!html.includes('id="workspace-compose"'));
    assert.match(html, /No items are waiting for your confirmation/);
    assert.match(html, /<script type="module" src="\/workspace-text-ui\.js">/);
    assert.deepEqual(auditAccessibility(html).problems, []);
  });

  it('without a session provider the workspace is unchanged', async (t) => {
    const workspace = createWorkspaceServer(demoConfig());
    const { url } = await workspace.listen();
    t.after(() => workspace.close({ gracePeriodMs: 0 }));
    const origin = new URL(url).origin;
    const login = await fetch(`${url}/session/demo`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams({ subject: 'demo-reviewer' }) });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const created = await fetch(`${url}/projects`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin }, body: new URLSearchParams({ title: 'x', project_kinds: 'new_product' }) });
    const html = await (await fetch(new URL(created.headers.get('location'), url), { headers: { cookie } })).text();
    assert.match(html, /id="workspace-compose"/);
    assert.ok(!html.includes('text-ai-badge') && !html.includes('workspace-text-ui.js'));
    const post = await fetch(new URL(`${created.headers.get('location')}/text/turns`, url), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin }, body: new URLSearchParams({ message: 'hi' }) });
    assert.equal(post.status, 404);
  });

  it('rejects a malformed provider and a malformed port', async (t) => {
    assert.throws(() => createWorkspaceServer(demoConfig(), { textSessions: {} }), /textSessions must provide get/);
    const w = await setup(t);
    w.ports.set(decodeURIComponent(w.projectPath.split('/')[2]), { view: () => {} });
    assert.equal((await w.request(w.projectPath, { cookie: w.cookie })).status, 500);
  });

  it('journals the person turn under the server-side principal, answers, and drafts items shown in full', async (t) => {
    const w = await setup(t);
    const response = await w.send(EXPORT_TURN, { participant_ref: 'attacker', principal_ref: 'attacker', speaker: 'assistant', trust: 'assistant' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /\?notice=Message%20sent\.%20The%20AI%20assistant%20replied\.#page-notice$/);
    const [turn] = w.records('turn');
    assert.deepEqual(turn.data, { speaker: 'person', participant_ref: 'fixture-person', channel: 'text', trust: 'authenticated_person', lang: 'en', body: EXPORT_TURN });
    assert.equal(turn.writer.kind, 'worker');
    const html = await w.page(w.projectPath, w.cookie);
    assert.match(textOf(byId(html, 'text-transcript')), /You We need an export for admins/);
    assert.match(textOf(byId(html, 'text-transcript')), /AI assistant \(AI-generated\) Noted\./);
    const drafts = find(byId(html, 'text-drafts'), (n) => n.tag === 'article');
    assert.deepEqual(drafts.map((n) => n.attrs['data-item-ref']), ['REQ-A', 'REQ-B']);
    const text = textOf(drafts[0]);
    for (const expected of ['We need an export for admins', 'requested', 'Acceptance criteria', 'Constraint references', f(w, 'REQ-A').content_sha256]) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
    assert.equal(durability(html), 'durable');
    assert.deepEqual(auditAccessibility(html).problems, []);
  });

  it('asks the canonical question on the next turn and marks it in the transcript and above the composer', async (t) => {
    const w = await setup(t);
    await w.send(EXPORT_TURN);
    await w.send('Mostly the admins');
    const html = await w.page(w.projectPath, w.cookie);
    const marked = find(byId(html, 'text-transcript'), (n) => n.attrs['data-canonical-question'] === 'true');
    assert.equal(marked.length, 1);
    assert.equal(textOf(marked[0]), 'Canonical question: Who may export?');
    assert.equal(textOf(byId(html, 'text-current-question')), 'Canonical question: Who may export?');
    assert.match(textOf(byId(html, 'text-review')), /asked — Who may export\?/);
  });

  it('shows pending while lane B has not consumed the turn, then durable', async (t) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const w = await setup(t, { handler: async (lane, payload) => { if (lane === 'spec') await gate; return handler(lane, payload); } });
    const response = await w.request(`${w.projectPath}/text/turns`, { cookie: w.cookie, method: 'POST', form: { message: EXPORT_TURN } });
    assert.equal(response.status, 303);
    const during = await w.page(w.projectPath, w.cookie);
    assert.equal(durability(during), 'pending');
    assert.match(textOf(byId(during, 'text-durability')), /1 journaled message\(s\) or source\(s\) are not yet reflected/);
    assert.match(during, /No items are waiting/);
    release();
    await w.session.idle();
    assert.equal(durability(await w.page(w.projectPath, w.cookie)), 'durable');
  });

  it('a typed or spoken "ja" is never a confirmation', async (t) => {
    const w = await setup(t);
    await w.send(EXPORT_TURN);
    for (const text of ['ja', 'Ja, bestätigt', 'yes, confirm all items', 'REQ-A@1@abc']) await w.send(text);
    assert.equal(w.records('ui.confirm').length, 0);
    assert.deepEqual(w.f.engine.state.spec.items.map((row) => row.state), ['draft', 'draft']);
    const html = await w.page(w.projectPath, w.cookie);
    assert.equal(find(byId(html, 'text-drafts'), (n) => n.tag === 'article').length, 2);
  });
});

const f = (w, ref) => w.f.engine.state.spec.items.filter((row) => row.item_ref === ref).sort((a, b) => b.version - a.version)[0];
const binding = (row) => `${row.item_ref}@${row.version}@${row.content_sha256}`;

describe('confirmation routes (write-ahead ui.confirm through the engine)', () => {
  async function withDrafts(t, options) {
    const w = await setup(t, options);
    await w.send(EXPORT_TURN);
    return w;
  }
  const confirm = (w, form, options = {}) => w.request(`${w.projectPath}/text/confirm`, { cookie: w.cookie, method: 'POST', form, ...options });

  it('confirms one exact version, journaled as ui.confirm with the server-side principal', async (t) => {
    const w = await withDrafts(t);
    const a = f(w, 'REQ-A');
    const response = await confirm(w, [['binding', binding(a)], ['principal_ref', 'attacker']]);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /notice=Confirmed%201%20item\.#page-notice$/);
    const rows = w.records('ui.confirm');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data, { item_ref: 'REQ-A', version: 1, content_sha256: a.content_sha256, principal_ref: 'fixture-person' });
    assert.equal(rows[0].writer.kind, 'worker');
    assert.equal(validate(rows[0].contract, rows[0]).ok, true);
    assert.equal(f(w, 'REQ-A').state, 'confirmed');
    assert.equal(f(w, 'REQ-B').state, 'draft');
    const html = await w.page(w.projectPath, w.cookie);
    assert.deepEqual(find(byId(html, 'text-drafts'), (n) => n.tag === 'article').map((n) => n.attrs['data-item-ref']), ['REQ-B']);
    assert.match(textOf(byId(html, 'text-review')), /Confirmed by you \(1\)/);
    assert.equal(durability(html), 'durable');
  });

  it('the forms on the page produce bindings the route accepts (Einreichen confirms every item shown)', async (t) => {
    const w = await withDrafts(t);
    const html = await w.page(w.projectPath, w.cookie);
    const all = bindingsIn(html, 'text-einreichen-form');
    assert.deepEqual(all, [binding(f(w, 'REQ-A')), binding(f(w, 'REQ-B'))]);
    const response = await confirm(w, [['action', 'einreichen'], ...all.map((value) => ['binding', value])]);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /Confirmed%202%20items\./);
    assert.equal(w.records('ui.confirm').length, 2);
    assert.deepEqual(w.f.engine.state.spec.items.map((row) => row.state), ['confirmed', 'confirmed']);
  });

  it('a repeated or double-clicked submission is an idempotent no-op and journals nothing more', async (t) => {
    const w = await withDrafts(t);
    const form = [['binding', binding(f(w, 'REQ-A'))]];
    assert.equal((await confirm(w, form)).status, 303);
    const rev = w.f.engine.state.working_rev;
    const again = await confirm(w, form);
    assert.equal(again.status, 303);
    assert.match(again.headers.get('location'), /Confirmed%200%20items\.%201%20already%20confirmed\./);
    assert.equal(w.records('ui.confirm').length, 1);
    assert.equal(w.f.engine.state.working_rev, rev);
  });

  it('concurrent submissions of the same binding journal exactly one confirmation', async (t) => {
    const w = await withDrafts(t);
    const form = [['binding', binding(f(w, 'REQ-A'))]];
    const results = await Promise.all([confirm(w, form, { json: true }), confirm(w, form, { json: true }), confirm(w, form, { json: true })]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(w.records('ui.confirm').length, 1);
    const bodies = await Promise.all(results.map((r) => r.json()));
    assert.deepEqual(bodies.map((b) => b.confirmed).sort(), [0, 0, 1]);
  });

  for (const [name, mutate, status, code] of [
    ['a mismatched content digest', (row) => `${row.item_ref}@${row.version}@${`${row.content_sha256.slice(0, 63)}${row.content_sha256.endsWith('0') ? '1' : '0'}`}`, 409, 'hash_mismatch'],
    ['a wrong version', (row) => `${row.item_ref}@2@${row.content_sha256}`, 409, 'unknown_item'],
    ['an unknown item', (row) => `REQ-X@1@${row.content_sha256}`, 409, 'unknown_item'],
    ['a malformed binding', () => 'REQ-A/1/abc', 400, 'invalid_binding'],
    ['markup in the binding', (row) => `<script>@1@${row.content_sha256}`, 400, 'invalid_binding'],
  ]) {
    it(`refuses ${name} without journaling anything`, async (t) => {
      const w = await withDrafts(t);
      const before = w.records().length;
      const rev = w.f.engine.state.working_rev;
      const json = await confirm(w, [['binding', mutate(f(w, 'REQ-A'))]], { json: true });
      assert.equal(json.status, status);
      assert.equal((await json.json()).code, code);
      const html = await confirm(w, [['binding', mutate(f(w, 'REQ-A'))]]);
      assert.equal(html.status, status);
      const body = await html.text();
      assert.equal(find(parseHtml(body), (n) => n.attrs.role === 'alert').length, 1);
      assert.match(body, /data-ai-disclosure="art50-1"/, 'the disclosure survives error pages');
      assert.ok(!body.includes('<script>@'));
      assert.equal(w.records('ui.confirm').length, 0);
      assert.equal(w.records().length, before);
      assert.equal(w.f.engine.state.working_rev, rev);
      assert.deepEqual(w.f.engine.state.spec.items.map((row) => row.state), ['draft', 'draft']);
    });
  }

  it('refuses an empty submission and ignores the principal a browser tries to supply', async (t) => {
    const w = await withDrafts(t);
    assert.equal((await confirm(w, [])).status, 400);
    assert.equal((await confirm(w, [['principal_ref', 'attacker'], ['item_ref', 'REQ-A']])).status, 400);
    assert.equal(w.records('ui.confirm').length, 0);
  });

  it('refuses the whole batch when one item changed after it was shown (all-or-nothing)', async (t) => {
    let passes = 0;
    const w = await setup(t, { handler: (lane, payload) => {
      if (lane !== 'spec') return handler(lane, payload);
      passes += 1;
      if (passes === 1) return handler(lane, payload);
      const original = payload.spec.items.find((row) => row.item_ref === 'REQ-A' && row.state === 'draft');
      return { base_rev: payload.base_rev, items: original ? [{ op: 'revise', identity: { item_ref: 'REQ-A', version: 1 },
        revision: { content: { ...original.content, statement: 'Changed after you looked.' }, citations: original.citations, provenance: original.provenance } }] : [] };
    } });
    await w.send(EXPORT_TURN);
    const shown = bindingsIn(await w.page(w.projectPath, w.cookie), 'text-einreichen-form');
    await w.send('Actually, change the first item');
    assert.deepEqual(w.errors.map((e) => e.cause?.message ?? e.message), []);
    assert.equal(f(w, 'REQ-A').version, 2);
    const response = await confirm(w, [['action', 'einreichen'], ...shown.map((value) => ['binding', value])]);
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(body, /replaced by a newer version/);
    assert.equal(w.records('ui.confirm').length, 0, 'REQ-B was not confirmed either');
    const fresh = bindingsIn(body, 'text-einreichen-form');
    assert.deepEqual(fresh.sort(), [binding(f(w, 'REQ-A')), binding(f(w, 'REQ-B'))].sort());
    assert.match(body, /Changed after you looked\./);
    assert.equal((await confirm(w, [['action', 'einreichen'], ...fresh.map((value) => ['binding', value])])).status, 303);
    assert.equal(w.records('ui.confirm').length, 2);
  });

  it('does not let a person confirm an item that changed while it was being confirmed', async (t) => {
    const w = await withDrafts(t);
    const stale = { ...w.session, async confirmItem(confirmation) {
      const state = await w.session.confirmItem(confirmation);
      return { ...state, spec: { ...state.spec, items: state.spec.items.map((row) => ({ ...row, state: 'draft' })) } };
    } };
    await assert.rejects(confirmBatch(stale, binding(f(w, 'REQ-A'))), (error) => error.code === 'changed_while_confirming' && error.status === 409);
  });

  it('answers JSON clients with counts, a fixed message and the durability state', async (t) => {
    const w = await withDrafts(t);
    const turn = await w.request(`${w.projectPath}/text/turns`, { cookie: w.cookie, method: 'POST', form: { message: 'More detail' }, json: true });
    assert.equal(turn.status, 200);
    const turnBody = await turn.json();
    assert.equal(turnBody.reaction_status, 'delivered');
    assert.equal(turnBody.message, 'Message sent. The AI assistant replied.');
    assert.ok(Number.isInteger(turnBody.turn_seq));
    assert.equal(turnBody.durability.journal_state, 'ACTIVE');
    await w.session.idle();
    const ok = await confirm(w, [['binding', binding(f(w, 'REQ-B'))]], { json: true });
    assert.deepEqual({ ...(await ok.json()), durability: undefined }, { status: 'ok', confirmed: 1, already_confirmed: 0, submitted: null, message: 'Confirmed 1 item.', durability: undefined });
  });
});

describe('who may act', () => {
  it('refuses an agent actor even when a session is attached, and journals nothing', async (t) => {
    const w = await setup(t);
    const agent = await w.login('demo-agent');
    const agentProject = await w.createProject(agent);
    await w.send(EXPORT_TURN);
    const before = w.records().length;
    const page = await w.page(agentProject, agent);
    assert.match(page, /Only a signed-in human participant can send messages/);
    assert.equal(find(parseHtml(page), (n) => n.tag === 'form' && Object.hasOwn(n.attrs, 'data-text-turn-form')).length, 0);
    const turn = await w.request(`${agentProject}/text/turns`, { cookie: agent, method: 'POST', form: { message: 'hello' } });
    assert.equal(turn.status, 403);
    const row = f(w, 'REQ-A');
    const confirmed = await w.request(`${agentProject}/text/confirm`, { cookie: agent, method: 'POST', form: { binding: binding(row) }, json: true });
    assert.equal(confirmed.status, 403);
    assert.equal(w.records().length, before);
    assert.equal(row.state, 'draft');
  });

  it('refuses a person who is not a member of the project, and a cross-origin post', async (t) => {
    const w = await setup(t);
    await w.send(EXPORT_TURN);
    const before = w.records().length;
    const outsider = await w.login('demo-outsider');
    const row = f(w, 'REQ-A');
    for (const path of ['turns', 'confirm']) {
      const response = await w.request(`${w.projectPath}/text/${path}`, { cookie: outsider, method: 'POST', form: { message: 'x', binding: binding(row) } });
      assert.ok([403, 404].includes(response.status), `outsider ${path}: ${response.status}`);
    }
    assert.equal((await w.request(w.projectPath, { cookie: outsider })).status, 403);
    const foreign = await w.request(`${w.projectPath}/text/confirm`, { cookie: w.cookie, method: 'POST', form: { binding: binding(row) }, origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    const noOrigin = await w.request(`${w.projectPath}/text/confirm`, { cookie: w.cookie, method: 'POST', form: { binding: binding(row) }, origin: null });
    assert.equal(noOrigin.status, 403);
    assert.equal(w.records().length, before);
    assert.equal(f(w, 'REQ-A').state, 'draft');
  });

  it('requires a signed-in actor', async (t) => {
    const w = await setup(t);
    const response = await w.request(`${w.projectPath}/text/turns`, { method: 'POST', form: { message: 'x' } });
    assert.equal(response.status, 401);
    assert.equal(w.records('turn').length, 0);
  });
});

describe('failure modes stay visible and honest', () => {
  it('escapes hostile text from the person and the model end to end', async (t) => {
    const w = await setup(t);
    const hostile = '<script>alert(1)</script> "quoted" export <img src=x onerror=alert(2)>';
    await w.send(hostile);
    const html = await w.page(w.projectPath, w.cookie);
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.deepEqual(auditAccessibility(html).problems, []);
  });

  it('keeps the draft and says so when the journal host does not acknowledge the message', async (t) => {
    let down = false;
    const w = await setup(t, { fixtureOptions: (holder) => ({ journalOverrides: { append: (original, auth) => {
      if (down && JSON.parse(original).kind === 'turn') throw new Error('host down');
      return holder.f.journal.append(original, auth);
    } } }) });
    await w.send(EXPORT_TURN);
    down = true;
    const response = await w.request(`${w.projectPath}/text/turns`, { cookie: w.cookie, method: 'POST', form: { message: 'Lost unless retained' } });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(textOf(find(parseHtml(html), (n) => n.attrs.role === 'alert')[0]), /did not acknowledge your message/);
    assert.equal(find(parseHtml(html), (n) => n.tag === 'textarea')[0].children[0]?.text, 'Lost unless retained');
    assert.equal(durability(html), 'pending');
    assert.match(textOf(byId(html, 'text-durability')), /1 record\(s\) were sent but the journal host has not acknowledged/);
    assert.equal(w.records('turn').length, 1);
  });

  it('still renders, with the badge and an alert, when the session cannot be read', async (t) => {
    let broken = false;
    const w = await setup(t, { fixtureOptions: (holder) => ({ journalOverrides: { cursor: (auth) => {
      if (broken) throw new Error('host down');
      return holder.f.journal.cursor(auth);
    } } }) });
    broken = true;
    const response = await w.request(w.projectPath, { cookie: w.cookie });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(textOf(find(parseHtml(html), (n) => n.attrs.role === 'alert')[0]), /text session is unavailable/);
    assert.match(html, /data-ai-disclosure="art50-1"/);
    assert.equal(durability(html), 'pending');
    assert.match(html, /session is not running/);
    assert.deepEqual(auditAccessibility(html).problems, []);
  });

  it('keeps the journaled turn and reports a failed reply instead of hiding the message', async (t) => {
    const w = await setup(t, { handler: (lane, payload) => (lane === 'reaction' ? 'not json' : handler(lane, payload)) });
    const response = await w.send(EXPORT_TURN);
    assert.equal(response.status, 303);
    assert.match(decodeURIComponent(response.headers.get('location')), /could not produce a reply/);
    assert.equal(w.records('turn').length, 1);
    assert.equal(w.errors.length, 1);
    assert.equal(w.f.engine.state.spec.items.length, 2, 'lane B still ran');
  });

  it('reports a partial batch honestly when the journal fails midway', async (t) => {
    const w = await setup(t);
    await w.send(EXPORT_TURN);
    let calls = 0;
    const flaky = { ...w.session, principalRef: w.session.principalRef, async confirmItem(confirmation) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('host down'), { status: 503 });
      return w.session.confirmItem(confirmation);
    } };
    await assert.rejects(confirmBatch(flaky, [binding(f(w, 'REQ-A')), binding(f(w, 'REQ-B'))]), (error) => {
      assert.equal(error.code, 'confirm_failed');
      assert.equal(error.status, 503);
      assert.equal(error.confirmed.length, 1);
      assert.match(error.message, /Confirmed 1 of 2/);
      return true;
    });
    assert.deepEqual(w.f.engine.state.spec.items.map((row) => row.state), ['confirmed', 'draft']);
  });

  it('serves the client script with a CSP that forbids inline script', async (t) => {
    const w = await setup(t);
    const asset = await w.request('/workspace-text-ui.js', { cookie: w.cookie });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /data-text-turn-form/);
    const response = await w.request(w.projectPath, { cookie: w.cookie });
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('works under a public base path', async (t) => {
    const w = await setup(t, { config: { publicBasePath: '/aithema' } });
    await w.send(EXPORT_TURN);
    const html = await w.page(w.projectPath, w.cookie);
    assert.ok(html.includes('src="/aithema/workspace-text-ui.js"'));
    const action = find(parseHtml(html), (n) => n.tag === 'form' && Object.hasOwn(n.attrs, 'data-text-turn-form'))[0].attrs.action;
    assert.equal(action, `/aithema${w.projectPath}/text/turns`);
    const response = await w.request(`${w.projectPath}/text/confirm`, { cookie: w.cookie, method: 'POST', form: { binding: binding(f(w, 'REQ-A')) } });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /^\/aithema\/projects\//);
  });
});

describe('durability across a restart', () => {
  it('shows the journaled spec and confirmations after a fresh worker takes over the same host', async (t) => {
    const first = await setup(t);
    await first.send(EXPORT_TURN);
    await first.request(`${first.projectPath}/text/confirm`, { cookie: first.cookie, method: 'POST', form: { binding: binding(f(first, 'REQ-A')) } });
    const second = fixture(t, { path: first.f.path, initialize: false, handler });
    await second.engine.resume({ authorizationFor, replay: false });
    const session = createTextSession({ engine: second.engine, journal: second.client, journalPort: second.port, principalRef: 'fixture-person' });
    first.ports.set(decodeURIComponent(first.projectPath.split('/')[2]), session);
    const html = await first.page(first.projectPath, first.cookie);
    assert.equal(durability(html), 'durable');
    assert.match(textOf(byId(html, 'text-review')), /Confirmed by you \(1\)/);
    assert.deepEqual(find(byId(html, 'text-drafts'), (n) => n.tag === 'article').map((n) => n.attrs['data-item-ref']), ['REQ-B']);
    assert.match(textOf(byId(html, 'text-transcript')), /We need an export for admins/);
    assert.equal(second.records('ui.confirm').length, 1);
  });
});

describe('batch confirmation unit behaviour', () => {
  const draft = (ref) => item({ citations: [], leaves: [] });
  const fakePort = (overrides = {}) => {
    const calls = [];
    const row = { ...draft(), state: 'draft' };
    const state = { spec: { items: [row] } };
    return { calls, row, port: { principalRef: 'fixture-person', view: async () => ({ state }), submitTurn: async () => ({}),
      confirmItem: async (c) => { calls.push(['confirm', c]); return { spec: { items: [{ ...row, state: 'confirmed' }] } }; },
      ...overrides } };
  };

  it('runs the Einreichen hook only after every confirmation succeeded, only for Einreichen', async () => {
    const hook = [];
    const { port, row } = fakePort({ submitConfirmed: async () => { hook.push('submit'); } });
    const ref = `${row.item_ref}@${row.version}@${row.content_sha256}`;
    assert.deepEqual((await confirmBatch(port, ref)).submitted, null);
    assert.deepEqual(hook, []);
    assert.equal((await confirmBatch(port, ref, { einreichen: true })).submitted, true);
    assert.deepEqual(hook, ['submit']);
  });

  it('never runs the hook after a refusal, and reports a failed submission without hiding the confirmation', async () => {
    const hook = [];
    const { port, row } = fakePort({ submitConfirmed: async () => { hook.push('submit'); throw Object.assign(new Error('x'), { status: 500 }); } });
    await assert.rejects(confirmBatch(port, `${row.item_ref}@${row.version}@${'0'.repeat(64)}`, { einreichen: true }), { code: 'hash_mismatch' });
    assert.deepEqual(hook, []);
    await assert.rejects(confirmBatch(port, `${row.item_ref}@${row.version}@${row.content_sha256}`, { einreichen: true }),
      (error) => error.code === 'submit_failed' && error.status === 503 && error.confirmed.length === 1);
  });

  it('uses only the port principal and refuses a port without one', async () => {
    const { port, calls, row } = fakePort();
    await confirmBatch(port, `${row.item_ref}@${row.version}@${row.content_sha256}`);
    assert.equal(calls[0][1].principal_ref, 'fixture-person');
    await assert.rejects(confirmBatch({ ...port, principalRef: '../etc' }, 'x'), { code: 'invalid_session' });
    await assert.rejects(confirmBatch({ view() {}, submitTurn() {}, confirmItem() {} }, 'x'), { code: 'invalid_session' });
  });

  it('validates turn text and session construction', () => {
    assert.equal(normalizeTurnText('  hi\r\nthere  '), 'hi\nthere');
    for (const bad of [undefined, null, 4, '', '   \n', 'x'.repeat(8001), ['a']]) {
      assert.throws(() => normalizeTurnText(bad), (error) => error instanceof TextUiError && error.code === 'invalid_turn');
    }
    assert.equal(normalizeTurnText('🙂'.repeat(8000)).length, 16000);
    assert.throws(() => createTextSession({ engine: {}, journal: {}, journalPort: {}, principalRef: 'not a ref' }), /principalRef/);
  });
});
