/** Same-origin authenticated fetch bridge. Host headers carry its existing owner
 * authentication; grants and connection capabilities never appear in URLs. */
export function createNetworkRelayClient({ url = '/composed/relay', fetch: request = globalThis.fetch, headers = {} } = {}) {
  return async function openRelay(grant) {
    const lifetime = new AbortController(); let connectionId, closed = false;
    async function post(action, body, binary = false, signal = lifetime.signal) {
      const response = await request(url, { method: 'POST', credentials: 'same-origin', signal,
        headers: { ...headers, 'content-type': binary ? 'application/octet-stream' : 'application/json',
          'x-composed-action': action, ...(connectionId ? { 'x-composed-connection': connectionId } : {}) },
        body: binary ? body : JSON.stringify(body ?? {}) });
      const value = await response.json();
      if (!response.ok) { const error = new Error('Composed relay request failed'); error.code = value.error; error.status = response.status; throw error; }
      return value;
    }
    ({ connectionId } = await post('open', grant));
    return {
      recoverOnResume: true,
      frames: { [Symbol.asyncIterator]() { return this; }, async next() {
        if (closed) return { done: true };
        const value = await post('frame'); if (value.done) return { done: true };
        const frame = value.frame;
        if (frame.type === 'audio') frame.bytes = Uint8Array.from(atob(frame.bytes), ch => ch.charCodeAt(0));
        return { done: false, value: frame };
      } },
      sendAudio: bytes => post('audio', bytes, true),
      command: async (name, ...args) => (await post('command', { name, args })).result,
      async disconnect() {
        if (closed) return;
        closed = true; lifetime.abort();
        try { await post('disconnect', {}, false, AbortSignal.timeout(1000)); } catch { /* Loss cannot obstruct recovery or local teardown. */ }
      },
    };
  };
}
