import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedDigest } from '../release/normalize.mjs';
import { releaseSet, json } from './fixtures/release-set.js';

function refusesChange(expected, directory) {
  let actual;
  try { actual = normalizedDigest(directory); } catch { return; }
  assert.notEqual(actual, expected, 'an unapproved difference must not normalize away');
}

test('normalization allows exactly candidate/release mode, run, derived inventory and archive digests', t => {
  const candidate = releaseSet(t), release = releaseSet(t, { mode: 'release', run: 'release-run' });
  const expected = normalizedDigest(candidate.directory);
  assert.match(expected, /^sha256:[a-f0-9]{64}$/u);
  assert.notDeepEqual(candidate.manifest, release.manifest);
  assert.equal(normalizedDigest(release.directory), expected);
});

for (const [label, mutateFiles] of [
  ['ordinary byte', files => files.set('README.md', Buffer.from('Different\n'))],
  ['ordinary JSON mode', files => files.set('release/ordinary.json', json({ mode: 'release', packing: { run: 'fixed' }, runtime_tree_digest: 'fixed' }))],
  ...['date', 'extra', 'missing', 'nested mode', 'source leaf'].map(label => [`runtime ${label}`, files => {
    const runtime = JSON.parse(files.get('release/runtime.json'));
    if (label === 'date') runtime.date = '2026-10-19T12:00:01.000Z';
    if (label === 'extra') runtime.extra = true;
    if (label === 'missing') delete runtime.date;
    if (label === 'nested mode') runtime.source.mode = 'release';
    if (label === 'source leaf') runtime.source.extra = true;
    for (const path of ['release/runtime.json', 'packages/server/src/release-runtime.json']) files.set(path, json(runtime));
  }]),
]) test(`normalization retains ${label}`, t => {
  const expected = normalizedDigest(releaseSet(t).directory);
  refusesChange(expected, releaseSet(t, { mode: 'release', mutateFiles }).directory);
});

for (const [label, mutateManifest] of [
  ['new top-level key', m => { m.extra = true; }], ['missing key', m => { delete m.validation; }],
  ['packing key', m => { m.packing.extra = true; }], ['missing run', m => { delete m.packing.run; }],
  ['missing mode', m => { delete m.mode; }], ['missing artifact digest', m => { delete m.artifacts[0].sha256; }],
  ['file extra key', m => { m.files.find(f => f.path === 'release/runtime.json').extra = true; }],
  ['file missing size', m => { delete m.files.find(f => f.path === 'release/runtime.json').size; }],
  ['module extra key', m => { m.artifacts[1].files.find(f => f.path === 'release-runtime.json').extra = true; }],
  ['unrelated file size', m => { m.files.find(f => f.path === 'README.md').size++; }],
  ['artifact extra key', m => { m.artifacts[0].extra = true; }],
  ['validation leaf', m => { m.validation.policy = 'other'; }],
  ['source leaf', m => { m.source.extra = true; }],
]) test(`normalization does not discard ${label}`, t => {
  const expected = normalizedDigest(releaseSet(t).directory);
  refusesChange(expected, releaseSet(t, { mode: 'release', mutateManifest }).directory);
});

test('normalization recomputes provenance rather than trusting an omitted tree digest', t => {
  assert.throws(() => normalizedDigest(releaseSet(t, { mode: 'release', badProvenance: true }).directory), /provenance|tree/iu);
});

test('normalization checks every runtime copy and refuses a module-only change', t => {
  assert.throws(() => normalizedDigest(releaseSet(t, { mode: 'release', mutateModule(members) {
    const runtime = JSON.parse(members.get('release-runtime.json')); runtime.extra = true;
    members.set('release-runtime.json', json(runtime));
  } }).directory), /binding|runtime/iu);
});

for (const mode of [undefined, 'dry-run', 'anything']) test(`runtime mode ${mode} cannot disappear unchecked`, t => {
  assert.throws(() => normalizedDigest(releaseSet(t, { mutateFiles(files) {
    const runtime = JSON.parse(files.get('release/runtime.json'));
    if (mode === undefined) delete runtime.mode; else runtime.mode = mode;
    for (const path of ['release/runtime.json', 'packages/server/src/release-runtime.json']) files.set(path, json(runtime));
  } }).directory));
});

for (const [label, mutateProvenance] of [
  ['added key', p => { p.extra = true; }],
  ['missing key', p => { delete p.normalization_note; }],
  ['lineage leaf', p => { p.private_source_commit = 'b'.repeat(40); }],
  ['note leaf', p => { p.normalization_note = 'changed'; }],
]) test(`provenance ${label} remains bound`, t => {
  const expected = normalizedDigest(releaseSet(t).directory);
  refusesChange(expected, releaseSet(t, { mode: 'release', mutateProvenance }).directory);
});
for (const [label, mutateFiles] of [
  ['added member', files => files.set('release/extra-runtime.json', json({ mode: 'release' }))],
  ['missing member', files => files.delete('release/ordinary.json')],
]) test(`${label} cannot normalize away`, t => {
  const expected = normalizedDigest(releaseSet(t).directory);
  refusesChange(expected, releaseSet(t, { mode: 'release', mutateFiles }).directory);
});
