export function createOwnership({ publicOrigin } = {}) { return {
  token(request) {
    const value = /(?:^|;\s*)aithema-visitor=([a-zA-Z0-9_-]{1,128})(?:;|$)/u.exec(request.headers.get('cookie') ?? '');
    return value?.[1] ?? null;
  },
  created(response, token, request) {
    const secure = new URL(publicOrigin ?? request.url).protocol === 'https:' ? '; Secure' : '';
    response.headers.set('set-cookie', `aithema-visitor=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
  },
}; }
export const ownership = createOwnership();

export function startExpiry(handlers) {
  const expiry = setInterval(async () => {
    try { await handlers.expire(Date.now() - 365 * 24 * 60 * 60 * 1000); }
    catch { console.error({ event: 'session-expiry-failed' }); }
  }, 60_000);
  expiry.unref();
  return expiry;
}
