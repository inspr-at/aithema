import { processingScope, MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';
import { matchingHTMLReasoning } from './html-config.js';

// Ported verbatim from START src/lib/consent-items.ts and the English items in
// src/lib/i18n.ts (consentCopy.en). No EU or zero-retention entitlement is inferred.
export const CONSENT_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;
export const CONSENT_COPY_VERSION = 'consent-page-2026-09-16-2';
export const CONSENT_ITEMS = [
  { id: 'models-international', version: 1, title: 'AI models, international',
    recipients: 'OpenRouter, Inc. and the model provider you select: OpenAI, Anthropic or xAI. Processing can take place outside Europe, including in the United States.',
    text: 'Your messages, text read from uploaded files, the conversation history and the resulting assessment are sent to generate answers and assessments. Processing without retention is not guaranteed.' },
  { id: 'voice-elevenlabs', version: 1, title: 'Voice with ElevenLabs',
    recipients: 'ElevenLabs, Inc., United States.',
    text: 'Your speech input, the live transcription and the spoken answers are processed by ElevenLabs. The answers themselves are generated under the item AI models, international.' },
];
export const CONSENT_INTRO = 'Choose once which processing you allow. Your choice applies in this browser until you change or withdraw it, for at most twelve months. As long as the selected processing is covered here, you can change settings without agreeing again. Items with different recipients or purposes are listed separately. Unselected items are not granted.';
export const CONSENT_WITHDRAWAL = 'You can withdraw consent here at any time. Withdrawal does not undo transfers that have already taken place.';

/** Account evidence port of START's international route, deliberately conservative.
 * START src/lib/config.ts elevenLabsAgentsSettings: self-serve api.elevenlabs.io,
 * US processing, without retention guarantees. src/lib/providers/elevenlabs.ts:
 * Enterprise residency/ZRM cannot be inferred from config flags. src/lib/engine-runtime.ts
 * admits this route only with configuration and current separate processing grants.
 * `training:true` here means we cannot qualify a no-training policy, not an assertion
 * that the provider trains. This host never enables EU or no-training presets.
 */
export function qualifyStartBinding(binding, now = Date.now()) {
  const voice = binding.plugin === 'elevenlabs';
  const providers = { openai: 'OpenAI', anthropic: 'Anthropic', 'x-ai': 'xAI' };
  const provider = binding.model.split('/')[0];
  if (!voice && (binding.plugin !== 'openrouter' || !providers[provider])) throw new TypeError('Model provider not covered by START consent');
  return { ...binding, legal: { approved: true, countries: ['US'], training: true, retention: 'retained',
    purpose: voice ? 'voice-elevenlabs' : 'models-international',
    recipient: voice ? 'ElevenLabs, Inc.' : 'OpenRouter, Inc.', processors: voice ? [] : [providers[provider]],
    dataCategories: voice ? ['speech-input', 'transcription', 'spoken-answers'] : ['messages', 'file-text', 'conversation-history', 'assessment'],
    consentVersion: 1, evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: binding.routing ?? {}, verifiedAt: now,
      expiresAt: now + 90 * 24 * 60 * 60 * 1000,
      sources: ['START src/lib/config.ts', 'START src/lib/engine-runtime.ts', 'START src/lib/consent-items.ts', 'START src/lib/i18n.ts'] } } };
}

/** Durable authoritative state + value-free evidence, as in START src/lib/consent-ledger.ts.
 * A mock grant has no item selection/contract and can never authorize these scopes.
 */
export function createProcessingConsent({ storage, bindings, now = Date.now }) {
  // HTML entries must carry the qualification from coverHTMLBinding: a reasoning
  // grant is not stretched to a different recipient or routing configuration.
  const coveredBindings = bindings.filter(binding => binding.plugin !== 'claude-html' || binding.legal?.purpose === 'models-international' &&
    matchingHTMLReasoning(binding, bindings));
  const allowed = coveredBindings.flatMap(binding => (binding.plugin === 'elevenlabs' ? ['start'] : binding.plugin === 'claude-html' ? ['generate', 'edit'] : ['stream', 'structured'])
    .map(operation => processingScope(binding, operation)));
  const modelProviders = [...new Set(bindings.filter(b => b.plugin === 'openrouter').map(b => b.model.split('/')[0]))];
  const items = CONSENT_ITEMS.filter(item => bindings.some(binding => binding.legal?.purpose === item.id));
  const contract = [CONSENT_COPY_VERSION, items.map(item => `${item.id}:${item.version}`).join(','), modelProviders.join(',')].join('|');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS processing_consents (session_id TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL,
    grants TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS processing_consent_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    revision INTEGER NOT NULL, at INTEGER NOT NULL, items TEXT NOT NULL, copy_version TEXT NOT NULL);`);
  const describe = sessionId => ({ contract, items, intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL,
    selected: sessionId ? Object.keys(JSON.parse(db.prepare('SELECT grants FROM processing_consents WHERE session_id=?').get(sessionId)?.grants ?? '{}')) : [] });
  return { describe,
    grant({ sessionId, consentRevision, decision }) {
      if (!decision || decision.contract !== contract || !Array.isArray(decision.items) ||
        new Set(decision.items).size !== decision.items.length || decision.items.some(id => !items.some(item => item.id === id))) return false;
      storage.transaction(() => {
        const session = storage.get(sessionId);
        if (session.tombstone || consentRevision !== session.consentRevision + 1) throw new Error('Consent revision changed');
        const at = now(), grants = Object.fromEntries(decision.items.map(id => [id, { at, version: 1,
          ...(id === 'models-international' ? { providers: modelProviders } : {}) }]));
        db.prepare(`INSERT INTO processing_consents VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET
          revision=excluded.revision,grants=excluded.grants`).run(sessionId, consentRevision, JSON.stringify(grants));
        db.prepare('INSERT INTO processing_consent_events(session_id,revision,at,items,copy_version) VALUES (?,?,?,?,?)')
          .run(sessionId, consentRevision, at, JSON.stringify(decision.items), CONSENT_COPY_VERSION);
      });
      return true;
    },
    withdraw({ sessionId }) {
      storage.transaction(() => {
        const session = storage.get(sessionId);
        db.prepare('DELETE FROM processing_consents WHERE session_id=?').run(sessionId);
        db.prepare('INSERT INTO processing_consent_events(session_id,revision,at,items,copy_version) VALUES (?,?,?,?,?)')
          .run(sessionId, session.consentRevision, now(), '[]', CONSENT_COPY_VERSION);
      });
    },
    coverage({ sessionId, consentRevision, scope }) {
      const session = storage.get(sessionId), row = db.prepare('SELECT * FROM processing_consents WHERE session_id=?').get(sessionId);
      if (!row || session.tombstone || session.consentWithdrawn || session.consentRevision !== consentRevision || row.revision !== consentRevision) return { covered: false };
      const grants = JSON.parse(row.grants);
      // An explicit decision may also permit the local mock reasoning used for local tests.
      if (JSON.stringify(scope) === JSON.stringify(MOCK_PROCESSING_SCOPE)) return { covered: true, ...scope,
        consentRevision, expiresAt: Math.min(...Object.values(grants).map(g => g.at + CONSENT_VALIDITY_MS)) };
      if (!allowed.some(entry => JSON.stringify(entry) === JSON.stringify(scope))) return { covered: false };
      const grant = grants[scope.purpose], at = now();
      if (!grant || grant.version !== scope.itemVersion || grant.at > at || at - grant.at >= CONSENT_VALIDITY_MS ||
        scope.plugin === 'openrouter' && !grant.providers?.includes(scope.model.split('/')[0])) return { covered: false };
      return { covered: true, ...scope, scope: structuredClone(scope), consentRevision, checkedAt: at,
        expiresAt: grant.at + CONSENT_VALIDITY_MS };
    },
  };
}
