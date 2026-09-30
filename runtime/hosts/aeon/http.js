import { canExecute, loadContractFile, validate } from '../../../contracts/validate.js';
import { JournalError } from '../../journal/port.js';

const matrix = loadContractFile('capabilities.json');
const codes = new Map(loadContractFile('error-codes.json').codes.map((entry) => [entry.code, entry.http]));
const contracts = new Set(loadContractFile('index.json').contracts.map((entry) => entry.contract));
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AeonError extends JournalError {
  constructor(status, message, code = null, document = null) {
    super(status, message, code);
    this.name = 'AeonError';
    this.document = document;
  }
}

/** Domain documents always retain the foundation schemas, including on reads. */
export function checkDocument(doc, contract = doc?.contract) {
  if (!doc || doc.contract !== contract || !contracts.has(contract)) throw new AeonError(502, 'Unexpected host document');
  if (!canExecute(doc).ok) throw new AeonError(422, 'Unsupported host contract', 'contract_too_new');
  if (!validate(contract, doc).ok) throw new AeonError(502, 'Invalid host contract document');
  return doc;
}

/** Bounded, fatal UTF-8 decoding applies to successful and unsuccessful replies. */
async function responseJson(response, signal) {
  if (!response.body) throw new AeonError(502, 'Empty host response');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new AeonError(502, 'Host response exceeds 4 MiB');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof AeonError) throw error;
    throw new AeonError(502, 'Malformed host response');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/**
 * Session-scoped HTTP boundary. credentials receives VERIFIED authority from
 * the authz integration and returns {token, liveGrant?}; JWT verification stays
 * in AIT-P05. The host independently checks scopes, expiry, epoch and generation.
 * paths may map the plugin routes to installation-specific Aeon mount points.
 * There are no automatic retries, acceptance methods, or provider calls.
 */
export class AeonHttp {
  #base;
  #credentials;
  #paths;
  #fetch;
  #timeoutMs;
  #scope;

  constructor({ baseUrl, scope, credentials, paths, fetchImpl = globalThis.fetch,
    timeoutMs = matrix.authority.request_deadline_seconds * 1000 }) {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash ||
        !(base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) {
      throw new TypeError('Aeon requires HTTPS or loopback HTTP, without URL credentials');
    }
    if (!UUID.test(scope?.sid) || ![scope?.tid, scope?.pid].every((s) => typeof s === 'string' && s.length > 0)) {
      throw new TypeError('Aeon requires a fixed session, tenant and project scope');
    }
    if (typeof credentials !== 'function' || typeof fetchImpl !== 'function' || paths !== undefined && typeof paths !== 'function') {
      throw new TypeError('Aeon requires credentials and an HTTP transport');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new TypeError('Host deadline must be 1..10000 ms');
    this.#base = base;
    this.#scope = Object.freeze({ sid: scope.sid, tid: scope.tid, pid: scope.pid });
    this.#credentials = credentials;
    this.#paths = paths ?? ((area, sid, action, id) => `${area}/sessions/${sid}${id ? `/drafts/${id}` : ''}${action ? `/${action}` : ''}`);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  get scope() { return { ...this.#scope }; }

  checkAuthority(authority, capability) {
    if (['sid', 'tid', 'pid'].some((key) => authority?.[key] !== this.#scope[key]) ||
        authority.writer_kind !== 'worker' || !Number.isSafeInteger(authority.gen) || authority.gen < 1 ||
        !Number.isSafeInteger(authority.auth_epoch) || authority.auth_epoch < 1) {
      throw new AeonError(403, 'Wrong delegated session authority');
    }
    if (!Array.isArray(authority.capabilities) || authority.capabilities.some((cap) => !matrix.delegated_allowed.includes(cap)) ||
        !authority.capabilities.includes(capability)) throw new AeonError(403, 'Exact delegated capability required');
  }

  async request({ area, action = '', id = null, method = 'GET', capability, authority, bytes, headers = {}, query = {}, signal }) {
    this.checkAuthority(authority, capability);
    authority = structuredClone(authority);
    if (id !== null && !UUID.test(id)) throw new AeonError(400, 'Invalid draft id');
    if (!['journal', 'intake'].includes(area) || !['GET', 'POST'].includes(method)) throw new AeonError(400, 'Unsupported adapter route');
    const path = this.#paths(area, authority.sid, action, id, this.scope);
    const mount = this.#base.pathname.replace(/\/$/, '') + '/';
    const url = new URL(path, new URL(mount, this.#base));
    if (url.origin !== this.#base.origin || !url.pathname.startsWith(mount) || url.username || url.password || url.hash || url.search) {
      throw new AeonError(400, 'Host route escaped its configured mount');
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const original = bytes === undefined ? undefined : Buffer.from(bytes);
    headers = { ...headers };
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new AeonError(timedOut ? 504 : 499, timedOut ? 'Host request deadline exceeded' : 'Host request cancelled'));
    combined.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const execute = async () => {
      if (combined.aborted) throw new AeonError(499, 'Host request cancelled');
      const credential = await this.#credentials(authority, capability);
      if (combined.aborted) throw new AeonError(timedOut ? 504 : 499, 'Host request cancelled');
      if (typeof credential?.token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(credential.token)) throw new AeonError(401, 'Delegated token unavailable');
      const requestHeaders = { ...headers, authorization: `Bearer ${credential.token}`, accept: 'application/json', 'cache-control': 'no-store' };
      if (original !== undefined) requestHeaders['content-type'] = 'application/json; charset=utf-8';
      if (area === 'intake' && method === 'POST') {
        if (typeof credential.liveGrant !== 'string' || !UUID.test(credential.liveGrant)) throw new AeonError(403, 'Ephemeral LiveGrant unavailable');
        requestHeaders['x-live-grant'] = credential.liveGrant;
      }
      const response = await this.#fetch(url, { method, headers: requestHeaders, body: original,
        signal: combined, redirect: 'error', cache: 'no-store' });
      const body = await responseJson(response, combined);
      if (!response.ok) {
        if (body?.code !== undefined) {
          if (codes.get(body.code) !== response.status) throw new AeonError(502, 'Unknown or inconsistent host error code');
          if (body.document !== undefined) {
            checkDocument(body.document);
            if (body.document.contract === 'aithema.element.event' &&
                (body.document.type !== 'aithema-error' || body.document.detail.code !== body.code)) {
              throw new AeonError(502, 'Host error document disagrees with its code');
            }
          }
          throw new AeonError(response.status, `Aeon refused operation: ${body.code}`, body.code, body.document ?? null);
        }
        throw new AeonError(response.status, `Aeon HTTP ${response.status}`);
      }
      if (body?.code !== undefined) throw new AeonError(502, 'Host returned an error as success');
      if (action === 'authority' && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) {
        throw new AeonError(502, 'Authority response must be uncached');
      }
      return body;
    };
    try { return await Promise.race([execute(), aborted]); }
    catch (error) {
      if (error instanceof JournalError) throw error;
      throw new AeonError(503, 'Aeon transport unavailable');
    } finally {
      clearTimeout(timeout);
      combined.removeEventListener('abort', onAbort);
    }
  }
}
