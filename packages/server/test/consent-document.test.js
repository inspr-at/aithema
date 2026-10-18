import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../src/index.js';
import { ownedRequest, testToken } from '../../../test/helpers.js';

const document = () => ({ contract: 'host-v1', selected: [], items: [
  { id: 'mock-processing', version: 1, title: 'Host processing', recipients: 'Host processor', text: 'Host purpose' },
] });
async function fixture(t, describe, scopes) {
  const storage = new SQLiteStorage(), logs = [];
  const consent = { coverage: () => ({ covered: false }), describe };
  const pluginRuntime = createPluginRuntime({ storage, consent });
  if (scopes) pluginRuntime.scopes = () => scopes;
  const handlers = createHandlers({ storage, consent, pluginRuntime, log: entry => logs.push(entry) });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const read = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`));
  return { read, logs };
}

for (const mock of [undefined, false, true]) test(`AIT-231: describe maps local processing independently of mock=${mock}`, async t => {
  const doc = document(); if (mock !== undefined) doc.mock = mock;
  const h = await fixture(t, () => doc), response = await h.read();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.features.text, ['mock-processing']);
  assert.deepEqual(result.features.analysis, ['mock-processing']);
  assert.deepEqual(result.items, doc.items);
  assert.deepEqual(h.logs, []);
});

for (const mock of [false, true]) test(`AIT-231: binding purposes map every described item with mock=${mock}`, async t => {
  const doc = { ...document(), mock, items: [
    { id: 'host-speech', version: 'v2', title: 'Speech', recipients: 'Speech processor', text: 'Speech purpose' },
    { id: 'host-model', version: 1, title: 'Model', recipients: 'Model processor', text: 'Model purpose' },
  ] };
  const h = await fixture(t, () => doc, [{ purpose: 'host-speech' }, { purpose: 'host-model' }, { purpose: 'host-model' }]);
  const response = await h.read(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).features.voice, ['host-speech', 'host-model']);
});

test('AIT-231: the existing one-item mock shorthand still maps processing', async t => {
  const h = await fixture(t, () => ({ mock: true, selected: [] }));
  const response = await h.read(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).features.analysis, ['mock-processing']);
});

const invalid = [
  ['null', () => null, 'document'],
  ['missing contract', () => ({ ...document(), contract: undefined }), 'contract'],
  ['missing items', () => ({ contract: 'v1', selected: [] }), 'items'],
  ['invalid mock', () => ({ ...document(), mock: 'yes' }), 'mock'],
  ['missing selected', () => ({ ...document(), selected: undefined }), 'selected'],
  ['duplicate selection', () => ({ ...document(), selected: ['mock-processing', 'mock-processing'] }), 'selected'],
  ['unknown selection', () => ({ ...document(), selected: ['private-payload'] }), 'selected'],
  ['duplicate item', () => ({ ...document(), items: [...document().items, ...document().items] }), 'items'],
  ['invalid version', () => ({ ...document(), items: [{ ...document().items[0], version: 0 }] }), 'items'],
  ['missing purpose', () => ({ ...document(), items: [{ ...document().items[0], text: '' }] }), 'items'],
  ['invalid optional', () => ({ ...document(), optional: ['private-payload'] }), 'optional'],
  ['invalid intro', () => ({ ...document(), intro: 123 }), 'intro'],
  ['invalid feature map', () => ({ ...document(), features: { 'private-payload': ['unknown'] } }), 'features'],
];
for (const [name, describe, field] of invalid) test(`AIT-231: ${name} fails closed with a value-free host diagnostic`, async t => {
  const h = await fixture(t, describe), response = await h.read();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'consent-document-unavailable' });
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].event, 'consent.document.invalid');
  assert.match(h.logs[0].reason, /Invalid consent\.describe\(\)/u);
  assert.ok(h.logs[0].reason.includes(field));
  assert.doesNotMatch(JSON.stringify(h.logs), /private-payload/u);
});

test('AIT-321: a stale tab cannot restore images withdrawn in another tab, with no refusal side effects', async t => {
  const storage = new SQLiteStorage(), calls = [], selected = new Set();
  const consent = {
    coverage: () => ({ covered: false }),
    describe: () => ({ contract: `host-v${storage.get(session.id).consentRevision}`, selected: [...selected],
      items: [{ id: 'images', version: 1, title: 'Images', recipients: 'Image processor', text: 'Generate images' }] }),
    grant: args => { calls.push(['grant', args]); selected.clear(); for (const item of args.decision.items) selected.add(item); return true; },
    withdraw: () => { calls.push(['withdraw']); selected.clear(); },
    conversationUnchanged: () => { calls.push(['conversationUnchanged']); return true; },
  };
  const handlers = createHandlers({ storage, consent });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const read = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`)).then(r => r.json());
  const save = body => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal((await save({ granted: true, processing: { contract: 'host-v0', revision: 0, items: ['images'] } })).status, 200);
  const tabA = await read();
  assert.deepEqual(tabA.selected, ['images']);
  // Both tabs saw revision 1. Tab B withdraws before tab A saves its unchanged selection.
  assert.equal((await save({ granted: false, processing: { contract: tabA.contract, revision: 1, items: [] } })).status, 200);
  await handlers.idle();
  const before = storage.get(session.id), invalidations = [];
  const revise = storage.reviseConsent.bind(storage);
  storage.reviseConsent = (...args) => { invalidations.push('reviseConsent'); return revise(...args); };
  for (const [lane, method] of [[handlers.lanes, 'cancel'], [handlers.conceptLane, 'invalidate']]) {
    const original = lane[method].bind(lane);
    lane[method] = (...args) => { invalidations.push(method); return original(...args); };
  }
  const stream = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/events?after=${before.seq}`));
  const broadcasts = [], reader = stream.body.getReader();
  const reading = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; broadcasts.push(new TextDecoder().decode(value)); } })();
  await new Promise(resolve => setImmediate(resolve));
  const initialBroadcasts = [...broadcasts], initialCalls = [...calls];
  const stale = await save({ granted: true, processing: { contract: tabA.contract, revision: 1, items: tabA.selected } });
  await new Promise(resolve => setImmediate(resolve));
  const after = storage.get(session.id);
  await reader.cancel(); await reading;
  assert.equal(stale.status, 409, 'stale tab must be refused before its withdrawn image grant reaches the host');
  assert.deepEqual(await stale.json(), { error: 'consent-stale', consentRevision: 2 });
  assert.deepEqual([...selected], [], 'images remain withdrawn');
  assert.deepEqual(calls, initialCalls, 'no host grant, withdrawal or conversation check');
  assert.deepEqual(invalidations, [], 'no revision or invalidation');
  assert.deepEqual(broadcasts, initialBroadcasts, 'no broadcast');
  assert.equal(after.consentRevision, before.consentRevision);
  assert.equal(after.seq, before.seq);
  assert.equal(tabA.consentRevision, 1, 'the server document carries the revision seen by this tab');
  assert.equal(initialCalls.find(([kind]) => kind === 'grant')[1].decision.revision, 0, 'host receives the expected revision');
});
