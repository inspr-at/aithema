import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { withDemoConsentCopy } from '../consent-copy.js';
import { CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../processing-consent.js';
import { START_GERMAN_CONSENT } from '../../test/fixtures/german-server-texts.js';

// Demo consent pins, with AIT-246 plain demo wording; persistence terms stay unchanged.
const previous = {
  "de": {
    "consentTitle": "Einwilligung für das Demo-Gespräch",
    "mockRecipients": "Empfänger: die lokale Demo; keine weiteren Auftragsverarbeiter.",
    "mockConsequence": "Ohne Einwilligung bleibt die Demo-Verarbeitung nicht verfügbar.",
    "mockTerms": "Das umfasst Gesprächsdaten, Fassung 1, für zwölf Monate. Einwilligungen liegen nur im Arbeitsspeicher; erteilen Sie sie nach einem Serverneustart erneut.",
    "consentUse": {
      "html": "Die lokalen Demo-Modelle, die Test-Sprache und die Testentwürfe (lokaler Klick-Entwurf) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und klickbare Entwürfe zu erstellen.",
      "images": "Die lokalen Demo-Modelle, die Test-Sprache und die Testbilder (lokales PNG) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und Entwürfe zu zeichnen.",
      "off": "Die lokalen Demo-Modelle und die Test-Sprache verwenden Ihr Gespräch, um zu antworten und ein Verständnis aufzubauen."
    }
  },
  "en": {
    "consentTitle": "Demo conversation consent",
    "mockRecipients": "Recipient: the local demo; no upstream processors.",
    "mockConsequence": "Without consent, demo processing remains unavailable.",
    "mockTerms": "This covers conversation data, item version 1, for twelve months. Grants live in memory; grant again after a server restart.",
    "consentUse": {
      "html": "The local demo models, simulated voice and clickable demo drafts use your conversation to reply, build understanding and draft clickable concepts.",
      "images": "The local demo models, simulated voice and test images (local PNG) use your conversation to reply, build understanding and draw concepts.",
      "off": "The local demo models and simulated voice use your conversation to reply and build understanding."
    }
  }
};
for (const bundle of [de, en]) test(`AIT-231 ${bundle.display.locale}: demo consent uses the approved wording; defaults make no persistence promise`, () => {
  const before = structuredClone(bundle), demo = withDemoConsentCopy(bundle), host = demo.host;
  const visible = { consentTitle: host.consentTitle, mockRecipients: host.consentPage.mockRecipients,
    mockConsequence: host.consentPage.mockConsequence, mockTerms: host.consentPage.mockTerms, consentUse: host.consentUse };
  assert.deepEqual(Buffer.from(JSON.stringify(visible)), Buffer.from(JSON.stringify(previous[bundle.display.locale])));
  const previousProcessing = bundle.display.locale === 'de' ? START_GERMAN_CONSENT : { intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL };
  for (const key of ['intro', 'withdrawal']) assert.deepEqual(Buffer.from(demo.processingConsent[key]), Buffer.from(previousProcessing[key]), key);
  assert.deepEqual(bundle, before, 'the demo never mutates the shipped defaults');
  const defaults = JSON.stringify({ intro: bundle.processingConsent.intro, withdrawal: bundle.processingConsent.withdrawal, title: bundle.host.consentTitle, use: bundle.host.consentUse,
    mockIntro: bundle.host.consentPage.intro, recipients: bundle.host.consentPage.mockRecipients,
    consequence: bundle.host.consentPage.mockConsequence, terms: bundle.host.consentPage.mockTerms });
  assert.doesNotMatch(defaults, /twelve|zwölf|Monat|month|year|Jahr|browser|stored|gespeichert|persist|Speicher|until|bis|memory|restart|Arbeitsspeicher|Serverneustart|local demo|lokalen Demo|simulated voice|Test-Sprache/iu);
});

test('AIT-228: mock consent intro uses Tick-approved EN wording and its existing DE mirror', () => {
  assert.equal(withDemoConsentCopy(en).host.consentPage.intro, "Choose which processing you allow for this conversation. Items you don't select are not allowed.");
  assert.equal(withDemoConsentCopy(de).host.consentPage.intro, 'Wählen Sie, welche Verarbeitung Sie für dieses Gespräch erlauben. Nicht ausgewählte Punkte sind nicht freigegeben.');
});
