// Preserve assertion and worker-exit evidence through the remote runner's compact log.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
export default async function* report(source) {
  const results = [];
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      const result = { type, name: data.name, file: data.file, details: inspect(data.details, { depth: 6, breakLength: Infinity }) };
      results.push(result);
      if (type === 'test:fail') yield `Error: ${JSON.stringify(result)}\n`;
    }
    if (type === 'test:summary') yield `ℹ tests ${data.counts?.tests}; pass ${data.counts?.passed}; fail ${data.counts?.failed}\n`;
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    mkdirSync(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, 'retry-test-results.json'), JSON.stringify(results, null, 2));
  }
}
