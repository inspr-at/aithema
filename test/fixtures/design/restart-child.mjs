import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SqliteJournal, JournalClient } from '../../../runtime/journal/index.js';
import { reopenDesign } from '../../../runtime/journal/hydrate.js';
import { exportDesign, renderHydratedDesign, renderStoredDesign } from '../../../runtime/design/index.js';
import { authority, bytes, now, session, snapshot } from '../journal/helpers.mjs';
import { submission } from './helpers.mjs';

// Every input is synthetic; this process never opens a socket or a provider.
const [mode, path] = process.argv.slice(2);
const host = new SqliteJournal(path, { now });
const client = new JournalClient({ port: host, authority: authority(), now });
if (mode === 'write') {
  host.createSession(bytes(session()));
  const rendered = [];
  const screens = [];
  for (const brand of ['a', 'b']) {
    const row = await client.append(submission(brand));
    rendered.push({ artifact: renderStoredDesign(row), exported: exportDesign(row), bytes: row.bytes.toString('base64') });
    screens.push({ screen_ref: `brand-${brand}`, design_input_seq: row.document.seq });
  }
  await client.append(bytes(snapshot({ consumed_seq: 2, spec: { items: [], questions: [], brief: null, screens } })));
  writeFileSync(`${path}.before.json`, JSON.stringify(rendered));
  // Crash after committed acknowledgements, without close/checkpoint. WAL must
  // survive a genuinely new process with no old objects or renderer cache.
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'resume') {
  const before = JSON.parse(readFileSync(`${path}.before.json`));
  const restored = await client.resume();
  assert.equal(client.authority.gen, 2);
  assert.deepEqual([...restored.closure.keys()], [1, 2]);
  const result = [];
  for (const [i, screen] of restored.snapshot.spec.screens.entries()) {
    const row = restored.closure.get(screen.design_input_seq);
    assert.equal(row.bytes.toString('base64'), before[i].bytes);
    const artifact = await reopenDesign(restored.snapshot, restored.closure, screen.screen_ref, renderHydratedDesign);
    const exported = exportDesign(row);
    assert.deepEqual(artifact, before[i].artifact);
    assert.deepEqual(exported, before[i].exported);
    result.push({ artifact, exported, bytes: row.bytes.toString('base64') });
  }
  writeFileSync(`${path}.after.json`, JSON.stringify(result));
  host.close();
} else {
  throw new Error('Expected write or resume mode');
}
