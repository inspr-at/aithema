import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { withDemoConsentCopy } from '../consent-copy.js';

// Visible strings frozen from the assigned base 75cb5385, before extraction.
const previous = {
  "de": {
    "consentTitle": "Einwilligung für das Mock-Gespräch",
    "mockRecipients": "Empfänger: der lokale Mock; keine weiteren Auftragsverarbeiter.",
    "mockConsequence": "Ohne Einwilligung bleibt die Mock-Verarbeitung nicht verfügbar.",
    "mockTerms": "Das umfasst Gesprächsdaten, Fassung 1, für zwölf Monate. Einwilligungen liegen nur im Arbeitsspeicher; erteilen Sie sie nach einem Serverneustart erneut.",
    "consentUse": {
      "html": "Die lokalen Demo-Modelle, die Test-Sprache und die Testentwürfe (lokaler Klick-Entwurf) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und klickbare Entwürfe zu erstellen.",
      "images": "Die lokalen Demo-Modelle, die Test-Sprache und die Testbilder (lokales PNG) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und Entwürfe zu zeichnen.",
      "off": "Die lokalen Demo-Modelle und die Test-Sprache verwenden Ihr Gespräch, um zu antworten und ein Verständnis aufzubauen."
    }
  },
  "en": {
    "consentTitle": "Mock conversation consent",
    "mockRecipients": "Recipient: the local mock; no upstream processors.",
    "mockConsequence": "Without consent, mock processing remains unavailable.",
    "mockTerms": "This covers conversation data, item version 1, for twelve months. Grants live in memory; grant again after a server restart.",
    "consentUse": {
      "html": "The local demo models, fake voice and test drafts (local click-dummy) use your conversation to reply, build understanding and draft clickable concepts.",
      "images": "The local demo models, fake voice and test images (local PNG) use your conversation to reply, build understanding and draw concepts.",
      "off": "The local demo models and fake voice use your conversation to reply and build understanding."
    }
  }
};
for (const bundle of [de, en]) test(`AIT-231 ${bundle.display.locale}: demo consent copy stays byte-equal; defaults make no persistence promise`, () => {
  const before = structuredClone(bundle), demo = withDemoConsentCopy(bundle), host = demo.host;
  const visible = { consentTitle: host.consentTitle, mockRecipients: host.consentPage.mockRecipients,
    mockConsequence: host.consentPage.mockConsequence, mockTerms: host.consentPage.mockTerms, consentUse: host.consentUse };
  assert.deepEqual(Buffer.from(JSON.stringify(visible)), Buffer.from(JSON.stringify(previous[bundle.display.locale])));
  assert.deepEqual(bundle, before, 'the demo never mutates the shipped defaults');
  const defaults = JSON.stringify({ title: bundle.host.consentTitle, use: bundle.host.consentUse,
    recipients: bundle.host.consentPage.mockRecipients, terms: bundle.host.consentPage.mockTerms });
  assert.doesNotMatch(defaults, /memory|restart|twelve months|Arbeitsspeicher|Serverneustart|zwölf Monate|local demo|lokalen Demo|fake voice|Test-Sprache/iu);
});
