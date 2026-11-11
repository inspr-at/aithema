import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function fixture(t, command, output) {
  const root = mkdtempSync(join(tmpdir(), 'aithema-script-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, command), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o755 });
  return { cwd: root, encoding: 'utf8', env: { PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin` } };
}

for (const [name, module, call, output, command] of [
  ['paginated unit jobs', 'check-unit-results.js', "fetchUnitJobs('123', 'fixture/repo', bounds)", JSON.stringify([{ jobs: [], padding: 'x'.repeat(128 * 1024) }]), 'gh api --paginate --slurp'],
  ['unit timing importer', 'update-unit-timings.js', "fetchUnitTimingApi('actions/runs/123', bounds)", JSON.stringify({ padding: 'x'.repeat(128 * 1024) }), 'gh api repos/inspr-at/aithema/actions/runs/123'],
]) test(`${name} refuses oversized gh output with an argument-injected cap`, t => {
  const options = fixture(t, 'gh', output);
  const url = new URL(`../scripts/${module}`, import.meta.url).href;
  const run = bounds => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as reader from ${JSON.stringify(url)};
    const { fetchUnitJobs, fetchUnitTimingApi } = reader;
    const bounds = ${JSON.stringify(bounds)};
    console.log(JSON.stringify(${call}));
  `], options);
  const allowed = run({ maxBuffer: 256 * 1024 });
  assert.equal(allowed.status, 0, allowed.stderr);
  const refused = run({ maxBuffer: 64 * 1024 });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exceeded maxBuffer=65536 bytes/u);
  assert.ok(refused.stderr.includes(command), refused.stderr);
  assert.equal(refused.stdout, '', 'partial API output never becomes accepted data');
});
