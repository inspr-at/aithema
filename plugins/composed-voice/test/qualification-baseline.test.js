import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaselineAuth, installBaselineAuth } from '../ops/qualification-production-baseline.mjs';

const secret = 'FAKE_BASIC_AUTH_VALUE_NEVER_IN_EVIDENCE';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baseline-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ username: 'fake-operator', password: secret }), { mode: 0o600 });
  return { path, dir };
}

test('baseline auth refuses missing, relative, wrong mode, wrong owner and symlink without disclosing input', async t => {
  const { path, dir } = await fixture(t);
  const refuses = async (input, options) => assert.rejects(loadBaselineAuth(input, options), error => {
    assert.doesNotMatch(String(error), new RegExp(`${secret}|${dir}|fake-operator`));
    return /baseline.*auth/i.test(error.message);
  });
  await refuses(undefined); await refuses('relative.json');
  await refuses(path, { uid: process.getuid() + 1 });
  await chmod(path, 0o640); await refuses(path); await chmod(path, 0o600);
  const link = join(dir, 'link'); await symlink(path, link); await refuses(link);
  assert.deepEqual(await loadBaselineAuth(path), { username: 'fake-operator', password: secret });
});

test('CDP sends basic auth only for a server challenge from baselineOrigin; other origins get no credential', async () => {
  const handlers = {}, sent = [];
  const cdp = { on(event, handler) { handlers[event] = handler; }, async send(method, params) { sent.push({ method, params }); } };
  await installBaselineAuth(cdp, 'https://start2.example', { username: 'fake-operator', password: secret });
  for (const [origin, source, scheme] of [['https://other.example', 'Server', 'basic'], ['https://start2.example', 'Proxy', 'basic'],
    ['https://start2.example', 'Server', 'digest'], ['https://start2.example', 'Server', 'basic']]) {
    await handlers['Fetch.authRequired']({ requestId: origin + source + scheme, authChallenge: { origin, source, scheme } });
  }
  const replies = sent.filter(row => row.method === 'Fetch.continueWithAuth');
  assert.equal(replies.length, 4);
  for (const reply of replies.slice(0, 3)) {
    assert.equal(reply.params.authChallengeResponse.response, 'CancelAuth');
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(secret));
  }
  assert.equal(replies[3].params.authChallengeResponse.password, secret);
  assert.equal(sent.some(row => row.method === 'Network.setExtraHTTPHeaders'), false);
});
