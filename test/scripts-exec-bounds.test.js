import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('DCO history reader refuses oversized git output with the bound message', t => {
  const options = fixture(t, 'git', 'x'.repeat(128 * 1024));
  const script = fileURLToPath(new URL('../scripts/check-dco.py', import.meta.url));
  const run = max_buffer => spawnSync('python3', ['-I', '-c', `
import runpy
reader = runpy.run_path(${JSON.stringify(script)})
print(reader['git']('rev-list', '--reverse', 'base..head', max_buffer=${max_buffer}))
`], options);
  assert.equal(run(256 * 1024).status, 0);
  const refused = run(64 * 1024);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /git rev-list --reverse base\.\.head.*exceeded maxBuffer=65536 bytes/u);
  assert.equal(refused.stdout, '');
});

test('DCO history reader fails closed on an argument-injected timeout', t => {
  const options = fixture(t, 'git', '');
  writeFileSync(join(options.cwd, 'git'), `#!${process.execPath}\nsetTimeout(() => {}, 5000);\n`, { mode: 0o755 });
  const script = fileURLToPath(new URL('../scripts/check-dco.py', import.meta.url));
  const refused = spawnSync('python3', ['-I', '-c', `
import runpy
reader = runpy.run_path(${JSON.stringify(script)})
print(reader['git']('rev-list', '--reverse', 'base..head', timeout=50))
`], options);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /git rev-list --reverse base\.\.head.*exceeded timeout=50 ms/u);
  assert.equal(refused.stdout, '');
});

test('DCO existing history and trailer regressions remain covered', () => {
  const result = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_dco.py', '-v'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
