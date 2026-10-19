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

for (const revision of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) test(`AIT-321: invalid expected revision ${JSON.stringify(revision)} has no host effects`, async t => {
  const storage = new SQLiteStorage(), calls = [];
  const handlers = createHandlers({ storage, consent: { coverage: () => ({ covered: false }),
    grant: () => calls.push('grant'), withdraw: () => calls.push('withdraw') } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken });
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true, processing: { revision } }),
  }));
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid-consent-revision' });
  assert.deepEqual(calls, []); assert.equal(storage.get(session.id).consentRevision, 0);
});

test('AIT-321: simultaneous decisions serialize around an async host grant', async t => {
  const storage = new SQLiteStorage(), entered = Promise.withResolvers(), release = Promise.withResolvers(), grants = [];
  const handlers = createHandlers({ storage, consent: { coverage: () => ({ covered: false }),
    grant: async args => { grants.push(args); entered.resolve(); await release.promise; return true; } } });
  t.after(async () => { release.resolve(); await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken });
  const save = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true, processing: { revision: 0, items: ['images'] } }),
  }));
  const first = save(); await entered.promise;
  const second = save(); release.resolve();
  assert.equal((await first).status, 200);
  const stale = await second;
  assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: 'consent-stale', consentRevision: 1 });
  assert.equal(grants.length, 1); assert.equal(storage.get(session.id).consentRevision, 1);
});

test('AIT-321: omitting the revision retains deprecated host compatibility', async t => {
  const storage = new SQLiteStorage(), grants = [];
  const handlers = createHandlers({ storage, consent: { coverage: () => ({ covered: false }), grant: args => grants.push(args) } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken });
  for (let i = 0; i < 2; i++) {
    const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }),
    }));
    assert.equal(response.status, 200);
  }
  assert.equal(grants.length, 2); assert.equal(grants[1].consentRevision, 2);
});

// Withdrawal is a revocation path: host latency must never hold it up.
for (const transport of ['external', 'http']) test(`AIT-321 R2: ${transport} withdrawal bypasses a hanging grant and its late completion fails closed`, async t => {
  const storage = new SQLiteStorage(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const handlers = createHandlers({ storage, consent: { coverage: () => ({ covered: false }),
    grant: async () => { entered.resolve(); await release.promise; return true; } } });
  t.after(async () => { release.resolve(); await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken });
  const save = granted => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted, processing: { revision: 0, items: granted ? ['images'] : [] } }),
  }));
  const pending = save(true); await entered.promise;
  let timer;
  try {
    const withdrawal = transport === 'external' ? handlers.withdrawConsent(session.id) : save(false);
    const result = await Promise.race([withdrawal, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    assert.ok(result, 'withdrawal completes while the host grant is still hanging');
    if (transport === 'http') assert.equal(result.status, 200);
    assert.equal(storage.get(session.id).consentWithdrawn, true);
    assert.equal(storage.get(session.id).consentRevision, 1);
  } finally { clearTimeout(timer); release.resolve(); await pending; }
  const response = await pending;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'consent-stale', consentRevision: 1 });
  assert.equal(storage.get(session.id).consentWithdrawn, true, 'a late grant cannot undo withdrawal');
  assert.equal(storage.get(session.id).consentRevision, 1);
});

for (const port of ['describe', 'conversationUnchanged', 'grant']) test(`AIT-321 R2: a host can withdraw inside its own ${port} port without deadlock`, async t => {
  const storage = new SQLiteStorage(), calls = [];
  let handlers, session, timer;
  const consent = { coverage: () => ({ covered: false }), describe: () => document(), grant: () => { calls.push('grant'); return true; } };
  consent[port] = async () => {
    const event = await Promise.race([handlers.withdrawConsent(session.id), new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    clearTimeout(timer);
    assert.ok(event, 'reentrant withdrawal completes before the host port returns');
    calls.push('withdrawn');
    return port === 'describe' ? document() : true;
  };
  handlers = createHandlers({ storage, consent });
  t.after(async () => { clearTimeout(timer); await handlers.close(); storage.close(); });
  session = storage.create({ ownerToken: testToken });
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: true, intent: 'settings-save', processing: { contract: 'host-v1', revision: 0, items: ['mock-processing'] } }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'consent-stale', consentRevision: 1 });
  assert.deepEqual(calls, ['withdrawn'], 'no later host grant after withdrawal inside an earlier port');
  assert.equal(storage.get(session.id).consentWithdrawn, true);
});

for (const initial of [[], ['models', 'drafts', 'images']]) test(`AIT-365: changed scopes come from authoritative documents (${initial.length ? 'withdraw' : 'grant'})`, async t => {
  const storage = new SQLiteStorage(); let selected = [...initial];
  const consent = { coverage: () => ({ covered: false }),
    describe: () => ({ contract: 'private-contract', selected: [...selected], items: ['models', 'drafts', 'images'].map(id =>
      ({ id, version: 1, title: 'Private title', recipients: 'Private recipient', text: 'Private terms' })) }),
    conversationUnchanged: () => true,
    // Deliberately differs from the submitted decision: never echo browser items.
    grant: () => { selected = initial.length ? ['models', 'images'] : ['drafts']; return true; },
  };
  const pluginRuntime = createPluginRuntime({ storage, consent });
  pluginRuntime.scopes = (session, { feature } = {}) => [{ purpose: feature === 'html' ? 'drafts' : feature === 'images' ? 'images' : 'models' }];
  const handlers = createHandlers({ storage, consent, pluginRuntime });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: true, processing: { revision: 0, contract: 'private-contract', items: ['images'], changed: ['images'] }, changed: ['images'], removed: ['images'] }),
  }));
  assert.equal(response.status, 200);
  const { event } = await response.json();
  assert.deepEqual(event.data.changed, ['html-drafts']);
  assert.deepEqual(event.data.removed, initial.length ? ['html-drafts'] : [], 'direction comes from the authoritative coverage delta');
  assert.deepEqual(storage.read(session.id).find(e => e.seq === event.seq).data, event.data, 'durable replay carries exactly the same scopes');
  assert.deepEqual(Object.keys(event.data).sort(), ['at', 'changed', 'conversationUnchanged', 'granted', 'removed']);
  assert.doesNotMatch(JSON.stringify(event), /private-|Private|"drafts"/u, 'scope names only; no document data');
});

for (const describe of [() => ({ selected: [] }), () => { throw new Error('Legacy read unavailable'); }]) test('AIT-365: optional scope enrichment preserves legacy grant POSTs', async t => {
  const storage = new SQLiteStorage(); let grants = 0;
  const handlers = createHandlers({ storage, consent: { coverage: () => ({ covered: false }), describe, grant: () => { grants++; return true; } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }),
  }));
  assert.equal(response.status, 200); assert.equal(grants, 1);
  assert.equal(Object.hasOwn((await response.json()).event.data, 'changed'), false);
  assert.equal(storage.get(session.id).consentRevision, 1);
});

for (const phase of ['previous', 'accepted']) test(`AIT-365 R2: legacy grant survives a hanging ${phase} enrichment read`, async t => {
  const storage = new SQLiteStorage(); let reads = 0, grants = 0;
  const consent = { coverage: () => ({ covered: false }),
    describe: () => { reads++; return reads === (phase === 'previous' ? 1 : 2) ? new Promise(() => {}) : document(); },
    grant: () => { grants++; return true; } };
  const handlers = createHandlers({ storage, consent });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let response;
  const saving = handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }),
  })).then(result => { response = result; });
  await new Promise(setImmediate);
  t.mock.timers.tick(250); await new Promise(setImmediate);
  assert.ok(response, 'optional describe enrichment cannot block a legacy grant beyond 250 ms');
  await saving;
  assert.equal(response.status, 200); assert.equal(grants, 1);
  assert.equal(Object.hasOwn((await response.json()).event.data, 'changed'), false);
  assert.equal(storage.get(session.id).consentRevision, 1);
});

test('AIT-365 R2: granted:false publishes every revoked scope without waiting for describe', async t => {
  const storage = new SQLiteStorage(); let selected = ['models', 'drafts', 'images'], reads = 0, hanging = false;
  const consent = { coverage: () => ({ covered: true }),
    describe: () => { reads++; return hanging ? new Promise(() => {}) : { contract: 'host-v1', selected: [...selected],
      items: ['models', 'drafts', 'images'].map(id => ({ id, version: 1, title: id, recipients: 'Local', text: 'Local terms' })) }; },
    grant: () => true, withdraw: () => { selected = []; } };
  const pluginRuntime = createPluginRuntime({ storage, consent });
  pluginRuntime.scopes = (session, { feature } = {}) => [{ purpose: feature === 'html' ? 'drafts' : feature === 'images' ? 'images' : 'models' }];
  const handlers = createHandlers({ storage, consent, pluginRuntime });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const save = granted => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted, changed: [] }),
  }));
  assert.equal((await save(true)).status, 200);
  hanging = true; const before = reads;
  const response = await save(false);
  assert.equal(response.status, 200); assert.equal(reads, before, 'withdrawal never waits for a host document');
  const { event } = await response.json();
  assert.ok(Array.isArray(event.data.changed), 'withdrawal must never omit changed when coverage is revoked');
  assert.deepEqual(event.data.removed, event.data.changed, 'every full-withdrawal scope is a removal');
  for (const scope of ['text', 'analysis', 'voice', 'transcription', 'images', 'html-drafts', 'uploads'])
    assert.ok(event.data.changed.includes(scope), `revoked ${scope} is in the event`);
  assert.deepEqual(storage.read(session.id).find(e => e.seq === event.seq).data, event.data);
  assert.equal(storage.get(session.id).consentWithdrawn, true);
  assert.deepEqual(selected, []);
});

test('AIT-365 R2: a grant changed hint cannot grant coverage or suppress authoritative removals', async t => {
  const storage = new SQLiteStorage(); let selected = ['models', 'drafts'];
  const consent = { coverage: () => ({ covered: false }),
    describe: () => ({ contract: 'host-v1', selected: [...selected], items: ['models', 'drafts', 'images'].map(id =>
      ({ id, version: 1, title: id, recipients: 'Local', text: 'Local terms' })) }),
    conversationUnchanged: () => true,
    grant: () => { selected = ['models']; return true; } };
  const pluginRuntime = createPluginRuntime({ storage, consent });
  pluginRuntime.scopes = (session, { feature } = {}) => [{ purpose: feature === 'html' ? 'drafts' : feature === 'images' ? 'images' : 'models' }];
  const handlers = createHandlers({ storage, consent, pluginRuntime });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const path = `http://localhost/api/sessions/${session.id}/consent`;
  const response = await handlers.handle(ownedRequest(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: true, changed: ['images'], processing: { revision: 0, items: ['images'] } }),
  }));
  assert.equal(response.status, 200);
  const { event } = await response.json();
  assert.deepEqual(event.data.changed, ['html-drafts'], 'the hint adds the actual removal and cannot claim an image grant');
  assert.deepEqual(event.data.removed, ['html-drafts']);
  const current = await (await handlers.handle(ownedRequest(path))).json();
  assert.equal(current.features.images.every(id => current.selected.includes(id)), false, 'changed never overrides missing authoritative image coverage');
  assert.equal(current.features.html.every(id => current.selected.includes(id)), false, 'the draft withdrawal remains authoritative');
  assert.deepEqual(current.selected, ['models']);
  assert.deepEqual(storage.read(session.id).find(e => e.seq === event.seq).data, event.data);
});
