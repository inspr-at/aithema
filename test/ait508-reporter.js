// Preserve regression diagnostics under every admitted lane's evidence directory.
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
export default async function* diagnostics(source) {
  const directory = process.env.AITHEMA_EVIDENCE_DIR;
  if (directory) mkdirSync(directory, { recursive: true });
  for await (const { type, data } of source) {
    if (directory && ['test:fail', 'test:summary'].includes(type)) {
      appendFileSync(join(directory, 'ait508-diagnostics.txt'), `${type} ${inspect(data, { depth: 12, colors: false })}\n`);
    }
  }
}
