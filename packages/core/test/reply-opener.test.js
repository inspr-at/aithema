import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const de = ['Danke', 'Danke schön', 'Danke sehr', 'Vielen Dank', 'Vielen herzlichen Dank', 'Herzlichen Dank', 'Besten Dank',
  'Dankeschön', 'Vielen lieben Dank', 'Danke vielmals', '**Danke**', '**Vielen Dank**'];
const en = ['Thanks', 'Thank you', 'Thank you very much', 'Many thanks', 'Thank you so much', 'Thanks a lot'];
for (const [locale, forms, complement, remainder] of [
  ['de', de, 'für Ihre Nachricht', 'das klingt nach einem klaren Vorhaben.'],
  ['en', en, 'for your message', 'it sounds like a clear plan.'],
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
  ['Danke, äh das hilft uns.', 'Äh das hilft uns.'],
  ['Danke, wir planen einen Pilotversuch.', 'Wir planen einen Pilotversuch.'],
  ['Thanks, we start.', 'We start.'],
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

const unsafeVerbStarts = [
  // The three gate2 examples: infinitives must not count as singular finite verbs.
  'Vielen Dank für das Beispiel, das helfen kann, den Ablauf zu verstehen.',
  'Vielen Dank für das Beispiel, das starten soll, sobald die Daten vorliegen.',
  'Vielen Dank für das Beispiel, das beginnen wird, wenn Sie bereit sind.',
  // More relative clauses and inverted or uncertain infinitive constructions.
  'Danke für das Beispiel, das machen kann, was Sie benötigen.',
  'Danke für das Beispiel, das zeigen soll, wie der Ablauf funktioniert.',
  'Danke für das Beispiel, das passen könnte, wenn Sie es anpassen.',
  'Danke für das Beispiel, das gehen muss, sobald die Freigabe vorliegt.',
  'Danke für das Beispiel, das reichen sollte, um den Ablauf zu prüfen.',
  'Danke für das Beispiel, das funktionieren kann, wenn die Daten vorliegen.',
  'Danke für das Beispiel, das bleiben darf, solange Sie es benötigen.',
  'Danke für das Beispiel, das wirken soll, sobald der Ablauf beginnt.',
  'Danke für das Beispiel, das helfen zu können scheint.',
  'Danke für das Beispiel, das zu starten ist.',
  'Danke, es helfen kann, den Ablauf zu verstehen.',
  'Danke, ich helfen kann, wenn Sie bereit sind.',
  'Danke, wir helfen können, sobald die Daten vorliegen.',
  'Danke, Sie starten sollen, sobald die Daten vorliegen.',
  'Danke für das Beispiel, das hilft können, den Ablauf zu verstehen.',
  'Danke für das Beispiel, das hat helfen können.',
  'Danke, ich haben einen Plan.',
  'Danke, wir ist bereit.',
  'Danke, Sie beschreibt den Ablauf.',
  'Danke, Ihr Vorhaben beginnen wird, wenn Sie bereit sind.',
  'Thanks, that help can clarify the process.',
  'Thanks, this start should simplify the process.',
  'Thanks, it work can simplify the process.',
  'Thanks, I helps with the process.',
  'Thanks, we helps with the process.',
  'Thanks, we help can clarify the process.',
  'Danke, das kann helfen müssen.',
  'Thanks, we can help should clarify the process.',
  'Danke, jetzt sehe ich den Ablauf.',
  'Thanks for the details, that sounds useful.',
  "Thanks, that's useful.",
];
const unsafeInterjections = [
  'Danke, äh, dass Sie das geteilt haben, wir können starten.',
  'Danke, äh dass Sie das geteilt haben, wir können starten.',
  'Danke, also, dass Sie das geteilt haben, wir können starten.',
  'Danke, also dass Sie das geteilt haben, wir können starten.',
  'Danke, nun, das helfen kann, den Ablauf zu verstehen.',
  'Danke, nun das helfen kann, den Ablauf zu verstehen.',
  'Thanks, well, that you have shared the details, we can start.',
  'Thanks, well that you have shared the details, we can start.',
  'Thanks, so, that help can clarify the process.',
  'Thanks, so that help can clarify the process.',
  'Thanks for the details, well that sounds useful.',
  'Vielen Dank für Ihre Nachricht. Gut, dann beginnen wir.',
  'Danke, okay, wir helfen können, sobald Sie bereit sind.',
  'Danke, äh.',
  'Thanks, well.',
];
for (const input of [...unsafeVerbStarts, ...unsafeInterjections]) {
  test(`AIT-157 fix2: keep uncertain verb or interjection clause: ${input}`, () => {
    for (const locale of ['de', 'en']) {
      assert.deepEqual(core.stripThanksOpener(input, locale), { text: input, stripped: false, kept: true });
      // Verify preservation in text and voice, independently of the pure guard.
      for (const bufferNormal of [true, false]) {
        for (let split = 0; split <= input.length; split++) {
          const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
          assert.equal(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.finish(), input);
          assert.equal(stream.stripped, false);
        }
        const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
        assert.equal([...input].map(char => stream.push(char)).join('') + stream.finish(), input);
        assert.equal(stream.stripped, false);
      }
    }
  });
}
for (const [input, expected] of [
  ['Danke! Das hilft.', 'Das hilft.'],
  ['Thanks — that helps.', 'That helps.'],
  ['Danke, das kann helfen.', 'Das kann helfen.'],
  ['Danke, es kann helfen.', 'Es kann helfen.'],
  ['Danke, ich kann helfen.', 'Ich kann helfen.'],
  ['Danke, wir können helfen.', 'Wir können helfen.'],
  ['Danke, Sie können helfen.', 'Sie können helfen.'],
  ['Thanks, that can help.', 'That can help.'],
  ['Thanks, I can help.', 'I can help.'],
  ['Danke, es funktioniert.', 'Es funktioniert.'],
  ['Danke, das wirkt klar.', 'Das wirkt klar.'],
  ['Danke, es bleibt überschaubar.', 'Es bleibt überschaubar.'],
  ['Danke, das scheint machbar.', 'Das scheint machbar.'],
  ['Danke, das sieht gut aus.', 'Das sieht gut aus.'],
  ['Danke, ich sehe den Ablauf.', 'Ich sehe den Ablauf.'],
  ['Danke, wir helfen beim Einstieg.', 'Wir helfen beim Einstieg.'],
  ['Danke, Sie beschreiben den Ablauf klar.', 'Sie beschreiben den Ablauf klar.'],
  ['Danke, äh das hilft uns.', 'Äh das hilft uns.'],
  ['Danke, also das hilft uns.', 'Also das hilft uns.'],
  ['Danke, nun das hilft uns.', 'Nun das hilft uns.'],
  ['Thanks, well that helps us.', 'Well that helps us.'],
  ['Thanks, so that helps us.', 'So that helps us.'],
]) test(`AIT-157 fix2: strip only confirmed finite main-clause starts: ${input}`, () => {
  for (const locale of ['de', 'en']) {
    assert.deepEqual(core.stripThanksOpener(input, locale), { text: expected, stripped: true });
    for (const bufferNormal of [true, false]) {
      for (let split = 0; split <= input.length; split++) {
        const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
        assert.equal(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.finish(), expected);
        assert.equal(stream.stripped, true);
      }
      const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
      assert.equal([...input].map(char => stream.push(char)).join('') + stream.finish(), expected);
      assert.equal(stream.stripped, true);
    }
  }
});

for (const [input, expected] of [
  // Gate3: capitalising third-person pronouns would turn them into formal address.
  ['Vielen Dank für die Unterlagen, sie sind sehr hilfreich.'],
  ['Danke für die Details, sie helfen sehr.'],
  ['Vielen Dank für die Unterlagen, ihr Vorschlag hilft.'],
  ['Vielen Dank, ihnen hilft der Vorschlag.'],
  ['Vielen Dank, ihre Idee hilft.'],
  ['Danke, ihre Beschreibung ist sehr hilfreich.'],
  ['Danke, sie können helfen.'],
  ['Danke, also sie helfen uns.'],
  ['Danke, äh ihr Vorschlag hilft.'],
  // Already-capitalised formal address keeps its referent; other safe starts do too.
  ['Vielen Dank, Sie haben recht.', 'Sie haben recht.'],
  ['Vielen Dank, Ihr Vorschlag hilft.', 'Ihr Vorschlag hilft.'],
  ['Vielen Dank, Ihre Idee hilft.', 'Ihre Idee hilft.'],
  ['Vielen Dank, Ihnen hilft der Vorschlag.'], // Dative start is outside the whitelist.
  ['Danke, das hilft uns.', 'Das hilft uns.'],
  ['Danke, es hilft uns.', 'Es hilft uns.'],
  ['Danke, er hilft uns.', 'Er hilft uns.'],
  ['Thanks, she helps us.', 'She helps us.'],
]) test(`AIT-157 fix3: capitalisation preserves meaning: ${input}`, () => {
  const stripped = expected !== undefined, text = expected ?? input;
  for (const locale of ['de', 'en']) {
    assert.deepEqual(core.stripThanksOpener(input, locale),
      stripped ? { text, stripped } : { text, stripped, kept: true });
    for (const bufferNormal of [true, false]) {
      for (let split = 0; split <= input.length; split++) {
        const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
        assert.equal(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.finish(), text);
        assert.equal(stream.stripped, stripped);
      }
      const stream = new core.ReplyOpenerStream(locale, { bufferNormal });
      assert.equal([...input].map(char => stream.push(char)).join('') + stream.finish(), text);
      assert.equal(stream.stripped, stripped);
    }
  }
});

for (const input of [
  ...de.map(form => `${form} für Ihre Nachricht, das klingt nach einem klaren Vorhaben.`),
  ...en.map(form => `${form} for your message, it sounds like a clear plan.`),
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

test('AIT-157: long recognised opener flushes unchanged at the 160-character bound', () => {
  for (const bufferNormal of [true, false]) {
    const stream = new core.ReplyOpenerStream('de', { bufferNormal });
    const prefix = 'Vielen Dank für ' + 'Ihre Beschreibung '.repeat(20);
    assert.equal(stream.push(prefix.slice(0, 159)), '');
    assert.equal(stream.push(prefix.slice(159, 160)), prefix.slice(0, 160));
    assert.equal(stream.push(prefix.slice(160) + ', das klingt gut.'), prefix.slice(160) + ', das klingt gut.');
    assert.equal(stream.finish(), '');
    assert.equal(stream.stripped, false);
  }
});

const gateExamples = [
  'Danke, dass Sie das geteilt haben, wir können starten.',
  'Vielen Dank für die Beschreibung, die Sie geschickt haben, das klingt gut.',
  '… Nachricht, in der Sie beschreiben, wie das Projekt starten soll.',
  'Vielen Dank für Ihre Nachricht, in der Sie beschreiben, wie das Projekt starten soll.',
];
const ambiguous = [
  ...gateExamples.slice(0, 2), gateExamples[3],
  ...['dass', 'daß', 'wenn', 'weil', 'ob', 'wie', 'als', 'damit', 'sodass'].map(word => `Danke, ${word} Sie das geteilt haben, wir können starten.`),
  ...['that', 'which', 'who', 'whom', 'whose', 'where', 'when', 'if', 'because', 'how'].map(word => `Thanks, ${word} you have shared the details, we can start.`),
  ...['der', 'die', 'das', 'den', 'dem', 'deren', 'dessen', 'welche', 'welcher', 'welches', 'welchen', 'welchem'].map(word => `Vielen Dank für die Beschreibung, ${word} Sie geschickt haben, das klingt gut.`),
  ...['which', 'that'].map(word => `Many thanks for the description, ${word} sounds useful, we can start.`),
  ...['in der', 'mit dem', 'von dem', 'über die'].map(words => `Danke für die Nachricht, ${words} Sie das Projekt beschreiben, wir können starten.`),
  ...['for which', 'in which', 'with whom', 'to whose'].map(words => `Thank you for the message, ${words} you have shared the details, we can start.`),
  'Danke, beim Projekt sind mehrere Systeme beteiligt.',
  'Thanks, after the meeting we can start.',
];
for (const input of ambiguous) test(`AIT-157 fix1: keep subordinate, relative or uncertain clause: ${input}`, () => {
  assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: input, stripped: false, kept: true });
});
test('AIT-157 fix1: preserve the abbreviated third gate example verbatim', () => {
  assert.deepEqual(core.stripThanksOpener(gateExamples[2], 'de'), { text: gateExamples[2], stripped: false });
});
for (const [open, close] of [['„', '“'], ['"', '"'], ['«', '»'], ["'", "'"], ['“', '”'], ['‘', '’']]) {
  for (const quoted of ['Danke für nichts', 'Danke, das klingt gut.', 'Vielen Dank']) {
    const input = `  ${open}${quoted}${close} – so beschreiben Sie das Projekt.`;
    test(`AIT-157 fix1: quoted user text is preserved: ${input}`, () => {
      assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: input, stripped: false });
    });
  }
}
for (const form of [...de, ...en]) test(`AIT-157 fix1: keep ambiguous remainder for ${form}`, () => {
  const input = `${form}, weil Sie das geteilt haben, wir können starten.`;
  assert.deepEqual(core.stripThanksOpener(input, 'de'), { text: input, stripped: false, kept: true });
});
for (const input of [...ambiguous, '„Danke für nichts“ – so beschreiben Sie das Projekt.',
  'Danke, das Projekt, das Sie beschreiben, ist klar.', 'Danke, das klingt gut. Danke für das Detail.']) {
  test(`AIT-157 fix1: every split and character stream preserves the safe decision: ${input}`, () => {
    const expected = core.stripThanksOpener(input, 'de');
    for (const bufferNormal of [true, false]) {
      for (let split = 0; split <= input.length; split++) {
        const stream = new core.ReplyOpenerStream('de', { bufferNormal });
        assert.equal(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.finish(), expected.text);
        assert.equal(stream.stripped, expected.stripped);
      }
      const stream = new core.ReplyOpenerStream('de', { bufferNormal });
      assert.equal([...input].map(char => stream.push(char)).join('') + stream.finish(), expected.text);
      assert.equal(stream.stripped, expected.stripped);
    }
  });
}
test('AIT-157 fix1: an ambiguous first remainder clause flushes at its boundary', () => {
  const stream = new core.ReplyOpenerStream('de', { bufferNormal: false });
  assert.equal(stream.push('Danke, dass Sie das geteilt haben'), '');
  assert.equal(stream.push(','), 'Danke, dass Sie das geteilt haben,');
  assert.equal(stream.push(' wir können starten.'), ' wir können starten.');
  assert.equal(stream.finish(), '');
});

test('AIT-157: voice forwards ordinary replies as soon as the prefix is unambiguous', () => {
  const stream = new core.ReplyOpenerStream('en', { bufferNormal: false });
  assert.equal(stream.push('H'), '', 'H can still become Herzlichen Dank');
  assert.equal(stream.push('ello'), 'Hello');
  assert.equal(stream.finish(), '');
});
for (const input of ['Gut, dann beginnen wir. Danke für Ihre Nachricht.', 'Das hilft uns. Vielen Dank.',
  'Thanksville is a place.', 'Dankeschönes Design ist ungewöhnlich.', 'Gut, dann …', '', '  "Ein klarer Plan."',
  '**Danke!** Das hilft.', 'Danke\nDas hilft.']) {
  test(`AIT-157: preserve other openers and later thanks: ${input}`, () => {
    assert.equal(typeof core.stripThanksOpener, 'function');
    assert.deepEqual(core.stripThanksOpener(input, 'en'), { text: input, stripped: false });
  });
}
