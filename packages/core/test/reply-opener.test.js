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
]) test(`AIT-157: clause, sentence, case and quote handling: ${input}`, () => {
  assert.equal(typeof core.stripThanksOpener, 'function');
  assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: expected, stripped: true });
});
for (const input of ['Danke.', 'Vielen Dank für Ihre Nachricht.', 'Danke, sehr hilfreich.', 'Thanks, for the details.',
  'Danke, die Beschreibung.', 'Danke, das klingt', 'Thank you, a clear plan.']) {
  test(`AIT-157: keep empty or fragment remainder: ${input}`, () => {
    assert.equal(typeof core.stripThanksOpener, 'function');
    assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: input, stripped: false, kept: true });
  });
}
for (const input of ['Gut, dann beginnen wir. Danke für Ihre Nachricht.', 'Das hilft uns. Vielen Dank.',
  'Thanksville is a place.', 'Dankeschönes Design ist ungewöhnlich.', 'Gut, dann …', '', '  "Ein klarer Plan."']) {
  test(`AIT-157: preserve other openers and later thanks: ${input}`, () => {
    assert.equal(typeof core.stripThanksOpener, 'function');
    assert.deepEqual(core.stripThanksOpener(input, 'en'), { text: input, stripped: false });
  });
}
