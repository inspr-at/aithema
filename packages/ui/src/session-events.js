// Server-sent events from a fetch body, one parsed event at a time.
export async function* serverEvents(reader) {
  let buffer = ''; const decoder = new TextDecoder();
  let work = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('Event stream too large');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
      if (data) {
        const started = performance.now();
        yield JSON.parse(data);
        work += performance.now() - started;
      }
      // Consumer rendering runs between yields. A microtask-only burst can
      // starve ready HTTP responses until their operation deadlines expire.
      // Network idle time between reads does not consume the work slice.
      if (work >= 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        work = 0;
      }
    }
  }
}
