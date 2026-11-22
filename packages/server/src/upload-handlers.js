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
// AIT-610, LEAD option A (Desk 203dfe1c): original image bytes are never written
// to SQLite, a file or any other persistent store. They wait in memory for the
// server's local normalizer; only an accepted image's normalized output is stored.
// Hard bound: at most MAX_PENDING_IMAGE_NORMALIZATIONS originals are held
// process-wide (image slots). While all slots are taken, a new request is
// refused (429, reason 'image-normalizations') before its body is read.
// Concurrent requests that passed that check while slots were free are bounded
// at admission: the slot assignment and the holds run in ONE synchronous turn
// (no await between counting free slots, storage.postUploads and holding), so
// images beyond the free slots are refused per file in the receipt with reason
// 'image-normalizations' and never held. A worst-case reservation before the
// body read is not possible: the server cannot know a request's image count
// before reading it, and AIT-219 requires three concurrent document requests to
// be admitted. Each original returns its slot when its job ends (or at shutdown).
// Memory bound, every live copy counted (AIT-610 r4; default ceilings:
// maxRequestBytes 21 MiB, maxBytes 20 MiB, MAX_PENDING_UPLOAD_REQUESTS 3
// retained requests, one normalization at a time through the extraction slot):
//   server process
//   - request bodies being read or parsed: at most 3 x 21 MiB (readBody's one
//     buffer; multipart parts are views of it, the metadata copy holds headers
//     only); zero-filled and dropped when the handler returns;
//   - held originals (owned copies): at most 8 slots and at most 3 x 21 MiB (a
//     request stays retained until its jobs end, so its originals count against
//     the same 3 requests);
//   - IPC to the normalizer child: one serialized message (<= 20 MiB original);
//   - the child's result: <= 8 MiB normalized output, received buffers plus the
//     deserialized message (<= 2 x 8 MiB);
//   normalizer child (one at a time; RSS capped at 384 MiB by its watchdog)
//   - the received message: receive buffers plus the deserialized message
//     (<= 2 x 20 MiB); the decoder reads a VIEW of it (normalize-input.js), not
//     another copy;
//   - its result: the encoded output plus its serialized message (<= 2 x 8 MiB).
// So at most 3 x 21 + 3 x 21 + 20 + 16 = 162 MiB in the server process and
// 40 + 16 = 56 MiB in the child: 218 MiB of request/image bytes in total.
// Bytes already dropped wait for the garbage collector; the bound counts live copies.
// A restart loses the held originals; their rows (no bytes) become
// staged-refused 'unavailable', which the client shows with an instruction to
// attach the image again.
const MAX_PENDING_IMAGE_NORMALIZATIONS = 8;
let imageSlots = 0; // held originals
// Upload IDs whose original some handler set in this process holds: recovery
// never treats those as lost, whichever handler set runs it.
const heldInProcess = new Set();
const STAGING_MS = 30 * 60 * 1000;
const RECOVERY_RETRY_MS = 1000;
/** Admission counters, for tests and diagnostics (counts only, never bytes). */
export const uploadAdmissionState = () => ({ pendingUploadRequests, imageSlots });
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
// Zero-fill a buffer except the given views of it (sorted, non-overlapping parts).
function zeroExcept(buffer, views) {
  let offset = 0;
  for (const view of [...views].sort((a, b) => a.byteOffset - b.byteOffset)) {
    const start = view.byteOffset - buffer.byteOffset;
    if (view.buffer !== buffer.buffer || start < offset || start + view.byteLength > buffer.byteLength) continue;
    buffer.fill(0, offset, start); offset = start + view.byteLength;
  }
  buffer.fill(0, offset);
}
// A standalone SVG: the root element is <svg> (optionally prefixed) after an
// optional BOM, XML declaration, processing instructions, comments and doctype
// (AIT-610 r4). The whole prolog is scanned, so padding cannot hide the root.
// An XML document with any other root stays a document (AIT-510).
function standaloneSvg(bytes) {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const space = code => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  let i = text.startsWith('\xef\xbb\xbf') ? 3 : 0;
  for (;;) {
    while (i < text.length && space(text.charCodeAt(i))) i++;
    let end;
    if (text.startsWith('<?', i)) end = text.indexOf('?>', i + 2) + 2;
    else if (text.startsWith('<!--', i)) end = text.indexOf('-->', i + 4) + 3;
    else if (text.startsWith('<!DOCTYPE', i)) {
      const close = text.indexOf('>', i), subset = text.indexOf('[', i);
      end = (subset >= 0 && subset < close ? text.indexOf('>', text.indexOf(']', subset)) : close) + 1;
    } else break;
    if (end <= i) return false; // an unterminated prolog item
    i = end;
  }
  return /^<(?:[A-Za-z_][\w.-]*:)?svg[\t\n\r />]/u.test(text.slice(i, i + 256));
}
const extensions = { pdf: EXTRACTOR_MEDIA_TYPES.pdf, docx: EXTRACTOR_MEDIA_TYPES.docx, xlsx: EXTRACTOR_MEDIA_TYPES.xlsx,
  pptx: EXTRACTOR_MEDIA_TYPES.pptx, txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml' };
export function sniffUploadDocument(bytes, filename, maxBytes = EXTRACTOR_LIMITS.maxBytes) {
  const gif = bytes.length >= 6 && /^GIF8[79]a$/u.test(Buffer.from(bytes.subarray(0, 6)).toString('ascii'));
  // Raster signatures that sniffDocument does not name (AIT-610 r3). BMP: 'BM'
  // plus its zero reserved fields (a text file never carries NUL bytes). TIFF:
  // either byte order. JPEG XL: bare codestream or ISO box container.
  const starts = signature => signature.every((value, index) => bytes[index] === value);
  const other = bytes.length >= 14 && starts([0x42, 0x4d]) && [6, 7, 8, 9].every(i => bytes[i] === 0) ? 'image/bmp'
    : starts([0x49, 0x49, 0x2a, 0x00]) || starts([0x4d, 0x4d, 0x00, 0x2a]) ? 'image/tiff'
      : starts([0xff, 0x0a]) || starts([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]) ? 'image/jxl' : null;
  // Excluded ISO-BMFF image containers remain non-input even without a filename
  // or MIME hint. Recognizing the container never enters its decoder.
  const brand = bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp'
    ? Buffer.from(bytes.subarray(8, 12)).toString('ascii') : '';
  const excluded = /^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/u.test(brand);
  const detected = excluded ? { mediaType: /^avi/u.test(brand) ? 'image/avif' : 'image/heic', reason: 'unsupported' }
    : gif ? { mediaType: 'image/gif', reason: 'unsupported' } : other ? { mediaType: other, reason: 'unsupported' }
      : standaloneSvg(bytes) ? { mediaType: 'image/svg+xml', reason: 'unsupported' } : sniffDocument(bytes, { ...EXTRACTOR_LIMITS, maxBytes });
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1].toLowerCase(), expected = extensions[extension];
  if (detected.reason) return detected;
  // Text subtypes are heuristic: an empty markdown/CSV/JSON file still belongs
  // to its extension. Binary signatures and Office structure take precedence.
  if (TEXT_MEDIA_TYPES.includes(detected.mediaType) && TEXT_MEDIA_TYPES.includes(expected)) return { mediaType: expected };
  return extension && expected !== detected.mediaType ? { mediaType: detected.mediaType, reason: 'unsupported' } : detected;
}
export function createUploadHandlers({ storage, runtime, ownership, readBody, publish, onInput, onWithdraw, signal, limits: configured, opener, now = () => storage.now() }) {
  const limits = normalizeUploadLimits(configured), jobs = new Map(), expiryTimers = new Map();
  // uploadId -> the owned copy of an image original awaiting normalization.
  const originals = new Map();
  // The caller assigned a free slot to this original in the same synchronous turn.
  function holdOriginal(uploadId, bytes) { originals.set(uploadId, Uint8Array.prototype.slice.call(bytes)); imageSlots++; heldInProcess.add(uploadId); }
  function releaseOriginal(uploadId) {
    const bytes = originals.get(uploadId);
    if (!bytes) return;
    originals.delete(uploadId); imageSlots--; heldInProcess.delete(uploadId);
    bytes.fill(0);
  }
  // A staged image whose original this process does not hold (lost to a
  // restart): staged-refused 'unavailable' with a fresh staging window, so the
  // visitor sees the instruction to attach it again before expiry removes it.
  const lost = () => ({ status: 'staged-refused', reason: 'unavailable', expiresAt: now() + STAGING_MS });
  // Boot recovery (resume): a staged-pending image with neither a job nor an
  // original held in this process was lost to a restart and becomes
  // staged-refused 'unavailable'. Returns false if a recovery write failed
  // (AIT-610 r4): the session stays in `unrecovered` and its expiry does not run
  // until a retry succeeds, so the pending row is never discarded before the
  // visitor sees the instruction to attach it again.
  const unrecovered = new Set();
  function recover(id) {
    if (signal.aborted) return true;
    let recovered = true;
    for (const upload of storage.get(id).uploads) {
      if (upload.kind !== 'image' || upload.state !== 'staged-pending' || upload.erased || jobs.has(upload.id) || heldInProcess.has(upload.id)) continue;
      try {
        const before = storage.get(id).seq, event = storage.completeUpload(id, upload.id, lost(), { opener });
        if (event) for (const saved of storage.read(id, before)) publish(id, saved);
      } catch { recovered = false; }
    }
    return recovered;
  }
  function expire(id) {
    if (unrecovered.has(id)) {
      if (!recover(id)) {
        // Keep the rows; try again shortly. Nothing expires in this session
        // until every lost image is recorded as 'unavailable'.
        clearTimeout(expiryTimers.get(id));
        if (!signal.aborted) { const timer = setTimeout(() => expire(id), RECOVERY_RETRY_MS); timer.unref?.(); expiryTimers.set(id, timer); }
        return;
      }
      unrecovered.delete(id);
    }
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
    if (signal.aborted) { releaseOriginal(uploadId); return; }
    const controller = new AbortController(), job = { id, controller, promise: null };
    jobs.set(uploadId, job);
    job.promise = Promise.resolve().then(async () => {
      const upload = storage.get(id).uploads.find(u => u.id === uploadId);
      if (!upload || !['pending', 'staged-pending'].includes(upload.state)) return;
      let result = upload.kind === 'image' && !originals.has(uploadId) ? lost() : null, release;
      // A missing original is decided first: after a restart it is
      // 'unavailable', never 'deadline', whatever the clock says.
      if (!result) {
        const scope = operationScope({ signal: AbortSignal.any([signal, controller.signal]), deadlineAt: upload.deadlineAt, now });
        try {
          release = await acquireExtraction(scope.signal, upload.kind === 'image');
          scope.signal.throwIfAborted();
          const session = storage.get(id);
          if (session.tombstone || !session.uploads.some(u => u.id === uploadId && ['pending', 'staged-pending'].includes(u.state))) return;
          // Images: only the in-memory original exists. None after a restart.
          const bytes = upload.kind === 'image' ? originals.get(uploadId) : storage.uploadBytes(id, uploadId);
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
      }
      if (signal.aborted) return; // shutdown keeps durable pending work for restart
      const current = storage.get(id);
      if (current.tombstone || !current.uploads.some(u => u.id === uploadId && ['pending', 'staged-pending'].includes(u.state))) return;
      const before = current.seq;
      const event = storage.completeUpload(id, uploadId, result, { opener });
      if (event) {
        for (const saved of storage.read(id, before)) publish(id, saved);
        if (!stagedImage(event.data)) onInput(id);
      }
      // The normalized result is stored above; now drop and zero the original.
    }).finally(() => { releaseOriginal(uploadId); jobs.delete(uploadId); });
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
      if (imageSlots >= MAX_PENDING_IMAGE_NORMALIZATIONS) return json({ error: 'upload-rate-limit', reason: 'image-normalizations' }, 429);
      pendingUploadRequests++;
      requestsPerSession.set(id, active + 1); requestsInDeployment++;
      let retained = false, files = [], bytes, kept = [];
      try {
        const deadlineAt = now() + limits.requestBudgetMs;
        bytes = await readBody(request, limits.maxRequestBytes);
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
        files = entries.map(({ value: f, bytes }) => {
          const detected = sniffUploadDocument(bytes, f.name, limits.maxBytes);
          // Image signatures always win (BMP, TIFF and JPEG XL included since
          // AIT-610 r3, a standalone SVG since r4), whatever the name or client
          // MIME. This runs before storage.postUploads: a disguised image is
          // held in memory only and never reaches the database. An image suffix also
          // makes the file image input. An image client MIME does so only without
          // a document suffix: AIT-510 keeps document admission for a named
          // document with a false image MIME hint (the MIME is untrusted).
          const extension = /\.([a-z0-9]+)$/iu.exec(f.name)?.[1].toLowerCase();
          const image = /^image\//u.test(detected.mediaType) || /\.(?:png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?|jxl|svg)$/iu.test(f.name) ||
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
        // From here to the holds below there is no await: count the free slots,
        // refuse the images beyond them, commit and hold in one synchronous turn.
        let free = MAX_PENDING_IMAGE_NORMALIZATIONS - imageSlots;
        for (const file of files) if (file.kind === 'image' && !file.refusal) { if (free > 0) free--; else file.refusal = 'image-normalizations'; }
        const result = storage.postUploads(id, clientEventId, digest, files, limits, { ...guard, revision, partialImages: true });
        if (!result.replayed) {
          // Events follow the admitted files in order; hold each admitted image's original before its job starts.
          const refusedIndexes = new Set(result.refused.map(record => record.index));
          const admittedFiles = files.filter((file, index) => !refusedIndexes.has(index));
          // Ownership and jobs are registered BEFORE anything that can throw
          // (publish, expiry and its erasure checkpoint): each job's finally
          // releases its original and slot, and the retained request.
          const pending = result.events.map((event, i) => {
            if (stagedImage(event.data)) holdOriginal(event.data.id, admittedFiles[i].bytes);
            return start(id, event.data.id);
          });
          // This callback captures no request body or multipart byte views.
          Promise.allSettled(pending).then(releasePendingRequest);
          retained = true;
          // Admitted documents are stored by the document rules; their views stay intact.
          kept = admittedFiles.filter(file => file.kind !== 'image').map(file => file.bytes);
          for (const event of result.events) publish(id, event);
          if (result.events.some(event => !stagedImage(event.data))) onInput(id, { pending: true });
          expire(id);
        }
        return json({ accepted: true, ...named(result), uploads: result.events.map(e => e.data), limits }, result.replayed ? 200 : 202);
      } finally {
        const remaining = requestsPerSession.get(id) - 1;
        if (remaining) requestsPerSession.set(id, remaining); else requestsPerSession.delete(id);
        requestsInDeployment--;
        if (!retained) releasePendingRequest();
        // Every exit (refusal, error or admission): zero the whole request body
        // (framing, fields, every image part and every refused part). Only the
        // views of admitted documents stay: the document rules store them anyway
        // and erase the stored copy after extraction. Admitted image originals
        // were copied into the in-memory hold before this point.
        if (bytes) zeroExcept(bytes, kept);
        for (const file of files) if (!kept.includes(file.bytes)) file.bytes.fill(0);
      }
    },
    resume() {
      // Recovery before boot expiry: a staged image whose original is gone
      // becomes staged-refused 'unavailable', so expiry never discards it
      // silently. If that write fails, the session's expiry waits (retried in
      // expire), and the row's fallback job below records 'unavailable'.
      for (const id of storage.list()) if (!recover(id)) unrecovered.add(id);
      for (const id of storage.list()) expire(id);
      for (const id of storage.list()) for (const upload of storage.get(id).uploads) {
        // An image another handler set in this process holds is that set's job.
        if (!['pending', 'staged-pending'].includes(upload.state) || jobs.has(upload.id) || heldInProcess.has(upload.id) || signal.aborted) continue;
        // Old durable backlogs may exceed today's admission budget. Drain their
        // metadata through the same FIFO and refuse new bodies until it clears.
        pendingUploadRequests++;
        Promise.resolve(start(id, upload.id)).finally(releasePendingRequest).catch(() => {});
      }
    },
    idle: () => Promise.allSettled([...jobs.values()].map(j => j.promise)),
    // Shutdown drains every owned original, with or without a registered job.
    close: () => { for (const timer of expiryTimers.values()) clearTimeout(timer); expiryTimers.clear();
      return Promise.allSettled([...jobs.values()].map(j => { j.controller.abort(); return j.promise; }))
        .then(results => { for (const uploadId of [...originals.keys()]) releaseOriginal(uploadId); return results; }); },
  };
}
