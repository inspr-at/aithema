import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { inputRevision, PluginError, operationScope, stagedImage, isConsentReason } from '@inspr/aithema-core';
import { sniffDocument, EXTRACTOR_LIMITS, TEXT_MEDIA_TYPES, EXTRACTOR_EXTENSIONS, EXTRACTABLE_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { inspectZip } from '@inspr/aithema-core/extractor-zip';
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
// Memory bound (AIT-610 r7, LEAD condition 1, scoped to IMAGE ORIGINALS), for
// the deployed runtime: the Dockerfile's node:24 image, IPC to both children
// with serialization 'advanced'. Checked against Node 24
// lib/internal/child_process/serialization.js in both forms the 24.x line
// ships (the JS ChildProcessSerializer, 24.15/24.16, and the native ipc_serdes
// codec, 24.22): the sender serializes ONCE into one buffer; the receiver keeps
// the received chunks until it has the whole message, concatenates them once,
// and deserializes a Uint8Array as a VIEW of that buffer (probed on 24.16 and
// 24.22).
//   - image originals held in memory (owned copies): at most
//     MAX_PENDING_IMAGE_NORMALIZATIONS (8) x the per-file cap (limits.maxBytes,
//     20 MiB) = 160 MiB;
//   - their IPC copies: one job at a time in the extraction slot, so one
//     original in flight: the server's send buffer with one growth reallocation
//     (2 x 20 MiB) and the normalizer child's received chunks plus their
//     concatenation (2 x 20 MiB; normalize-input.js decodes a view) = 80 MiB;
//   so at most 240 MiB of image originals and their IPC copies. Arithmetic
//   over live copies, not an RSS measurement.
// The document path is bounded by its own ceilings (docs/plugins.md names them
// with their values): MAX_PENDING_UPLOAD_REQUESTS x maxRequestBytes for request
// bodies; one extraction job at a time (this module's slot, shared with images,
// and the extractor's single process slot); EXTRACTOR_LIMITS.maxBytes per file,
// so a job's SQLite read-back, the extractor's owned snapshot (taken inside the
// slot) and the PDF child's copy are each <= 20 MiB; the child's maxHeapMb and
// maxRssMb; maxPages/maxChars and the OOXML entry/part/ratio limits. Intake
// classification makes no full-file copy (< 0.5 MiB of prefix per file,
// synchronous).
// A restart loses the held originals. Their rows (no bytes) stay as stored and
// are REPORTED as staged-refused 'unavailable' on every read (reportUploads);
// the client shows that with an instruction to attach the image again.
const MAX_PENDING_IMAGE_NORMALIZATIONS = 8;
let imageSlots = 0; // held originals
// Upload IDs whose original some handler set in this process holds: reads
// never report those as lost, whichever handler set serves the read.
const heldInProcess = new Set();
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
// AIT-610 r5: text recognition reads at most this prefix of a file. Beyond it
// the only full passes are allocation-free: a control-byte scan and
// buffer.isUtf8 (a native validator over the bytes in place). No full-file
// string or Latin-1 copy is made at intake.
export const UPLOAD_SNIFF_PREFIX_BYTES = 64 * 1024;
const unsupported = { mediaType: 'application/octet-stream', reason: 'unsupported' };
// The decoded prefix, cut at a UTF-8 character boundary (the caller validated
// the whole file as UTF-8). At most UPLOAD_SNIFF_PREFIX_BYTES bytes.
function prefixBytes(bytes) {
  let end = Math.min(bytes.length, UPLOAD_SNIFF_PREFIX_BYTES);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
// The XML root of a UTF-8 text prefix (AIT-610 r5). One forward pass, so the
// work is linear in the prefix: whitespace, processing instructions, comments
// and a doctype whose internal subset may hold quoted strings (a quoted ']' or
// '>' does not end it), comments and PIs. `whole` says the prefix is the whole
// file. Returns
//   null          not an XML document (plain text, CSV, JSON, Markdown, or
//                 markup no XML parser accepts as a document)
//   'incomplete'  a prolog item or the root name runs past a truncated prefix
//                 (fail closed: the caller refuses the file)
//   <name>        the root element's name, e.g. 'svg', 'svg:svg', 'note'.
function xmlRoot(text, whole) {
  const space = code => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  const open = () => whole ? null : 'incomplete';
  const until = (at, token) => { const end = text.indexOf(token, at); return end < 0 ? -1 : end + token.length; };
  const name = /[A-Za-z_][\w.:-]*/uy;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && space(text.charCodeAt(i))) i++;
    if (i >= text.length) return open();
    if (text[i] !== '<') return null;
    // A token cut by a truncated prefix ('<!DO', '<!-', '<') cannot be told
    // apart from a prolog item: fail closed.
    if (!whole && text.length - i < 10) return 'incomplete';
    let end;
    if (text.startsWith('<?', i)) end = until(i + 2, '?>');
    else if (text.startsWith('<!--', i)) end = until(i + 4, '-->');
    else if (/^<!doctype/iu.test(text.slice(i, i + 9))) {
      end = -1;
      for (let j = i + 9, subset = false; j >= 0 && j < text.length;) {
        const c = text[j];
        if (c === '"' || c === "'") { const close = text.indexOf(c, j + 1); j = close < 0 ? -1 : close + 1; }
        else if (subset && text.startsWith('<!--', j)) j = until(j + 4, '-->');
        else if (subset && text.startsWith('<?', j)) j = until(j + 2, '?>');
        else if (c === '[' && !subset) { subset = true; j++; }
        else if (c === ']' && subset) { subset = false; j++; }
        else if (c === '>' && !subset) { end = j + 1; break; }
        else j++;
      }
    } else {
      name.lastIndex = i + 1;
      const root = name.exec(text);
      if (!root) return null;
      // r6 (gate5c): the name must END there (whitespace, '/' or '>'), so
      // plain text such as '<svg=' is not an svg root. A name that runs to the
      // end of a truncated prefix cannot be decided: fail closed.
      const after = i + 1 + root[0].length;
      if (after >= text.length) return whole ? null : 'incomplete';
      return space(text.charCodeAt(after)) || text[after] === '/' || text[after] === '>' ? root[0] : null;
    }
    if (end < 0) return open();
    i = end;
  }
}
const startsWith = (bytes, signature) => bytes.length >= signature.length && signature.every((value, index) => value === undefined || bytes[index] === value);
// Signatures sniffDocument decides from the whole file without decoding text.
const binarySignatures = [[37, 80, 68, 70, 45], [80, 75, 3, 4], [80, 75, 5, 6], [137, 80, 78, 71, 13, 10, 26, 10], [255, 216, 255],
  [82, 73, 70, 70, undefined, undefined, undefined, undefined, 87, 69, 66, 80]];
// Netpbm (PBM/PGM/PPM 'P1'..'P6' with width and height, PAM 'P7'): image
// formats, never documents, even in their ASCII forms (AIT-610 r5).
const netpbm = bytes => /^(?:P[1-6](?:\s+(?:#[^\n]*\n\s*)*\d+){2}\s|P7\s)/u.test(Buffer.from(bytes.subarray(0, 512)).toString('latin1'));
const extensions = EXTRACTOR_EXTENSIONS;
// PDF, Office and the sniffer's own image signatures go to sniffDocument with
// the whole file (it returns before any text decoding). Everything else must be
// UTF-8 text without control bytes; its root decides SVG versus document, and
// its subtype comes from the bounded prefix.
function sniffText(bytes, maxBytes) {
  const limits = { ...EXTRACTOR_LIMITS, maxBytes };
  if (bytes.length > maxBytes || binarySignatures.some(signature => startsWith(bytes, signature))) return sniffDocument(bytes, limits);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) return unsupported;
  }
  if (!isUtf8(bytes)) return unsupported; // UTF-16 and legacy encodings included
  const head = prefixBytes(bytes), root = xmlRoot(new TextDecoder('utf-8').decode(head), head.length === bytes.length);
  if (root === 'incomplete') return unsupported;
  if (root && /^(?:[^:]*:)?svg$/iu.test(root)) return { mediaType: 'image/svg+xml', reason: 'unsupported' };
  return sniffDocument(head, limits);
}
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
      : netpbm(bytes) ? { mediaType: 'image/x-portable-anymap', reason: 'unsupported' } : sniffText(bytes, maxBytes);
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1].toLowerCase(), expected = extensions[extension];
  if (detected.reason) return detected;
  // Text subtypes are heuristic: an empty markdown/CSV/JSON file still belongs
  // to its extension. Binary signatures and Office structure take precedence.
  if (TEXT_MEDIA_TYPES.includes(detected.mediaType) && TEXT_MEDIA_TYPES.includes(expected)) return { mediaType: expected };
  return extension && expected !== detected.mediaType ? { mediaType: detected.mediaType, reason: 'unsupported' } : detected;
}
// AIT-610 r6 (LEAD 03:0x): the reason a refused document is named with at
// intake. A specific reason only where it is CERTAIN; otherwise 'unsupported'
// (the generic "file type not accepted"). Only for an Office suffix:
//   - a Compound File Binary container (D0 CF 11 E0 A1 B1 1A E1) whose
//     directory was walked validly from the root entry (r7, cfbRootStreams)
//     with BOTH an EncryptionInfo and an EncryptedPackage stream LINKED under
//     the root is a password-protected Office file: 'encrypted';
//   - any other validly walked CFB is an older Office format (e.g. a .doc
//     renamed .docx): 'legacy';
//   - a ZIP with structural damage (an unreadable central directory), or a
//     readable archive without [Content_Types].xml: 'malformed';
//   - anything else, including a CFB directory that cannot be walked with
//     certainty within the bound and an intact ZIP using a feature the reader
//     does not support (ZIP64, spanning, a method or flag): 'unsupported'.
// Runs before persistence, only for a file already refused, and is bounded:
// at most CFB_DIRECTORY_SECTORS_MAX directory sectors (64: 256 entries with
// 512-byte sectors, 2,048 with 4 KiB sectors), FAT lookups by index (the FAT
// sector list is bounded by the file's own sector count), and the existing
// non-inflating ZIP inspection (maxEntries). No copy of the file is made.
export const CFB_DIRECTORY_SECTORS_MAX = 64;
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// AIT-610 r7 (gate6c): the names of the streams LINKED directly under the root
// storage of a CFB, or null unless the directory is read with certainty: at
// least one directory sector actually read (an end-of-chain first is not a
// directory), entry 0 is the root storage, and a walk of every storage's
// red-black tree from the root (left/right siblings, storage children) stays
// inside the entries read, meets each entry at most once (no loop) and finds
// only storages and streams with valid names and colors. Orphaned entries
// (not reachable from the root) are not part of the file's content.
const CFB_NOSTREAM = 0xffffffff, CFB_END_OF_CHAIN = 0xfffffffe;
function cfbRootStreams(bytes) {
  if (bytes.length < 512) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  const major = u16(0x1a), shift = u16(0x1e);
  if (u16(0x1c) !== 0xfffe || !(major === 3 && shift === 9 || major === 4 && shift === 12)) return null;
  const size = 2 ** shift, perSector = size / 4, sectors = Math.floor(bytes.length / size) - 1;
  const inFile = sector => sector < sectors;
  const offset = sector => (sector + 1) * size;
  const fatCount = u32(0x2c);
  if (fatCount > sectors) return null;
  const fat = [];
  for (let i = 0; i < 109 && fat.length < fatCount; i++) fat.push(u32(0x4c + i * 4));
  // Every DIFAT sector adds perSector - 1 entries, so this ends within fatCount.
  for (let difat = u32(0x44); fat.length < fatCount;) {
    if (!inFile(difat)) return null;
    for (let i = 0; i < perSector - 1 && fat.length < fatCount; i++) fat.push(u32(offset(difat) + i * 4));
    difat = u32(offset(difat) + size - 4);
  }
  const entries = []; // byte offsets of the directory entries read, by entry id
  for (let sector = u32(0x30), read = 0; sector !== CFB_END_OF_CHAIN; read++) {
    if (read >= CFB_DIRECTORY_SECTORS_MAX || !inFile(sector)) return null;
    for (let entry = offset(sector); entry < offset(sector) + size; entry += 128) entries.push(entry);
    const holder = fat[Math.floor(sector / perSector)];
    if (holder === undefined || !inFile(holder)) return null;
    sector = u32(offset(holder) + (sector % perSector) * 4);
  }
  if (!entries.length) return null;
  const name = at => {
    const length = u16(at + 0x40);
    return length >= 2 && length <= 64 && length % 2 === 0 && u16(at + length - 2) === 0
      ? Buffer.from(bytes.buffer, bytes.byteOffset + at, length - 2).toString('utf16le') : null;
  };
  const root = entries[0];
  // AIT-610 r8 (gate7c): every pointer the walk can reach is checked; the root
  // has no siblings and a stream has no child (MS-CFB 2.6.1/2.6.3), so any
  // value there is an inconsistency (doubt: generic), never ignored.
  if (bytes[root + 0x42] !== 5 || name(root) !== 'Root Entry' ||
    u32(root + 0x44) !== CFB_NOSTREAM || u32(root + 0x48) !== CFB_NOSTREAM) return null;
  const streams = new Set(), seen = new Set([0]), stack = [[u32(root + 0x4c), true]];
  while (stack.length) {
    const [id, top] = stack.pop();
    if (id === CFB_NOSTREAM) continue;
    if (id >= entries.length || seen.has(id)) return null;
    seen.add(id);
    const at = entries[id], type = bytes[at + 0x42], entryName = name(at);
    if (type !== 1 && type !== 2 || bytes[at + 0x43] > 1 || entryName === null) return null;
    if (type === 2 && u32(at + 0x4c) !== CFB_NOSTREAM) return null;
    if (type === 2 && top) streams.add(entryName);
    stack.push([u32(at + 0x44), top], [u32(at + 0x48), top]);
    if (type === 1) stack.push([u32(at + 0x4c), false]);
  }
  return streams;
}
export function uploadIntakeReason(bytes, filename, maxBytes = EXTRACTOR_LIMITS.maxBytes) {
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1].toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) return 'unsupported';
  if (startsWith(bytes, CFB_SIGNATURE)) {
    const streams = cfbRootStreams(bytes);
    return !streams ? 'unsupported' : streams.has('EncryptionInfo') && streams.has('EncryptedPackage') ? 'encrypted' : 'legacy';
  }
  if (startsWith(bytes, [80, 75, 3, 4]) || startsWith(bytes, [80, 75, 5, 6])) {
    let entries;
    try { entries = inspectZip(bytes, { ...EXTRACTOR_LIMITS, maxBytes }); }
    // Structural damage only; an unsupported ZIP feature (ZIP64, spanning,
    // an unsupported method or flag) in an intact archive is generic (r7).
    catch (error) { return error.reason === 'malformed' && !error.feature ? 'malformed' : 'unsupported'; }
    return entries.has('[Content_Types].xml') ? 'unsupported' : 'malformed';
  }
  return 'unsupported';
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
  const lost = upload => upload?.kind === 'image' && upload.state === 'staged-pending' && !upload.erased && !heldInProcess.has(upload.id);
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
    if (signal.aborted) { releaseOriginal(uploadId); return; }
    const controller = new AbortController(), job = { id, controller, promise: null };
    jobs.set(uploadId, job);
    job.promise = Promise.resolve().then(async () => {
      const upload = storage.get(id).uploads.find(u => u.id === uploadId);
      if (!upload || !['pending', 'staged-pending'].includes(upload.state)) return;
      // A missing original is decided first: 'unavailable', never 'deadline'.
      // (Intake holds every admitted original before its job starts, and
      // resume starts no image jobs, so this is a guard only.)
      let result = upload.kind === 'image' && !originals.has(uploadId) ? { status: 'staged-refused', reason: 'unavailable' } : null, release;
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
  // AIT-610 r5 (LEAD condition 2): a staged-pending image whose original no
  // handler set in this process holds was lost to a restart. It is REPORTED
  // as staged-refused 'unavailable' whenever the session or its uploads are
  // read; nothing is written. The answer depends only on the row and this
  // process's holds, so it is the same on every read, and it maps only the
  // rows of the session being read. Expiry removes the row at its normal
  // deadline like any refusal record. No write-through on read: a write would
  // add a failure mode and a published event to every read, for a state that
  // expiry removes anyway.
  function reportUpload(id, upload) {
    return lost(upload) && lost(storage.get(id).uploads.find(current => current.id === upload.id))
      ? { ...upload, state: 'staged-refused', reason: 'unavailable' } : upload;
  }
  const reportUploads = (id, uploads) => {
    const current = new Map(storage.get(id).uploads.map(upload => [upload.id, upload]));
    return uploads.map(upload => lost(upload) && lost(current.get(upload.id)) ? { ...upload, state: 'staged-refused', reason: 'unavailable' } : upload);
  };
  const reportEvent = (id, event) => event?.type === 'upload.state' ? { ...event, data: reportUpload(id, event.data) } : event;
  return { cancelSession, cancelUpload, reportUploads, reportEvent,
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
      if (request.method === 'GET' && !uploadId) return json({ uploads: reportUploads(id, session.uploads), limits });
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
          // AIT-610 r3, a standalone SVG since r4, Netpbm since r5), whatever the name or client
          // MIME. This runs before storage.postUploads: a disguised image is
          // held in memory only and never reaches the database. An image suffix also
          // makes the file image input. An image client MIME does so only without
          // a document suffix: AIT-510 keeps document admission for a named
          // document with a false image MIME hint (the MIME is untrusted).
          const extension = /\.([a-z0-9]+)$/iu.exec(f.name)?.[1].toLowerCase();
          const image = /^image\//u.test(detected.mediaType) || /\.(?:png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?|jxl|svg)$/iu.test(f.name) ||
            !Object.hasOwn(extensions, extension) && /^image\//u.test(f.type);
          // AIT-610 r5, allowlist: a document is persisted ONLY when it is
          // positively one of the types the text extraction supports today.
          // Everything else is refused here, before storage, as 'unsupported',
          // or with a reason that is certain for an Office suffix (r6).
          const refusal = !image && (detected.reason || !EXTRACTABLE_MEDIA_TYPES.includes(detected.mediaType)) ? { refusal: uploadIntakeReason(bytes, f.name, limits.maxBytes) } : {};
          return { bytes, ...(image ? { kind: 'image' } : {}), ...refusal, filename: f.name.slice(0, 200), originalName: f.name, mediaType: detected.mediaType, deadlineAt };
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
        if (replay) return json({ accepted: true, ...named(replay), uploads: replay.events.map(e => reportUpload(id, e.data)), events: replay.events.map(e => reportEvent(id, e)), limits });
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
      // No recovery write (AIT-610 r5): a staged image whose original is gone
      // is reported 'unavailable' on read (reportUploads) and expires at its
      // normal deadline. Only documents have durable work to resume; an image
      // job exists only while intake holds its original.
      for (const id of storage.list()) expire(id);
      for (const id of storage.list()) for (const upload of storage.get(id).uploads) {
        if (upload.kind === 'image' || upload.state !== 'pending' || jobs.has(upload.id) || signal.aborted) continue;
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
