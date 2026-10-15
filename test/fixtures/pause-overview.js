// AIT-188 deterministic server scenario. No provider or sample product data.
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { createMockReasoning } from '../../packages/core/src/index.js';
import { instrumentedMockRuntime } from '../server-fixtures.js';
import { ownedRequest, testToken } from '../helpers.js';
import { start2PurposePolicy } from '../../demo/safeguards.js';

export async function pausedOverview(locale) {
  const storage = new SQLiteStorage(), mock = createMockReasoning();
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let calls = 0, assessments = 0;
  const plugin = { ...mock,
    async *stream(request, options) {
      for await (const _ of mock.stream(request, options)) { /* canonical dispatch */ }
      const first = ++calls === 1;
      yield JSON.stringify({ content: locale === 'de' ? 'Was soll sich durch das Vorhaben verbessern?' : 'What should the project improve?',
        scope: first ? 'in' : 'off', question_short: null, options: [] });
    },
    async structured(request, options) {
      assessments++; const result = await mock.structured(request, options);
      started.resolve(); await gate.promise; return result;
    },
  };
  const handlers = createHandlers({ storage, pluginRuntime: instrumentedMockRuntime(storage, plugin), purposePolicy: start2PurposePolicy });
  const session = storage.create({ locale, demo: true, ownerToken: testToken });
  const request = (action = '', body) => ownedRequest(`http://localhost/api/sessions/${session.id}${action ? '/' + action : ''}`,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  try {
    const project = locale === 'de' ? 'Wir brauchen eine Website für unser Unternehmen.' : 'We need a website for our company.';
    assert.equal((await handlers.handle(request('turns', { content: project, clientEventId: 'project' }))).status, 200);
    await started.promise;
    for (let i = 0; i < 3; i++) {
      assert.equal((await handlers.handle(request('turns', { content: locale === 'de' ? 'Gib mir ein Suppenrezept.' : 'Give me a soup recipe.', clientEventId: `off-${i}` }))).status, 200);
      for (let attempt = 0; storage.safeguards(session.id).offTopicTurns !== i + 1 && attempt < 1000; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(storage.safeguards(session.id).offTopicTurns, i + 1);
    }
    const before = await handlers.handle(request()).then(r => r.json());
    assert.equal(before.pauseReason, 'purpose');
    assert.equal(before.understanding.readinessAssessed, false);
    gate.resolve(); await handlers.idle();
    const after = await handlers.handle(request()).then(r => r.json());
    assert.equal(after.understanding.readinessAssessed, true);
    assert.ok(after.understanding.summary.includes(project));
    assert.doesNotMatch(after.understanding.summary, /Suppenrezept|soup/iu);
    assert.equal(assessments, 1);
    return { before, after, events: storage.read(session.id, before.seq), assessments, offTopicTurns: 3 };
  } finally { gate.resolve(); await handlers.close(); storage.close(); }
}
