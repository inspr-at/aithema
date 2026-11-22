export { plural } from './copy-resolve.js';
import { resolveCopy } from './copy-resolve.js';

// START document intake (scripts/v2.ts attachment management, lib/config.ts accepted types and
// limits), ported to the AIT-100 B1 owner routes. The server stays authoritative: these checks only
// say early and in plain words what it would refuse. Only bounded signatures are read to defer ambiguous session-limit checks.

// The route's defaults (packages/server/src/upload-limits.js): 20 MiB per document, 21 MiB per
// request including framing. Hosts can only lower them; limits GET and successful POST report them.
export const UPLOAD_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxRequestBytes: 21 * 1024 * 1024,
  maxFilesPerRequest: 8, maxDocumentsPerSession: 8, maxImagesPerSession: 8, maxSessionBytes: 160 * 1024 * 1024 });
// Extensions the server sniffs and extracts; a file without one is left to the server's sniffing.
export const DOCUMENT_UPLOAD_EXTENSIONS = Object.freeze(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'xml']);
export const DOCUMENT_UPLOAD_ACCEPT = DOCUMENT_UPLOAD_EXTENSIONS.map(extension => `.${extension}`).join(',');
export const UPLOAD_EXTENSIONS = Object.freeze([...DOCUMENT_UPLOAD_EXTENSIONS, 'png', 'jpg', 'jpeg', 'webp', 'gif']);
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map(extension => `.${extension}`).join(',');
// Multipart framing, byte for byte as the browser writes it (HTML multipart/form-data encoding):
// the clientEventId field, then one part per file, then the closing delimiter. The browser picks
// the boundary; it is at most 70 characters (RFC 2046, which the server enforces), so the sum is
// exact for that boundary and never below the real body.
const MAX_BOUNDARY = 70, encoder = new TextEncoder(), utf8 = text => encoder.encode(text).length;
// Names and filenames escape LF, CR and the double quote; a file without a type is sent as octet-stream.
const escaped = name => name.replace(/[\n\r"]/gu, c => ({ '\n': '%0A', '\r': '%0D', '"': '%22' })[c]);
const partBytes = (name, type, boundary) => 2 + boundary + 2
  + utf8(`Content-Disposition: form-data; name="files"; filename="${escaped(name)}"\r\nContent-Type: ${type}\r\n\r\n`) + 2;
/** Bytes of the multipart framing around one file (its delimiter and headers), without its contents. */
export const filePartBytes = (file, boundary = MAX_BOUNDARY) => partBytes(file.name, file.type || 'application/octet-stream', boundary);
/** Bytes of the request outside the file parts: the clientEventId field (a UUID) and the closing delimiter. */
export function formBytes(boundary = MAX_BOUNDARY) {
  return 2 + boundary + 2 + utf8('Content-Disposition: form-data; name="clientEventId"\r\n\r\n') + 36 + 2 + 2 + boundary + 2 + 2;
}
export const isImageFile = file => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || !/\.[a-z0-9]+$/iu.test(file.name) && /^image\/(?:png|jpeg|webp|gif)$/u.test(file.type);
const extension = name => /\.([a-z0-9]+)$/iu.exec(name)?.[1].toLowerCase() ?? null;
// AIT-610 r6: reasons the server names for a document refused at intake when
// it is certain (an Office suffix); each is shown as '{name} ({reason copy})'
// (punctuation only, so it is not a copy key), or with the file-type wording
// when the host copy has no text for that reason.
export const DOCUMENT_INTAKE_REASONS = Object.freeze(['encrypted', 'legacy', 'malformed']);
const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (match, key) => values[key] ?? match);

/** Files whose document/image kind needs authoritative classification. Only a
 * small signature is read; contents are never decoded or retained by the UI. */
export async function unclassifiedUploads(files, imageFile = isImageFile) {
  const unknown = await Promise.all(files.map(async file => {
    if (imageFile(file)) return false;
    const type = extension(file.name);
    if (!type) return true;
    if (!DOCUMENT_UPLOAD_EXTENSIONS.includes(type)) return false;
    try {
      const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const starts = signature => signature.every((byte, index) => bytes[index] === byte);
      const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
      return starts([137, 80, 78, 71, 13, 10, 26, 10]) || starts([255, 216, 255])
        || starts([82, 73, 70, 70]) && ascii(8, 12) === 'WEBP'
        || /^GIF8[79]a$/u.test(ascii(0, 6))
        || ascii(4, 8) === 'ftyp' && /^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/u.test(ascii(8, 12));
    } catch { return true; }
  }));
  return files.filter((file, index) => unknown[index]);
}

/** Server limits from a response, falling back to the defaults for anything missing or malformed. */
export function uploadLimits(value) {
  return Object.freeze(Object.fromEntries(Object.entries(UPLOAD_LIMITS).map(([key, fallback]) =>
    [key, Number.isSafeInteger(value?.[key]) && value[key] > 0 ? value[key] : fallback])));
}

/** Back off for 5 then 10 seconds; honor a longer Retry-After up to 30 seconds. */
export function uploadRetryDelay(response, attempt, now = Date.now()) {
  const header = response.headers.get('retry-after'), seconds = /^\d+$/u.test(header ?? '') ? Number(header) : NaN;
  const retryAfter = Number(header) < 0 ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - now;
  return Math.min(30000, Math.max(5000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0));
}
// The largest file one request can carry: its own framing for a given file, the shortest framing
// (no name, no type) for the limits shown before a file is chosen. Never negative; below one byte
// this host's limits leave no room for any file.
const room = (limits, part) => Math.min(limits.maxBytes, limits.maxRequestBytes - formBytes() - part);
const ceiling = (limits, part) => Math.max(0, room(limits, part));
const fileCeiling = (limits, file) => ceiling(limits, file ? filePartBytes(file) : partBytes('', '', MAX_BOUNDARY));
/** Whether this host's limits leave room for a file at all. */
export const uploadsPossible = limits => fileCeiling(uploadLimits(limits)) > 0;

/**
 * Splits chosen files into what is sent and what is refused before sending. Files that pass go in
 * as few requests as the per-request ceilings allow. Excess images are refused individually;
 * document count and total-byte holds can be deferred to authoritative server classification.
 */
export function planUploads(files, { limits: raw, uploads = [], images = true, imageFile = isImageFile, deferSessionLimits = false } = {}) {
  const limits = uploadLimits(raw), refused = [], fitting = [], possible = uploadsPossible(limits);
  for (const file of files) {
    // The whole request one file would need on its own (form, its part's headers and its bytes) is checked
    // against the ceilings before batching: an empty file still carries headers that may not fit.
    const type = extension(file.name), limit = fileCeiling(limits, file);
    if (type && !(images ? UPLOAD_EXTENSIONS : DOCUMENT_UPLOAD_EXTENSIONS).includes(type)) refused.push({ name: file.name, reason: 'type' });
    else if (!possible || file.size > room(limits, filePartBytes(file))) refused.push({ name: file.name, reason: 'size', limit });
    else fitting.push(file);
  }
  const active = uploads.filter(u => !['withdrawn', 'staged-discarded', 'withheld'].includes(u.state) && !u.erased);
  const imageCount = active.filter(u => u.kind === 'image').length, imageRefused = [];
  let imageSlots = Math.max(0, limits.maxImagesPerSession - imageCount);
  const admitted = fitting.filter(file => {
    if (!images || !imageFile(file)) return true;
    if (imageSlots > 0) { imageSlots--; return true; }
    imageRefused.push({ name: file.name, reason: 'limit' }); return false;
  });
  // Known images on a document-only host are refused by the server. They
  // still occupy transport bytes, but cannot consume document/session slots.
  const used = active.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
  const adding = admitted.filter(file => images || !imageFile(file)).reduce((sum, file) => sum + file.size, 0);
  const addingImages = admitted.filter(imageFile).length;
  const blocked = !admitted.length ? imageRefused.length ? 'images' : null
    : !deferSessionLimits && active.length - imageCount + admitted.length - addingImages > limits.maxDocumentsPerSession ? 'count'
    : !deferSessionLimits && used + adding > limits.maxSessionBytes ? 'session' : null;
  const batches = [];
  if (!blocked) for (const file of admitted) {
    const last = batches.at(-1), size = filePartBytes(file) + file.size;
    if (last && last.files.length < limits.maxFilesPerRequest && last.bytes + size <= limits.maxRequestBytes) { last.files.push(file); last.bytes += size; }
    else batches.push({ files: [file], bytes: formBytes() + size });
  }
  return { batches: batches.map(batch => batch.files), refused, imageRefused, blocked, limits };
}

/** A byte count in the page language: "820 B", "12 KB", "1.4 MB" ("1,4 MB" in German). */
export function formatBytes(bytes, locale = 'en') {
  const [value, unit] = bytes < 1024 ? [bytes, 'B'] : bytes < 1024 ** 2 ? [bytes / 1024, 'KB'] : [bytes / 1024 ** 2, 'MB'];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 'B' || value >= 10 ? 0 : 1 }).format(value)} ${unit}`;
}
export function limitsText(copy, limits, locale, images = false) {
  if (!uploadsPossible(limits)) return copy.uploads.impossible;
  return fill(images ? resolveCopy(copy, 'uploads.limitsWithImages', 'uploads.limits', locale) : copy.uploads.limits, { files: limits.maxDocumentsPerSession, size: formatBytes(fileCeiling(limits), locale) });
}
export function dropText(copy, limits, locale) {
  if (!uploadsPossible(limits)) return copy.uploads.impossible;
  return fill(copy.uploads.dropLimits, { files: limits.maxDocumentsPerSession, size: formatBytes(fileCeiling(limits), locale) });
}

/** The plain-words refusal for a plan, or '' when everything chosen is sent. */
export function refusalText(copy, { refused, blocked, limits }, locale) {
  const u = copy.uploads, sentences = [];
  if (refused.length && !uploadsPossible(limits)) return u.impossible;
  if (refused.length) sentences.push(fill(u.refused, { list: refused.map(r => fill(r.reason === 'type' ? u.type
    : DOCUMENT_INTAKE_REASONS.includes(r.reason) ? u.reasons?.[r.reason] ? '{name} ({reason})' : u.type : u.tooLarge,
    { name: r.name, size: formatBytes(r.limit ?? 0, locale), reason: u.reasons?.[r.reason] })).join(', ') }));
  if (blocked === 'images') sentences.push(resolveCopy(copy, 'imageRefusals.limit', undefined, locale));
  if (blocked === 'count') sentences.push(fill(u.tooMany, { files: limits.maxDocumentsPerSession }));
  if (blocked === 'session') sentences.push(fill(u.sessionFull, { size: formatBytes(limits.maxSessionBytes, locale) }));
  return sentences.join(' ');
}

/** Every state line one language can show, for the slot that reserves the tallest of them. */
export function uploadStateTexts(copy) {
  const u = copy.uploads;
  return [u.pending, u.accepted, u.truncated, ...Object.values(u.reasons).map(reason => fill(u.unreadable, { reason }))];
}
/** The chip's state line: pending, accepted (or accepted in part), unreadable with its reason. */
export function uploadStateText(copy, upload) {
  const u = copy.uploads;
  if (upload.state === 'withdrawn' || upload.erased) return u.withdrawn;
  if (upload.state === 'pending') return u.pending;
  if (upload.state === 'accepted') return upload.truncated ? u.truncated : u.accepted;
  return fill(u.unreadable, { reason: Object.hasOwn(u.reasons, upload.reason ?? '') ? u.reasons[upload.reason] : u.reasons.unavailable });
}

const svg = body => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const UPLOAD_ICONS = Object.freeze({
  attach: svg('<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
});
