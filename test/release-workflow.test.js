import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const yaml = { parse };
test('workflow parses, only a matching pushed tag admits release packing, and PR retention never publishes', () => {
  const release = yaml.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(release.on.push.tags, ['v*']); assert.equal(release.on.pull_request, undefined);
  assert.equal(release.permissions.contents, 'read'); assert.equal(Object.keys(release.jobs).length, 1);
  assert.match(release.jobs.pack.if, /startsWith\(github.ref, 'refs\/tags\/'\)/u);
  const text = JSON.stringify(release); assert.doesNotMatch(text, /npm publish|gh release|git tag|git push|retain-forge/u);
  const ci = yaml.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.on.pull_request, null); assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.ok(ci.jobs.test.steps.some(step => step.run?.includes('release/dry-run.mjs')));
  assert.equal(ci.jobs.browser['timeout-minutes'], 10); // 480 s is the measured budget, with runner headroom.
  assert.equal(ci.jobs.test['timeout-minutes'], 10);
  const upload = ci.jobs.test.steps.find(step => step.uses?.includes('upload-artifact'));
  assert.equal(upload.with.name, 'reset-candidate'); assert.equal(upload.with['retention-days'], 90);
  assert.match(upload.with.path, /release-evidence\/candidate\//u);
  assert.doesNotMatch(JSON.stringify(ci), /npm publish|gh release|git tag|git push/u);
  assert.deepEqual(release.jobs.pack.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  const attest = release.jobs.pack.steps.find(step => step.uses?.includes('attest-build-provenance'));
  assert.match(attest.uses, /@[a-f0-9]{40}$/u);
  assert.match(attest.with['subject-path'], /dist\/release\/\*\.tgz/u);
  assert.match(attest.with['subject-path'], /release-set\.json/u);
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
