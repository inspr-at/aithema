import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { creditCost, draftsLine, languageFlag } from '../src/display.js';
import { reasonSeparator } from '../src/consent-line.js';

test('AIT-228: overview header and draft label carry the same meaning in DE/EN', () => {
  assert.deepEqual([de.understanding, de.conceptTab], ['Überblick', 'Entwurf']);
  assert.deepEqual([en.understanding, en.conceptTab], ['Overview', 'Draft']);
});

test('AIT-228: every application UI separator uses reasonSeparator, including locale and upload copy', () => {
  const sweep = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) sweep(file);
      // The hash-pinned upstream closure is immutable. version-display.js overrides its labels.
      else if (entry.name.endsWith('.js') && !file.pathname.includes('/src/versioning/')) assert.equal(readFileSync(file, 'utf8').includes(' · '), false, file.pathname);
    }
  };
  sweep(new URL('../src/', import.meta.url));
  assert.equal(reasonSeparator, '\u00a0· ');
});

test('AIT-228: free, sub-credit, singular and plural quotes in both languages', () => {
  for (const copy of [de, en]) {
    const one = copy === de ? 'Credit' : 'credit', many = copy === de ? 'Credits' : 'credits';
    for (const [micro, expected] of [[0, ''], [1, `< 1 ${one}`], [9999, `< 1 ${one}`], [10000, `1 ${one}`], [10001, `2 ${many}`], [20000, `2 ${many}`]]) {
      assert.equal(creditCost(micro, copy), expected);
      assert.deepEqual(draftsLine({ copy, feature: { available: true }, cost: { maxMicro: micro } }), {
        state: 'on', action: true, text: [copy.display.draftsOn, expected].filter(Boolean).join(reasonSeparator),
      });
    }
    for (const invalid of [-1, NaN, Infinity, undefined]) assert.equal(creditCost(invalid, copy), '');
  }
  assert.equal(creditCost(10000000, de), '1.000 Credits');
  assert.equal(creditCost(10000000, en), '1,000 credits');
});

test('AIT-228: footer flag follows UI language', () => {
  assert.match(languageFlag('de'), /#ffce00/u);
  assert.doesNotMatch(languageFlag('de'), /#bd2940/u);
  assert.match(languageFlag('en'), /#bd2940/u);
});
