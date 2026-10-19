import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reserveVersion } from '../release/lib/version.mjs';
import { version, json } from './fixtures/release-set.js';

test('surgical merge M repairs all mirrors and new internal pins while C prime stays untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'aithema-surgical-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), json(value)); };
  const read = path => JSON.parse(readFileSync(join(root, path)));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = message => { git(['add', '.']); git(['commit', '--signoff', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  const initial = { ...version, release_sequence: 19 };
  write('release/version.json', initial);
  write('package.json', { name: 'workspace', version: initial.version });
  write('packages/existing/package.json', { name: '@fixture/existing', version: initial.version });
  write('package-lock.json', { version: initial.version, packages: { '': { name: 'workspace', version: initial.version },
    'packages/existing': { name: '@fixture/existing', version: initial.version } } });
  const C = commit('candidate C');
  git(['checkout', '-qb', 'surgical']);
  const next = reserveVersion({ ...initial, status: 'unreserved' }, { now: '2026-10-19T12:00:01Z', candidateGo: true,
    previous: { ...initial, version: '261019115959.0.0', release_sequence: 18 } });
  assert.equal(next.release_sequence, initial.release_sequence, 're-cut keeps the unpublished sequence');
  write('release/version.json', next);
  for (const path of ['package.json', 'packages/existing/package.json']) write(path, { ...read(path), version: next.version });
  const surgicalLock = read('package-lock.json'); surgicalLock.version = next.version;
  for (const entry of Object.values(surgicalLock.packages)) entry.version = next.version;
  write('package-lock.json', surgicalLock); write('packages/existing/src/fix.json', { fixed: true });
  const Cprime = commit('fixed candidate C prime');
  const candidateTree = git(['rev-parse', `${Cprime}^{tree}`]);
  git(['checkout', 'main']);
  // Work on main introduces a new package AND new edges on an old package.
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const existing = read('packages/existing/package.json');
  for (const field of fields) existing[field] = { '@fixture/added': initial.version, external: '^1.2.3' };
  write('packages/existing/package.json', existing);
  write('plugins/added/package.json', { name: '@fixture/added', version: initial.version, dependencies: { '@fixture/existing': initial.version } });
  const mainLock = read('package-lock.json');
  Object.assign(mainLock.packages['packages/existing'], existing);
  mainLock.packages['plugins/added'] = read('plugins/added/package.json');
  write('package-lock.json', mainLock); const main = commit('main adds package and internal edges');
  git(['checkout', '-qb', 'integration', Cprime]);
  // A real merge may conflict in mirrors. Resolve them on M, never on C prime.
  const merge = (() => { try { git(['merge', '--no-ff', '--no-commit', main]); return true; } catch { return false; } })();
  assert.equal(typeof merge, 'boolean');
  const paths = ['package.json', ...['packages', 'plugins'].flatMap(folder => readdirSync(join(root, folder)).map(name => `${folder}/${name}/package.json`))];
  // Take main's manifests (including the new edges) then repair all mirrors.
  for (const path of [...paths, 'package-lock.json']) write(path, JSON.parse(git(['show', `${main}:${path}`])));
  const names = new Set(paths.map(path => read(path).name));
  const repair = pkg => {
    pkg.version = next.version;
    for (const field of fields) for (const name of Object.keys(pkg[field] ?? {})) if (names.has(name)) pkg[field][name] = next.version;
    return pkg;
  };
  for (const path of paths) write(path, repair(read(path)));
  const lock = read('package-lock.json'); lock.version = next.version;
  for (const path of paths) {
    const key = path === 'package.json' ? '' : path.slice(0, -'/package.json'.length);
    repair(lock.packages[key]);
  }
  write('package-lock.json', lock); write('release/version.json', next);
  const M = commit('merge main and repair every version mirror and internal pin');
  assert.deepEqual(git(['rev-list', '--parents', '-n1', M]).split(' ').slice(1), [Cprime, main]);
  assert.equal(git(['rev-parse', `${Cprime}^{tree}`]), candidateTree);
  assert.equal(git(['merge-base', Cprime, main]), C);
  assert.throws(() => git(['cat-file', '-e', `${Cprime}:plugins/added/package.json`]), 'main-only package must not enter C prime');
  assert.equal(read('release/version.json').version, next.version);
  assert.equal(read('package-lock.json').version, next.version);
  for (const path of paths) {
    const pkg = read(path), key = path === 'package.json' ? '' : path.slice(0, -'/package.json'.length);
    for (const mirror of [pkg, read('package-lock.json').packages[key]]) {
      assert.equal(mirror.version, next.version, path);
      for (const field of fields) for (const [name, pin] of Object.entries(mirror[field] ?? {})) {
        assert.equal(pin, names.has(name) ? next.version : '^1.2.3', `${path} ${field} ${name}`);
      }
    }
  }
});
