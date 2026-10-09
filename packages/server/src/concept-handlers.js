import { ConceptLane, syncConceptIntent, expressedVisualWish, reduceConceptIntent, inputRevision, PluginError, MAX_UI_REFERENCES, validateUIReferences } from '@inspr/aithema-core';
import { NotFoundError, ConflictError } from './storage.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
export function createConceptHandlers({ storage, runtime, ownership, readBody, publish, signal, policy, deadlineMs, estimateMs,
  references = () => [] }) {
  const prepare = session => {
    const history = session.concepts ?? [];
    const previous = history.filter(c => !c.archived && c.feedback?.vote !== 'down').at(-1);
    const rejected = history.filter(c => c.archived || c.feedback?.vote === 'down').slice(-3);
    const chosen = [...(previous ? [{ item: previous, role: 'previous' }] : []), ...rejected.map(item => ({ item, role: 'rejected' }))];
    const extras = references(session); // trusted host storage port, never request bytes/URLs
    if (!Array.isArray(extras)) throw new TypeError('Invalid concept reference port');
    const selected = [...chosen.map(({ item, role }) => {
      const artifact = storage.conceptArtifact(session.id, item.id);
      if (artifact.erased) return null;
      return { id: item.id, bytes: artifact.bytes, mediaType: artifact.mediaType, role };
    }).filter(Boolean), ...extras].slice(0, MAX_UI_REFERENCES);
    const privateReferences = selected.map(({ bytes, mediaType, role }) => ({ bytes, mediaType, role }));
    validateUIReferences(privateReferences);
    if (selected.some(r => !identifier(r.id))) throw new TypeError('Invalid concept reference identity');
    return { references: privateReferences, referenceIds: selected.map(r => r.id), refreshReferenceIds: extras.map(r => r.id),
      feedback: JSON.stringify(history.filter(c => c.feedback?.vote !== 'clear' || c.feedback?.chips?.length)
        .slice(-8).map(c => ({ artifactId: c.id, vote: c.feedback?.vote, guidance: c.feedback?.chips ?? [], rejected: c.archived }))) };
  };
  const lane = new ConceptLane({ getSession: id => storage.get(id), prepare, policy, deadlineMs, estimateMs,
    admit: args => runtime.admit(args), publicationAllowed: (session, options) => runtime.publicationAllowed(session, options),
    persist(id, data) { const event = storage.append(id, 'concept.state', data); if (event) publish(id, event); return event; },
    complete(id, artifact, metadata, data) { const event = storage.completeConcept(id, artifact, metadata, data); publish(id, event); return event; } });
  const schedule = (id, trigger = 'progress') => lane.run(id, { trigger, signal }).catch(() => {});
  async function gate(session, { read = false, operation = 'generate' } = {}) {
    if (session.tombstone || session.consentWithdrawn || !read && session.paused) throw new PluginError('not-admitted');
    if (read) {
      if (!await runtime.publicationAllowed(session, { operation })) throw new PluginError('not-admitted');
    } else {
      const matrix = await runtime.matrix(session);
      if (!matrix[session.processingPreset ?? 'best']?.images?.available) throw new PluginError('not-admitted');
    }
  }
  return { lane, schedule,
    onTurn(id, turnId) {
      const session = storage.get(id), turn = session.transcript.find(t => t.id === turnId && t.role === 'user' && !t.erased);
      if (turn && expressedVisualWish(turn.content) && session.conceptIntent?.visualIntent?.id !== turnId) lane.recordIntent(id, { intentId: turnId, sourceTurnId: turnId });
      schedule(id);
    },
    async handle(request) {
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})\/concepts(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(image|provenance|feedback|regenerate|reject))?)?$/u.exec(new URL(request.url).pathname);
      if (!match) return null;
      const [, id, artifactId, action] = match;
      const ownerToken = ownership.token(request), session = storage.authorize(id, ownerToken);
      const guard = { ownerToken, revision: inputRevision(session) };
      if (request.method === 'GET') {
        const stored = artifactId ? storage.conceptArtifact(id, artifactId) : null;
        if (stored?.erased) throw new NotFoundError();
        await gate(session, { read: true, operation: stored?.referenceIds.length ? 'edit' : 'generate' }); storage.authorize(id, ownerToken);
        if (!artifactId) return json({ items: storage.get(id).concepts ?? [], intent: storage.get(id).conceptIntent,
          status: storage.get(id).conceptStatus, cost: runtime.imageQuote(session) });
        const artifact = storage.conceptArtifact(id, artifactId); if (artifact.erased) throw new NotFoundError();
        if (action === 'provenance') return json(artifact.provenance);
        if (action === 'image') return new Response(artifact.bytes, { headers: { 'content-type': artifact.mediaType,
          'content-length': String(artifact.bytes.length), 'cache-control': 'private, no-store', 'vary': 'Cookie, x-aithema-session-token',
          'x-content-type-options': 'nosniff', 'content-digest': artifact.provenance.subject.contentDigest,
          'x-aithema-origin': artifact.provenance.origin,
          'content-disposition': `${new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline'}; filename="concept-${artifactId}.${artifact.mediaType.split('/')[1]}"` } });
        return json({ error: 'not-found' }, 404);
      }
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
      const bytes = await readBody(request), body = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!body || !identifier(body.clientEventId)) throw new TypeError('Concept action requires client id');
      await gate(session);
      if (artifactId && !storage.get(id).concepts?.some(c => c.id === artifactId)) throw new NotFoundError();
      let trigger;
      const result = storage.conceptAction(id, body.clientEventId, bytes, current => {
        if (!artifactId || action === 'regenerate') {
          if (body.intent !== true || !identifier(body.sourceTurnId) || !current.transcript.some(t => t.id === body.sourceTurnId && t.role === 'user' && !t.erased && !t.withdrawn)) throw new TypeError('Recorded person intent required');
          if (current.conceptIntent?.pending) throw new ConflictError('Concept already pending');
          const prepared = prepare(current);
          let intent = syncConceptIntent(current, prepared.referenceIds, { policy, refreshReferenceIds: prepared.refreshReferenceIds });
          intent = reduceConceptIntent(intent, { type: 'intent-recorded', id: body.clientEventId, sourceTurnId: body.sourceTurnId, now: Date.now() }, policy);
          intent = syncConceptIntent({ ...current, conceptIntent: intent }, prepared.referenceIds, { policy, refreshReferenceIds: prepared.refreshReferenceIds });
          // Initial requests wait for understanding. Explicit retries/refinements
          // may use manual planning after a previously admitted attempt.
          trigger = artifactId || current.conceptStatus?.phase === 'failed' ? 'manual' : 'progress';
          return { type: 'concept.state', data: { intent, status: { phase: 'waiting' } } };
        }
        if (!['feedback', 'reject'].includes(action) || !['up', 'down', 'clear'].includes(body.vote ?? 'clear') ||
          !Array.isArray(body.chips ?? []) || (body.chips ?? []).length > 8 ||
          (body.chips ?? []).some(c => typeof c !== 'string' || !c.trim() || c.length > 160)) throw new TypeError('Invalid concept feedback');
        return { type: 'concept.feedback', data: { artifactId, vote: action === 'reject' ? 'down' : body.vote ?? 'clear',
          chips: [...new Set(body.chips ?? [])], archived: action === 'reject' || current.concepts.find(c => c.id === artifactId).archived } };
      }, guard);
      if (!result.replayed) { publish(id, result.event); if (trigger) schedule(id, trigger); }
      return json({ accepted: true, ...result }, trigger && !result.replayed ? 202 : 200);
    },
    async resume() {
      for (const id of storage.list()) {
        const session = storage.get(id);
        if (!session.tombstone && session.conceptIntent?.pending) {
          // Recovery never repeats a dispatched image. A new explicit retry needs
          // a new intent, admission and claim, after conservative ledger recovery.
          const intent = reduceConceptIntent(session.conceptIntent, { type: 'render-failed', id: session.conceptIntent.pending.id, now: Date.now() }, policy);
          const event = storage.append(id, 'concept.state', { intent, status: { phase: 'failed', error: 'restart', retryable: true } }); publish(id, event);
        }
      }
    },
    async removeReference(id, referenceId) {
      const event = storage.removeConceptReference(id, referenceId); publish(id, event); await lane.invalidate(id); return event;
    },
  };
}
