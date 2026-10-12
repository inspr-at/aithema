import { generationId, usdCostMicro, operationScope, untilCancelled, responseText } from '@inspr/aithema-core';

/** Only metadata is retained: no prompt, output or credential enters the cost journal. */
export async function reconcileGeneration(record, { resolveSecret, fetchImpl = fetch, ...options }) {
  const id = generationId(record.generationId);
  if (!id) return null; // An interrupted request without a returned ID remains explicitly uncertain.
  const scope = operationScope(options);
  try {
    const key = await resolveSecret(record.secretRef);
    if (typeof key !== 'string' || !key || /[\r\n]/u.test(key)) return null;
    const url = new URL(record.endpoint);
    url.pathname = /\/chat\/completions\/?$/u.test(url.pathname)
      ? url.pathname.replace(/\/chat\/completions\/?$/u, '/generation') : '/api/v1/generation';
    url.searchParams.set('id', id);
    scope.signal.throwIfAborted();
    const response = await untilCancelled(fetchImpl(url.href, { signal: scope.signal, redirect: 'error',
      headers: { authorization: `Bearer ${key}` } }), scope.signal);
    if (!response.ok) { await response.body?.cancel(); return null; }
    const { data } = JSON.parse(await responseText(response, 65_536, { signal: scope.signal }));
    const chargedMicro = usdCostMicro(data?.total_cost);
    return data?.id === id && chargedMicro !== null ? { generationId: id, chargedMicro } : null;
  } finally { scope.dispose(); }
}
