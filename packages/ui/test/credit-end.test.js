// Keep credit-end regressions in their own DOM lifetime. The large host matrix
// already approaches the default Node heap ceiling; no larger heap is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { HostSurface } from '../src/host-surface.js';
const window = new Window({ url: 'http://localhost/' });
test.after(() => window.happyDOM.close());
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const balance = { owner: { limitMicro: 5_000_000, committedMicro: 750_000, availableMicro: 4_250_000, overrunMicro: 0 } };

// A connected component; `routes` maps "METHOD path" (after /api/sessions/:id or /api) to a handler.
function setup(t, { copy = en, host = { credits: true }, routes = {}, session: extra = {} } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  Object.assign(session, extra);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url).replace(`/api/sessions/${c.session.id}`, '').replace(/^\/api/u, ''), method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) { if (options.signal?.aborted) controller.close();
      else options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (routes[key]) return routes[key](body, path);
    if (key === 'GET /credits') return Response.json({ balance, limitSlot: null });
    return Response.json(c.session);
  });
  c.configure({ copy, session, host }); document.body.append(c);
  t.after(async () => {
    c.remove();
    // Disconnect starts async voice/host cleanup. Drain those continuations while
    // this test's fetch/timer mocks still own them, before the next fixture starts.
    await tick(12);
  });
  return { c, root: c.shadowRoot, calls };
}
const userTurn = (c, id = 't1') => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id, role: 'user', content: 'We need a preorder app.' } });

// Exercise the durable end-event path with shipped copy, without manufacturing
// a matching action failure. Observe inserted text only: removals are not speech.
for (const copy of [de, en]) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
  test(`AIT-292 r2 ${copy.display.locale}/${reason}: real end events use only the composer announcement`, async t => {
    const { c, root } = setup(t, { copy, host: { credits: true } });
    await tick(8); userTurn(c);
    const limit = copy.hostSurface.credits.ended[reason];
    const body = reason === 'session' ? copy.hostSurface.credits.ended.sessionDefaultBody : limit.body;
    const message = `${limit.title} ${body}`, announcements = [];
    const observer = new window.MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.textContent === message) announcements.push(record.target.className);
      }
    });
    for (const selector of ['.status__label', '.status__live', '.credit-announcement']) observer.observe(root.querySelector(selector), { childList: true });
    t.after(() => observer.disconnect());
    for (const type of ['credits.limit-reached', 'conversation.end-requested', 'credits.limit-reached']) {
      c.receive({ seq: c.session.seq + 1, type, data: { reason } }); await tick(8);
      assert.equal(root.querySelector('.composer-out__body > [data-active="true"]').textContent, body);
      assert.equal(root.querySelector('.status__label').closest('.composer-dock'), null, 'no end-reason toast');
    }
    assert.deepEqual(announcements, ['credit-announcement sr-only'], 'exactly one polite block announcement');
    assert.equal(root.querySelector('.credit-announcement').getAttribute('aria-live'), 'polite');
  });
  test(`AIT-292 r2 ${copy.display.locale}/${reason}: host end-event source never sends a status toast`, async t => {
    const { c, root } = setup(t, { copy, host: {} }); await tick(8);
    const statuses = [];
    // HostSurface's status callback is the source of the old ended-copy toast.
    // Even a host without an onCredits callback must not emit that toast.
    const host = new HostSurface({ root, copy, options: {}, baseUrl: '', session: () => c.session, status: text => statuses.push(text) });
    t.after(() => host.destroy());
    for (const type of ['credits.limit-reached', 'conversation.end-requested']) host.receive({ type, data: { reason } });
    assert.equal(host.endReason, reason);
    assert.deepEqual(statuses, [], 'end reasons belong to the composer, never the status channel');
  });
}

for (const copy of [de, en]) test(`AIT-292 r2 ${copy.display.locale}: recovery permits the same limit announcement again`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { c, root } = setup(t, { copy, host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance, exhausted: false, limitSlot: null }),
  } }); await tick(8); userTurn(c);
  const announcement = root.querySelector('.credit-announcement'), messages = [];
  const observer = new window.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.textContent) messages.push(node.textContent);
  });
  observer.observe(announcement, { childList: true }); t.after(() => observer.disconnect());
  const end = () => c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  end(); await tick(8);
  c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  t.mock.timers.tick(15_001); await tick(12);
  assert.equal(announcement.textContent, '', 'recovery clears announcement history');
  end(); await tick(8);
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1], 'the repeated limit copy is announced again after recovery');
});

for (const failure of ['http', 'network']) test(`AIT-292 r2: ${failure} credits poll failure does not request features`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let failed = false;
  const { c, root, calls } = setup(t, { host: { credits: true }, session: {
    featureMatrix: { best: { text: { available: false, reason: 'budget denied' } } },
  }, routes: {
    'GET /credits': () => {
      if (failed) { if (failure === 'network') throw new Error('offline'); return Response.json({}, { status: 503 }); }
      return Response.json({ balance, exhausted: true, limitSlot: null });
    },
  } }); await tick(12); userTurn(c);
  const reads = path => calls.filter(call => call.path === path).length;
  const creditReads = reads('/credits'), featureReads = reads('');
  failed = true; t.mock.timers.tick(15_001); await tick(12);
  assert.equal(reads('/credits'), creditReads + 1, 'the exhausted wallet was polled');
  assert.equal(reads(''), featureReads, 'a failed receipt cannot justify a feature request');
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false', 'acknowledged exhaustion stays visible');
  failed = false; t.mock.timers.tick(15_001); await tick(12);
  assert.equal(reads('/credits'), creditReads + 2);
  assert.ok(reads('') > featureReads, 'a later successful receipt still refreshes denied features');
});

for (const copy of [de, en]) for (const failure of ['http', 'network']) {
  test(`AIT-292 ${copy.display.locale}: restored host-limit announces once after ${failure} credits failure`, async t => {
    const { c, root } = setup(t, { copy, host: { credits: true }, session: { credits: { status: 'ended', endReason: 'host-limit' } },
      routes: { 'GET /credits': () => { if (failure === 'network') throw new Error('offline'); return Response.json({}, { status: 503 }); } } });
    const announcement = root.querySelector('.credit-announcement'), changes = [];
    const observer = new window.MutationObserver(records => changes.push(...records));
    observer.observe(announcement, { childList: true }); t.after(() => observer.disconnect());
    await tick(8);
    const limit = copy.hostSurface.credits.ended['host-limit'];
    assert.equal(announcement.textContent, `${limit.title} ${limit.body}`);
    assert.equal(root.querySelector('.status__label').closest('.composer-dock'), null);
    c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
    await tick(8); assert.equal(changes.length, 1);
  });
}

// Keep the no-toast check from Tick's recorded capture head 21e06f34.
// AIT-435 Tick item 2 updates the O1-off session body; announcements stay exact.
for (const copy of [de, en]) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
  test(`AIT-292 QA-base ${copy.display.locale}/${reason}: end event must not duplicate the composer as a toast`, async t => {
    const { c, root } = setup(t, { copy, host: { credits: true } }); await tick(8); userTurn(c);
    c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason } }); await tick(8);
    const ended = copy.hostSurface.credits.ended[reason], body = reason === 'session'
      ? copy.hostSurface.credits.ended.sessionDefaultBody : typeof ended === 'string' ? ended : ended.body;
    assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
    assert.equal(root.querySelector('.composer-out__body > [data-active="true"]').textContent, body, 'the composer shows the actual ended reason');
    const toast = root.querySelector('.composer-dock > .status__label');
    assert.equal(toast?.textContent ?? '', '', `duplicate ended-reason toast: ${toast?.textContent ?? ''}`);
  });
}
