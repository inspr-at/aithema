/** Same-origin authenticated fetch bridge. Host headers carry its existing owner
 * authentication; grants and connection capabilities never appear in URLs. */
export function createNetworkRelayClient({ url = '/composed/relay', fetch: request = globalThis.fetch, headers = {} } = {}) {
  return async function openRelay(grant) {
    const lifetime = new AbortController(); let connectionId, closed = false, commands = 0, retirementRevision = 0;
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
      async command(name, ...args) {
        // Pause revokes the relay before its durable save acknowledges. Do not
        // send a competing heartbeat to that retired connection while awaiting the save.
        if (name === 'heartbeat' && commands) return { acknowledged: true, deferred: true };
        const revision = retirementRevision;
        if (name === 'pause' || name === 'close') retirementRevision++;
        if (name !== 'heartbeat') commands++;
        try { return (await post('command', { name, args })).result; }
        catch (error) {
          // A heartbeat already on the wire may arrive after pause retires its connection.
          if (name === 'heartbeat' && revision !== retirementRevision) return { acknowledged: true, deferred: true };
          throw error;
        }
        finally { if (name !== 'heartbeat') commands--; }
      },
      async disconnect() {
        if (closed) return;
        closed = true; lifetime.abort();
        try { await post('disconnect', {}, false, AbortSignal.timeout(1000)); } catch { /* Loss cannot obstruct recovery or local teardown. */ }
      },
    };
  };
}
