// Server-sent events from a fetch body, one parsed event at a time.
export async function* serverEvents(reader) {
  let buffer = ''; const decoder = new TextDecoder();
  let sliceStarted = performance.now();
  while (true) {
    const { done, value } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('Event stream too large');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
      if (data) yield JSON.parse(data);
      // Consumer rendering runs between yields. A microtask-only burst can
      // starve ready HTTP responses until their operation deadlines expire.
      if (performance.now() - sliceStarted >= 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStarted = performance.now();
      }
    }
  }
}
