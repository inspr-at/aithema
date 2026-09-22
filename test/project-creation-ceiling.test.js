import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateMembershipMapping } from '../runtime/identity.js';
import { SqliteProjectStore } from '../runtime/store.js';
import { provisionMappedProject } from '../runtime/provision-project.js';
import { createWorkspaceServer } from '../workspace/server.js';

const reviewer = {
  subject: 'sandbox-reviewer', party_ref: 'party:sandbox-reviewer', actor_kind: 'human',
  roles: ['requirements_approver'], projects: ['project:uxqa'], can_create_projects: false,
};
const ordinary = { subject: 'ordinary', party_ref: 'party:ordinary', actor_kind: 'human', roles: ['requirements_approver'], projects: [] };

test('creation ceiling is validated, preserved in mapping, and enforced by store', () => {
  for (const invalid of [null, 0, 1, 'false', {}, []]) {
    assert.throws(() => validateMembershipMapping([{ ...reviewer, can_create_projects: invalid }]), /must be a boolean/);
  }
  const actor = validateMembershipMapping([reviewer]).get(reviewer.subject);
  assert.equal(actor.can_create_projects, false);
  const store = new SqliteProjectStore(':memory:');
  try {
    assert.throws(() => store.createProject({ actor, title: 'Forbidden', projectKinds: ['integration'] }), { code: 'forbidden' });
    const created = store.createProject({ actor: ordinary, title: 'Existing behavior', projectKinds: ['integration'] });
    assert.equal(store.getProject(created.project_ref, ordinary).title, 'Existing behavior');
    assert.throws(() => store.getProject(created.project_ref, reviewer), { code: 'forbidden' });
  } finally { store.close(); }
});

test('offline provision inserts only the mapped project, no creator grant, and never changes an existing row', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aithema-restricted-project-'));
  t.after(() => execFileSync('trash', [dir]));
  const databaseFile = join(dir, 'aithema-workspace.sqlite');
  const initial = new SqliteProjectStore(databaseFile);
  initial.createProject({ projectRef: 'project:untouched', title: 'Existing project', projectKinds: ['iteration'], actor: ordinary });
  initial.close();
  const inspect = () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try { return { projects: db.prepare('SELECT * FROM projects ORDER BY project_ref').all(), members: db.prepare('SELECT * FROM members ORDER BY project_ref').all() }; }
    finally { db.close(); }
  };
  const before = inspect();
  const input = { databaseFile, actor: reviewer, projectRef: 'project:uxqa', title: 'UXQA sandbox' };
  assert.deepEqual(provisionMappedProject(input), { schema: 'inspr.aithema.project-provision.v1', eligible: true, created: false });
  assert.deepEqual(inspect(), before);
  for (const actor of [{ ...reviewer, can_create_projects: true }, { ...reviewer, projects: [] }, { ...reviewer, projects: ['project:other'] }, { ...reviewer, roles: ['requirements_approver', 'operator'] }]) {
    assert.throws(() => provisionMappedProject({ ...input, actor, apply: true }), /requires one exact/);
    assert.deepEqual(inspect(), before);
  }
  assert.equal(provisionMappedProject({ ...input, apply: true }).created, true);
  const after = inspect();
  assert.deepEqual(after.projects.filter((row) => row.project_ref !== 'project:uxqa'), before.projects);
  assert.deepEqual(after.members, before.members);
  assert.throws(() => provisionMappedProject({ ...input, apply: true }), /already exists/);
  assert.deepEqual(inspect(), after);
  const store = new SqliteProjectStore(databaseFile);
  try {
    assert.equal(store.getProject('project:uxqa', reviewer).title, 'UXQA sandbox');
    assert.throws(() => store.getProject('project:uxqa', { ...reviewer, projects: [] }), { code: 'forbidden' });
    assert.throws(() => store.getProject('project:untouched', reviewer), { code: 'forbidden' });
  } finally { store.close(); }
});

test('provisioning refuses a reviewer with any earlier creator grant without changing stored rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aithema-existing-reviewer-'));
  t.after(() => execFileSync('trash', [dir]));
  const databaseFile = join(dir, 'aithema-workspace.sqlite');
  const store = new SqliteProjectStore(databaseFile);
  store.createProject({ projectRef: 'project:earlier-work', title: 'Earlier work', projectKinds: ['integration'], actor: { ...reviewer, can_create_projects: true } });
  store.close();
  const inspect = () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try { return { projects: db.prepare('SELECT * FROM projects ORDER BY project_ref').all(), members: db.prepare('SELECT * FROM members ORDER BY project_ref, subject').all() }; }
    finally { db.close(); }
  };
  const before = inspect();
  for (const apply of [false, true]) {
    assert.throws(() => provisionMappedProject({ databaseFile, actor: reviewer, projectRef: 'project:uxqa', title: 'UXQA sandbox', apply }), /Existing subject grants/);
    assert.deepEqual(inspect(), before);
  }
});

test('HTTP and visible UI reject creation without losing mapped project access', async () => {
  const workspace = createWorkspaceServer({ mode: 'test', dataDir: ':memory:', listenHost: '127.0.0.1', listenPort: 0,
    defaultProvider: 'mock', providers: { mock: { kind: 'mock' } },
    identity: { kind: 'demo', demoHmacSecret: 'synthetic-only-test-signing-key', defaultSubject: reviewer.subject, memberships: [reviewer, ordinary] },
  });
  const { url } = await workspace.listen();
  try {
    workspace.store.createProject({ projectRef: 'project:uxqa', title: 'UXQA sandbox', projectKinds: ['integration'], actor: ordinary });
    workspace.store.createProject({ projectRef: 'project:other', title: 'Unrelated project', projectKinds: ['integration'], actor: ordinary });
    const signedIn = await fetch(`${url}/session/demo`, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subject: reviewer.subject }), redirect: 'manual' });
    const cookie = signedIn.headers.getSetCookie()[0].split(';')[0];
    const page = await (await fetch(url, { headers: { cookie } })).text();
    assert.match(page, /UXQA sandbox/);
    assert.doesNotMatch(page, /Create project|Unrelated project/);
    const attempt = await fetch(`${url}/projects`, { method: 'POST', headers: { cookie, origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title: 'Forged', project_kinds: 'integration', can_create_projects: 'true' }), redirect: 'manual' });
    assert.equal(attempt.status, 403);
    assert.equal((await fetch(`${url}/projects/project%3Auxqa`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${url}/projects/project%3Aother`, { headers: { cookie } })).status, 403);
    assert.equal(workspace.store.listProjects(ordinary).length, 2);
  } finally { await workspace.close(); }
});

test('provisioning CLI defaults read-only and emits no config values on success or failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aithema-provision-cli-'));
  t.after(() => execFileSync('trash', [dir]));
  const databaseFile = join(dir, 'aithema-workspace.sqlite');
  new SqliteProjectStore(databaseFile).close();
  const configFile = join(dir, 'config.json');
  const canary = 'SYNTHETIC_PRIVATE_CONFIG_CANARY';
  writeFileSync(configFile, JSON.stringify({ mode: 'production', dataDir: dir, identity: { memberships: [reviewer] }, providers: { synthetic: { apiKey: canary } } }));
  const args = ['bin/aithema-provision-project.js', '--config', configFile, '--subject', reviewer.subject, '--project-ref', 'project:uxqa', '--title', 'UXQA sandbox'];
  for (const [index, suffix] of [[], ['--apply'], ['--apply']].entries()) {
    const out = spawnSync(process.execPath, [...args, ...suffix], { encoding: 'utf8' });
    assert.equal(out.status, index < 2 ? 0 : 1);
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(canary));
    if (out.status === 0) assert.equal(JSON.parse(out.stdout).created, suffix.length > 0);
    else assert.match(out.stderr, /provisioning refused/);
  }
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0); }
  finally { db.close(); }
});
