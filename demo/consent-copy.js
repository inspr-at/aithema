// These statements describe this demo's local, memory-only ledger. They are not
// defaults for embedding hosts, whose ledgers can persist across restarts.
const hostCopy = {
  de: {
    consentTitle: 'Einwilligung für das Mock-Gespräch',
    consentUse: {
      html: 'Die lokalen Demo-Modelle, die Test-Sprache und die Testentwürfe (lokaler Klick-Entwurf) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und klickbare Entwürfe zu erstellen.',
      images: 'Die lokalen Demo-Modelle, die Test-Sprache und die Testbilder (lokales PNG) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und Entwürfe zu zeichnen.',
      off: 'Die lokalen Demo-Modelle und die Test-Sprache verwenden Ihr Gespräch, um zu antworten und ein Verständnis aufzubauen.',
    },
    consentPage: {
      mockRecipients: 'Empfänger: der lokale Mock; keine weiteren Auftragsverarbeiter.',
      mockConsequence: 'Ohne Einwilligung bleibt die Mock-Verarbeitung nicht verfügbar.',
      mockTerms: 'Das umfasst Gesprächsdaten, Fassung 1, für zwölf Monate. Einwilligungen liegen nur im Arbeitsspeicher; erteilen Sie sie nach einem Serverneustart erneut.',
    },
  },
  en: {
    consentTitle: 'Mock conversation consent',
    consentUse: {
      html: 'The local demo models, fake voice and test drafts (local click-dummy) use your conversation to reply, build understanding and draft clickable concepts.',
      images: 'The local demo models, fake voice and test images (local PNG) use your conversation to reply, build understanding and draw concepts.',
      off: 'The local demo models and fake voice use your conversation to reply and build understanding.',
    },
    consentPage: {
      mockRecipients: 'Recipient: the local mock; no upstream processors.',
      mockConsequence: 'Without consent, mock processing remains unavailable.',
      mockTerms: 'This covers conversation data, item version 1, for twelve months. Grants live in memory; grant again after a server restart.',
    },
  },
};
export function withDemoConsentCopy(copy) {
  const host = hostCopy[copy.display.locale];
  return { ...copy, host: { ...copy.host, ...host, consentPage: { ...copy.host.consentPage, ...host.consentPage } } };
}
