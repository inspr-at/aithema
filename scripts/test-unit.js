import { spawnSync } from 'node:child_process';
import { assertUnitMeasuredHeadroom, selectUnitShard, unitConcurrency, unitTestCommand } from './unit-shards.js';

const args = process.argv.slice(2), files = selectUnitShard(args);
// Preserve npm test's watchdog, deadlines and reporters, replacing ONLY its
// file globs with the selected complete files. No name filters or native shards.
const options = unitTestCommand().filter(arg => !arg.endsWith('*.test.js'));
const started = performance.now();
const child = spawnSync(process.execPath, [...options, `--test-concurrency=${unitConcurrency}`, ...files], {
  stdio: 'inherit', env: { ...process.env, UNIT_TEST_FILES: JSON.stringify(files), UNIT_TEST_SHARD: args[1] },
});
if (child.error) throw child.error;
if (child.status === 0) assertUnitMeasuredHeadroom((performance.now() - started) / 1000);
process.exitCode = child.status ?? 1;
