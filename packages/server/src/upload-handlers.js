import { createHash } from 'node:crypto';
import { inputRevision, PluginError, operationScope } from '@inspr/aithema-core';
import { sniffDocument, EXTRACTOR_LIMITS, TEXT_MEDIA_TYPES, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { normalizeUploadLimits } from './upload-limits.js';
import { scanUploadMultipart } from './upload-multipart.js';
import { ConflictError } from './storage.js';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
// Shared by handler instances in this deployment's server process.
const requestsPerSession = new Map();
let requestsInDeployment = 0;
const extensions = { pdf: EXTRACTOR_MEDIA_TYPES.pdf, docx: EXTRACTOR_MEDIA_TYPES.docx, xlsx: EXTRACTOR_MEDIA_TYPES.xlsx,
  pptx: EXTRACTOR_MEDIA_TYPES.pptx, txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml' };
export function sniffUploadDocument(bytes, filename, maxBytes = EXTRACTOR_LIMITS.maxBytes) {
  const detected = sniffDocument(bytes, { ...EXTRACTOR_LIMITS, maxBytes });
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1].toLowerCase(), expected = extensions[extension];
  if (detected.reason) return detected;
  // Text subtypes are heuristic: an empty markdown/CSV/JSON file still belongs
  // to its extension. Binary signatures and Office structure take precedence.
  if (TEXT_MEDIA_TYPES.includes(detected.mediaType) && TEXT_MEDIA_TYPES.includes(expected)) return { mediaType: expected };
  return extension && expected !== detected.mediaType ? { mediaType: detected.mediaType, reason: 'unsupported' } : detected;
}
export function createUploadHandlers({ storage, runtime, ownership, readBody, publish, onInput, onWithdraw, signal, limits: configured }) {
  const limits = normalizeUploadLimits(configured), jobs = new Map();
  function start(id, uploadId) {
    if (jobs.has(uploadId) || signal.aborted) return;
    const controller = new AbortController(), job = { id, controller, promise: null };
    jobs.set(uploadId, job);
    job.promise = Promise.resolve().then(async () => {
      const session = storage.get(id), upload = session.uploads.find(u => u.id === uploadId);
      if (!upload || upload.state !== 'pending' || session.tombstone) return;
      const scope = operationScope({ signal: AbortSignal.any([signal, controller.signal]), deadlineAt: upload.deadlineAt });
      let result;
      try {
        scope.signal.throwIfAborted();
        const bytes = storage.uploadBytes(id, uploadId);
        if (!bytes) result = { status: 'unreadable', reason: 'unavailable', truncated: false };
        else {
          const detected = sniffUploadDocument(bytes, upload.filename, limits.maxBytes);
          if (bytes.length > EXTRACTOR_LIMITS.maxBytes || detected.reason) result = { status: 'unreadable', reason: bytes.length > EXTRACTOR_LIMITS.maxBytes ? 'limit' : detected.reason, truncated: false };
          else result = await runtime.extractUpload({ session, uploadId, bytes, metadata: { filename: upload.filename, mediaType: detected.mediaType },
            options: { signal: scope.signal, deadlineAt: upload.deadlineAt } });
        }
      } catch (error) {
        result = { status: 'unreadable', reason: scope.signal.aborted ? scope.signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'
          : error instanceof PluginError && ['deadline', 'limit'].includes(error.code) ? error.code : 'unavailable', truncated: false };
      } finally { scope.dispose(); }
      if (signal.aborted) return; // shutdown keeps durable pending work for restart
      const current = storage.get(id);
      if (current.tombstone || !current.uploads.some(u => u.id === uploadId && u.state === 'pending')) return;
      const event = storage.completeUpload(id, uploadId, result);
      if (event) { publish(id, event); onInput(id); }
    }).finally(() => jobs.delete(uploadId));
    job.promise.catch(() => {});
  }
  async function cancelSession(id) {
    const pending = [...jobs.values()].filter(j => j.id === id);
    for (const job of pending) job.controller.abort(new DOMException('Upload processing revoked', 'AbortError'));
    await Promise.allSettled(pending.map(j => j.promise));
  }
  async function cancelUpload(id, uploadId) {
    const job = jobs.get(uploadId);
    if (job?.id !== id) return;
    job.controller.abort(new DOMException('Upload processing revoked', 'AbortError'));
    await job.promise;
  }
  return { cancelSession, cancelUpload,
    async handle(request) {
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})\/uploads(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(withdraw))?)?$/u.exec(new URL(request.url).pathname);
      if (!match) return null;
      const [, id, uploadId, action] = match;
      const ownerToken = ownership.token(request), session = storage.authorize(id, ownerToken);
      const guard = { ownerToken, revision: inputRevision(session) };
      if (uploadId && (request.method === 'DELETE' && !action || request.method === 'POST' && action === 'withdraw')) {
        const event = storage.withdrawUpload(id, uploadId, guard);
        jobs.get(uploadId)?.controller.abort(new DOMException('Upload withdrawn', 'AbortError'));
        await Promise.all([jobs.get(uploadId)?.promise, onWithdraw(id, event)]);
        return json({ withdrawn: uploadId, event, providerDeletion: 'not-confirmed' });
      }
      if (request.method === 'GET' && !uploadId) return json({ uploads: session.uploads, limits });
      if (request.method !== 'POST' || uploadId) return json({ error: 'method-not-allowed' }, 405);
      if (!/^multipart\/form-data\s*;/iu.test(request.headers.get('content-type') ?? '')) return json({ error: 'multipart-required' }, 415);
      const length = request.headers.get('content-length');
      if (length && /^\d+$/u.test(length) && Number(length) > limits.maxRequestBytes) throw new RangeError('Upload request limit');
      const active = requestsPerSession.get(id) ?? 0;
      if (active >= limits.maxConcurrentRequestsPerSession || requestsInDeployment >= limits.maxConcurrentRequestsPerDeployment) return json({ error: 'upload-rate-limit' }, 429);
      requestsPerSession.set(id, active + 1); requestsInDeployment++;
      try {
        const deadlineAt = Date.now() + limits.requestBudgetMs;
        const bytes = await readBody(request, limits.maxRequestBytes);
        const { parts, metadata } = scanUploadMultipart(bytes, request.headers.get('content-type'), limits.maxFilesPerRequest);
        const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') }, body: metadata }).formData();
        const fields = [...form.entries()].map(([key, value], i) => ({ key, value, bytes: parts[i]?.bytes }));
        if (fields.length !== parts.length || fields.some(f => !['clientEventId', 'inputRevision', 'file', 'files'].includes(f.key))) return json({ error: 'invalid-upload' }, 400);
        const ids = fields.filter(f => f.key === 'clientEventId'), revisions = fields.filter(f => f.key === 'inputRevision');
        if (ids.length !== 1 || revisions.length > 1 || [...ids, ...revisions].some(f => typeof f.value !== 'string' || f.bytes.length > 128)) return json({ error: 'invalid-upload' }, 400);
        const clientEventId = ids[0].bytes.toString('utf8'), rawRevision = revisions[0]?.bytes.toString('utf8');
        const revision = rawRevision ?? guard.revision;
        if (!identifier(clientEventId)) return json({ error: 'invalid-upload' }, 400);
        const entries = [...fields.filter(f => f.key === 'file'), ...fields.filter(f => f.key === 'files')];
        if (!entries.length || entries.some(f => !(f.value instanceof File))) return json({ error: 'invalid-upload' }, 400);
        if (entries.length > limits.maxFilesPerRequest || entries.some(f => f.bytes.length > limits.maxBytes)) throw new RangeError('Upload file limit');
        const files = entries.map(({ value: f, bytes }) => {
          const detected = sniffUploadDocument(bytes, f.name, limits.maxBytes);
          return { bytes, filename: f.name.slice(0, 200), originalName: f.name, mediaType: detected.mediaType, deadlineAt };
        });
        // Multipart boundary and the untrusted client MIME are transport details.
        // The receipt binds exact filenames, order, content bytes and base revision.
        const digest = createHash('sha256').update(JSON.stringify({ revision: rawRevision ?? null, files: files.map(f => ({ filename: f.originalName,
          hash: createHash('sha256').update(f.bytes).digest('hex') })) })).digest('hex');
        const replay = storage.uploadReceipt(id, clientEventId, digest, guard);
        if (replay) return json({ accepted: true, ...replay, uploads: replay.events.map(e => e.data), limits });
        const availability = await runtime.uploadAvailability(session, { signal: request.signal, deadlineAt });
        storage.authorize(id, ownerToken);
        if (inputRevision(storage.get(id)) !== guard.revision) throw new ConflictError('Upload admission changed');
        if (availability.reason) return json({ error: 'uploads-unavailable', reason: availability.reason }, 403);
        const result = storage.postUploads(id, clientEventId, digest, files, limits, { ...guard, revision });
        if (!result.replayed) {
          for (const event of result.events) publish(id, event);
          onInput(id, { pending: true });
          for (const event of result.events) start(id, event.data.id);
        }
        return json({ accepted: true, ...result, uploads: result.events.map(e => e.data), limits }, result.replayed ? 200 : 202);
      } finally {
        const remaining = requestsPerSession.get(id) - 1;
        if (remaining) requestsPerSession.set(id, remaining); else requestsPerSession.delete(id);
        requestsInDeployment--;
      }
    },
    resume() {
      for (const id of storage.list()) for (const upload of storage.get(id).uploads) if (upload.state === 'pending') start(id, upload.id);
    },
    idle: () => Promise.allSettled([...jobs.values()].map(j => j.promise)),
    close: () => Promise.allSettled([...jobs.values()].map(j => { j.controller.abort(); return j.promise; })),
  };
}
