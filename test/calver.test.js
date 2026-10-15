import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseVersion, compareVersions, reserveVersion, migrationGate, assertReleaseTag } from '../release/lib/version.mjs';
const declared = JSON.parse(readFileSync(new URL('../release/version.json', import.meta.url)));
const source = { ...declared, status: 'unreserved', version: '0.0.0', version_scheme: 'legacy', release_sequence: null,
  migration: { ...declared.migration, first_calendar_version: null } };
const record = (version, version_scheme = 'inspr-calver-3', release_sequence = 12) => ({ version, version_scheme, release_sequence, release_channel: 'stable' });
test('CalVer3 validates full UTC dates and SemVer-clean coordinates without truncating integers', () => {
  for (const value of ['100101000000.0.0', '260909113550.0.0', '280229120000.0.0', '991231235959.0.0']) {
    assert.equal(parseVersion(record(value)).version, value);
  }
  for (const value of ['26.09.09', '26.09.09.11.35.50', '5.21.0', '20260909113550.0.0', '2609091135.0.0', '260909113550',
    '260909113550.0.1', '260909113550.1.0', '260909113550.0.0-rc1', '260909113550.0.0+sha', '260909240000.0.0',
    '260909116000.0.0', '260229120000.0.0', '260431120000.0.0', '090909113550.0.0', ' 260909113550.0.0', '260909113550.0.0\n']) {
    assert.throws(() => parseVersion(record(value)), /version|coordinate|date/i, value);
  }
  for (const scheme of [undefined, '', 'calendar', 'semver']) assert.throws(() => parseVersion(record('260909113550.0.0', scheme === undefined ? null : scheme)));
});
test('ordering validates first, accepts historical CalVer2 and v1, and anchors mixed eras explicitly', () => {
  assert.equal(compareVersions(record('260909113550.0.0', 'inspr-calendar-v2'), record('260909113551.0.0')), -1);
  assert.equal(compareVersions(record('26.09.09', 'inspr-calendar-v1'), record('26.09.09.00.00.01', 'inspr-calendar-v1')), -1);
  assert.throws(() => compareVersions(record('0.10.1', 'legacy', 11), record('260909113550.0.0')), /anchor/i);
  const anchor = { last_legacy_scheme: 'legacy', last_legacy_version: '0.10.1', last_legacy_sequence: 11,
    first_calendar_version: '260909113550.0.0', first_calendar_sequence: 12 };
  assert.equal(compareVersions(record('0.10.1', 'legacy', 11), record('260909113550.0.0'), anchor), -1);
  assert.throws(() => compareVersions(record('0.10.1', 'legacy', 12), record('260909113550.0.0'), anchor));
  assert.throws(() => compareVersions(record('260229120000.0.0'), record('260909113550.0.0')));
});
test('reservation is pure, owner-triggered, single-use and refuses a same-second collision', () => {
  const original = JSON.stringify(source);
  for (const now of ['2009-12-31T23:59:59Z', '2100-01-01T00:00:00Z', 'invalid']) assert.throws(() => reserveVersion(source, { now, publishGo: true }), /UTC reservation/i);
  assert.throws(() => reserveVersion(source, { now: '2026-10-14T08:00:00Z' }), /publish go/i);
  const reserved = reserveVersion(source, { now: '2026-10-14T08:00:00Z', publishGo: true });
  assert.equal(reserved.version, '261014080000.0.0'); assert.equal(reserved.version_scheme, 'inspr-calver-3');
  assert.equal(reserved.release_sequence, 12); assert.equal(reserved.migration.first_calendar_version, reserved.version);
  assert.equal(JSON.stringify(source), original);
  assert.throws(() => reserveVersion(reserved, { now: '2026-10-14T08:00:01Z', publishGo: true }), /reserved/i);
  assert.throws(() => reserveVersion(source, { now: '2026-10-14T08:00:00Z', publishGo: true, previous: reserved }), /next second|later/i);
  assertReleaseTag('refs/tags/v261014080000.0.0', reserved);
  for (const tag of ['refs/heads/main', 'refs/tags/v261014080001.0.0', 'refs/tags/v0.10.1']) assert.throws(() => assertReleaseTag(tag, reserved));
});
test('migration gate keeps current legacy metadata and live evidence pending before publication', () => {
  assert.equal(source.status, 'unreserved'); assert.equal(source.version, '0.0.0'); assert.equal(source.version_scheme, 'legacy');
  const gate = migrationGate(source, {}); assert.equal(gate.authoritative, false);
  assert.ok(gate.pending.includes('immutable-candidate'));
  const reserved = reserveVersion(source, { now: '2026-10-14T08:00:00Z', publishGo: true });
  assert.equal(migrationGate(reserved, { 'AIT-139': { status: 'merged' }, 'AIT-160': { status: 'merged' } }).authoritative, false);
});

test('owner candidate authorization reserves without claiming publication or measured qualifications', () => {
  const candidate = reserveVersion(source, { now: '2026-10-15T16:46:01Z', candidateGo: true });
  assert.equal(candidate.version, declared.version);
  const gate = migrationGate(candidate, {});
  assert.equal(gate.authoritative, false);
  assert.ok(gate.pending.includes('presentation-pin'));
  assert.ok(!gate.pending.includes('AIT-139')); assert.ok(!gate.pending.includes('AIT-160'));
  assert.deepEqual(gate.qualifications, {
    'AIT-139': 'not measured (Markus decision)', 'AIT-160': 'not measured (Markus decision)',
  });
  const claimed = migrationGate(candidate, { 'AIT-139': { status: 'verified' }, 'AIT-160': { status: 'verified' } });
  assert.deepEqual(claimed.qualifications, gate.qualifications);
});

test('historical release-manifest scheme declarations remain explicit, unchanged legacy records', () => {
  for (const scheme of ['legacy-semver-public', 'legacy-semver-private']) {
    const parsed = parseVersion(record('0.10.1', scheme, 11));
    assert.equal(parsed.version_scheme, scheme); assert.equal(parsed.version, '0.10.1');
    const anchor = { last_legacy_scheme: 'legacy', last_legacy_version: '0.10.1', last_legacy_sequence: 11,
      first_calendar_version: '261014080000.0.0', first_calendar_sequence: 12 };
    assert.equal(compareVersions(parsed, record('261014080000.0.0'), anchor), -1);
  }
});

test('candidate version gate admits the existing reservation and exact mirrored coordinate without reserving', () => {
  const root = new URL('../', import.meta.url);
  assert.equal(declared.status, 'reserved');
  assert.equal(declared.version_scheme, 'inspr-calver-3');
  const original = readFileSync(new URL('release/version.json', root), 'utf8');
  execFileSync(process.execPath, [new URL('release/gate.mjs', root).pathname,
    'tag', `refs/tags/v${declared.version}`], { stdio: 'pipe' });
  const history = JSON.parse(readFileSync(new URL('release/history.json', root)));
  const previous = history.releases.at(-1);
  assert.equal(declared.release_sequence, previous.release_sequence + 1);
  assert.equal(compareVersions(previous, declared, declared.migration), -1);
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
  assert.equal(readFileSync(new URL('release/version.json', root), 'utf8'), original);
});
