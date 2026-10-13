import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const de = ['Danke', 'Danke schön', 'Danke sehr', 'Vielen Dank', 'Vielen herzlichen Dank', 'Herzlichen Dank', 'Besten Dank'];
const en = ['Thanks', 'Thank you', 'Thank you very much', 'Many thanks'];
for (const [locale, forms, complement, remainder] of [
  ['de', de, 'für Ihre Nachricht', 'das klingt nach einem klaren Vorhaben.'],
  ['en', en, 'for your message', 'that sounds like a clear plan.'],
]) for (const form of forms) for (const suffix of ['', ` ${complement}`]) {
  test(`AIT-157: strip ${form}${suffix} with either session locale`, () => {
    for (const sessionLocale of [locale, locale === 'de' ? 'en' : 'de']) {
      assert.equal(typeof core.stripThanksOpener, 'function');
      assert.deepEqual(core.stripThanksOpener(`${form}${suffix}, ${remainder}`, sessionLocale),
        { text: remainder[0].toUpperCase() + remainder.slice(1), stripped: true });
    }
  });
}
for (const [input, expected] of [
  ['Vielen Dank für die Beschreibung, das klingt nach einem gut abgrenzbaren Vorhaben.', 'Das klingt nach einem gut abgrenzbaren Vorhaben.'],
  ['Thank you very much for the details — we can start with the scope.', 'We can start with the scope.'],
  ['Danke - Sie können mit dem Umfang beginnen.', 'Sie können mit dem Umfang beginnen.'],
  ['Vielen Dank für Ihre Nachricht. Ihr Vorhaben ist klar.', 'Ihr Vorhaben ist klar.'],
  ['Thanks for the details! What should we start with?', 'What should we start with?'],
  ['  „vIeLeN dAnK für Ihre Nachricht.“\n\nDas hilft bei der Eingrenzung.', 'Das hilft bei der Eingrenzung.'],
  ['  "THANKS, that sounds useful."', 'That sounds useful.'],
  ['Danke, äh das hilft uns.', 'Äh das hilft uns.'],
  ['Danke, wir planen einen Pilotversuch.', 'Wir planen einen Pilotversuch.'],
  ['Thanks, we start.', 'We start.'],
  ['„Danke“, Sie können mit dem Umfang beginnen.', 'Sie können mit dem Umfang beginnen.'],
  ['Vielen Dank für Ihre Nachricht. Gut, dann beginnen wir.', 'Gut, dann beginnen wir.'],
]) test(`AIT-157: clause, sentence, case and quote handling: ${input}`, () => {
  assert.equal(typeof core.stripThanksOpener, 'function');
  assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: expected, stripped: true });
});
for (const input of ['Danke.', 'Vielen Dank für Ihre Nachricht.', 'Danke, sehr hilfreich.', 'Thanks, for the details.',
  'Danke, die Beschreibung.', 'Danke, das klingt', 'Thank you, a clear plan.',
  'Danke, die Systeme können.', 'Danke, mit den Daten können wir.', 'Thanks, that is a.',
  'Thanks, a plan for tomorrow.', 'Danke, Ihr Plan für morgen.']) {
  test(`AIT-157: keep empty or fragment remainder: ${input}`, () => {
    assert.equal(typeof core.stripThanksOpener, 'function');
    assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: input, stripped: false, kept: true });
  });
}

for (const input of [
  ...de.map(form => `${form} für Ihre Nachricht, das klingt nach einem klaren Vorhaben.`),
  ...en.map(form => `${form} for your message, that sounds like a clear plan.`),
  '  "THANKS, that sounds useful."',
  '„Vielen Dank, das klingt gut.“ Danach können Sie beginnen.',
  '„Danke.“ Das hilft uns. Danke für das Detail.',
  'Danke, sehr hilfreich.',
  'Vielen Dank für Ihre Nachricht. Gut, dann beginnen wir.',
  `Vielen Dank für ${'Ihre Beschreibung '.repeat(8)}, das klingt gut.`,
  `Thank you, that sounds like ${'a detailed '.repeat(8)}plan.`,
  'Thanksville is a place.',
]) test(`AIT-157: stream and pure guard agree for every chunk split: ${input}`, () => {
  const expected = core.stripThanksOpener(input, 'de');
  for (const bufferNormal of [true, false]) {
    for (let split = 0; split <= input.length; split++) {
      const stream = new core.ReplyOpenerStream('de', { bufferNormal });
      const output = stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.finish();
      assert.equal(output, expected.text, `split ${split}, bufferNormal ${bufferNormal}`);
      assert.equal(stream.stripped, expected.stripped);
    }
    const stream = new core.ReplyOpenerStream('de', { bufferNormal });
    let output = '';
    for (const char of input) output += stream.push(char);
    assert.equal(output + stream.finish(), expected.text, `one-character chunks, bufferNormal ${bufferNormal}`);
  }
});

test('AIT-157: long recognised opener stays private beyond the soft buffer cap', () => {
  const stream = new core.ReplyOpenerStream('de');
  assert.equal(stream.push(`Vielen Dank für ${'Ihre Beschreibung '.repeat(8)}`), '');
  assert.equal(stream.push(', '), '');
  assert.equal(stream.push('das klingt gut.'), 'Das klingt gut.');
  assert.equal(stream.finish(), '');
});

test('AIT-157: voice forwards ordinary replies as soon as the prefix is unambiguous', () => {
  const stream = new core.ReplyOpenerStream('en', { bufferNormal: false });
  assert.equal(stream.push('H'), 'H');
  assert.equal(stream.push('ello'), 'ello');
  assert.equal(stream.finish(), '');
});
for (const input of ['Gut, dann beginnen wir. Danke für Ihre Nachricht.', 'Das hilft uns. Vielen Dank.',
  'Thanksville is a place.', 'Dankeschönes Design ist ungewöhnlich.', 'Gut, dann …', '', '  "Ein klarer Plan."']) {
  test(`AIT-157: preserve other openers and later thanks: ${input}`, () => {
    assert.equal(typeof core.stripThanksOpener, 'function');
    assert.deepEqual(core.stripThanksOpener(input, 'en'), { text: input, stripped: false });
  });
}
