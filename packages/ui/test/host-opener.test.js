import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '../../core/src/session.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = () => ({ ...createSession({ demo: true }), opener: { text: 'Welcome from a host.', locale: 'en' },
  settings: { ...createSession().settings, origin: 'chosen' },
  featureMatrix: { best: { text: { available: true }, analysis: { available: true } } } });
test('AIT-505: render-only opener reconciles in place without visitor input or restore', async t => {
  const c = document.createElement('aithema-session');
  c.configure({ copy: en, session: session() }); t.after(() => c.remove());
  c.shadowRoot.querySelector('.ready__start').click(); await tick();
  assert.equal(c.session.transcript.length, 0);
  const row = c.shadowRoot.querySelector('[data-id="host:opener"]');
  assert.ok(row, 'host opener is visible immediately after Start');
  assert.match(row.textContent, /Welcome from a host/u);
  assert.equal(c.shadowRoot.querySelector('.workspace').dataset.understanding, 'absent');
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: 'Welcome from a host.' } });
  assert.equal(c.shadowRoot.querySelector('[data-id="host:opener"]'), row);
  assert.equal(c.shadowRoot.querySelector('.workspace').dataset.understanding, 'absent');
});

test('AIT-505: device mode inserts the host turn once into local model context', async t => {
  const c = document.createElement('aithema-session'), source = session(), requests = [];
  source.processingPreset = 'device'; source.featureMatrix.device = source.featureMatrix.best;
  const deviceReasoning = {id:'fixture-device',model:'fixture-model',async connect(){},async *stream(request){requests.push(request);yield JSON.stringify({content:'A fixture reply.',question_short:null,options:[]});}};
  c.configure({copy:en,session:source,deviceReasoning}); t.after(()=>c.remove());
  c.shadowRoot.querySelector('.ready__start').click();
  for (const text of ['First input','Second input']) {
    c.shadowRoot.querySelector('textarea').value=text;c.shadowRoot.querySelector('form.composer').dispatchEvent(new window.Event('submit', { cancelable: true }));await tick();
  }
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].messages.map(m=>m.role),['assistant','user']);
  assert.equal(requests[0].messages[0].content,source.opener.text);
  assert.match(requests[0].system,/first assistant message was written by the host/u);
  assert.equal(c.session.transcript.filter(t=>t.id==='host:opener').length,1);
});

test('AIT-505: first send applies both returned events without a snapshot restore', async t => {
  const c=document.createElement('aithema-session');c.configure({copy:en,session:session()});t.after(()=>c.remove());
  const fetch=t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.match(String(url),/\/turns$/u,'a first send must not restore a sequence gap');
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body),opener={seq:1,type:'turn.final',data:{id:'host:opener',role:'assistant',origin:'host',content:'Welcome from a host.'}};
    const event={seq:2,type:'turn.final',data:{id:body.clientEventId,role:'user',content:body.content}};
    return Response.json({...event,event,events:[opener,event]});
  });
  c.shadowRoot.querySelector('.ready__start').click();
  const row=c.shadowRoot.querySelector('[data-id="host:opener"]');
  c.shadowRoot.querySelector('textarea').value='An invoice system.';c.shadowRoot.querySelector('form.composer').dispatchEvent(new window.Event('submit', { cancelable: true }));await tick();
  assert.deepEqual(c.session.transcript.map(turn=>turn.role),['assistant','user']);
  assert.equal(c.session.transcript[0].id,'host:opener');
  assert.equal(c.shadowRoot.querySelector('[data-id="host:opener"]'),row);
  assert.equal(fetch.mock.callCount(),1);
});

for (const peer of [false,true]) test(`AIT-505: pre-input locale event resolves host copy in ${peer?'peer':'requesting'} tab`, async t => {
  const c=document.createElement('aithema-session');c.configure({copy:en,session:session(),copyForLocale:locale=>locale==='de'?de:en});t.after(()=>c.remove());
  c.shadowRoot.querySelector('.ready__start').click();
  const event={seq:1,type:'session.locale-changed',data:{locale:'de',opener:{text:'Willkommen von einem Host.',locale:'de'}}};
  if(peer)c.receive(event);
  else {
    t.mock.method(globalThis,'fetch',async()=>Response.json({event}));
    assert.equal(await c.changeLocale('de'),true);
  }
  assert.equal(c.session.transcript.length,0);
  assert.equal(c.shadowRoot.querySelector('[data-id="host:opener"] .turn-text')?.textContent,event.data.opener.text);
  c.receive({seq:2,type:'session.locale-changed',data:{locale:'en',opener:null}});
  assert.equal(c.shadowRoot.querySelector('[data-id="host:opener"]'),null,'missing locale clears the render-only row');
});

for (const boundary of ['erase', 'withdraw', 'consent']) test(`AIT-505: ${boundary} clears full opener text from a text-only dialog`, async t => {
  const c = document.createElement('aithema-session');
  c.configure({ copy: en, session: session() }); t.after(() => c.remove());
  c.shadowRoot.querySelector('.ready__start').click();
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: 'Welcome from a host.' } });
  c.shadowRoot.querySelector('.host-opener-more').click();
  const dialog = c.shadowRoot.querySelector('.voice-reply-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('.voice-reply-text').textContent, 'Welcome from a host.');
  const event = boundary === 'erase' ? { type: 'session.erased', data: { at: new Date().toISOString() } }
    : boundary === 'withdraw' ? { type: 'turn.withdrawn', data: { turnId: 'host:opener' } }
      : { type: 'consent.revised', data: { granted: false, changed: [], removed: [] } };
  c.receive({ seq: 2, ...event });
  assert.equal(dialog.open, false, 'invalidated full text cannot remain visible');
  assert.equal(dialog.querySelector('.voice-reply-text').textContent, '', 'invalidated full text cannot remain in hidden DOM');
});
