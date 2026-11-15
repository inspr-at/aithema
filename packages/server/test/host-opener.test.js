import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockReasoning, PluginRegistry } from '@inspr/aithema-core';
import { registerDemoExtractors } from '../../../demo/uploads.js';
import { createPluginRuntime, mockPresets, SQLiteStorage, createHandlers } from '../src/index.js';
import { exportSession } from '../src/export.js';
import { mockConsent, testToken, ownedRequest } from '../../../test/helpers.js';
const now = () => 1_800_000_000_000;
const pinned = new WeakSet();
const opener = { en: 'Welcome. Your AI assistant is ready.', de: 'Willkommen. Ihre KI-Assistenz ist bereit.' };
async function fixture(t, options = {}) {
  if (!pinned.has(t)) { t.mock.timers.enable({ apis: ['Date'], now: now() }); pinned.add(t); }
  const storage = options.storage ?? new SQLiteStorage(':memory:', { now });
  const handlers = createHandlers({ storage, consent: mockConsent, host: { now }, opener, ...options });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken, locale: options.locale ?? 'en' });
  const get = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}`));
  const send = (clientEventId = 'first', content = 'We need an invoice system.') => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientEventId, content }),
  }));
  return { storage, handlers, session, get, send };
}
test('AIT-505: snapshot resolves locale but Start does not persist the opener', async t => {
  const f = await fixture(t);
  assert.deepEqual((await (await f.get()).json()).opener, { text: opener.en, locale: 'en' });
  assert.deepEqual(f.storage.get(f.session.id).transcript, []);
});
test('AIT-505: first send atomically returns opener then user; replay has no gap or duplicates', async t => {
  const f = await fixture(t), response = await f.send();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events.map(e => e.data.id), ['host:opener', 'first']);
  assert.equal(body.event.data.id, 'first');
  assert.equal(body.data.id, 'first', 'legacy event-shaped response stays available');
  assert.equal(body.events[1].seq, body.events[0].seq + 1);
  assert.equal(body.events[0].data.origin, 'host');
  await f.handlers.idle();
  const replay = await (await f.send()).json();
  assert.deepEqual(replay.events, body.events);
  assert.equal(f.storage.get(f.session.id).transcript.filter(t => t.id === 'host:opener').length, 1);
  assert.ok(f.storage.get(f.session.id).transcript.some(t => t.role === 'assistant' && t.id !== 'host:opener'));
});
test('AIT-505: missing locale and existing histories never get an opener inserted', async t => {
  for (const options of [{ opener: { de: opener.de } }, { opener: { en: '   ' } }, {}]) {
    const f = await fixture(t, options);
    if (!Object.keys(options).length) f.storage.append(f.session.id, 'turn.final', { id: 'old', role: 'user', content: 'Existing history' });
    await f.send(); await f.handlers.idle();
    assert.equal(f.storage.get(f.session.id).transcript.some(t => t.id === 'host:opener'), false);
  }
});
test('AIT-505: host namespace cannot be supplied by a visitor', async t => {
  const f = await fixture(t);
  for (const id of ['host:opener', 'host:anything']) assert.equal((await f.send(id)).status, 400);
  assert.equal(f.storage.get(f.session.id).transcript.length, 0);
});
test('AIT-505: invalid host opener configuration fails at startup', () => {
  const storage = new SQLiteStorage(':memory:', { now });
  try {
    for (const value of [{ en: 42 }, { en: 'x'.repeat(1001) }, { fr: 'Welcome' }, 'Welcome']) {
      assert.throws(() => createHandlers({ storage, consent: mockConsent, opener: value }), TypeError);
    }
  } finally { storage.close(); }
});
test('AIT-505: server export identifies host-authored opener', async t => {
  const f = await fixture(t); await f.send(); await f.handlers.idle();
  const zip = exportSession(f.storage.get(f.session.id), [], [], { exportedAt: new Date(now()).toISOString() }).toString();
  assert.match(zip, /## assistant \(host\)/u);
  assert.match(zip, /"origin": "host"/u);
});

test('AIT-505: peer SSE receives the opener before the first visitor turn', async t => {
  const f = await fixture(t);
  const stream = await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/events`));
  const received = (async () => {
    const reader = stream.body.getReader(), decoder = new TextDecoder(), events = []; let buffer = '';
    try {
      for (;;) {
        const {done,value} = await reader.read(); assert.equal(done,false);
        buffer += decoder.decode(value,{stream:true}); let end;
        while ((end=buffer.indexOf('\n\n'))>=0) {
          const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
          const data=block.split('\n').find(line=>line.startsWith('data:'));
          if (data) { const event=JSON.parse(data.slice(5));events.push(event);if(event.data?.id==='first')return events; }
        }
      }
    } finally { await reader.cancel(); }
  })();
  const body = await (await f.send()).json();
  const events = (await received).filter(event=>event.type==='turn.final');
  assert.deepEqual(events.slice(0,2).map(event=>event.data.id),['host:opener','first']);
  assert.deepEqual(events.slice(0,2).map(event=>event.seq),body.events.map(event=>event.seq));
});

for (const locale of ['en','de']) test(`AIT-505: ${locale} persistence pins its exact host text and locale`, async t => {
  const f=await fixture(t,{locale});
  assert.deepEqual((await(await f.get()).json()).opener,{text:opener[locale],locale});
  await f.send();await f.handlers.idle();
  const first=f.storage.get(f.session.id).transcript[0];
  assert.equal(first.id,'host:opener');assert.equal(first.content,opener[locale]);
  assert.throws(()=>f.storage.changeLocale(f.session.id,locale==='en'?'de':'en',{ownerToken:testToken}));
});

test('AIT-505: locale events publish resolved opener copy or explicit absence', async t => {
  for(const configured of [opener,{en:opener.en}]) {
    const f=await fixture(t,{opener:configured});
    const response=await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/locale`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({locale:'de'})}));
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body.event.data.opener,configured.de?{text:configured.de,locale:'de'}:null);
    assert.equal(f.storage.get(f.session.id).transcript.length,0);
    assert.equal('opener' in f.storage.read(f.session.id).findLast(e=>e.type==='session.locale-changed').data,false,'public copy is not journal content before input');
  }
});

for (const configured of [undefined, {}]) test(`AIT-505 M2: no opener retains the exact legacy turns response (${JSON.stringify(configured)})`, async t => {
  const f = await fixture(t, { opener: configured });
  const response = await f.send(); assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, f.storage.read(f.session.id).find(e => e.type === 'turn.final' && e.data.id === 'first'));
  assert.equal(Object.hasOwn(body, 'event'), false);
  assert.equal(Object.hasOwn(body, 'events'), false);
});

for (const state of ['accepted', 'unreadable']) test(`AIT-505 M3: document-first ${state} stores the opener before reply dispatch, export and replay`, async t => {
  const requests = [], base = createMockReasoning();
  const reasoning = { ...base, bind() { return reasoning; }, async *stream(request, options) {
    requests.push(request); yield* base.stream(request, options);
  } };
  const storage = new SQLiteStorage(':memory:', { now });
  const registry = new PluginRegistry().register(reasoning), presets = mockPresets();
  registerDemoExtractors(registry, presets);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent: mockConsent });
  const f = await fixture(t, { storage, reasoning, pluginRuntime: runtime });
  const form = new FormData(); form.append('clientEventId', 'document');
  form.append('files', new File([state === 'accepted' ? 'Invoice system requirements.' : ''], 'requirements.txt', { type: 'text/plain' }));
  const post = () => f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST', body: form }));
  assert.equal((await post()).status, 202); await f.handlers.idle();
  const current = f.storage.get(f.session.id);
  assert.equal(current.uploads[0].state, state);
  assert.equal(current.transcript[0].id, 'host:opener');
  assert.equal(current.transcript.filter(turn => turn.id === 'host:opener').length, 1);
  assert.ok(current.transcript.some(turn => turn.role === 'assistant' && turn.id !== 'host:opener'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].role, 'assistant');
  assert.equal(requests[0].messages[0].content, opener.en);
  assert.equal(requests[0].messages.filter(message => message.content === opener.en).length, 1);
  const terminal = f.storage.read(f.session.id).find(e => e.type === 'upload.state' && e.data.state === state);
  const host = f.storage.read(f.session.id).find(e => e.data.id === 'host:opener');
  assert.equal(host.seq + 1, terminal.seq, 'same completion transaction publishes opener before terminal document');
  const zip = exportSession(current, [], [], { exportedAt: new Date(now()).toISOString() }).toString();
  assert.match(zip, /## assistant \(host\)/u); assert.ok(zip.includes(opener.en));
  assert.equal((await post()).status, 200); await f.handlers.idle();
  assert.equal(f.storage.get(f.session.id).transcript.filter(turn => turn.id === 'host:opener').length, 1);
});
