export function deploymentConfig(values = process.env) {
  const publicOrigin = values.AITHEMA_PUBLIC_ORIGIN;
  let acceptedHost;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.origin !== publicOrigin || url.username || url.password || url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Invalid AITHEMA_PUBLIC_ORIGIN');
    acceptedHost = url.host;
  }
  const port = Number(values.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid PORT');
  return { publicOrigin, acceptedHost, hostname: values.AITHEMA_LISTEN_HOST ?? '127.0.0.1', port,
    commit: values.AITHEMA_COMMIT ?? null };
}
export function deploymentGate(request, settings, localHosts) {
  const host = request.headers.get('host');
  if (!(settings.acceptedHost ? host === settings.acceptedHost : localHosts.has(host))) return new Response(null, { status: 403 });
  const path = new URL(request.url).pathname;
  // Provider callback is server-to-server; health needs only the Host allowlist.
  if (path !== '/api/voice/llm/chat/completions' && path !== '/healthz') {
    const origin = request.headers.get('origin');
    if (origin && origin !== (settings.publicOrigin ?? `http://${host}`)) return new Response(null, { status: 403 });
  }
  return null;
}
