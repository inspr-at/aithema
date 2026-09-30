import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { trashTemp } from './fixtures/packaging-support.mjs';

const script = fileURLToPath(new URL('../scripts/needs-release-proof.mjs', import.meta.url));

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(repo, path, content = 'fixture\n') {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo) {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Markus Barta', '-c', 'user.email=markus@barta.com', 'commit', '-qm', 'test fixture']);
}

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'aithema-release-trigger-'));
  t.after(() => trashTemp(repo));
  git(repo, ['init', '-q']);
  write(repo, 'notes.txt');
  write(repo, 'package.json', '{"private":true}\n');
  commit(repo);
  git(repo, ['tag', 'base']);
  return repo;
}

function check(repo, expected, ref = 'base') {
  const result = spawnSync(process.execPath, [script, ref], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `release-proof: ${expected}\n`);
  assert.equal(result.stderr, '');
}

describe('AIT-83 release proof trigger', () => {
  it('does not require proof for an unchanged tree or ordinary code and docs', (t) => {
    const repo = fixture(t);
    check(repo, 'not-required');
    write(repo, 'lib/example.js');
    commit(repo);
    write(repo, 'notes.txt', 'dirty docs\n');
    write(repo, 'test/ordinary.test.js');
    git(repo, ['add', 'test/ordinary.test.js']);
    write(repo, 'runtime/untracked.js');
    check(repo, 'not-required');
  });

  for (const path of [
    'release/build-release.mjs',
    'release/build-source.mjs',
    'release/lib/digest.mjs',
    'release/allowlist.json',
    'release/source-allowlist.json',
    'package.json',
    'package-lock.json',
    'bin/aithema-workspace.js',
    'scripts/export-source.mjs',
    'scripts/packaging.mjs',
    'test/packaging.test.js',
    'test/source-export.test.js',
    'test/fixtures/packaging-support.mjs',
    'test/fixtures/publish-race-child.mjs',
  ]) {
    it(`requires proof for committed changes to ${path}`, (t) => {
      const repo = fixture(t);
      write(repo, path, path === 'package.json' ? '{"private":false}\n' : 'fixture\n');
      commit(repo);
      check(repo, 'required');
    });
  }

  it('includes staged and unstaged changes even when their combined diff cancels', (t) => {
    const repo = fixture(t);
    write(repo, 'package.json', '{"private":false}\n');
    check(repo, 'required');
    git(repo, ['add', 'package.json']);
    check(repo, 'required');
    write(repo, 'package.json', '{"private":true}\n');
    assert.equal(git(repo, ['diff', 'HEAD', '--', 'package.json']), '');
    check(repo, 'required');
  });

  it('includes untracked release files, including names with newlines', (t) => {
    const repo = fixture(t);
    write(repo, 'release/new\nexport.mjs');
    check(repo, 'required');
  });

  it('requires proof when a release path is renamed away', (t) => {
    const repo = fixture(t);
    git(repo, ['mv', 'package.json', 'notes-package.txt']);
    check(repo, 'required');
    commit(repo);
    check(repo, 'required');
    check(repo, 'not-required', 'HEAD');
  });

  it('requires proof for staged and committed deletion of a release path', (t) => {
    const repo = fixture(t);
    trashTemp(join(repo, 'package.json'));
    git(repo, ['add', '-A']);
    check(repo, 'required');
    commit(repo);
    check(repo, 'required');
  });

  it('uses the merge base and ignores changes made only on the base branch', (t) => {
    const repo = fixture(t);
    git(repo, ['checkout', '-qb', 'upstream']);
    write(repo, 'package.json', '{"upstream":true}\n');
    commit(repo);
    git(repo, ['checkout', '-qb', 'worker', 'base']);
    write(repo, 'lib/worker.js');
    commit(repo);
    check(repo, 'not-required', 'upstream');
    write(repo, 'release/worker.mjs');
    commit(repo);
    check(repo, 'required', 'upstream');
  });

  it('exits 2 without a decision for missing, option-like, and non-commit refs', (t) => {
    const repo = fixture(t);
    const blob = git(repo, ['rev-parse', 'HEAD:package.json']);
    for (const args of [[], ['missing-ref'], ['--help'], [blob], ['base', 'extra']]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 2, `${args}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /unable to compare base ref/);
    }
  });
});
