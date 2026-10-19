import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gateModule from '../release/gate.mjs';
import { normalizedDigest } from '../release/normalize.mjs';
import { releaseSet, version, digest, json } from './fixtures/release-set.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aithema-candidate-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'release/version.json'), json(version));
  writeFileSync(join(root, 'release/history.json'), json({ releases: [] }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'tag.gpgsign', 'false']);
  git(['add', 'release']); git(['commit', '-qm', 'candidate', '--signoff']);
  const commit = git(['rev-parse', 'HEAD']), ref = `refs/tags/v${version.version}`;
  git(['tag', `v${version.version}`, commit]);
  git(['init', '--bare', '-q', '.remote.git']);
  git(['remote', 'add', 'origin', join(root, '.remote.git')]);
  git(['push', '-q', 'origin', 'HEAD:refs/heads/main', `refs/tags/v${version.version}`]);
  const candidate = releaseSet(t, { commit });
  const release = releaseSet(t, { commit, mode: 'release', run: 'publication' });
  const marker = { version: version.version, release_sequence: version.release_sequence, source_commit: commit,
    manifest_sha256: digest(readFileSync(join(candidate.directory, 'release-set.json'))), normalized_digest: normalizedDigest(candidate.directory) };
  const tag = (body = marker, target = commit, coordinate = version.version, annotated = true) =>
    git(annotated ? ['tag', '-a', `candidate/v${coordinate}`, target, '-m', JSON.stringify(body)] : ['tag', `candidate/v${coordinate}`, target]);
  writeFileSync(join(root, 'published.json'), '[[]]');
  writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('gh-calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] !== 'api' || !process.argv.includes('--paginate') || !process.argv.includes('--slurp')) process.exit(91);
process.stdout.write(fs.readFileSync('published.json', 'utf8'));
`, { mode: 0o755 });
  // Explicit minimal child environment: no ambient credentials or network.
  const env = { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, GITHUB_REPOSITORY: 'fixture/repo', GH_TOKEN: 'fixture-only' };
  const gate = fileURLToPath(new URL('../release/gate.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [gate, 'candidate', ref, release.directory], { cwd: root, env, encoding: 'utf8' });
  const pages = entries => writeFileSync(join(root, 'published.json'), JSON.stringify(entries));
  const published = entries => pages([entries]);
  return { root, git, commit, marker, tag, run, published, pages };
}
function refused(result, reason) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, reason);
}

test('candidate gate admits the active annotated marker and uses only paginated read-only release API', t => {
  const f = fixture(t); f.tag();
  f.published([{ tag_name: 'v999999999999.0.0', draft: true }]);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(f.root, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['api', '--paginate', '--slurp', 'repos/fixture/repo/releases?per_page=100']);
});
for (const [name, setup, reason] of [
  ['no marker', () => {}, /candidate.*marker|marker.*missing/iu],
  ['lightweight marker', f => f.tag(f.marker, f.commit, version.version, false), /annotated/iu],
  ['wrong commit', f => { f.git(['commit', '--allow-empty', '-qm', 'other', '--signoff']); const other = f.git(['rev-parse', 'HEAD']); f.tag({ ...f.marker, source_commit: other }, other); }, /commit/iu],
  ['superseded marker', f => { f.tag(); const next = '261019120001.0.0'; f.tag({ ...f.marker, version: next }, f.commit, next); }, /superseded|active/iu],
  ['published equal sequence', f => { f.tag(); f.published([{ tag_name: `v${version.version}`, draft: false }]); }, /published.*sequence/iu],
  ['published later sequence', f => {
    f.tag(); const next = { ...version, version: '261019120001.0.0', release_sequence: version.release_sequence + 1 };
    writeFileSync(join(f.root, 'release/version.json'), json(next));
    f.git(['add', 'release/version.json']); f.git(['commit', '-qm', 'later release', '--signoff']);
    f.git(['tag', `v${next.version}`]); f.published([{ tag_name: `v${next.version}`, draft: false }]);
    f.git(['checkout', '--detach', f.commit]);
  }, /published.*sequence/iu],
  ['failed-terminal rerun', f => { f.tag(); f.git(['tag', '-a', `release-failed/v${version.version}`, '-m', 'terminal failure']); }, /failed|terminal/iu],
  ['digest mismatch', f => f.tag({ ...f.marker, normalized_digest: digest('other') }), /normalized.*digest/iu],
  ['missing manifest digest', f => { const m = { ...f.marker }; delete m.manifest_sha256; f.tag(m); }, /marker|manifest/iu],
  ['invalid manifest digest', f => f.tag({ ...f.marker, manifest_sha256: 'invalid' }), /marker|manifest/iu],
  ['marker sequence mismatch', f => f.tag({ ...f.marker, release_sequence: 18 }), /marker|sequence/iu],
]) test(`candidate gate refuses ${name}`, t => {
  const f = fixture(t); setup(f); refused(f.run(), reason);
  if (['failed-terminal rerun', 'superseded marker'].includes(name)) refused(f.run(), reason);
});

test('an older published sequence permits retry while an older candidate of N stays superseded', t => {
  const f = fixture(t); f.tag();
  const old = '261019115959.0.0';
  f.tag({ ...f.marker, version: old }, f.commit, old);
  const oldVersion = { ...version, version: old, release_sequence: version.release_sequence - 1 };
  writeFileSync(join(f.root, 'release/version.json'), json(oldVersion));
  f.git(['add', 'release/version.json']); f.git(['commit', '-qm', 'older published', '--signoff']);
  f.git(['tag', `v${old}`]); f.published([{ tag_name: `v${old}`, draft: false }]);
  f.git(['checkout', '--detach', f.commit]);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
});

test('published releases on later API pages also close admission', t => {
  const f = fixture(t); f.tag();
  f.pages([[], [{ tag_name: `v${version.version}`, draft: false }]]);
  refused(f.run(), /published.*sequence/iu);
});
test('explicit legacy ledger binds published sequences to their original tag commit', t => {
  const f = fixture(t); f.tag();
  f.git(['tag', 'v0.10.1', f.commit]);
  const legacy = { version_scheme: 'legacy', version: '0.10.1', release_sequence: 11,
    release_channel: 'stable', tag: 'v0.10.1', source_commit: f.commit };
  writeFileSync(join(f.root, 'release/history.json'), json({ releases: [legacy] }));
  f.published([{ tag_name: 'v0.10.1', draft: false }]);
  const allowed = f.run(); assert.equal(allowed.status, 0, allowed.stderr);
  writeFileSync(join(f.root, 'release/history.json'), json({ releases: [{ ...legacy, source_commit: 'b'.repeat(40) }] }));
  refused(f.run(), /published.*binding/iu);
});

test('unreadable or unbound published release metadata fails closed', t => {
  const f = fixture(t); f.tag();
  for (const pages of [{ unexpected: true }, [[{ tag_name: 'vunknown', draft: false }]],
    [[{ tag_name: 'v261019120002.0.0', draft: false }]]]) {
    f.pages(pages);
    assert.notEqual(f.run().status, 0);
  }
});

test('exported marker parser validates the exact annotated object before a helper pushes it', t => {
  const f = fixture(t); f.tag();
  const name = `candidate/v${version.version}`;
  assert.equal(typeof gateModule.parseCandidateMarker, 'function');
  const object = f.git(['cat-file', '-p', `refs/tags/${name}`]);
  assert.deepEqual(gateModule.parseCandidateMarker(name, object), f.marker);
  assert.throws(() => gateModule.parseCandidateMarker(name, object.replace(f.marker.manifest_sha256, 'invalid')), /marker/iu);
  assert.throws(() => gateModule.parseCandidateMarker(name, object.replace(f.commit, 'b'.repeat(40))), /marker/iu);
});

test('a malformed marker of another sequence warns without blocking the candidate', t => {
  const f = fixture(t); f.tag();
  const other = '261019120001.0.0';
  f.tag({ ...f.marker, version: other, release_sequence: version.release_sequence - 1, manifest_sha256: 'invalid' }, f.commit, other);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning.*candidate\/v261019120001.*sequence/iu);
});

test('a malformed marker claiming the candidate sequence still refuses', t => {
  const f = fixture(t); f.tag();
  const other = '261019115959.0.0';
  f.tag({ ...f.marker, version: other, manifest_sha256: 'invalid' }, f.commit, other);
  refused(f.run(), /marker/iu);
});

test('the candidate own malformed marker refuses even if it claims another sequence', t => {
  const f = fixture(t);
  f.tag({ ...f.marker, release_sequence: version.release_sequence - 1, normalized_digest: 'invalid' });
  refused(f.run(), /marker/iu);
});

for (const kind of ['candidate', 'release-failed', 'v']) test(`gate refreshes remote-only ${kind} tags before admission`, t => {
  const f = fixture(t); f.tag();
  let name;
  if (kind === 'candidate') {
    const later = '261019120001.0.0';
    name = `candidate/v${later}`;
    f.tag({ ...f.marker, version: later }, f.commit, later);
  } else if (kind === 'release-failed') {
    name = `release-failed/v${version.version}`;
    f.git(['tag', '-a', name, '-m', 'failed-terminal after checkout']);
  } else {
    name = 'v261019120001.0.0';
    const next = { ...version, version: name.slice(1), release_sequence: version.release_sequence + 1 };
    writeFileSync(join(f.root, 'release/version.json'), json(next));
    f.git(['add', 'release/version.json']); f.git(['commit', '-qm', 'published after checkout', '--signoff']);
    f.git(['tag', name]);
    f.published([{ tag_name: name, draft: false }]);
    f.git(['checkout', '--detach', f.commit]);
  }
  f.git(['push', '-q', 'origin', `refs/tags/${name}`]);
  f.git(['tag', '-d', name]);
  const result = f.run();
  refused(result, kind === 'candidate' ? /superseded/iu : kind === 'release-failed' ? /failed-terminal/iu : /published release sequence/iu);
  assert.equal(f.git(['rev-parse', '--verify', `refs/tags/${name}`]).length, 40, 'remote tag must be refreshed into the checkout');
});

test('tag refresh failure closes admission before reading releases', t => {
  const f = fixture(t); f.tag();
  f.git(['remote', 'set-url', 'origin', join(f.root, 'missing-remote')]);
  refused(f.run(), /fetch|remote|repository/iu);
  assert.throws(() => readFileSync(join(f.root, 'gh-calls.jsonl')));
});
