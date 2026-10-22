import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitPlan } from './unit-shards.js';

export function assertUnitResults(recordsByShard, packing, expectedRun) {
  if (recordsByShard.length !== packing.shards.length) throw new Error('Missing unit shard results');
  let tests = 0;
  for (let index = 0; index < packing.shards.length; index++) {
    const records = recordsByShard[index], header = records[0];
    if (header?.type !== 'run' || header.schema !== 1 || header.shard !== `${index + 1}/${packing.shards.length}` ||
        header.runId !== expectedRun.runId || header.sha !== expectedRun.sha || header.attempt !== expectedRun.attempt ||
        JSON.stringify([...(header.files ?? [])].sort()) !== JSON.stringify([...packing.shards[index]].sort())) {
      throw new Error('Unit artifact provenance or assignment mismatch');
    }
    const summaries = records.slice(1), final = summaries.filter(record => !record.file);
    if (final.length !== 1 || summaries.some(record => record.type !== 'test:summary' || !record.success ||
        ['failed', 'cancelled', 'skipped', 'todo'].some(key => record.counts?.[key] !== 0) ||
        !Number.isInteger(record.counts?.tests) || record.counts.tests < 1 || record.counts.passed !== record.counts.tests)) {
      throw new Error('Incomplete or unsuccessful unit summary');
    }
    const files = summaries.filter(record => record.file);
    if (JSON.stringify(files.map(record => record.file).sort()) !== JSON.stringify([...packing.shards[index]].sort()) ||
        files.reduce((sum, record) => sum + record.counts.tests, 0) !== final[0].counts.tests) {
      throw new Error('Unit result files/counts do not match the exactly-once assignment');
    }
    tests += final[0].counts.tests;
  }
  return tests;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packing = unitPlan();
  const records = packing.shards.map((_, index) => readFileSync(resolve(process.argv[2],
    `unit-timings-${index + 1}-of-${packing.shards.length}`, 'timings.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  const tests = assertUnitResults(records, packing, { runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
  records.forEach((rows, index) => {
    const summary = rows.find(row => row.type === 'test:summary' && !row.file);
    console.log(`Unit shard ${index + 1}/${records.length}: ${summary.counts.tests} tests; ${(summary.duration_ms / 1000).toFixed(3)}s suite elapsed.`);
  });
  const baseline = JSON.parse(readFileSync(new URL('./unit-timings.json', import.meta.url), 'utf8'));
  console.log(`Unit count evidence: measured baseline ${baseline.totalTests}; current ${tests}.`);
  console.log(`Unit coverage verified: ${tests} tests passed, ${packing.shards.flat().length} files exactly once; zero failed/cancelled/skipped/todo.`);
}
