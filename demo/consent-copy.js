// This demo supplies its own consent terms: the mock ledger is memory-only,
// while real processing keeps the existing START twelve-month introduction.
// Neither describes the ledgers of embedding hosts.
const processingCopy = {
  de: {
    intro: 'Legen Sie einmal fest, welche Verarbeitung Sie freigeben. Ihre Auswahl gilt in diesem Browser, bis Sie sie ändern oder widerrufen, höchstens zwölf Monate. Solange die gewählte Verarbeitung hier freigegeben ist, können Sie Einstellungen ändern, ohne erneut zuzustimmen. Punkte mit unterschiedlichen Empfängern oder Zwecken sind getrennt aufgeführt. Nicht ausgewählte Punkte sind nicht freigegeben.',
  },
  en: {
    intro: 'Choose once which processing you allow. Your choice applies in this browser until you change or withdraw it, for at most twelve months. As long as the selected processing is covered here, you can change settings without agreeing again. Items with different recipients or purposes are listed separately. Unselected items are not granted.',
  },
};
const hostCopy = {
  de: {
    slots: { licenseShort: 'AGPL-3.0', legalSourceShort: 'Quellcode' },
    consentTitle: 'Einwilligung für das Demo-Gespräch',
    consentUse: {
      html: 'Die lokalen Demo-Modelle, die Test-Sprache und die Testentwürfe (lokaler Klick-Entwurf) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und klickbare Entwürfe zu erstellen.',
      images: 'Die lokalen Demo-Modelle, die Test-Sprache und die Testbilder (lokales PNG) verwenden Ihr Gespräch, um zu antworten, ein Verständnis aufzubauen und Entwürfe zu zeichnen.',
      off: 'Die lokalen Demo-Modelle und die Test-Sprache verwenden Ihr Gespräch, um zu antworten und ein Verständnis aufzubauen.',
    },
    consentPage: {
      mockRecipients: 'Empfänger: die lokale Demo; keine weiteren Auftragsverarbeiter.',
      mockConsequence: 'Ohne Einwilligung bleibt die Demo-Verarbeitung nicht verfügbar.',
      mockTerms: 'Das umfasst Gesprächsdaten, Fassung 1, für zwölf Monate. Einwilligungen liegen nur im Arbeitsspeicher; erteilen Sie sie nach einem Serverneustart erneut.',
    },
  },
  en: {
    slots: { licenseShort: 'AGPL-3.0', legalSourceShort: 'Source' },
    consentTitle: 'Demo conversation consent',
    consentUse: {
      html: 'The local demo models, simulated voice and clickable demo drafts use your conversation to reply, build understanding and draft clickable concepts.',
      images: 'The local demo models, simulated voice and test images (local PNG) use your conversation to reply, build understanding and draw concepts.',
      off: 'The local demo models and simulated voice use your conversation to reply and build understanding.',
    },
    consentPage: {
      mockRecipients: 'Recipient: the local demo; no upstream processors.',
      mockConsequence: 'Without consent, demo processing remains unavailable.',
      mockTerms: 'This covers conversation data, item version 1, for twelve months. Grants live in memory; grant again after a server restart.',
    },
  },
};
export function withDemoConsentCopy(copy) {
  const host = hostCopy[copy.display.locale];
  return { ...copy, processingConsent: { ...copy.processingConsent, ...processingCopy[copy.display.locale] }, host: { ...copy.host, ...host,
    slots: { ...copy.host.slots, ...host.slots }, consentPage: { ...copy.host.consentPage, ...host.consentPage } } };
}
