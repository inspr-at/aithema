import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
const steps = () => parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).jobs.pack.steps;

test('candidate admission follows build and verify and precedes creation; cleanup is armed before asset upload', () => {
  const commands = steps().map(step => step.run ?? '').join('\n');
  const build = commands.indexOf('release/pack.mjs pack'), verify = commands.indexOf('release/pack.mjs verify');
  const gate = commands.indexOf('node release/gate.mjs candidate "$GITHUB_REF"');
  const trap = commands.indexOf('trap cleanup_failed_release ERR'), create = commands.indexOf('gh release create');
  assert.ok(build >= 0 && build < verify && verify < gate && gate < create, 'candidate admission must guard creation after verification');
  assert.ok(trap >= 0 && trap < create, 'asset-upload failures during create must run cleanup');
});

test('candidate admission is its own read-only-token step immediately after verify, before attestation', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const list = workflow.jobs.pack.steps;
  const verify = list.findIndex(step => step.run?.includes('release/pack.mjs verify'));
  const gate = list.findIndex(step => step.run?.includes('release/gate.mjs candidate'));
  const attest = list.findIndex(step => step.uses?.startsWith('actions/attest-build-provenance@'));
  const create = list.findIndex(step => step.run?.includes('gh release create'));
  assert.equal(gate, verify + 1);
  assert.ok(verify < gate && gate < attest && attest < create, 'verify < gate < attest < create');
  assert.equal(list[gate].env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(list[gate].run.trim(), 'node release/gate.mjs candidate "$GITHUB_REF"');
});

test('all release refs share one non-cancelling concurrency group', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.concurrency.group, 'release');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('refused candidates cannot retain the built release artifact', () => {
  const list = steps();
  const gate = list.find(step => step.run?.includes('release/gate.mjs candidate'));
  const artifact = list.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(gate.id, 'candidate-gate');
  assert.equal(artifact.if, "always() && steps.candidate-gate.outcome == 'success'");
});

test('asset-upload failure removes its partial draft, retains the tag, and permits a clean retry', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'aithema-upload-failure-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin')); mkdirSync(join(cwd, 'dist/release'), { recursive: true });
  writeFileSync(join(cwd, 'dist/release/fixture.tgz'), 'fixture');
  writeFileSync(join(cwd, 'tag-retained'), 'immutable ref');
  writeFileSync(join(cwd, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[3];
fs.appendFileSync('calls.jsonl', command + '\\n');
if (command === 'create') {
  if (fs.existsSync('draft') || fs.existsSync('published')) process.exit(2);
  fs.writeFileSync('draft', 'assets partly uploaded');
  if (fs.existsSync('fail-upload')) process.exit(1);
} else if (command === 'delete') {
  if (fs.existsSync('published')) process.exit(3);
  fs.unlinkSync('draft');
} else if (command === 'edit') {
  fs.renameSync('draft', 'published');
} else if (command === 'view') console.log('true');
else process.exit(90);
`, { mode: 0o755 });
  // This fixture exercises the publication shell, while release-candidate-gate
  // exercises the actual admission command against Git and API fixtures.
  writeFileSync(join(cwd, 'bin/node'), '#!/bin/sh\n[ "$1" = release/gate.mjs ] && [ "$2" = candidate ]\n', { mode: 0o755 });
  const command = [steps().find(step => step.run?.includes('release/gate.mjs candidate')).run,
    steps().find(step => step.run?.includes('gh release create')).run].join('\n');
  const env = { PATH: `${join(cwd, 'bin')}:/usr/bin:/bin`, GITHUB_REF_NAME: 'v261019120000.0.0',
    GITHUB_REF: 'refs/tags/v261019120000.0.0', GITHUB_REPOSITORY: 'fixture/repo', GH_TOKEN: 'fixture-only' };
  const run = () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], { cwd, env, encoding: 'utf8' });
  writeFileSync(join(cwd, 'fail-upload'), 'once');
  const failure = run(); assert.notEqual(failure.status, 0, failure.stdout);
  assert.equal(existsSync(join(cwd, 'draft')), false, 'the trap removes the draft created before the upload failure');
  assert.equal(readFileSync(join(cwd, 'tag-retained'), 'utf8'), 'immutable ref');
  assert.equal(readFileSync(join(cwd, 'calls.jsonl'), 'utf8'), 'create\ndelete\n');
  rmSync(join(cwd, 'fail-upload'));
  const retry = run(); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(existsSync(join(cwd, 'published')), true);
  assert.equal(existsSync(join(cwd, 'draft')), false);
  assert.equal(readFileSync(join(cwd, 'calls.jsonl'), 'utf8'), 'create\ndelete\ncreate\nedit\nview\n');
  // A denied candidate must stop before creation and before the cleanup trap.
  writeFileSync(join(cwd, 'bin/node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(cwd, 'calls.jsonl'), '');
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(join(cwd, 'calls.jsonl'), 'utf8'), '');
  assert.equal(existsSync(join(cwd, 'published')), true);
});
