import { validateManifest } from './plugins.js';
import { isExtraction, EXTRACTOR_MEDIA_TYPES } from './extractor.js';

// Portable offline kit. Adapters supply a normal and unreadable document, a
// non-cooperative parser fixture, and observations of actual process lifetime.
export async function extractorConformance(plugin, fixture, { timeoutMs = 3000, stallBytes, unreadableBytes,
  pageBytes, archiveBombBytes, workCount, activeCount, killedCount, requestCount, waitForWork } = {}) {
  const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
  if (!validateManifest(plugin?.manifest).ok || !plugin.manifest.kinds.includes('extractor') ||
    typeof plugin.extract !== 'function' || typeof plugin.health !== 'function') return { ok: false, failures: ['extractor manifest/operations'] };
  if (!(fixture?.bytes instanceof Uint8Array) || typeof fixture.mediaType !== 'string' ||
    !(stallBytes instanceof Uint8Array) || !(unreadableBytes instanceof Uint8Array) ||
    [workCount, activeCount, killedCount, requestCount, waitForWork].some(value => typeof value !== 'function')) {
    return { ok: false, failures: ['local active/caps/unreadable/network fixtures required'] };
  }
  const formats = new Set(plugin.manifest.models.flatMap(model => model.formats));
  if ([EXTRACTOR_MEDIA_TYPES.pdf, EXTRACTOR_MEDIA_TYPES.xlsx, EXTRACTOR_MEDIA_TYPES.pptx].some(type => formats.has(type)) &&
    !(pageBytes instanceof Uint8Array)) return { ok: false, failures: ['page cap fixture required for paginated formats'] };
  if (pageBytes !== undefined && !(pageBytes instanceof Uint8Array) ||
    archiveBombBytes !== undefined && !(archiveBombBytes instanceof Uint8Array)) {
    return { ok: false, failures: ['invalid page/archive cap fixtures'] };
  }
  const requestsBefore = requestCount();
  const options = (extra = {}) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + timeoutMs, ...extra });
  // Harness timers bound bad plugins without pretending their abandoned work stopped.
  const bounded = async operation => {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('conformance timeout')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const rejects = async (operation, code, label) => {
    try { await bounded(operation); check(false, label); }
    catch (error) { check(error?.code === code, `${label}: typed ${code}`); }
  };
  const extract = (bytes = fixture.bytes, metadata = fixture.metadata ?? {}, extra = {}) =>
    plugin.extract(bytes, metadata, options(extra));
  try {
    const health = await bounded(plugin.health(options()));
    check(health?.available === true, 'local health');
    const result = await bounded(extract());
    check(isExtraction(result) && result.status === 'accepted' && result.mediaType === fixture.mediaType, 'valid text and citable segments');
    check(result?.text.includes(fixture.expectedText ?? ''), 'fixture text retained');
    for (const mediaType of new Set(['image/png', ...[...formats].filter(type => type !== fixture.mediaType), 'text/plain'])) {
      const lied = await bounded(extract(fixture.bytes, { mediaType, filename: 'lie.png' }));
      check(isExtraction(lied) && lied.mediaType === fixture.mediaType && lied.text === result?.text,
        `sniffing beats declared type/filename: ${mediaType}`);
    }
    const broken = await bounded(extract(unreadableBytes));
    check(isExtraction(broken) && broken.status === 'unreadable', 'unreadable input is a typed result');
    const beforeCap = workCount();
    const size = await bounded(extract(fixture.bytes, {}, { limits: { maxBytes: Math.max(1, fixture.bytes.length - 1) } }));
    check(isExtraction(size) && size.status === 'unreadable' && size.reason === 'limit' &&
      size.limits.maxBytes < fixture.bytes.length, 'byte cap enforced');
    check(workCount() === beforeCap, 'oversized bytes spawn no work');
    const chars = await bounded(extract(fixture.bytes, {}, { limits: { maxChars: 8 } }));
    check(isExtraction(chars) && chars.status === 'accepted' && chars.text.length <= 8 && chars.truncated &&
      chars.limits.maxChars === 8, 'character cap enforced');
    if (pageBytes) {
      const pages = await bounded(extract(pageBytes, {}, { limits: { maxPages: 1 } }));
      check(isExtraction(pages) && pages.status === 'unreadable' && pages.reason === 'limit', 'page cap enforced');
    }
    if (archiveBombBytes) {
      const bomb = await bounded(extract(archiveBombBytes));
      check(isExtraction(bomb) && bomb.status === 'unreadable' && bomb.reason === 'limit', 'archive bomb cap enforced');
    }
    const beforePreflight = workCount(), controller = new AbortController(); controller.abort();
    await rejects(extract(fixture.bytes, {}, { signal: controller.signal }), 'cancelled', 'preflight cancellation');
    await rejects(extract(fixture.bytes, {}, { deadlineAt: Date.now() - 1 }), 'deadline', 'preflight deadline');
    await rejects(plugin.health(options({ signal: controller.signal })), 'cancelled', 'health cancellation');
    await rejects(plugin.health(options({ deadlineAt: Date.now() - 1 })), 'deadline', 'health deadline');
    check(workCount() === beforePreflight, 'preflight spawns no work');

    const run = async deadline => {
      const before = workCount(), killedBefore = killedCount(), abort = new AbortController();
      const work = extract(stallBytes, {}, { signal: abort.signal, deadlineAt: Date.now() + (deadline ? Math.min(750, timeoutMs / 2) : timeoutMs) });
      // Attach the rejection handler immediately, including while waiting for work.
      const outcome = work.then(() => null, error => error);
      try {
        // A short deadline can kill the process before its started message on slow hosts.
        // Race against settlement so waiting for that message cannot strand the kit.
        const started = await bounded(Promise.race([
          Promise.resolve(waitForWork(before, { signal: abort.signal })).then(() => true), outcome.then(() => false),
        ]));
        check(workCount() > before && (deadline || started && activeCount() > 0), 'active parser fixture started');
        if (!deadline) abort.abort();
        const error = await bounded(outcome);
        check(error?.code === (deadline ? 'deadline' : 'cancelled'), 'active typed cancellation/deadline');
        check(activeCount() === 0 && killedCount() > killedBefore, 'cancel/deadline kills and reaps work');
      } finally { abort.abort(); await bounded(outcome); }
    };
    await run(false); await run(true);
  } catch (error) { failures.push(`extractor operation: ${error?.code ?? error?.name ?? 'failed'}`); }
  check(requestCount() === requestsBefore, 'extraction made no network requests');
  check(activeCount() === 0, 'no parser left running');
  return { ok: failures.length === 0, failures };
}
