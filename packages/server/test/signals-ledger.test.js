import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { SQLiteStorage } from '../src/storage.js';
import { exportSession } from '../src/export.js';
const now = () => 1_800_000_000_000;
function fixture(t) {
  const storage = new SQLiteStorage(':memory:', { now }); t.after(() => storage.close());
  const s = storage.create();
  storage.append(s.id, 'turn.final', { id: 'person', role: 'user', content: 'We use orders.' });
  const final = signals => { const current = storage.get(s.id); return storage.append(s.id, 'understanding.updated', reduceUnderstanding(current.understanding,
    { signals, constraints: {}, progress: {}, summary: 'Orders', openQuestions: [] }, { transcript: current.transcript, inputRevision: inputRevision(current) })); };
  return { storage, id: s.id, final };
}

test('AIT-515 persisted ledger survives reset and replay, journal/snapshot carry no raw signal text', t => {
  const { storage, id, final } = fixture(t);
  final(['Unique sensitive signal']);
  const ledger = storage.get(id).signalLedger;
  assert.equal(ledger.length, 1);
  storage.changeLocale(id, 'de');
  assert.deepEqual(storage.get(id).signalLedger, ledger);
  final(['Unique sensitive signal', 'New fact']);
  const current = storage.get(id);
  assert.deepEqual(current.understanding.signals, ['New fact', 'Unique sensitive signal']);
  const replay = storage.read(id).reduce(applyEvent, createSession({ id }));
  assert.deepEqual(replay.signalLedger, current.signalLedger);
  assert.doesNotMatch(storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id).snapshot, /Unique sensitive signal/iu);
  for (const row of storage.db.prepare('SELECT event FROM events WHERE session_id=?').all(id)) assert.doesNotMatch(row.event, /Unique sensitive signal/iu);
});

for (const action of ['withdraw', 'consent', 'erase']) test(`AIT-515 ${action} removes ledger from snapshot, replay, stored bytes and export`, t => {
  const { storage, id, final } = fixture(t); final(['Unique sensitive signal']);
  if (action === 'withdraw') storage.withdraw(id, 'person');
  if (action === 'consent') storage.reviseConsent(id, false);
  if (action === 'erase') storage.erase(id);
  const s = storage.get(id);
  assert.deepEqual(s.signalLedger, []);
  assert.deepEqual(storage.read(id).reduce(applyEvent, createSession({ id })).signalLedger, []);
  for (const row of storage.db.prepare('SELECT bytes FROM content WHERE session_id=?').all(id)) assert.doesNotMatch(row.bytes ?? '', /Unique sensitive signal/iu);
  assert.equal(exportSession(s, [], [], { exportedAt: new Date(now()).toISOString() }).includes(Buffer.from('Unique sensitive signal')), false);
});

test('AIT-515 export retains newest-first legacy strings and additive signal metadata', t => {
  const { storage, id, final } = fixture(t);
  final(['Old']); final(['Old', { text: 'New', basis: 'assistant' }]);
  const zip = exportSession(storage.get(id), [], [], { exportedAt: new Date(now()).toISOString() }).toString();
  assert.ok(zip.includes('"signals": [\n    "New",\n    "Old"\n  ]'));
  assert.ok(zip.includes('"basis": "assistant"'));
});
