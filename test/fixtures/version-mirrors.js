import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export function assertVersionMirrors(root, declared) {
  const paths = ['package.json', ...['packages', 'plugins'].flatMap(directory =>
    readdirSync(new URL(directory + '/', root)).map(name => `${directory}/${name}/package.json`)
      .filter(path => existsSync(new URL(path, root))))];
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)));
  const packages = paths.map(path => [path, JSON.parse(readFileSync(new URL(path, root)))]);
  const names = new Set(packages.map(([, pkg]) => pkg.name));
  assert.equal(lock.version, declared.version);
  for (const [path, pkg] of packages) {
    assert.equal(pkg.version, declared.version, path);
    const key = path === 'package.json' ? '' : path.slice(0, -'/package.json'.length);
    assert.equal(lock.packages[key].version, declared.version, `lock ${key}`);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        if (names.has(name)) assert.equal(version, declared.version, `${path} ${name}`);
      }
    }
  }
}
