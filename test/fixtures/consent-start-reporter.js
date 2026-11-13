// Keep failure details as fetched lane evidence; the lane's console is summarized.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function* consentStartEvidence(source) {
  const directory = process.env.AITHEMA_EVIDENCE_DIR;
  const path = directory && join(directory, 'consent-start-results.jsonl');
  if (path) { mkdirSync(directory, { recursive: true }); writeFileSync(path, ''); }
  for await (const { type, data } of source) {
    if (!path) continue;
    if (type === 'test:fail') {
      const error = data.details?.error;
      appendFileSync(path, JSON.stringify({ type, name: data.name, file: data.file, nesting: data.nesting,
        message: error?.cause?.message ?? error?.message, stack: error?.cause?.stack ?? error?.stack }) + '\n');
    }
    if (type === 'test:summary') appendFileSync(path, JSON.stringify({ type, ...data }) + '\n');
  }
}
