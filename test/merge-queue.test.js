import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const workflows = ['ci', 'dco'].map(name => readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));

// Parse the indentation-delimited mappings used by these workflows. Unsupported
// event conditions fail closed rather than pretending that a job runs on both.
function mappingEntries(source, indent) {
  const lines = source.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^ {${indent}}([\\w-]+):(?: (.*))?$`, 'u').exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].startsWith(' '.repeat(indent + 1)) || lines[end].trimStart().startsWith('#'))) end += 1;
    entries.push({ key: match[1], value: match[2], body: lines.slice(index + 1, end).join('\n') });
  }
  return entries;
}

function block(source, key, indent = 0) {
  const entry = mappingEntries(source, indent).find(entry => entry.key === key);
  assert.ok(entry, `Missing workflow mapping: ${key}`);
  return entry.body;
}

function checkNames(workflow, event) {
  block(block(workflow, 'on'), event, 2);
  return mappingEntries(block(workflow, 'jobs'), 2).flatMap(job => {
    const condition = /^    if: (.+)$/mu.exec(job.body)?.[1];
    if (condition) {
      const events = condition.split(' || ').map(expression => {
        const match = /^github\.event_name == '(pull_request|merge_group)'$/u.exec(expression);
        assert.ok(match, `Unsupported job condition: ${expression}`);
        return match[1];
      });
      if (!events.includes(event)) return [];
    }
    const name = /^    name: (.+)$/mu.exec(job.body)?.[1] ?? job.key;
    const matrix = /^        shard: (\[[^\n]+\])$/mu.exec(job.body);
    return matrix ? JSON.parse(matrix[1]).map(shard => name.replace('${{ matrix.shard }}', shard)) : [name];
  });
}

test('both required workflows request merge-group checks', () => {
  for (const workflow of workflows) {
    const trigger = block(block(workflow, 'on'), 'merge_group', 2);
    assert.match(trigger, /^    types: \[checks_requested\]$/mu);
  }
});

test('PR and merge-group events run the same seven required check names', () => {
  const expected = ['test', 'browser (1/4)', 'browser (2/4)', 'browser (3/4)', 'browser (4/4)', 'dco', 'dco-tests'];
  for (const event of ['pull_request', 'merge_group']) {
    assert.deepEqual(workflows.flatMap(workflow => checkNames(workflow, event)), expected);
  }
});

test('DCO workflow checks the event-specific commit range and opts in to queue handling only for merge groups', () => {
  const job = block(block(workflows[1], 'jobs'), 'dco', 2);
  assert.match(job, /fetch-depth: 0/u);
  for (const event of ['pull_request', 'merge_group']) {
    const step = job.split(/^      - /mu).find(step => step.includes(`if: github.event_name == '${event}'`));
    assert.ok(step, `Missing explicit ${event} DCO step`);
    assert.ok(step.includes(`DCO_BASE: \${{ github.event.${event}.base${event === 'pull_request' ? '.sha' : '_sha'} }}`));
    assert.ok(step.includes(`DCO_HEAD: \${{ github.event.${event}.head${event === 'pull_request' ? '.sha' : '_sha'} }}`));
    assert.ok(step.includes('python3 -I scripts/check-dco.py "$DCO_BASE" "$DCO_HEAD"'));
    assert.equal(step.includes('--merge-group'), event === 'merge_group');
  }
});

test('DCO validates real signed, unsigned and merge-queue Git histories', () => {
  execFileSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_dco.py', '-v'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  });
});
