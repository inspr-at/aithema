import { PluginError } from './invocation.js';
import { validateManifest, deepFreeze } from './plugins.js';
import { inspectZip } from './extractor-zip.js';

// Slim port of Gen-2 lib/extract-limits.js; hosts may only lower these ceilings.
export const EXTRACTOR_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxChars: 60_000,
  maxPages: 100, deadlineMs: 10_000, maxEntries: 512, maxPartBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 48 * 1024 * 1024, maxCompressionRatio: 100, maxHeapMb: 128, maxRssMb: 384 });
export const UPLOAD_LIMITS = Object.freeze({ maxRequestBytes: 8 * 1024 * 1024, maxFilesPerRequest: 4,
  maxDocumentsPerSession: 8, requestBudgetMs: 25_000, providerDocumentChars: 16_000 });
export const EXTRACTOR_MEDIA_TYPES = Object.freeze({ pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
export const TEXT_MEDIA_TYPES = Object.freeze(['text/plain', 'text/csv', 'text/markdown', 'application/xml', 'application/json']);
const UNREADABLE_REASONS = ['unsupported', 'empty', 'malformed', 'encrypted', 'limit'];

export function normalizeExtractorLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !Object.hasOwn(EXTRACTOR_LIMITS, key))) throw new TypeError('Invalid extractor limits');
  return Object.freeze(Object.fromEntries(Object.entries(EXTRACTOR_LIMITS).map(([key, ceiling]) => {
    const limit = value[key] ?? ceiling;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid extractor limit');
    return [key, Math.min(limit, ceiling)];
  })));
}

const starts = (bytes, signature) => signature.every((value, index) => bytes[index] === value);
export function sniffDocument(bytes, limits = EXTRACTOR_LIMITS) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected document bytes');
  if (bytes.length > limits.maxBytes) return { mediaType: 'application/octet-stream', reason: 'limit' };
  if (starts(bytes, [37, 80, 68, 70, 45])) return { mediaType: EXTRACTOR_MEDIA_TYPES.pdf };
  if (starts(bytes, [80, 75, 3, 4]) || starts(bytes, [80, 75, 5, 6])) {
    try {
      const entries = inspectZip(bytes, limits);
      const kinds = [['word/document.xml', 'docx'], ['xl/workbook.xml', 'xlsx'], ['ppt/presentation.xml', 'pptx']]
        .filter(([part]) => entries.has(part));
      return kinds.length === 1 ? { mediaType: EXTRACTOR_MEDIA_TYPES[kinds[0][1]] }
        : { mediaType: 'application/zip', reason: 'unsupported' };
    } catch (error) { return { mediaType: 'application/zip', reason: error.reason ?? 'malformed' }; }
  }
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return { mediaType: 'image/png', reason: 'unsupported' };
  if (starts(bytes, [255, 216, 255])) return { mediaType: 'image/jpeg', reason: 'unsupported' };
  if (starts(bytes, [82, 73, 70, 70]) && starts(bytes.subarray(8), [87, 69, 66, 80])) return { mediaType: 'image/webp', reason: 'unsupported' };
  // Binary control bytes must never fall through to a textual parser.
  if (bytes.some(byte => byte < 32 && ![9, 10, 12, 13].includes(byte))) return { mediaType: 'application/octet-stream', reason: 'unsupported' };
  let sample;
  try { sample = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { mediaType: 'application/octet-stream', reason: 'unsupported' }; }
  if (/^\s*(?:<\?xml\b|<!DOCTYPE\b|<[A-Za-z_:][\w:.-]*(?:\s|>|\/))/u.test(sample)) return { mediaType: 'application/xml' };
  // JSON-shaped text stays literal too; sniffing never parses/imports its claims.
  if (/^\s*[\[{]/u.test(sample)) return { mediaType: 'application/json' };
  if (/^(?:#{1,6} |```|[-*] )/mu.test(sample)) return { mediaType: 'text/markdown' };
  const rows = sample.trim().split('\n', 3);
  if (rows.length > 1 && [',', ';', '\t'].some(separator => {
    const counts = rows.map(row => row.split(separator).length);
    return counts[0] > 1 && counts.every(count => count === counts[0]);
  })) return { mediaType: 'text/csv' };
  return { mediaType: 'text/plain' };
}
export const sniffUploadMime = (bytes, limits) => sniffDocument(bytes, limits).mediaType;

export function unreadable(mediaType, limits, reason = 'malformed') {
  return { status: 'unreadable', reason: UNREADABLE_REASONS.includes(reason) ? reason : 'malformed',
    text: '', segments: [], mediaType, truncated: false, limits };
}
export function extractionResult(raw, mediaType, limits) {
  if (raw?.reason) return unreadable(mediaType, limits, raw.reason);
  if (!Array.isArray(raw?.segments) || raw.segments.length > limits.maxPages ||
    raw.segments.some(segment => typeof segment?.text !== 'string' ||
      segment.page !== undefined && (!Number.isSafeInteger(segment.page) || segment.page < 1 || segment.page > limits.maxPages))) {
    return unreadable(mediaType, limits, 'limit');
  }
  const segments = [];
  let remaining = limits.maxChars, truncated = Boolean(raw.truncated);
  for (const segment of raw.segments) {
    const normalized = segment.text.replace(/\r\n?/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
    if (!normalized) continue;
    const allowance = Math.max(0, remaining - (segments.length ? 2 : 0));
    if (normalized.length > allowance) truncated = true;
    if (!allowance) continue;
    let text = normalized.slice(0, allowance);
    if (text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) text = text.slice(0, -1);
    if (!text) continue;
    remaining -= text.length + (segments.length ? 2 : 0);
    segments.push({ id: `segment:${segments.length + 1}`, text, ...(segment.page === undefined ? {} : { page: segment.page }) });
  }
  const text = segments.map(segment => segment.text).join('\n\n');
  return text ? { status: 'accepted', text, segments, mediaType, truncated, limits } : unreadable(mediaType, limits, 'empty');
}
export function extractorLifetime(options = {}, limits = EXTRACTOR_LIMITS) {
  const signal = options.signal ?? new AbortController().signal;
  if (typeof signal.addEventListener !== 'function' ||
    options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new TypeError('Invalid extractor lifetime');
  if (signal.aborted) throw new PluginError('cancelled');
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + limits.deadlineMs);
  if (deadlineAt <= Date.now()) throw new PluginError('deadline');
  return { signal, deadlineAt };
}
export function assertExtractor(plugin) {
  if (!validateManifest(plugin?.manifest).ok || !plugin.manifest.kinds.includes('extractor') ||
    typeof plugin.extract !== 'function' || typeof plugin.health !== 'function') throw new TypeError('Invalid extractor plugin');
  return plugin;
}
export function extractorManifest(id, formats) {
  return deepFreeze({ id, version: '0.0.0', apiVersion: '^1.0.0', kinds: ['extractor'], placement: 'server',
    entrypoints: { server: './src/index.js' }, configSchema: { type: 'object', properties: {}, additionalProperties: false },
    vendor: { name: 'INSPR', url: 'https://github.com/inspr-at/aithema' },
    models: [{ id: id, operations: ['extract'], streaming: false, structured: false, efforts: ['none'],
      languages: ['und'], germanQuality: 'unverified', formats, processingLocations: ['host'], qualification: 'unverified',
      evidence: [], expiresAt: null, cost: { unit: 'document', inputMicro: 0, outputMicro: 0, reviewedAt: null } }] });
}
// A host owns registration/preset admission. This dispatcher has no implicit network or fallback.
export function createExtractor({ plugins, limits: overrides } = {}) {
  if (!Array.isArray(plugins)) throw new TypeError('Expected extractor plugins');
  plugins.forEach(assertExtractor);
  const limits = normalizeExtractorLimits(overrides);
  return { limits, async extract(bytes, metadata = {}, options = {}) {
    const requested = normalizeExtractorLimits(options.limits);
    const effective = normalizeExtractorLimits(Object.fromEntries(Object.entries(limits)
      .map(([key, ceiling]) => [key, Math.min(ceiling, requested[key])])));
    const lifetime = extractorLifetime(options, effective), detected = sniffDocument(bytes, effective);
    if (detected.reason) return unreadable(detected.mediaType, effective, detected.reason);
    const plugin = plugins.find(candidate => candidate.manifest.models.some(model => model.formats.includes(detected.mediaType)));
    if (!plugin) return unreadable(detected.mediaType, effective, 'unsupported');
    const result = await plugin.extract(bytes, metadata, { ...lifetime, limits: effective });
    extractorLifetime(lifetime, effective);
    if (result?.mediaType !== detected.mediaType || !isExtraction(result) ||
      Object.entries(effective).some(([key, cap]) => result.limits[key] > cap)) throw new PluginError('invalid-output');
    return extractionResult(result.status === 'unreadable' ? { reason: result.reason } : result, detected.mediaType, result.limits);
  } };
}
export function isExtraction(value) {
  if (!value || !['accepted', 'unreadable'].includes(value.status) || typeof value.text !== 'string' ||
    typeof value.mediaType !== 'string' || typeof value.truncated !== 'boolean' || !Array.isArray(value.segments)) return false;
  try {
    if (Object.entries(normalizeExtractorLimits(value.limits)).some(([key, cap]) => value.limits?.[key] !== cap)) return false;
  } catch { return false; }
  if (value.text.length > value.limits.maxChars || value.segments.length > value.limits.maxPages ||
    new Set(value.segments.map(segment => segment?.id)).size !== value.segments.length ||
    value.segments.some(segment => typeof segment?.id !== 'string' || !segment.id || typeof segment.text !== 'string' ||
      !segment.text || segment.page !== undefined && (!Number.isSafeInteger(segment.page) || segment.page < 1 || segment.page > value.limits.maxPages))) return false;
  return value.status === 'unreadable' ? value.text === '' && value.segments.length === 0 && !value.truncated && UNREADABLE_REASONS.includes(value.reason)
    : value.text.length > 0 && value.text === value.segments.map(segment => segment.text).join('\n\n') && value.reason === undefined;
}
