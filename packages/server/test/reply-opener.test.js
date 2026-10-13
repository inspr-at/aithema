import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockReasoning } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { instrumentedMockRuntime } from '../../../test/server-fixtures.js';
import { ownedRequest, testToken, unzip } from '../../../test/helpers.js';
import { beginInvocation } from '../../../packages/core/src/invocation.js';

for (const format of ['plain', 'card', 'card-content-last']) for (const language of ['de', 'en']) {
  test(`AIT-157: ${format} ${language} reply is guarded before display, storage and export`, async () => {
    const storage = new SQLiteStorage(), first = Promise.withResolvers(), release = Promise.withResolvers();
    const opener = language === 'de' ? 'Vielen Dank für Ihre Beschreibung, ' : 'Thank you very much for your description, ';
    const remainder = language === 'de' ? 'das klingt nach einem klaren Vorhaben. Danke für das Detail.' : 'it sounds like a clear plan. Thanks for the detail.';
    const expected = remainder[0].toUpperCase() + remainder.slice(1), partials = [], logs = [];
    const card = { content: opener + remainder, question_short: 'Welche Systeme?', options: [{ text: 'SAP', likely: true }] };
    let calls = 0, pending;
    const reasoning = { ...createMockReasoning(), async *stream(request, options) {
      const invocation = await beginInvocation(options, { billable: false });
      invocation.dispatch(); invocation.usage({ inputTokens: 0, outputTokens: 0 });
      let completed = false;
      calls++;
      try {
      if (format === 'card-content-last') {
        yield JSON.stringify({ question_short: card.question_short, options: card.options, content: card.content }); completed = true; return;
      }
      if (format === 'card') yield '{"content":"';
      yield opener; first.resolve(); await release.promise;
      // Token-size chunks exercise partial prefix decisions and capitalization.
      for (const char of remainder) yield char;
      if (format === 'card') yield `","question_short":${JSON.stringify(card.question_short)},"options":${JSON.stringify(card.options)}}`;
      completed = true;
      } finally { await invocation.finish(completed); }
    } };
    const handlers = createHandlers({ storage, reasoning, pluginRuntime: instrumentedMockRuntime(storage, reasoning), log: entry => logs.push(entry) });
    const transient = handlers.lanes.transient;
    handlers.lanes.transient = (id, event) => { partials.push(event.data.delta); transient(id, event); };
    try {
      const session = storage.create({ demo: true, locale: 'de', ownerToken: testToken });
      storage.postTurn(session.id, 'input', Buffer.from('Beschreibung'), 'Beschreibung');
      pending = handlers.lanes.run(session.id, 'reaction');
      if (format !== 'card-content-last') {
        await first.promise;
        assert.deepEqual(partials, [], 'no thanks opener flashes while the first clause is buffered');
      }
      release.resolve(); await pending;
      assert.equal(partials.join(''), expected);
      const stored = storage.get(session.id).transcript.at(-1);
      assert.equal(stored.content, expected);
      assert.equal(storage.read(session.id).at(-1).data.content, expected);
      if (format !== 'plain') { assert.equal(stored.question_short, card.question_short); assert.deepEqual(stored.options, card.options); }
      const snapshot = await handlers.handle(ownedRequest(`http://host/api/sessions/${session.id}`)).then(r => r.json());
      assert.equal(snapshot.transcript.at(-1).content, expected);
      const exported = await handlers.handle(ownedRequest(`http://host/api/sessions/${session.id}/export`));
      const files = unzip(new Uint8Array(await exported.arrayBuffer()));
      assert.equal(JSON.parse(files['transcript.json']).turns.at(-1).content, expected);
      assert.ok(files['transcript.md'].includes(expected));
      assert.equal(calls, 1, 'no regeneration');
      assert.deepEqual(logs.filter(entry => entry.event === 'reply.opener-stripped'), [{ event: 'reply.opener-stripped', count: 1, lane: 'reaction' }]);
      assert.equal(JSON.stringify(logs).includes('Beschreibung'), false, 'diagnostics carry no text');
    } finally { release.resolve(); await pending?.catch(() => {}); await handlers.close(); storage.close(); }
  });
}
