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

test('AIT-228: every application UI separator uses reasonSeparator, including locale, upload and visitor demo copy', () => {
  const sweep = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) sweep(file);
      // The hash-pinned upstream closure is immutable. version-display.js overrides its labels.
      else if (entry.name.endsWith('.js') && !file.pathname.includes('/src/versioning/')) assert.equal(readFileSync(file, 'utf8').includes(' · '), false, file.pathname);
    }
  };
  sweep(new URL('../src/', import.meta.url));
  for (const file of ['host.js', 'index.html']) {
    const source = new URL(`../../../demo/${file}`, import.meta.url);
    assert.equal(readFileSync(source, 'utf8').includes(' · '), false, source.pathname);
  }
  assert.equal(reasonSeparator, '\u00a0· ');
});

test('AIT-228: free, sub-credit, singular and plural quotes in both languages', () => {
  for (const copy of [de, en]) {
    const one = copy === de ? 'Credit' : 'credit', many = copy === de ? 'Credits' : 'credits';
    const upTo = copy === de ? 'bis\u00a0zu' : 'up\u00a0to';
    for (const [micro, expected] of [[0, ''], [1, `<\u00a01\u00a0${one}`], [9999, `<\u00a01\u00a0${one}`], [10000, `${upTo}\u00a01\u00a0${one}`], [10001, `${upTo}\u00a02\u00a0${many}`], [20000, `${upTo}\u00a02\u00a0${many}`], [400000, `${upTo}\u00a040\u00a0${many}`], [1000000, `${upTo}\u00a0100\u00a0${many}`]]) {
      assert.equal(creditCost(micro, copy), expected);
      assert.deepEqual(draftsLine({ copy, feature: { available: true }, cost: { maxMicro: micro } }), {
        state: 'on', action: true, text: [copy.display.draftsOn, expected].filter(Boolean).join(reasonSeparator),
      });
    }
    for (const invalid of [-1, 1234.5, NaN, Infinity, undefined]) assert.equal(creditCost(invalid, copy), '');
  }
  assert.equal(creditCost(10000000, de), 'bis\u00a0zu\u00a01.000\u00a0Credits');
  assert.equal(creditCost(10000000, en), 'up\u00a0to\u00a01,000\u00a0credits');
});

test('AIT-228: footer flag follows UI language', () => {
  assert.match(languageFlag('de'), /#ffce00/u);
  assert.doesNotMatch(languageFlag('de'), /#bd2940/u);
  assert.match(languageFlag('en'), /#bd2940/u);
});
