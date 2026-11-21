// AIT-603 PR-B r4 (gate Low): the footer help line names a consent reason in at
// most 40 characters. The cut counts and keeps whole graphemes: it never splits
// a surrogate pair (emoji) or a base letter from its combining mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { helpReason } from '../src/settings-dialog.js';

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

test('AIT-603 PR-B r4: helpReason keeps short reasons as they are', () => {
  assert.equal(helpReason('Your messages reach the provider.'), 'Your messages reach the provider.');
  assert.equal(helpReason(undefined), '');
  assert.equal(helpReason('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(helpReason('a'.repeat(41)), `${'a'.repeat(39)}…`);
});

test('AIT-603 PR-B r4: helpReason counts graphemes, so 40 with an emoji is not cut', () => {
  const forty = `${'a'.repeat(39)}😀`;
  assert.equal(forty.length, 41);
  assert.equal(helpReason(forty), forty);
});

test('AIT-603 PR-B r4: helpReason never splits a surrogate pair at the cut', () => {
  for (const emoji of ['😀', '👍🏽', '👩‍👩‍👧']) {
    const text = `${'a'.repeat(38)}${emoji}${'b'.repeat(10)}`;
    const cut = helpReason(text);
    assert.doesNotMatch(cut, lone, `no lone surrogate for ${emoji}`);
    assert.equal(cut, `${'a'.repeat(38)}${emoji}…`);
  }
});

test('AIT-603 PR-B r4: helpReason keeps a combining mark with its letter at the cut', () => {
  const text = `${'a'.repeat(38)}é${'x'.repeat(10)}`;
  assert.equal(helpReason(text), `${'a'.repeat(38)}é…`);
});
