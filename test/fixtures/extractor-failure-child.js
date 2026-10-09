import { serveExtractor } from '../../packages/core/src/extractor-process.js';
serveExtractor(async bytes => {
  const mode = Buffer.from(bytes).toString();
  if (mode.includes('heap')) {
    const retained = [];
    for (;;) retained.push(new Array(100_000).fill('bounded heap OOM fixture'));
  }
  if (mode.includes('signal')) process.kill(process.pid, 'SIGTERM');
  if (mode.includes('disconnect')) {
    process.send?.({ type: 'started' });
    await new Promise(() => {});
  }
  process.exit(1);
});
