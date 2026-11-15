import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { exportSession } from '../src/export.js';
import { mockConsent, testToken, ownedRequest } from '../../../test/helpers.js';
const now = () => 1_800_000_000_000;
const opener = { en: 'Welcome. Your AI assistant is ready.', de: 'Willkommen. Ihre KI-Assistenz ist bereit.' };
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: now() });
  const storage = new SQLiteStorage(':memory:', { now });
  const handlers = createHandlers({ storage, consent: mockConsent, host: { now }, opener, ...options });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
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
