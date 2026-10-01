import { it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { SqliteJournal, JournalClient } from '../runtime/journal/index.js';
import { DesignRenderer, exportDesign } from '../runtime/design/index.js';
import { DesignScheduler } from '../runtime/engine/design.js';
import { systemClock } from '../runtime/engine/common.js';
import { authority, bytes, now, session } from './fixtures/journal/helpers.mjs';
import { input, submission } from './fixtures/design/helpers.mjs';

it('(e) real rendering, journaling and exports for 12 bounded maximum-node screens fit the 60 s attempt bound', async (t) => {
  const host = new SqliteJournal(':memory:', { now }); host.createSession(bytes(session()));
  t.after(() => host.close());
  const client = new JournalClient({ port: host, authority: authority(), now });
  const screen = input().screen_ir;
  screen.nodes = Array.from({ length: 2000 }, (_, i) => ({ kind: 'text', id: `node${i}`, text: '&'.repeat(210) }));
  const durations = [];
  const renderer = new DesignRenderer({ clock: systemClock, journal: client, getInput: ({ working_rev }) => submission(working_rev % 2 ? 'a' : 'b', {
    screen_ir: { ...screen, screen_ref: `screen${working_rev}` },
    client_event_id: `00000000-0000-4000-8000-${String(working_rev).padStart(12, '0')}`,
  }) });
  const start = performance.now();
  for (let working_rev = 1; working_rev <= 12; working_rev++) {
    const before = performance.now();
    const result = await renderer.render({ revision: { working_rev }, attempt: 1, deadline: before + 60_000 });
    const row = host.recordsByIds([result.design_input_seq], client.authority)[0];
    const exported = exportDesign(row);
    assert.equal(exported.design_rev, result.design_rev);
    assert.ok(result.html.length > 1_000_000, 'exercises escaping-heavy HTML, not a stub');
    durations.push(performance.now() - before);
  }
  const total = performance.now() - start;
  assert.ok(Math.max(...durations) < 60_000);
  assert.ok(total < 60_000, 'whole 12-screen session fits one attempt window');
  t.diagnostic(`REAL renderer+SQLite+exports: max=${Math.max(...durations).toFixed(2)} ms; total12=${total.toFixed(2)} ms; IR=${JSON.stringify(screen).length} bytes; ${process.version}; ${process.platform}/${process.arch}; ${cpus()[0]?.model}`);
});

it('(e) real scheduler start and completion fit 30 s/60 s and the 150 s no-retry freshness bound', async (t) => {
  const host = new SqliteJournal(':memory:', { now }); host.createSession(bytes(session()));
  t.after(() => host.close());
  const client = new JournalClient({ port: host, authority: authority(), now });
  const renderer = new DesignRenderer({ journal: client, getInput: () => submission() });
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const scheduler = new DesignScheduler({ renderer, waitMs: 0, getRevision: () => ({ working_rev: 1 }), onComplete: finish });
  t.after(() => scheduler.stop());
  const before = performance.now();
  scheduler.intent({ intent_id: 'timing', working_rev: 1 });
  await completed;
  const run = scheduler.state.runs[0];
  const intent = scheduler.state.intents[0];
  assert.equal(intent.state, 'rendered');
  assert.ok(run.started_at - intent.arrived_at <= 30_000);
  assert.ok(run.ended_at - run.started_at <= 60_000);
  assert.ok(intent.served_at - intent.arrived_at <= 150_000);
  t.diagnostic(`REAL scheduler: start=${(run.started_at - intent.arrived_at).toFixed(2)} ms; attempt=${(run.ended_at - run.started_at).toFixed(2)} ms; served=${(performance.now() - before).toFixed(2)} ms; ${process.version}`);
});
