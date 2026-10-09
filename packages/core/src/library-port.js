import { createSession } from './session.js';
import { hostPortKit } from './host-port-kit.js';

export const LIBRARY_OPERATIONS = Object.freeze(['list', 'open', 'rename', 'delete', 'new', 'reset']);
export class LibraryPortError extends Error {
  constructor(code) { super(code); this.name = 'LibraryPortError'; this.code = code; }
}
export function assertLibraryPort(port) {
  if (LIBRARY_OPERATIONS.some(name => typeof port?.[name] !== 'function')) throw new TypeError('Library operations missing');
  return port;
}
const validTitle = title => typeof title === 'string' && title.length <= 200;
const metadata = entry => ({ id: entry.id, title: entry.title, revision: entry.revision,
  createdAt: entry.createdAt, updatedAt: entry.updatedAt });

/** Bound to one owner by the host. list({search,offset,limit}) ->
 * {items,total,offset,limit}; open(id) -> {...metadata,session}; rename(id,title)
 * -> metadata; delete(id) -> {id,erased:true}; new(options)/reset(id) -> open result.
 * erase({id,revision}) MUST await the existing storage.erase + invalidation path.
 * The reference's default callback only erases its own in-memory records. */
export function createMemoryLibrary({ erase = async () => ({ erased: true }), now = () => 0 } = {}) {
  if (typeof erase !== 'function' || typeof now !== 'function') throw new TypeError('Invalid memory library hooks');
  const entries = new Map(), erasures = new Map(), erasedIds = new Set();
  let counter = 0;
  const timestamp = () => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid library time');
    return at;
  };
  const get = id => {
    if (!entries.has(id)) throw new LibraryPortError('not-found');
    if (erasures.has(id)) throw new LibraryPortError('erasing');
    return entries.get(id);
  };
  const open = entry => structuredClone({ ...metadata(entry), session: entry.session });
  const port = {
    async list({ search = '', offset = 0, limit = 20 } = {}) {
      if (typeof search !== 'string' || search.length > 200 || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid library page');
      const query = search.trim().toLowerCase();
      const matches = [...entries.values()].filter(e => !erasures.has(e.id) && e.title.toLowerCase().includes(query))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      return { items: matches.slice(offset, offset + limit).map(metadata), total: matches.length, offset, limit };
    },
    async open(id) { return open(get(id)); },
    async rename(id, title) {
      if (!validTitle(title)) throw new TypeError('Invalid conversation title');
      const entry = get(id), updatedAt = timestamp();
      entry.title = title.trim(); entry.revision += 1; entry.updatedAt = updatedAt;
      return metadata(entry);
    },
    async delete(id) {
      if (erasures.has(id)) return erasures.get(id);
      const entry = get(id);
      // Set the single-flight slot before calling user code, including a
      // synchronous callback; no open/rename can race an erasure acknowledgement.
      const pending = Promise.resolve().then(async () => {
        const receipt = await erase({ id, revision: entry.revision });
        if (receipt?.erased !== true) throw new LibraryPortError('erasure-unconfirmed');
        entries.delete(id); erasedIds.add(id);
        return { id, erased: true };
      }).finally(() => erasures.delete(id));
      erasures.set(id, pending);
      return pending;
    },
    async new({ title = '', locale = 'en', processingPreset = 'best', preset } = {}) {
      if (!validTitle(title)) throw new TypeError('Invalid conversation title');
      const at = timestamp(), id = `conversation-${++counter}`;
      const session = createSession({ id, locale, processingPreset, ...(preset ? { preset } : {}) });
      const entry = { id, title: title.trim(), revision: 0, createdAt: at, updatedAt: at, session };
      entries.set(id, entry);
      return open(entry);
    },
    async reset(id) {
      const { locale, processingPreset, preset } = get(id).session;
      await port.delete(id);
      return port.new({ locale, processingPreset, preset });
    }
  };
  return { port, wasErased: id => erasedIds.has(id) };
}

/** Destructive conformance kit for a fresh owner-bound local fixture. The
 * independently instrumented wasErased hook must observe the storage path. */
export async function libraryConformance(port, { wasErased, timeoutMs = 1000 } = {}) {
  const kit = hostPortKit(timeoutMs), { check, run } = kit;
  try { assertLibraryPort(port); } catch { check(false, 'library operations missing'); return kit.result(); }
  if (typeof wasErased !== 'function') { check(false, 'storage erasure observer missing'); return kit.result(); }
  const first = await run('new failed', () => port.new({ title: 'Kit alpha', locale: 'de' }));
  const second = await run('second new failed', () => port.new({ title: 'Kit beta' }));
  check(first?.id && second?.id && first.id !== second.id && first.session?.id === first.id &&
    first.session?.transcript?.length === 0, 'new fresh session');
  const page = await run('list failed', () => port.list({ search: 'KIT', offset: 0, limit: 1 }));
  const next = await run('paging failed', () => port.list({ search: 'KIT', offset: 1, limit: 1 }));
  check(page?.total === 2 && page.offset === 0 && page.limit === 1 && page.items?.length === 1 &&
    next?.total === 2 && next.offset === 1 && next.limit === 1 && next.items?.length === 1 &&
    page.items[0].id !== next.items[0].id, 'search and paging');
  const empty = await run('empty search failed', () => port.list({ search: 'no such kit conversation' }));
  check(empty?.total === 0 && empty.items?.length === 0, 'search filters');
  if (first?.id) {
    const opened = await run('open failed', () => port.open(first.id));
    check(opened?.id === first.id && opened.session?.locale === 'de', 'open identity and content');
    if (opened?.session?.transcript) opened.session.transcript.push({ content: 'fixture mutation' });
    const again = await run('second open failed', () => port.open(first.id));
    check(again?.session?.transcript?.length === 0, 'open snapshot isolation');
    const renamed = await run('rename failed', () => port.rename(first.id, 'Kit renamed'));
    check(renamed?.title === 'Kit renamed' && renamed.revision > first.revision, 'rename metadata revision');
    const found = await run('renamed search failed', () => port.list({ search: 'renamed' }));
    check(found?.total === 1 && found.items?.[0]?.id === first.id, 'rename searchable');
    const erased = await run('delete failed', () => port.delete(first.id));
    check(erased?.id === first.id && erased.erased === true && await run('delete observer failed', () => wasErased(first.id)), 'delete uses storage erasure');
    await run('deleted open check failed', async () => {
      try { await port.open(first.id); check(false, 'deleted session still opens'); } catch (e) { check(e?.code === 'not-found', 'deleted open error'); }
    });
  }
  if (second?.id) {
    const replacement = await run('reset failed', () => port.reset(second.id));
    check(replacement?.id && replacement.id !== second.id && replacement.session?.id === replacement.id &&
      replacement.session?.transcript?.length === 0 && replacement.title === '' &&
      await run('reset observer failed', () => wasErased(second.id)), 'reset erases and creates a fresh session');
    await run('reset open check failed', async () => {
      try { await port.open(second.id); check(false, 'reset session still opens'); } catch (e) { check(e?.code === 'not-found', 'reset open error'); }
    });
    const remaining = await run('post erasure list failed', () => port.list());
    check(remaining?.items?.every(item => item.id !== first?.id && item.id !== second.id), 'erased entries absent from list');
  }
  return kit.result();
}
