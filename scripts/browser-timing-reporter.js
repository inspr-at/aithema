// Machine-readable companion to spec output. Only top-level tests count: their
// durations already include nested subtests and fixture hooks.
import { browserWorkload } from './browser-timings.js';

export default async function* browserTimings(source) {
  const files = JSON.parse(process.env.BROWSER_TIMING_FILES ?? '[]');
  yield `${JSON.stringify({ type: 'run', schema: 1,
    runId: process.env.GITHUB_RUN_ID ?? 'remote', attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    sha: process.env.GITHUB_SHA ?? null, observedAt: new Date().toISOString(),
    files: Object.fromEntries(files.map(file => [file, browserWorkload(file)])) })}\n`;
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0) {
      yield `${JSON.stringify({ type, file: data.file, name: data.name, seconds: data.details.duration_ms / 1000,
        skip: Boolean(data.skip), todo: Boolean(data.todo),
        ...(type === 'test:fail' ? { error: data.details.error?.cause?.stack ?? data.details.error?.stack } : {}) })}\n`;
    }
    if (type === 'test:summary') yield `${JSON.stringify({ type, ...data })}\n`;
  }
}
