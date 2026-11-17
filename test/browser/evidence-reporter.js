// Explicit remote QA companion: retain complete failures when the lane prints
// only a log tail. It does not alter test selection, assertions or CI reporting.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export default async function* evidenceReporter(source) {
  const directory = process.env.AITHEMA_EVIDENCE_DIR;
  const output = directory && join(directory, 'browser-complete.jsonl');
  if (output) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(output, JSON.stringify({ type: 'run', schema: 1, observedAt: new Date().toISOString() }) + '\n');
  }
  for await (const { type, data } of source) {
    if (!output || !['test:summary', 'test:fail'].includes(type)) continue;
    const { details, ...record } = data;
    appendFileSync(output, JSON.stringify({ type, ...record,
      ...(data.file ? { file: relative(process.cwd(), data.file).replaceAll('\\', '/') } : {}),
      ...(details ? { duration_ms: details.duration_ms,
        error: details.error?.cause?.stack ?? details.error?.stack ?? String(details.error),
        failureType: details.error?.failureType } : {}),
    }) + '\n');
  }
}
