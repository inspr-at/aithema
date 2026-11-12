// AIT-497: keep measured geometry and per-file counts in the bounded lane log
// when a completed run's artifact fetch is refused by the admission guard.
import { relative } from 'node:path';

export default async function* laneEvidence(source) {
  for await (const { type, data } of source) {
    if (type === 'test:diagnostic' && data.message.startsWith('AIT-497 geometry ')) {
      yield `ℹ tests ${data.message}\n`;
    }
    if (type === 'test:summary' && data.file) {
      yield `ℹ tests AIT-497 file ${JSON.stringify({ ...data, file: relative(process.cwd(), data.file).replaceAll('\\', '/') })}\n`;
    }
  }
}
