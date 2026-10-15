import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processingScope, reasoningRequest, createSession, understandingSchema, validateManifest, PluginError } from '@inspr/aithema-core';
import { chargedMicro, consentItem, createExternalReasoning, manifest, reply, summary, usage } from './fixtures/external-plugin/index.js';
import { createExternalHost, externalBinding } from './fixtures/external-plugin-host.js';
import { ownedRequest, testToken } from './helpers.js';

test('external package resolves outside the workspace and imports only public core exports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-external-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = join(directory, 'node_modules');
  await mkdir(join(modules, '@aithema-test'), { recursive: true }); await mkdir(join(modules, '@inspr'), { recursive: true });
  await cp(new URL('./fixtures/external-plugin/', import.meta.url), join(modules, '@aithema-test/external-plugin'), { recursive: true });
  await symlink(fileURLToPath(new URL('../packages/core/', import.meta.url)), join(modules, '@inspr/aithema-core'), 'dir');
  await writeFile(join(directory, 'probe.mjs'), `import { manifest } from '@aithema-test/external-plugin'; console.log(manifest.models[0].id);`);
  const result = await promisify(execFile)(process.execPath, [join(directory, 'probe.mjs')], { cwd: directory });
  assert.equal(result.stdout.trim(), 'external/proof-v1');
  const source = await readFile(new URL('./fixtures/external-plugin/index.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(m => m[1]), ['@inspr/aithema-core']);
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
});

function options(extra = {}) {
  const reports = []; let consumed = 0;
  return { reports, signal: new AbortController().signal, deadlineAt: Date.now() + 10_000,
    attempt: { attemptId: 'external-attempt', claimId: 'external-claim', consume() { consumed++; assert.equal(consumed, 1); } },
    report: terminal => reports.push(terminal), ...extra };
}
test('external model reports actual cost and usage for replies and analysis; missing cost is uncertain', async () => {
  for (const reportCost of [true, false]) {
    const plugin = createExternalReasoning({ binding: externalBinding(), reportCost });
    assert.deepEqual(await plugin.health(options()), { available: true });
    for (const operation of ['stream', 'structured']) {
      const opt = options(), request = reasoningRequest(createSession(), operation === 'stream' ? 'reaction' : 'understanding');
      if (operation === 'structured') request.schema = understandingSchema();
      if (operation === 'stream') {
        const chunks = []; for await (const chunk of plugin.stream(request, opt)) chunks.push(chunk);
        assert.equal(JSON.parse(chunks.join('')).content, reply);
      } else assert.equal((await plugin.structured(request, opt)).summary, summary);
      assert.deepEqual(opt.reports, [{ attemptId: opt.attempt.attemptId, servedModel: 'external/proof-v1',
        ...(reportCost ? { outcome: 'completed', usage, chargedMicro } : { outcome: 'uncertain' }) }]);
    }
  }
});

test('external model respects cancellation, deadlines and refused authority before producing a reply', async () => {
  const plugin = createExternalReasoning({ binding: externalBinding() });
  const controller = new AbortController(); controller.abort();
  for (const [extra, code] of [[{ signal: controller.signal }, 'cancelled'], [{ deadlineAt: 0 }, 'deadline'],
    [{ attempt: { attemptId: 'refused', claimId: 'refused', consume() { throw new PluginError('not-admitted'); } } }, 'not-admitted']]) {
    const opt = options(extra), chunks = [];
    await assert.rejects(async () => { for await (const chunk of plugin.stream({}, opt)) chunks.push(chunk); }, { code });
    assert.deepEqual(chunks, []);
    assert.deepEqual(opt.reports, code === 'not-admitted' ? [] : [{ attemptId: opt.attempt.attemptId,
      outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
});

test('returning a reply stream early reports cancelled billable usage, not a false completion', async () => {
  const plugin = createExternalReasoning({ binding: externalBinding() }), opt = options();
  for await (const chunk of plugin.stream({}, opt)) { assert.equal(chunk, reply); break; }
  assert.deepEqual(opt.reports, [{ attemptId: opt.attempt.attemptId, servedModel: 'external/proof-v1', outcome: 'cancelled', usage, chargedMicro }]);
});

for (const reportCost of [true, false]) test(`host configuration uses external reasoning in both lanes and settles ${reportCost ? 'actual' : 'uncertain'} costs`, async t => {
  const host = createExternalHost({ reportCost }); t.after(() => host.close());
  const created = await host.handlers.handle(ownedRequest('http://localhost/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) }));
  assert.equal(created.status, 201);
  const session = await created.json();
  const request = (action = '', body) => host.handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}${action ? '/' + action : ''}`,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}));
  const initial = await request().then(r => r.json());
  assert.equal(initial.featureMatrix.best.text.available, false); assert.equal(initial.featureMatrix.best.analysis.available, false);
  assert.deepEqual((await request('consent').then(r => r.json())).items, [consentItem]);
  assert.equal((await request('consent', { granted: true, processing: { contract: host.consent.describe().contract, items: ['models-international'] } })).status, 409);
  assert.equal((await request('consent', { granted: true, processing: { contract: host.consent.describe().contract, items: [consentItem.id] } })).status, 200);
  const granted = await request().then(r => r.json());
  assert.equal(granted.featureMatrix.best.text.available, true); assert.equal(granted.featureMatrix.best.analysis.available, true);
  for (const operation of ['stream', 'structured']) {
    const scope = processingScope(host.binding, operation), query = { sessionId: session.id, consentRevision: granted.consentRevision, scope };
    assert.equal(host.consent.coverage(query).covered, true);
    for (const change of [{ model: 'another-model' }, { endpoint: 'https://another.invalid' }, { operation: 'start' },
      { accountRef: 'another-account' }, { routing: { provider: 'another' } }, { recipients: ['another-recipient'] }]) {
      assert.equal(host.consent.coverage({ ...query, scope: { ...scope, ...change } }).covered, false);
    }
  }
  assert.equal((await request('turns', { content: 'We need a project planning application.', clientEventId: 'external-turn' })).status, 200);
  await host.handlers.idle();
  const current = await request().then(r => r.json());
  assert.equal(current.transcript.filter(t => t.role === 'assistant').length, 1);
  assert.equal(current.transcript.at(-1).content, reply);
  assert.equal(current.transcript.at(-1).model, 'external/proof-v1');
  assert.equal(current.understanding.summary, summary); assert.equal(current.understanding.readinessAssessed, true);
  const rows = host.storage.db.prepare('SELECT * FROM budget_attempts WHERE session_id=?').all(session.id);
  assert.deepEqual(new Set(rows.map(r => r.lane)), new Set(['reaction', 'understanding']));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.state, 'settled'); assert.equal(row.outcome, reportCost ? 'completed' : 'uncertain');
    assert.equal(row.settled_micro, reportCost ? chargedMicro : host.binding.maxMicro);
    assert.deepEqual(JSON.parse(row.usage), reportCost ? usage : null);
  }
  const amounts = host.pluginRuntime.budget.breakdown(session.id);
  assert.equal(amounts.reservedMicro, 0); assert.equal(amounts.confirmedSpendMicro, reportCost ? 2 * chargedMicro : 0);
  assert.equal(amounts.uncertainSpendMicro, reportCost ? 0 : 2 * host.binding.maxMicro);
  await request('consent', { granted: false });
  assert.equal(host.consent.coverage({ sessionId: session.id, consentRevision: granted.consentRevision, scope: processingScope(host.binding, 'stream') }).covered, false);
  assert.equal((await request().then(r => r.json())).featureMatrix.best.text.available, false);
});

test('external model health disables both configured lanes', async t => {
  const host = createExternalHost({ available: false }); t.after(() => host.close());
  const session = host.storage.create({ ownerToken: testToken });
  host.consent.grant({ sessionId: session.id, consentRevision: 1, decision: { contract: host.consent.describe().contract, items: [consentItem.id] } });
  host.storage.reviseConsent(session.id, true);
  const matrix = await host.pluginRuntime.matrix(host.storage.get(session.id));
  for (const feature of ['text', 'analysis']) assert.deepEqual(matrix.best[feature], { available: false, reason: 'plugin unhealthy' });
});

test('external consent expires and stale revisions never cover a configured model', async t => {
  let at = Date.now(); const host = createExternalHost({ now: () => at }); t.after(() => host.close());
  const session = host.storage.create({ ownerToken: testToken });
  host.consent.grant({ sessionId: session.id, consentRevision: 1, decision: { contract: host.consent.describe().contract, items: [consentItem.id] } });
  host.storage.reviseConsent(session.id, true);
  const query = { sessionId: session.id, consentRevision: 1, scope: processingScope(host.binding, 'stream') };
  assert.equal(host.consent.coverage(query).covered, true);
  assert.equal(host.consent.coverage({ ...query, consentRevision: 0 }).covered, false);
  at += 60_001;
  assert.equal(host.consent.coverage(query).covered, false); assert.deepEqual(host.consent.describe(session.id).selected, []);
});
