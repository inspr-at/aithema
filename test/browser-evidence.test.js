import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'yaml';

// Execute the actual evidence teardown without starting a browser. This must
// work when AIT-512 is the first evidence-producing test in its shard.
const questionCard = await readFile(new URL('./browser/question-card.test.js', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('question-card.test.js', questionCard, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const navigationTest = sourceFile.statements.find(node => node.getText(sourceFile).startsWith("test('AIT-512:"));
const testBody = navigationTest?.expression?.arguments.at(-1)?.body;
// Parse the callback boundary so nested blocks and object literals are retained.
const evidenceTeardown = testBody?.statements.find(node => node.getText(sourceFile).startsWith('t.after(async'))
  ?.expression.arguments[0].getText(sourceFile);

test('AIT-532: AIT-512 evidence writes create a missing directory independently of earlier tests', async t => {
  assert.ok(evidenceTeardown, 'Exercise the actual AIT-512 evidence teardown');
  const root = await mkdtemp(join(tmpdir(), 'aithema-browser-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const laneEvidenceDirectory = join(root, 'missing', 'evidence');
  const rectEvidence = [{ width: 390, before: { width: 100, height: 50 } }];
  const teardown = runInNewContext(`(${evidenceTeardown})`, { laneEvidenceDirectory, rectEvidence, mkdir, writeFile, join });
  await teardown();
  const file = join(laneEvidenceDirectory, 'ait-512-rects.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), rectEvidence);
  // Existing directories and repeated writes must remain safe too.
  rectEvidence.push({ width: 1440, after: { width: 100, height: 50 } });
  await teardown();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), rectEvidence);
});

test('AIT-532: AIT-512 evidence remains optional', async () => {
  assert.ok(evidenceTeardown);
  const unexpected = () => assert.fail('No filesystem access without an evidence directory');
  await runInNewContext(`(${evidenceTeardown})`, {
    laneEvidenceDirectory: undefined, rectEvidence: [], mkdir: unexpected, writeFile: unexpected, join: unexpected,
  })();
});

test('AIT-532: CI creates the browser evidence directory before running any shard', async t => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = ci.jobs.browser.steps;
  const prepare = steps.find(step => step.name === 'Create browser evidence directory');
  const browser = steps.find(step => step.run?.includes('npm run test:browser -- --shard'));
  assert.ok(prepare, 'Prepare the artifact directory independently of the test execution order');
  assert.ok(steps.indexOf(prepare) < steps.indexOf(browser));
  assert.equal(prepare.if, browser.if, 'Retain the docs-only and duplicate-main guards');
  assert.equal(prepare.env.AITHEMA_EVIDENCE_DIR, browser.env.AITHEMA_EVIDENCE_DIR);
  const root = await mkdtemp(join(tmpdir(), 'aithema-ci-browser-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('bash', ['-e', '-c', [
    'npm() { test -d "$AITHEMA_EVIDENCE_DIR"; }',
    prepare.run,
    browser.run.replaceAll('${{ matrix.shard }}', '1'),
  ].join('\n')], { env: { PATH: process.env.PATH, AITHEMA_EVIDENCE_DIR: join(root, 'missing', 'evidence') } });
  assert.equal(result.status, 0, result.stderr.toString());
});
