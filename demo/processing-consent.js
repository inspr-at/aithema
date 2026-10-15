import { processingScope, MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';
import { manifest as voiceManifest } from '@inspr/aithema-plugin-elevenlabs/manifest';
import { modelProvider } from './model-provider.js';

// Reasoning/voice copy is ported verbatim from START consentCopy.en. The separate
// drafts item follows its optional images item; no retention guarantee is inferred.
export const CONSENT_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;
export const CONSENT_COPY_VERSION = 'consent-page-2026-10-12-drafts-1';
export const CONSENT_ITEMS = [
  { id: 'models-international', version: 1, title: 'AI models, international',
    recipients: 'OpenRouter, Inc. and the model provider you select: OpenAI, Anthropic or xAI. Processing can take place outside Europe, including in the United States.',
    text: 'Your messages, text read from uploaded files, the conversation history and the resulting assessment are sent to generate answers and assessments. Processing without retention is not guaranteed.' },
  voiceManifest.presentation.translations.find(item => item.locale === 'en').consentItem,
  { id: 'drafts-anthropic', version: 1, title: 'AI drafts (Anthropic)',
    recipients: 'OpenRouter, Inc. and Anthropic PBC, United States.',
    text: 'Your conversation, text read from uploaded files and the current assessment are sent to generate clickable draft screens. Processing without retention is not guaranteed.' },
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
  const drafts = binding.plugin === 'claude-html';
  const providers = { openai: 'OpenAI', anthropic: 'Anthropic', 'x-ai': 'xAI' };
  const provider = modelProvider(binding.model);
  if (!voice && !(drafts && provider === 'anthropic') &&
    (binding.plugin !== 'openrouter' || !Object.hasOwn(providers, provider))) throw new TypeError('Model provider not covered by START consent');
  return { ...binding, legal: { approved: true, countries: ['US'], training: true, retention: 'retained',
    purpose: voice ? 'voice-elevenlabs' : drafts ? 'drafts-anthropic' : 'models-international',
    recipient: voice ? 'ElevenLabs, Inc.' : 'OpenRouter, Inc.', processors: voice ? [] : [drafts ? 'Anthropic PBC' : providers[provider]],
    dataCategories: voice ? ['speech-input', 'transcription', 'spoken-answers'] : ['messages', 'file-text', 'conversation-history', 'assessment'],
    consentVersion: 1, evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: binding.routing ?? {}, verifiedAt: now,
      ...(drafts ? { processor: 'Anthropic PBC' } : {}),
      expiresAt: now + 90 * 24 * 60 * 60 * 1000,
      sources: drafts ? ['demo/html-config.js', 'demo/processing-consent.js'] :
        ['START src/lib/config.ts', 'START src/lib/engine-runtime.ts', 'START src/lib/consent-items.ts', 'START src/lib/i18n.ts'] } } };
}

/** Durable authoritative state + value-free evidence, as in START src/lib/consent-ledger.ts.
 * A mock grant has no item selection/contract and can never authorize these scopes.
 */
export function createProcessingConsent({ storage, bindings, voiceConfigured = false, voiceBinding, now = Date.now }) {
  // HTML requires its own purpose; reasoning grants never authorize drafts.
  const coveredBindings = bindings.filter(binding => binding.plugin !== 'claude-html' || binding.legal?.purpose === 'drafts-anthropic');
  const allowed = coveredBindings.filter(binding => !voiceBinding || binding.plugin !== 'elevenlabs').flatMap(binding => (binding.plugin === 'elevenlabs' ? ['start'] : binding.plugin === 'claude-html' ? ['generate', 'edit'] : ['stream', 'structured'])
    .map(operation => processingScope(binding, operation)));
  const modelProviders = [...new Set(bindings.filter(b => b.plugin === 'openrouter').map(b => modelProvider(b.model)))];
  // The configured processing contract is stable even while voice is unavailable.
  // Its exact dispatch scope comes from the atomically published runtime binding.
  const items = CONSENT_ITEMS.filter(item => (item.id === 'voice-elevenlabs' && voiceConfigured) || coveredBindings.some(binding => binding.legal?.purpose === item.id &&
    (item.id !== 'drafts-anthropic' || binding.plugin === 'claude-html')));
  const contract = [CONSENT_COPY_VERSION, items.map(item => `${item.id}:${item.version}`).join(','), modelProviders.join(',')].join('|');
  const validDecision = decision => decision?.contract === contract && Array.isArray(decision.items) &&
    new Set(decision.items).size === decision.items.length && decision.items.every(id => items.some(item => item.id === id));
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS processing_consents (session_id TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL,
    grants TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS processing_consent_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    revision INTEGER NOT NULL, at INTEGER NOT NULL, items TEXT NOT NULL, copy_version TEXT NOT NULL);`);
  const describe = sessionId => {
    const row = sessionId ? db.prepare('SELECT * FROM processing_consents WHERE session_id=?').get(sessionId) : null;
    const session = sessionId ? storage.get(sessionId) : null, at = now();
    const grants = row && !session.tombstone && !session.consentWithdrawn && row.revision === session.consentRevision ? JSON.parse(row.grants) : {};
    const selected = items.filter(item => { const grant = grants[item.id]; return grant?.contract === contract && grant.version === item.version &&
      grant.at <= at && at - grant.at < CONSENT_VALIDITY_MS; }).map(item => item.id);
    return { contract, items, optional: items.filter(item => item.id === 'drafts-anthropic').map(item => item.id),
      intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL, selected };
  };
  return { describe,
    conversationUnchanged({ sessionId, decision }) {
      if (!validDecision(decision)) return false;
      // Only the separate draft item may change without the conversation's D5
      // cascade. Expired or withdrawn grants cannot authorize preservation.
      const conversation = selected => selected.filter(id => id !== 'drafts-anthropic').sort();
      const before = conversation(describe(sessionId).selected), after = conversation(decision.items);
      return before.length > 0 && JSON.stringify(before) === JSON.stringify(after);
    },
    grant({ sessionId, consentRevision, decision }) {
      if (!validDecision(decision)) return false;
      storage.transaction(() => {
        const session = storage.get(sessionId);
        if (session.tombstone || consentRevision !== session.consentRevision + 1) throw new Error('Consent revision changed');
        const at = now(), grants = Object.fromEntries(decision.items.map(id => [id, { at, version: 1, contract,
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
      if (!Object.values(grants).length || Object.values(grants).some(grant => grant.contract !== contract)) return { covered: false };
      // An explicit decision may also permit the local mock reasoning used for local tests.
      if (JSON.stringify(scope) === JSON.stringify(MOCK_PROCESSING_SCOPE)) return { covered: true, ...scope,
        consentRevision, expiresAt: Math.min(...Object.values(grants).map(g => g.at + CONSENT_VALIDITY_MS)) };
      const currentVoice = voiceBinding?.();
      const scopes = currentVoice ? [...allowed, processingScope(currentVoice, 'start')] : allowed;
      if (!scopes.some(entry => JSON.stringify(entry) === JSON.stringify(scope))) return { covered: false };
      const grant = grants[scope.purpose], at = now();
      if (!grant || grant.contract !== contract || grant.version !== scope.itemVersion || grant.at > at || at - grant.at >= CONSENT_VALIDITY_MS ||
        scope.plugin === 'openrouter' && !grant.providers?.includes(modelProvider(scope.model))) return { covered: false };
      return { covered: true, ...scope, scope: structuredClone(scope), consentRevision, checkedAt: at,
        expiresAt: grant.at + CONSENT_VALIDITY_MS };
    },
  };
}
