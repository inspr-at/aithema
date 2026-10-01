import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { hydrateSnapshot, reopenDesign, validateCitations } from '../../../runtime/journal/hydrate.js';
import { exportDesign, renderHydratedDesign, renderStoredDesign } from '../../../runtime/design/index.js';
import { authorizationFor } from '../../engine-helpers.test.js';
import { engineFixture } from './engine-helpers.mjs';
import { textDesign } from './engine.mjs';

// Synthetic adapters and the reference host only: no sockets or providers.
const [mode, path, brand] = process.argv.slice(2);
if (mode === 'write') {
  const f = engineFixture(null, { path, brand });
  await textDesign(f);
  assert.equal(f.engine.state.spec.screens.length, 1);
  assert.equal(f.engine.state.spec.items.length, 1);
  const binding = f.engine.state.spec.screens[0];
  const row = f.journal.recordsByIds([binding.design_input_seq], f.client.authority)[0];
  const artifact = renderStoredDesign(row);
  assert.equal(binding.design_rev, artifact.design_rev);
  writeFileSync(`${path}.before.json`, JSON.stringify({ binding, artifact,
    exported: exportDesign(row), bytes: row.bytes.toString('base64'), working_rev: f.engine.state.working_rev,
    holds: f.records('budget.hold').length, claims: f.records('budget.claim').length }));
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'resume') {
  const before = JSON.parse(readFileSync(`${path}.before.json`, 'utf8'));
  const f = engineFixture(null, { path, initialize: false,
    handler() { throw new Error('Completed text must not be regenerated'); },
    getDesignInput() { throw new Error('Completed design must not be regenerated'); } });
  try {
    await f.engine.resume({ authorizationFor, replay: false });
    await f.clock.advance(30_000);
    assert.equal(f.client.authority.gen, 2);
    assert.equal(f.engine.state.working_rev, before.working_rev);
    assert.deepEqual(f.engine.state.spec.screens, [before.binding]);
    const stored = f.journal.cursor(f.client.authority).snapshot;
    const closure = await hydrateSnapshot(f.port, stored, f.client.authority);
    assert.equal(validateCitations(f.engine.state, closure), true);
    assert.ok(closure.has(f.engine.state.spec.items[0].citations[0].record_seq));
    const row = closure.get(before.binding.design_input_seq);
    assert.equal(row.bytes.toString('base64'), before.bytes);
    const artifact = await reopenDesign(f.engine.state, closure, before.binding.screen_ref, renderHydratedDesign);
    assert.deepEqual(artifact, before.artifact);
    assert.deepEqual(exportDesign(row), before.exported);
    assert.equal(f.records('budget.hold').length, before.holds);
    assert.equal(f.records('budget.claim').length, before.claims);
    assert.deepEqual(f.errors, []);
    writeFileSync(`${path}.after.json`, JSON.stringify({ binding: f.engine.state.spec.screens[0],
      artifact, exported: exportDesign(row), bytes: row.bytes.toString('base64') }));
  } finally { f.close(); }
} else throw new Error('Expected write or resume mode');
