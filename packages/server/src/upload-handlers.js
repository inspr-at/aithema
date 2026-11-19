import { createHash } from 'node:crypto';
import { inputRevision, PluginError, operationScope, stagedImage, isConsentReason } from '@inspr/aithema-core';
import { sniffDocument, EXTRACTOR_LIMITS, TEXT_MEDIA_TYPES, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { normalizeUploadLimits } from './upload-limits.js';
import { scanUploadMultipart } from './upload-multipart.js';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
// Shared by handler instances in this deployment's server process.
const requestsPerSession = new Map();
let requestsInDeployment = 0;
// Reserve before body reads, and retain the reservation until every file in the
// request finishes. Acknowledging HTTP 202 must not open an unbounded job queue.
const MAX_PENDING_UPLOAD_REQUESTS = 3; // one running request, two pending
let pendingUploadRequests = 0;
const releasePendingRequest = () => { pendingUploadRequests--; };
// Process-wide FIFO: waiting jobs retain IDs/metadata only, never stored bytes.
// This covers runtime admission as well as the single isolated extractor slot.
const extractionWaiters = [];
let extracting = false;
function releaseExtraction() { extracting = false; extractionWaiters.shift()?.(); }
function acquireExtraction(signal, image = false) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = extractionWaiters.indexOf(start);
      if (index >= 0) extractionWaiters.splice(index, 1);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener('abort', abort);
      extracting = true;
      resolve(releaseExtraction);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    if (!extracting) { start(); return; }
    start.image = image;
    const before = image ? -1 : extractionWaiters.findIndex(waiter => waiter.image);
    if (before < 0) extractionWaiters.push(start); else extractionWaiters.splice(before, 0, start);
    signal.addEventListener('abort', abort, { once: true });
  });
}
const extensions = { pdf: EXTRACTOR_MEDIA_TYPES.pdf, docx: EXTRACTOR_MEDIA_TYPES.docx, xlsx: EXTRACTOR_MEDIA_TYPES.xlsx,
  pptx: EXTRACTOR_MEDIA_TYPES.pptx, txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml' };
export function sniffUploadDocument(bytes, filename, maxBytes = EXTRACTOR_LIMITS.maxBytes) {
  const gif = bytes.length >= 6 && /^GIF8[79]a$/u.test(Buffer.from(bytes.subarray(0, 6)).toString('ascii'));
  // Excluded ISO-BMFF image containers remain non-input even without a filename
  // or MIME hint. Recognizing the container never enters its decoder.
  const brand = bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp'
    ? Buffer.from(bytes.subarray(8, 12)).toString('ascii') : '';
  const excluded = /^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/u.test(brand);
  const detected = excluded ? { mediaType: /^avi/u.test(brand) ? 'image/avif' : 'image/heic', reason: 'unsupported' }
    : gif ? { mediaType: 'image/gif', reason: 'unsupported' } : sniffDocument(bytes, { ...EXTRACTOR_LIMITS, maxBytes });
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1].toLowerCase(), expected = extensions[extension];
  if (detected.reason) return detected;
  // Text subtypes are heuristic: an empty markdown/CSV/JSON file still belongs
  // to its extension. Binary signatures and Office structure take precedence.
  if (TEXT_MEDIA_TYPES.includes(detected.mediaType) && TEXT_MEDIA_TYPES.includes(expected)) return { mediaType: expected };
  return extension && expected !== detected.mediaType ? { mediaType: detected.mediaType, reason: 'unsupported' } : detected;
}
export function createUploadHandlers({ storage, runtime, ownership, readBody, publish, onInput, onWithdraw, signal, limits: configured, opener, now = () => storage.now() }) {
  const limits = normalizeUploadLimits(configured), jobs = new Map(), expiryTimers = new Map();
  function expire(id) {
    for (const event of storage.expireStagedUploads(id, now())) { jobs.get(event.data.id)?.controller.abort(); publish(id, event); }
    clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id);
    const pending = storage.get(id).uploads.filter(upload => stagedImage(upload) && !upload.erased);
    if (pending.length && !signal.aborted) {
      const timer = setTimeout(() => expire(id), Math.max(1, Math.min(...pending.map(upload => upload.expiresAt)) - now()));
      timer.unref?.(); expiryTimers.set(id, timer);
    }
  }
  function start(id, uploadId) {
    if (jobs.has(uploadId)) return jobs.get(uploadId).promise;
    if (signal.aborted) return;
    const controller = new AbortController(), job = { id, controller, promise: null };
    jobs.set(uploadId, job);
    job.promise = Promise.resolve().then(async () => {
      const upload = storage.get(id).uploads.find(u => u.id === uploadId);
      if (!upload || !['pending', 'staged-pending'].includes(upload.state)) return;
      const scope = operationScope({ signal: AbortSignal.any([signal, controller.signal]), deadlineAt: upload.deadlineAt, now });
      let result, release;
      try {
        release = await acquireExtraction(scope.signal, upload.kind === 'image');
        scope.signal.throwIfAborted();
        const session = storage.get(id);
        if (session.tombstone || !session.uploads.some(u => u.id === uploadId && ['pending', 'staged-pending'].includes(u.state))) return;
        const bytes = storage.uploadBytes(id, uploadId);
        if (!bytes) result = { status: 'unreadable', reason: 'unavailable', truncated: false };
        else {
          if (upload.kind === 'image') result = await runtime.normalizeImageUpload({ session, uploadId, bytes, metadata: { filename: upload.filename, mediaType: upload.mediaType }, options: { signal: scope.signal, deadlineAt: upload.deadlineAt, now } });
          else {
            const detected = sniffUploadDocument(bytes, upload.filename, limits.maxBytes);
            if (bytes.length > EXTRACTOR_LIMITS.maxBytes || detected.reason) result = { status: 'unreadable', reason: bytes.length > EXTRACTOR_LIMITS.maxBytes ? 'limit' : detected.reason, truncated: false };
            else result = await runtime.extractUpload({ session, uploadId, bytes, metadata: { filename: upload.filename, mediaType: detected.mediaType },
              options: { signal: scope.signal, deadlineAt: upload.deadlineAt, now } });
          }
        }
      } catch (error) {
        result = { status: 'unreadable', reason: scope.signal.aborted ? scope.signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'
          : error instanceof PluginError && ['deadline', 'limit'].includes(error.code) ? error.code : 'unavailable', truncated: false };
      } finally { release?.(); scope.dispose(); }
      if (upload.kind === 'image' && result.status !== 'staged-ready') result = { status: 'staged-refused', reason: result.reason ?? 'unavailable' };
      if (signal.aborted) return; // shutdown keeps durable pending work for restart
      const current = storage.get(id);
      if (current.tombstone || !current.uploads.some(u => u.id === uploadId && ['pending', 'staged-pending'].includes(u.state))) return;
      const before = current.seq;
      const event = storage.completeUpload(id, uploadId, result, { opener });
      if (event) {
        for (const saved of storage.read(id, before)) publish(id, saved);
        if (!stagedImage(event.data)) onInput(id);
      }
    }).finally(() => jobs.delete(uploadId));
    job.promise.catch(() => {});
    return job.promise;
  }
  async function cancelSession(id) {
    clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id);
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
    async cancelImages(id) {
      clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id);
      const ids = new Set(storage.get(id).uploads.filter(upload => upload.kind === 'image').map(upload => upload.id));
      await Promise.all([...jobs.keys()].filter(uploadId => ids.has(uploadId)).map(uploadId => cancelUpload(id, uploadId)));
    },
    async handle(request) {
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})\/uploads(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(withdraw|image))?)?$/u.exec(new URL(request.url).pathname);
      if (!match) return null;
      const [, id, uploadId, action] = match;
      const ownerToken = ownership.token(request);
      storage.authorize(id, ownerToken); expire(id);
      const session = storage.authorize(id, ownerToken);
      const guard = { ownerToken, revision: inputRevision(session) };
      if (request.method === 'GET' && action === 'image') {
        const availability = await runtime.imageInputAvailability(session, { signal: request.signal, deadlineAt: now() + 1000, now });
        const current = storage.authorize(id, ownerToken), image = storage.imageUpload(id, uploadId);
        if (availability.reason || current.consentRevision !== session.consentRevision || !image) return json({ error: 'image-unavailable' }, 404);
        return new Response(image.imageBytes, { headers: { 'content-type': image.mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
      }
      if (uploadId && (request.method === 'DELETE' && !action || request.method === 'POST' && action === 'withdraw')) {
        const event = storage.withdrawUpload(id, uploadId, guard);
        jobs.get(uploadId)?.controller.abort(new DOMException('Upload withdrawn', 'AbortError'));
        await Promise.all([jobs.get(uploadId)?.promise, stagedImage(event.data) ? Promise.resolve(publish(id, event)) : onWithdraw(id, event)]);
        return json({ withdrawn: uploadId, event, providerDeletion: 'not-confirmed' });
      }
      if (request.method === 'GET' && !uploadId) return json({ uploads: session.uploads, limits });
      if (request.method !== 'POST' || uploadId) return json({ error: 'method-not-allowed' }, 405);
      if (session.pauseReason === 'purpose') return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
      if (!/^multipart\/form-data\s*;/iu.test(request.headers.get('content-type') ?? '')) return json({ error: 'multipart-required' }, 415);
      const length = request.headers.get('content-length');
      if (length && /^\d+$/u.test(length) && Number(length) > limits.maxRequestBytes) throw new RangeError('Upload request limit');
      const active = requestsPerSession.get(id) ?? 0;
      if (active >= limits.maxConcurrentRequestsPerSession || requestsInDeployment >= limits.maxConcurrentRequestsPerDeployment) return json({ error: 'upload-rate-limit' }, 429);
      if (pendingUploadRequests >= MAX_PENDING_UPLOAD_REQUESTS) return json({ error: 'upload-rate-limit' }, 429);
      pendingUploadRequests++;
      requestsPerSession.set(id, active + 1); requestsInDeployment++;
      let retained = false;
      try {
        const deadlineAt = now() + limits.requestBudgetMs;
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
          const extension = /\.([a-z0-9]+)$/iu.exec(f.name)?.[1].toLowerCase();
          // Image bytes always win; a false client MIME cannot reclassify a named document.
          const image = /^image\//u.test(detected.mediaType) || /\.(?:png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?|svg)$/iu.test(f.name) ||
            !Object.hasOwn(extensions, extension) && /^image\//u.test(f.type);
          return { bytes, ...(image ? { kind: 'image' } : {}), filename: f.name.slice(0, 200), originalName: f.name, mediaType: detected.mediaType, deadlineAt };
        });
        // Multipart boundary and the untrusted client MIME are transport details.
        // The receipt binds exact filenames, order, content bytes and base revision.
        const digest = createHash('sha256').update(JSON.stringify({ revision: rawRevision ?? null, files: files.map(f => ({ filename: f.originalName,
          hash: createHash('sha256').update(f.bytes).digest('hex') })) })).digest('hex');
        // Refusal receipts need positions and reasons, not plaintext filenames.
        // The byte-bound request supplies the same names again on replay.
        const named = result => ({ ...result, refused: (result.refused ?? []).map(record => ({ ...record, name: files[record.index].originalName })) });
        if (storage.get(id).pauseReason === 'purpose') return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
        const replay = storage.uploadReceipt(id, clientEventId, digest, guard);
        if (replay) return json({ accepted: true, ...named(replay), uploads: replay.events.map(e => e.data), limits });
        for (const image of [false, true]) {
          if (!files.some(file => (file.kind === 'image') === image)) continue;
          const availability = await (image ? runtime.imageInputAvailability : runtime.uploadAvailability)(session, { signal: request.signal, deadlineAt, now });
          storage.authorize(id, ownerToken);
          if (storage.get(id).pauseReason === 'purpose') return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
          // An earlier file can finish during admission of the next batch. No receipt exists yet:
          // let the client retry against fresh admission rather than reporting a byte conflict.
          if (inputRevision(storage.get(id)) !== guard.revision) return json({ error: 'upload-rate-limit' }, 429);
          if (image) {
            const unavailable = availability.reason && !isConsentReason(availability.reason);
            const reason = unavailable ? availability.reason : storage.get(id).consentRevision !== session.consentRevision
              ? 'current processing consent required' : availability.reason;
            if (reason) for (const file of files) if (file.kind === 'image') file.refusal = reason;
          } else if (availability.reason) return json({ error: 'uploads-unavailable', reason: availability.reason }, 403);
        }
        const result = storage.postUploads(id, clientEventId, digest, files, limits, { ...guard, revision, partialImages: true });
        if (!result.replayed) {
          for (const event of result.events) publish(id, event);
          if (result.events.some(event => !stagedImage(event.data))) onInput(id, { pending: true });
          expire(id);
          const pending = result.events.map(event => start(id, event.data.id));
          // This callback captures no request body or multipart byte views.
          Promise.allSettled(pending).then(releasePendingRequest);
          retained = true;
        }
        return json({ accepted: true, ...named(result), uploads: result.events.map(e => e.data), limits }, result.replayed ? 200 : 202);
      } finally {
        const remaining = requestsPerSession.get(id) - 1;
        if (remaining) requestsPerSession.set(id, remaining); else requestsPerSession.delete(id);
        requestsInDeployment--;
        if (!retained) releasePendingRequest();
      }
    },
    resume() {
      for (const id of storage.list()) expire(id);
      for (const id of storage.list()) for (const upload of storage.get(id).uploads) {
        if (!['pending', 'staged-pending'].includes(upload.state) || jobs.has(upload.id) || signal.aborted) continue;
        // Old durable backlogs may exceed today's admission budget. Drain their
        // metadata through the same FIFO and refuse new bodies until it clears.
        pendingUploadRequests++;
        Promise.resolve(start(id, upload.id)).finally(releasePendingRequest).catch(() => {});
      }
    },
    idle: () => Promise.allSettled([...jobs.values()].map(j => j.promise)),
    close: () => { for (const timer of expiryTimers.values()) clearTimeout(timer); expiryTimers.clear(); return Promise.allSettled([...jobs.values()].map(j => { j.controller.abort(); return j.promise; })); },
  };
}
