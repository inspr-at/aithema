// Only run explicitly in an isolated mbp2606 archive. Never included by npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const source = new URL('../../packages/ui/src/session-element.js', import.meta.url);
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const mutations = [
  ['e155043', '(analysis.available || cached) && scheduledAnalysis', 'analysis.available && scheduledAnalysis', /paused: pending overview stays visible/u],
  ['be304ae', '(analysis.available || cached) && scheduledAnalysis', '(analysis.available || cached) && waiting', /assistant final ends wird erstellt/u],
  ['e5bb795', "missingReply && this.#session.pauseReason !== 'purpose' &&", 'missingReply &&', /purpose stop is deliberate/u],
];
test('AIT-197 three isolated hunk reversions red → restored green', { timeout: 240_000 }, async () => {
  const original = await readFile(source, 'utf8');
  for (const [commit, before, after, expected] of mutations) {
    assert.equal(original.split(before).length, 2, `${commit} mutation matches exactly once`);
    const args = ['--test', `--test-name-pattern=AIT-197 ${commit}`, 'test/browser/lane-race-kit.test.js'];
    let red;
    try {
      await writeFile(source, original.replace(before, after));
      red = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 45_000, env: childEnv });
    } finally { await writeFile(source, original); }
    assert.equal(red.status, 1, `${commit}: expected assertion failure, not a crash: ${red.stdout}${red.stderr}`);
    assert.match(red.stdout + red.stderr, expected);
    console.log(`AIT-197 ${commit} RED: ${expected.source}`);
    const green = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 45_000, env: childEnv });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.equal(await readFile(source, 'utf8'), original);
    console.log(`AIT-197 ${commit} GREEN: source restored byte-for-byte; regression passes.`);
  }
});
