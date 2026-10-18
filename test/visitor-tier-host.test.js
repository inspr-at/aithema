import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { ownerWalletConformance } from '@inspr/aithema-core';
import { createVisitorTierHost, ceilingMicro } from './host-fixtures/visitor-tier-host.js';

const origin = 'https://host.example.test';
const amounts = (anonymous, emailGiven = anonymous, emailConfirmed = emailGiven) => ({ anonymous, emailGiven, emailConfirmed });
function localProvider() {
  const allowed = new Set(['trusted-subject']); let state;
  return { label: 'Offline operator fixture', sessionNamespace: 'offline-host-v1', allowed,
    allows: subject => allowed.has(subject),
    begin() {
      state = randomBytes(32).toString('base64url');
      return { url: `https://identity.invalid/authorize?state=${state}`, pending: { state,
        nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url') } };
    },
    async complete(code, pending) {
      assert.equal(code, 'offline-code'); assert.equal(pending.state, state);
      return { subject: 'trusted-subject', name: 'Host administrator' };
    },
  };
}
function fixture(t, options = {}) {
  const provider = localProvider(), host = createVisitorTierHost({ operatorProvider: provider, ...options });
  t.after(() => host.close()); return { host, provider };
}
async function login(host) {
  const begin = await host.handle(new Request(origin + '/api/operator/login/'));
  assert.equal(begin.status, 303);
  const cookie = begin.headers.getSetCookie().find(c => c.startsWith('aithema-operator-state=')).split(';')[0];
  const state = new URL(begin.headers.get('location')).searchParams.get('state');
  const callback = await host.handle(new Request(origin + `/api/operator/callback/?state=${state}&code=offline-code`, { headers: { cookie } }));
  assert.equal(callback.status, 303);
  const grant = callback.headers.getSetCookie().find(c => c.startsWith('aithema-operator='));
  assert.ok(grant, 'real operator session issued by the public session helper');
  return grant.split(';')[0];
}
function admin(host, cookie, { path = '/host/admin/tiers', input, headers = {}, method = input ? 'POST' : 'GET' } = {}) {
  return host.handle(new Request(origin + path, { method,
    headers: { ...(cookie ? { cookie } : {}), ...(input ? { origin, 'content-type': 'application/json' } : {}), ...headers },
    ...(input ? { body: JSON.stringify(input) } : {}) }));
}
async function update(host, cookie, allowancesMicro, baseRevision = host.settings().revision) {
  const response = await admin(host, cookie, { input: { baseRevision, allowancesMicro } });
  assert.equal(response.status, 200); return response.json();
}
const request = (sessionId, attemptId, maxMicro, lane = 'reaction') => ({ sessionId, attemptId, lane, maxMicro,
  maxVisitorMicro: lane === 'voice' ? maxMicro : 0, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
const credits = (host, id, token) => host.handle(new Request(origin + `/api/sessions/${id}/credits`, { headers: { 'x-aithema-session-token': token } }));

test('AIT-320: external host imports only public exports and runs outside the workspace', async t => {
  const source = await readFile(new URL('./host-fixtures/visitor-tier-host.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('host.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) { assert.ok(ts.isStringLiteral(node.moduleSpecifier)); imports.push(node.moduleSpecifier.text); }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.text === 'require')) {
      assert.fail('fixture dependencies must use static public imports');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.deepEqual(imports, ['node:crypto', '@inspr/aithema-core', '@inspr/aithema-server']);
  const dir = await mkdtemp(join(tmpdir(), 'aithema-tier-consumer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'node_modules/@inspr'), { recursive: true });
  for (const name of ['core', 'server']) await symlink(fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)), join(dir, `node_modules/@inspr/aithema-${name}`), 'dir');
  await cp(new URL('./host-fixtures/visitor-tier-host.js', import.meta.url), join(dir, 'host.mjs'));
  await writeFile(join(dir, 'probe.mjs'), `import { createVisitorTierHost } from './host.mjs';
    const host = createVisitorTierHost(); console.log(host.settings().revision); await host.close();`);
  const result = await promisify(execFile)(process.execPath, [join(dir, 'probe.mjs')], { cwd: dir });
  assert.equal(result.stdout.trim(), '1');
});

test('AIT-320: authenticated settings/audit access, trusted attribution, validation and revision races', async t => {
  const { host, provider } = fixture(t), cookie = await login(host);
  for (const path of ['/host/admin/tiers', '/host/admin/tier-audit']) {
    for (const headers of [{}, { 'x-aithema-session-token': 'visitor', subject: 'trusted-subject' }, { cookie: 'aithema-operator=forged' }]) {
      assert.equal((await admin(host, null, { path, headers })).status, 401);
    }
  }
  const initialResponse = await admin(host, cookie);
  assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
  const initial = await initialResponse.json(); assert.equal(initial.revision, 1);
  const input = { baseRevision: 1, allowancesMicro: amounts(1_000_000, 2_000_000, 3_000_000) };
  assert.equal((await admin(host, null, { input })).status, 401);
  assert.equal((await admin(host, cookie, { input, headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await admin(host, cookie, { input, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await admin(host, cookie, { input, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await admin(host, cookie, { method: 'DELETE' })).status, 405);
  for (const invalid of [amounts(-1), amounts(1.5), amounts(Number.MAX_SAFE_INTEGER + 1), amounts(ceilingMicro + 1),
    amounts(2, 1, 3), amounts(1, 3, 2), amounts('1'), { anonymous: 1, emailGiven: 2 }, { ...amounts(1), other: 2 }]) {
    assert.equal((await admin(host, cookie, { input: { ...input, allowancesMicro: invalid } })).status, 400);
  }
  for (const extra of [{ actor: 'attacker' }, { subject: 'attacker' }, { source: 'system' }, { baseRevision: 0 }]) {
    assert.equal((await admin(host, cookie, { input: { ...input, ...extra } })).status, 400);
  }
  assert.deepEqual(await admin(host, cookie, { path: '/host/admin/tier-audit' }).then(r => r.json()), []);
  const saves = await Promise.all([admin(host, cookie, { input }), admin(host, cookie, { input })]);
  assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual((await saves.find(r => r.status === 409).json()).current, host.settings());
  const rows = await admin(host, cookie, { path: '/host/admin/tier-audit' }).then(r => r.json());
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].oldValues, initial); assert.deepEqual(rows[0].newValues, host.settings());
  assert.deepEqual(rows[0].actor, { namespace: provider.sessionNamespace, subject: 'trusted-subject', name: 'Host administrator' });
  assert.ok(Number.isFinite(Date.parse(rows[0].at)));
  assert.throws(() => host.storage.db.prepare('UPDATE host_tier_audit SET at=?').run('changed'), /append only/u);
  // Fault injection proves update and audit insert are one atomic host transaction.
  host.storage.db.exec("CREATE TRIGGER fail_tier_audit BEFORE INSERT ON host_tier_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.equal((await admin(host, cookie, { input: { ...input, baseRevision: 2 } })).status, 503);
  assert.equal(host.settings().revision, 2);
  assert.equal((await admin(host, cookie, { path: '/host/admin/tier-audit' }).then(r => r.json())).length, 1);
  provider.allowed.clear();
  assert.equal((await admin(host, cookie)).status, 401);
  assert.equal((await admin(host, cookie, { input })).status, 401);
});

test('AIT-320: runtime allowances feed cached wallets, concurrent conversations and creditTiers/nextTier', async t => {
  const { host } = fixture(t, { canConfirm: true, privacyDocumentConfigured: () => true }), cookie = await login(host);
  const owner = 'visitor-owner', other = 'other-owner';
  const a = host.storage.create({ ownerToken: owner }), b = host.storage.create({ ownerToken: owner });
  const cachedWallet = host.host.wallet(owner);
  await update(host, cookie, amounts(1_000_000, 2_000_000, 3_000_000));
  assert.equal(cachedWallet.balance().limitMicro, 1_000_000);
  const admissions = await Promise.all([host.admit(owner, request(a.id, 'race-a', 700_000)), host.admit(owner, request(b.id, 'race-b', 700_000))]);
  assert.equal(admissions.filter(r => r.ok).length, 1);
  assert.equal(admissions.find(r => !r.ok).reason, 'host-limit');
  assert.equal(cachedWallet.balance().committedMicro, 700_000);
  assert.equal(host.host.walletForSession(b).balance().committedMicro, 700_000);
  assert.equal(host.host.wallet(other).balance().committedMicro, 0);
  const creditResponse = await credits(host, b.id, owner); assert.equal(creditResponse.status, 200);
  const view = await creditResponse.json(); assert.equal(view.tiers.next, 'emailGiven'); assert.equal(view.tiers.delta, 1_000_000);
  assert.equal((await credits(host, b.id, other)).status, 404);
  await update(host, cookie, amounts(1_000_000));
  assert.equal((await credits(host, b.id, owner).then(r => r.json())).tiers.next, null, 'equal tiers offer no nextTier upgrade');
  await update(host, cookie, amounts(1_000_000, 2_000_000, 3_000_000));
  host.recordTrustedTier(owner, 'emailGiven');
  assert.equal(cachedWallet.balance().limitMicro, 2_000_000); assert.equal(host.host.creditTiers(owner).next, 'emailConfirmed');
  assert.equal((await host.admit(owner, request(b.id, 'after-upgrade', 700_000))).ok, true);
  host.recordTrustedTier(owner, 'emailConfirmed');
  assert.equal(cachedWallet.balance().limitMicro, 3_000_000); assert.equal(host.host.creditTiers(owner).next, null);
  assert.equal(cachedWallet.balance().committedMicro, 1_400_000, 'identity changes preserve reservations');
});

test('AIT-320: policy reductions preserve spend and holds across restart; voice extensions use current policy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-tier-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = localProvider(), options = { path: join(directory, 'host.sqlite'), operatorProvider: provider, canConfirm: true };
  let host = createVisitorTierHost(options); t.after(() => host?.close());
  const cookie = await login(host), owner = 'durable-owner';
  const a = host.storage.create({ ownerToken: owner }), b = host.storage.create({ ownerToken: owner });
  host.recordTrustedTier(owner, 'emailGiven');
  await update(host, cookie, amounts(1_000_000, 2_000_000, 3_000_000));
  assert.equal((await host.admit(owner, request(a.id, 'spent', 400_000))).ok, true);
  const claim = host.budget.claim('spent'); claim.consume();
  host.budget.settle(claim.claimId, { attemptId: 'spent', outcome: 'completed', chargedMicro: 250_000, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal((await host.admit(owner, request(b.id, 'voice', 500_000, 'voice'))).ok, true);
  const voiceClaim = host.budget.claim('voice'); voiceClaim.consume();
  // A hold not yet inserted into the module ledger also survives a crash.
  assert.equal(host.host.wallet(owner).admit(request(a.id, 'owner-only', 100_000)).ok, true);
  const before = host.host.wallet(owner).balance(); assert.equal(before.committedMicro, 850_000);
  await update(host, cookie, amounts(100_000, 200_000, 300_000));
  assert.equal(host.host.wallet(owner).balance().committedMicro, before.committedMicro);
  assert.equal((await host.admit(owner, request(a.id, 'refused', 1))).reason, 'host-limit');
  assert.throws(() => host.budget.extendVoice('voice', { maxMicro: 600_000, maxVisitorMicro: 600_000 }, extra => host.host.wallet(owner).canAdmit(extra)), { code: 'not-admitted' });
  const historical = host.budget.get('spent'), reserved = host.budget.get('voice');
  await host.close(); host = createVisitorTierHost(options);
  assert.deepEqual(host.budget.get('spent'), historical); assert.deepEqual(host.budget.get('voice'), reserved);
  assert.deepEqual(host.host.wallet(owner).balance(), { ...before, limitMicro: 200_000 });
  assert.equal((await admin(host, cookie)).status, 200, 'operator grant also survives restart');
  assert.equal((await admin(host, cookie, { path: '/host/admin/tier-audit' }).then(r => r.json())).length, 2);
  assert.equal(host.host.creditTiers(owner).current, 'emailGiven');
  await update(host, cookie, amounts(1_000_000, 2_000_000, 3_000_000));
  assert.deepEqual(host.budget.extendVoice('voice', { maxMicro: 600_000, maxVisitorMicro: 600_000 }, extra => host.host.wallet(owner).canAdmit(extra)), { maxMicro: 600_000, maxVisitorMicro: 600_000 });
  assert.equal(host.host.wallet(owner).balance().committedMicro, 950_000);
  host.budget.settleVoice(voiceClaim.claimId, { attemptId: 'voice', outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 300_000, visitorMicro: 300_000 } });
  assert.equal(host.host.wallet(owner).balance().committedMicro, 650_000);
  assert.deepEqual(host.budget.get('spent'), historical, 'policy changes never rewrite historical spend');
  const rows = await admin(host, cookie, { path: '/host/admin/tier-audit' }).then(r => r.json());
  assert.equal(rows.length, 3); assert.deepEqual(rows[0].oldValues, rows[1].newValues);
});

test('AIT-320: host wallet passes the public idempotency/conflict conformance kit; confirmation is opt-in', async t => {
  const { host } = fixture(t), owner = 'conformance-owner', session = host.storage.create({ ownerToken: owner });
  const result = await ownerWalletConformance(host.host.wallet(owner), request(session.id, 'kit', 1_000));
  assert.equal(result.ok, true, JSON.stringify(result));
  host.recordTrustedTier(owner, 'emailGiven');
  assert.equal(host.host.creditTiers(owner).next, null);
  assert.throws(() => host.recordTrustedTier(owner, 'emailConfirmed'), /Unqualified tier/u);
});
