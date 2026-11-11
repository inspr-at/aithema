// AIT-484 remote handoff: preserve per-file counts and assertion causes through
// the lane's compact console filter. Works alongside Node's standard spec reporter.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async function* erasedEvidence(source) {
  const results = [], summaries = [];
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      const error = data.details?.error?.cause ?? data.details?.error;
      results.push({ file: data.file, name: data.name, type, nesting: data.nesting,
        skip: Boolean(data.skip), error: error?.stack });
    }
    if (type === 'test:summary') summaries.push(data);
  }
  const directory = process.env.AITHEMA_EVIDENCE_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'ait-484-test-results.json'), JSON.stringify({ results, summaries }, null, 2));
  }
  yield '';
}
