// Measurement-only preload in the real sandboxed worker. GC tracing supplies
// heap high-water marks before collections; this covers the final allocation
// interval and the OS high-water RSS even when the parent polls too slowly.
const send = process.send.bind(process);
process.send = (message, ...args) => send(message?.type === 'result' ? {
  ...message, measurement: { heapBytes: process.memoryUsage().heapUsed,
    rssBytes: process.resourceUsage().maxRSS * 1024 },
} : message, ...args);
