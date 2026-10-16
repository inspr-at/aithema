// Machine-readable companion to spec output. Only top-level tests count: their
// durations already include nested subtests and fixture hooks.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export default async function* browserTimings(source) {
  const files = JSON.parse(process.env.BROWSER_TIMING_FILES ?? '[]');
  yield `${JSON.stringify({ type: 'run', schema: 1,
    runId: process.env.GITHUB_RUN_ID ?? 'remote', attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    sha: process.env.GITHUB_SHA ?? null,
    files: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) })}\n`;
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0) {
      yield `${JSON.stringify({ type, file: data.file, name: data.name, seconds: data.details.duration_ms / 1000,
        skip: Boolean(data.skip), todo: Boolean(data.todo) })}\n`;
    }
    if (type === 'test:summary') yield `${JSON.stringify({ type, ...data })}\n`;
  }
}
