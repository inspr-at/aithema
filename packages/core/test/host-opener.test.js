import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const opener = { id: 'host:opener', role: 'assistant', origin: 'host', content: 'Welcome.', model: 'must-drop', provider: 'must-drop' };
test('AIT-505: host provenance survives without a model or provider', () => {
  const session = core.applyEvent(core.createSession(), { seq: 1, type: 'turn.final', data: opener });
  assert.equal(session.transcript[0].origin, 'host');
  assert.equal(session.transcript[0].model, undefined);
  assert.equal(session.transcript[0].provider, undefined);
  assert.equal(session.inputRevision, 0);
  assert.equal(core.conversationStarted(session), true);
});
test('AIT-505: hasVisitorInput excludes host, assistant and withdrawn inputs', () => {
  assert.equal(typeof core.hasVisitorInput, 'function');
  const session = core.createSession();
  session.transcript = [opener, { role: 'user', content: 'Gone', withdrawn: true }];
  assert.equal(core.hasVisitorInput(session), false);
  session.uploads = [{ id: 'doc', state: 'pending' }];
  assert.equal(core.hasVisitorInput(session), false);
  session.uploads[0].state = 'accepted';
  assert.equal(core.hasVisitorInput(session), true);
  session.uploads = []; session.transcript.push({ role: 'user', content: 'Hello' });
  assert.equal(core.hasVisitorInput(session), true);
});
test('AIT-505: model context includes delivered host text and continuation guidance', () => {
  const session = core.applyEvent(core.createSession(), { seq: 1, type: 'turn.final', data: opener });
  const request = core.reasoningRequest(session, 'reaction');
  assert.ok(request.messages.some(message => message.role === 'assistant' && message.content === opener.content));
  assert.equal(request.messages.find(message => message.role === 'assistant').content, opener.content);
  assert.equal(request.messages.filter(message => message.role === 'assistant' && message.content === opener.content).length, 1);
  assert.match(request.system, /first assistant message was written by the host.*already been delivered/u);
});

test('AIT-505: host-only context defers both lanes and never satisfies a visitor reply cache', async () => {
  let session = core.applyEvent(core.createSession({demo:true}),{seq:1,type:'turn.final',data:opener});
  const plugin=core.createMockReasoning(),calls=[];
  const lanes=new core.SessionLanes({reasoning:plugin,now:()=>1800000000000,getSession:()=>session,
    beforeDispatch:()=>{calls.push('dispatch');return true;},publish(id,type,data){session=core.applyEvent(session,{seq:session.seq+1,type,data});return true;}});
  assert.equal(await lanes.run(session.id,'reaction'),'deferred');
  assert.equal(await lanes.run(session.id,'understanding'),'deferred');
  assert.deepEqual(calls,[]);
  session=core.applyEvent(session,{seq:2,type:'turn.final',data:{id:'person',role:'user',content:'An invoice system.'}});
  session.transcript[0].inputRevision=core.inputRevision(session);
  assert.equal(await lanes.run(session.id,'reaction'),'completed');
  assert.equal(calls.length,1);
  assert.equal(session.transcript.length,3);
});
