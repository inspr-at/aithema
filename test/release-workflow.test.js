import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
const yaml = { parse };
const releaseWorkflow = () => parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
test('workflow parses, only a matching pushed tag admits release packing, and PR retention never publishes', () => {
  const release = yaml.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(release.on.push.tags, ['v*']); assert.equal(release.on.pull_request, undefined);
  assert.equal(release.permissions.contents, 'read'); assert.equal(Object.keys(release.jobs).length, 1);
  assert.equal(release.on.workflow_dispatch, undefined);
  assert.equal(release.jobs.pack.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  const text = JSON.stringify(release); assert.doesNotMatch(text, /npm (?:publish|login|adduser)|git tag|git push|registry-url|NODE_AUTH_TOKEN|NPM_TOKEN/u);
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1]), ['GITHUB_TOKEN']);
  assert.doesNotMatch(text, /secrets\[|secrets\s*\}\}|github\.token/u);
  const ci = yaml.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.on.pull_request, null); assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(ci.jobs.test.steps.some(step => step.run?.includes('release/dry-run.mjs')));
  assert.equal(ci.jobs.browser['timeout-minutes'], 10); // 420 s is the measured budget, with runner headroom.
  assert.equal(ci.jobs.test['timeout-minutes'], 10);
  const boot = ci.jobs.test.steps.find(step => step.name === 'Boot standalone host from candidate tarballs');
  assert.equal(boot['timeout-minutes'], 2);
  assert.equal(boot.if, ci.jobs.test.steps.find(step => step.run?.trim().endsWith('npm test')).if);
  assert.match(boot.run, /npm run release:pack -- "\$RUNNER_TEMP\/release-evidence\/tarball-boot" --candidate\nnpm run release:consumer -- "\$RUNNER_TEMP\/release-evidence\/tarball-boot" --boot-only/u);
  const upload = ci.jobs.test.steps.find(step => step.uses?.includes('upload-artifact'));
  assert.equal(upload.with.name, 'reset-candidate'); assert.equal(upload.with['retention-days'], 90);
  assert.equal(upload.with.path, '${{ runner.temp }}/release-evidence/candidate/');
  const smokeUpload = ci.jobs.test.steps.find(step => step.with?.name === 'consumer-smoke');
  assert.equal(smokeUpload.with.path, '${{ runner.temp }}/release-evidence/tarball-boot/');
  assert.equal(smokeUpload.if, upload.if);
  assert.equal(smokeUpload.with['retention-days'], 90);
  assert.doesNotMatch(JSON.stringify(ci), /npm publish|gh release|git tag|git push/u);
  assert.deepEqual(release.permissions, { contents: 'read' });
  assert.deepEqual(release.jobs.pack.permissions, { contents: 'write', 'id-token': 'write', attestations: 'write' });
  const attest = release.jobs.pack.steps.find(step => step.uses?.includes('attest-build-provenance'));
  assert.match(attest.uses, /@[a-f0-9]{40}$/u);
  assert.match(attest.with['subject-path'], /dist\/release\/\*\.tgz/u);
  assert.match(attest.with['subject-path'], /release-set\.json/u);
  assert.match(attest.with['subject-path'], /dist\/release\/SHA256SUMS/u);
  assert.match(attest.with['subject-path'], /consumer-evidence\.json/u);
  for (const step of release.jobs.pack.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/u);
});

test('tag build tests and checksums its one archive set before attesting and publishing it', () => {
  const { steps } = releaseWorkflow().jobs.pack;
  const index = command => steps.findIndex(step => step.run?.includes(command));
  const build = index('release/pack.mjs pack'), verify = index('release/pack.mjs verify');
  const consumer = index('release/consumer.mjs'), sums = index("writeFileSync('SHA256SUMS'");
  const attest = steps.findIndex(step => step.uses?.includes('attest-build-provenance'));
  const publish = index('gh release create');
  assert.ok(index('npm ci --ignore-scripts') < build);
  assert.ok(build >= 0 && build < verify && verify < consumer && consumer < sums && sums < attest && attest < publish);
  assert.equal(steps[consumer].run, 'node release/consumer.mjs dist/release');
  assert.equal(steps[sums]['working-directory'], 'dist/release');
  assert.equal(steps.filter(step => step.run?.includes('release/pack.mjs pack')).length, 1);
  for (const step of steps.slice(build, publish + 1)) {
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.if, undefined);
    assert.doesNotMatch(step.run ?? '', /\|\|\s*true|npm pack/u);
  }
  assert.deepEqual(steps[publish].env, { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
  assert.match(steps[publish].run, /--verify-tag/u);
  assert.match(steps[publish].run, /--notes-file release\/notes\.md/u);
  for (const path of ['*.tgz', 'SHA256SUMS', 'release-set.json', 'consumer-evidence.json', 'consumer-package-lock.json', 'deployment-pin.json']) {
    assert.ok(steps[publish].run.includes('dist/release/' + path));
  }
  assert.doesNotMatch(steps[publish].run, /--clobber|--target|--generate-notes/u);
  assert.match(steps[publish].run, /--json isImmutable/u);
});

function checksumFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'aithema-workflow-sums-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const artifacts = ['workspace.tgz', 'module.tgz'].map((path, i) => {
    writeFileSync(join(cwd, path), path);
    return { kind: i ? 'module' : 'workspace', ...(i ? { name: '@inspr/example' } : {}), path, sha256: 'sha256:' + hash(path) };
  });
  const manifest = { source: { commit: 'a'.repeat(40) }, artifacts };
  const manifestBytes = JSON.stringify(manifest); writeFileSync(join(cwd, 'release-set.json'), manifestBytes);
  const consumer = { source_commit: manifest.source.commit, manifest_sha256: 'sha256:' + hash(manifestBytes),
    packages: artifacts.filter(a => a.kind === 'module').map(({ name, path, sha256 }) => ({ name, path, sha256 })) };
  writeFileSync(join(cwd, 'consumer-evidence.json'), JSON.stringify(consumer));
  for (const path of ['consumer-package-lock.json', 'deployment-pin.json']) writeFileSync(join(cwd, path), '{}');
  const step = releaseWorkflow().jobs.pack.steps.find(s => s.run?.includes("writeFileSync('SHA256SUMS'"));
  const run = () => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd, stdio: 'pipe' });
  return { cwd, hash, run, consumer };
}

test('workflow checksum command binds every manifest archive and retained evidence to its actual bytes', t => {
  const { cwd, hash, run } = checksumFixture(t); run();
  const lines = readFileSync(join(cwd, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  for (const line of lines) {
    const [digest, path] = line.split('  ');
    assert.equal(digest, hash(readFileSync(join(cwd, path))));
  }
  assert.throws(run, 'an existing checksum set cannot be overwritten');
});

for (const mutation of ['archive', 'extra archive', 'manifest binding', 'consumer package binding']) {
  test(`workflow checksum command rejects mismatched ${mutation} before publication`, t => {
    const { cwd, run, consumer } = checksumFixture(t);
    if (mutation === 'archive') writeFileSync(join(cwd, 'module.tgz'), 'tampered');
    else if (mutation === 'extra archive') writeFileSync(join(cwd, 'extra.tgz'), 'unexpected');
    else {
      if (mutation === 'manifest binding') consumer.manifest_sha256 = 'sha256:' + '0'.repeat(64);
      else consumer.packages[0].sha256 = 'sha256:' + '0'.repeat(64);
      writeFileSync(join(cwd, 'consumer-evidence.json'), JSON.stringify(consumer));
    }
    assert.throws(run);
  });
}

test('release command stages assets in a draft and removes releases whose immutability cannot be verified', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'aithema-workflow-publish-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin')); mkdirSync(join(cwd, 'dist/release'), { recursive: true });
  for (const name of ['a.tgz', 'b.tgz']) writeFileSync(join(cwd, 'dist/release', name), name);
  writeFileSync(join(cwd, 'bin/gh'), `#!${process.execPath}
import('node:fs').then(fs => {
  fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
  if (process.argv[3] === process.env.TEST_FAIL_COMMAND) {
    console.error('simulated gh failure');
    process.exitCode = 1;
  } else if (process.argv[3] === 'view') {
    if (process.env.TEST_IMMUTABLE === 'unsupported') {
      console.error('Unknown JSON field: isImmutable');
      process.exitCode = 1;
    } else if (process.env.TEST_IMMUTABLE === 'failed') {
      console.log('true');
      process.exitCode = 1;
    } else console.log(process.env.TEST_IMMUTABLE);
  }
});\n`, { mode: 0o755 });
  // Admission is covered against real Git/API fixtures in release-candidate-gate.
  // Keep this fixture focused on the existing publication/cleanup assertions.
  writeFileSync(join(cwd, 'bin/node'), '#!/bin/sh\n[ "$1" = release/gate.mjs ] && [ "$2" = candidate ]\n', { mode: 0o755 });
  const step = releaseWorkflow().jobs.pack.steps.find(s => s.run?.includes('gh release create'));
  const env = { ...process.env, PATH: join(cwd, 'bin') + ':' + process.env.PATH,
    GH_TOKEN: 'test-placeholder', GITHUB_REF_NAME: 'v261015164601.0.0', GITHUB_REPOSITORY: 'inspr-at/aithema' };
  const run = (immutable, failCommand = '') => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run],
    { cwd, env: { ...env, TEST_IMMUTABLE: immutable, TEST_FAIL_COMMAND: failCommand }, stdio: 'pipe' });
  const calls = () => readFileSync(join(cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  run('true');
  const [create, edit, view] = calls();
  assert.deepEqual(create, ['release', 'create', env.GITHUB_REF_NAME, '--repo', env.GITHUB_REPOSITORY, '--verify-tag', '--draft',
    '--title', env.GITHUB_REF_NAME, '--notes-file', 'release/notes.md', 'dist/release/a.tgz', 'dist/release/b.tgz',
    'dist/release/SHA256SUMS', 'dist/release/release-set.json', 'dist/release/consumer-evidence.json',
    'dist/release/consumer-package-lock.json', 'dist/release/deployment-pin.json']);
  assert.deepEqual(edit, ['release', 'edit', env.GITHUB_REF_NAME, '--repo', env.GITHUB_REPOSITORY, '--draft=false']);
  assert.deepEqual(view, ['release', 'view', env.GITHUB_REF_NAME, '--repo', env.GITHUB_REPOSITORY,
    '--json', 'isImmutable', '--jq', '.isImmutable']);
  assert.equal(calls().length, 3, 'an immutable release must not be deleted');
  for (const immutable of ['false', 'null', '', 'unsupported', 'failed']) {
    writeFileSync(join(cwd, 'calls.jsonl'), '');
    assert.throws(() => run(immutable), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /release immutability not enabled — release removed, enable it and re-run/u);
      return true;
    });
    assert.deepEqual(calls(), [create, edit, view,
      ['release', 'delete', env.GITHUB_REF_NAME, '--repo', env.GITHUB_REPOSITORY, '--yes']],
    `${immutable || 'empty'} status must remove the release after publishing and checking it`);
  }
  const remove = ['release', 'delete', env.GITHUB_REF_NAME, '--repo', env.GITHUB_REPOSITORY, '--yes'];
  for (const command of ['edit', 'delete']) {
    writeFileSync(join(cwd, 'calls.jsonl'), '');
    assert.throws(() => run('false', command), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /attempting release deletion \(tag retained\)/u);
      assert.match(error.stderr.toString(), command === 'delete' ? /manual deletion required immediately/u : /release removed/u);
      return true;
    });
    assert.deepEqual(calls(), command === 'edit' ? [create, edit, remove] : [create, edit, view, remove, remove]);
  }
});

test('release refuses a tag whose commit is outside main before packing', () => {
  const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const steps = release.jobs.pack.steps;
  const guard = steps.findIndex(step => step.run?.includes('merge-base --is-ancestor'));
  assert.ok(guard >= 0, 'release must check ancestry');
  assert.match(steps[guard].run, /git fetch origin main/u);
  assert.match(steps[guard].run, /git merge-base --is-ancestor HEAD origin\/main/u);
  assert.ok(guard < steps.findIndex(step => step.run?.includes('release/pack.mjs pack')));
});
