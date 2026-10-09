// Frozen legal fixture: START src/lib/i18n.ts, consentCopy.de.
// CI uses this fixture, never a sibling START checkout.
export const START_GERMAN_CONSENT = {
  // START src/lib/i18n.ts:2739.
  intro: 'Legen Sie einmal fest, welche Verarbeitung Sie freigeben. Ihre Auswahl gilt in diesem Browser, bis Sie sie ändern oder widerrufen, höchstens zwölf Monate. Solange die gewählte Verarbeitung hier freigegeben ist, können Sie Einstellungen ändern, ohne erneut zuzustimmen. Punkte mit unterschiedlichen Empfängern oder Zwecken sind getrennt aufgeführt. Nicht ausgewählte Punkte sind nicht freigegeben.',
  // START src/lib/i18n.ts:2747.
  withdrawal: 'Sie können Freigaben hier jederzeit widerrufen. Bereits erfolgte Übermittlungen werden dadurch nicht rückgängig gemacht.',
  items: {
    // Stable id: START src/lib/consent-items.ts:16.
    'models-international': {
      // START src/lib/i18n.ts:2751.
      title: 'KI-Modelle international',
      // START src/lib/i18n.ts:2752.
      recipients: 'OpenRouter, Inc. und der von Ihnen gewählte Modellanbieter: OpenAI, Anthropic oder xAI. Die Verarbeitung kann außerhalb Europas stattfinden, auch in den USA.',
      // START src/lib/i18n.ts:2753.
      text: 'Ihre Nachrichten, der aus hochgeladenen Dateien gelesene Text, der Gesprächsverlauf und die daraus erstellte Einschätzung werden übermittelt, um Antworten und Einschätzungen zu erzeugen. Eine Verarbeitung ohne Speicherung ist nicht zugesichert.',
    },
    // Stable id: START src/lib/consent-items.ts:18.
    'voice-elevenlabs': {
      // START src/lib/i18n.ts:2761.
      title: 'Sprache mit ElevenLabs',
      // START src/lib/i18n.ts:2762.
      recipients: 'ElevenLabs, Inc., USA.',
      // START src/lib/i18n.ts:2763.
      text: 'Ihre Spracheingabe, die Live-Transkription und die gesprochenen Antworten verarbeitet ElevenLabs. Die Antworten selbst entstehen über den Punkt KI-Modelle international.',
    },
  },
};

// Grepped from core presets/consent and server plugin-runtime/handlers; the wire
// strings themselves remain the stable codes. Compound voice reasons wrap these.
export const FEATURE_REASON_CODES = [
  'session paused', 'current processing consent required', 'consent port unavailable', 'not configured',
  'unavailable on device', 'plugin not registered', 'plugin not in preset', 'preset not configured', 'preset choices invalid',
  'unknown preset', 'browser only', 'device browser only', 'model not supported', 'effort not supported',
  'manifest evidence expired', 'binding evidence unverified', 'binding evidence mismatch', 'binding evidence not yet valid',
  'binding evidence expired', 'binding invalid', 'processing scope invalid', 'processing residency unverified',
  'processing residency denied', 'training policy denied', 'endpoint not allowed', 'plugin binding mismatch',
  'plugin kind unsupported', 'operation unsupported', 'invalid mock budget', 'plugin unhealthy', 'admission deadline',
  'budget denied', 'concept storage limit', 'voice off', 'visuals off', 'visual kind not selected', 'visual kind invalid',
  'model not offered', 'effort not offered', 'voice not offered', 'visuals not offered', 'HTML format unsupported',
  'HTML consent scope unavailable: START has no matching HTML item',
  // server ui-render-limits/spend-cap and OpenRouter plugin/facade.
  'UI render limit reached for this session', 'UI render limit reached for this UTC day',
  'OpenRouter spend cap exhausted', 'OpenRouter request exceeds spend reservation',
  // claude-html health and ElevenLabs health.
  'cost ceiling breached', 'spend cap reached', 'spend ledger unreadable', 'credential unavailable',
];

// Server voice-handlers, handlers invalidation, core live-voice and ElevenLabs
// server/client lifecycle, plus demo start2-voice-host and ensure-agent failures.
export const VOICE_REASON_CODES = [
  'closed', 'cancelled', 'transport-lost', 'recovery-failed', 'closure-uncertain', 'spend-deadline', 'browser-liveness-deadline',
  'start-cancelled', 'start-failed', 'pause-failed', 'call-authorization-lost', 'session-revoked', 'server-restart', 'server-stopping',
  'transcript-persistence-failed', 'provider-identity-mismatch', 'transcript-limit', 'turn-withdrawn', 'consent-revised',
  'session-erased', 'consent-withdrawn', 'turn-expired', 'voice-host-unavailable', 'template-agent-required', 'public-origin-invalid',
  'api-base-invalid', 'voice-secret-unavailable', 'agent-api-unavailable', 'agent-list-incomplete', 'agent-list-invalid',
  'agent-name-ambiguous', 'template-agent-write-forbidden', 'agent-ownership-unproven', 'template-voice-invalid',
  'secret-list-invalid', 'secret-name-ambiguous', 'secret-ownership-unproven', 'secret-create-invalid', 'agent-create-invalid',
  'agent-readback-mismatch',
];
