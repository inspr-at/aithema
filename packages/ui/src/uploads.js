// START document intake (scripts/v2.ts attachment management, lib/config.ts accepted types and
// limits), ported to the AIT-100 B1 owner routes. The server stays authoritative: these checks only
// say early and in plain words what it would refuse. File contents are never read here.

// The route's defaults (packages/server/src/upload-limits.js); a host can only lower them, and every
// upload response reports the binding values.
export const UPLOAD_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxRequestBytes: 64 * 1024 * 1024,
  maxFilesPerRequest: 8, maxDocumentsPerSession: 8, maxSessionBytes: 160 * 1024 * 1024 });
// Extensions the server sniffs and extracts; a file without one is left to the server's sniffing.
export const UPLOAD_EXTENSIONS = Object.freeze(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'xml']);
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
const extension = name => /\.([a-z0-9]+)$/iu.exec(name)?.[1].toLowerCase() ?? null;
const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (match, key) => values[key] ?? match);

/** Server limits from a response, falling back to the defaults for anything missing or malformed. */
export function uploadLimits(value) {
  return Object.freeze(Object.fromEntries(Object.entries(UPLOAD_LIMITS).map(([key, fallback]) =>
    [key, Number.isSafeInteger(value?.[key]) && value[key] > 0 ? value[key] : fallback])));
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
 * as few requests as the per-request ceilings allow; a batch that would overfill the conversation
 * (count or total size) is refused as a whole, since only the person can choose which files matter.
 */
export function planUploads(files, { limits: raw, uploads = [] } = {}) {
  const limits = uploadLimits(raw), refused = [], fitting = [], possible = uploadsPossible(limits);
  for (const file of files) {
    // The whole request one file would need on its own (form, its part's headers and its bytes) is checked
    // against the ceilings before batching: an empty file still carries headers that may not fit.
    const type = extension(file.name), limit = fileCeiling(limits, file);
    if (type && !UPLOAD_EXTENSIONS.includes(type)) refused.push({ name: file.name, reason: 'type' });
    else if (!possible || file.size > room(limits, filePartBytes(file))) refused.push({ name: file.name, reason: 'size', limit });
    else fitting.push(file);
  }
  const active = uploads.filter(u => u.state !== 'withdrawn' && !u.erased);
  const used = active.reduce((sum, u) => sum + (u.bytes ?? 0), 0), adding = fitting.reduce((sum, f) => sum + f.size, 0);
  const blocked = !fitting.length ? null : active.length + fitting.length > limits.maxDocumentsPerSession ? 'count'
    : used + adding > limits.maxSessionBytes ? 'session' : null;
  const batches = [];
  if (!blocked) for (const file of fitting) {
    const last = batches.at(-1), size = filePartBytes(file) + file.size;
    if (last && last.files.length < limits.maxFilesPerRequest && last.bytes + size <= limits.maxRequestBytes) { last.files.push(file); last.bytes += size; }
    else batches.push({ files: [file], bytes: formBytes() + size });
  }
  return { batches: batches.map(batch => batch.files), refused, blocked, limits };
}

/** A byte count in the page language: "820 B", "12 KB", "1.4 MB" ("1,4 MB" in German). */
export function formatBytes(bytes, locale = 'en') {
  const [value, unit] = bytes < 1024 ? [bytes, 'B'] : bytes < 1024 ** 2 ? [bytes / 1024, 'KB'] : [bytes / 1024 ** 2, 'MB'];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 'B' || value >= 10 ? 0 : 1 }).format(value)} ${unit}`;
}
export function plural(forms, count) { return fill(count === 1 ? forms.one : forms.other, { count }); }
export function limitsText(copy, limits, locale) {
  if (!uploadsPossible(limits)) return copy.uploads.impossible;
  return fill(copy.uploads.limits, { files: limits.maxDocumentsPerSession, size: formatBytes(fileCeiling(limits), locale) });
}
export function dropText(copy, limits, locale) {
  if (!uploadsPossible(limits)) return copy.uploads.impossible;
  return fill(copy.uploads.dropLimits, { files: limits.maxDocumentsPerSession, size: formatBytes(fileCeiling(limits), locale) });
}

/** The plain-words refusal for a plan, or '' when everything chosen is sent. */
export function refusalText(copy, { refused, blocked, limits }, locale) {
  const u = copy.uploads, sentences = [];
  if (refused.length && !uploadsPossible(limits)) return u.impossible;
  if (refused.length) sentences.push(fill(u.refused, { list: refused.map(r => fill(r.reason === 'type' ? u.type : u.tooLarge, { name: r.name, size: formatBytes(r.limit ?? 0, locale) })).join(', ') }));
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
