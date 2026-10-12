import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/index.js';
import { inputRevision } from '@inspr/aithema-core';
import { temporaryDb } from '../../../test/helpers.js';

test('AIT-132: card fields survive SQLite reopen and journal replay, and remain erasable with the reply', async () => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path);
  const session = storage.create({ demo: true });
  storage.postTurn(session.id, 'source', Buffer.from('Cushions'), 'Cushions');
  const card = { question_short: 'Question sentinel?', options: [{ text: 'Answer sentinel', likely: true }, { text: 'Other answer' }] };
  storage.append(session.id, 'turn.final', { id: 'assistant', role: 'assistant', content: 'Which design?',
    inputRevision: inputRevision(storage.get(session.id)), ...card });
  storage.close(); storage = new SQLiteStorage(path);
  try {
    const reply = storage.get(session.id).transcript.at(-1);
    assert.equal(reply.question_short, card.question_short);
    assert.deepEqual(reply.options, card.options);
    assert.deepEqual(storage.read(session.id).at(-1).data.options, card.options);
    const journal = storage.db.prepare('SELECT event FROM events WHERE session_id=?').all(session.id).map(row => row.event).join('');
    assert.equal(journal.includes('sentinel'), false, 'card content belongs in the erasable payload, never journal metadata');
    storage.erase(session.id);
    assert.equal(JSON.stringify(storage.get(session.id)).includes('sentinel'), false);
    assert.equal(JSON.stringify(storage.read(session.id)).includes('sentinel'), false);
  } finally { storage.close(); }
});
