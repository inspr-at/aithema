// Companion to spec output: file summaries include hooks, imports and worker
// teardown, unlike a sum of assertion durations. Keep the final suite count too.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export default async function* unitTimings(source) {
  const directory = process.env.UNIT_TIMING_DIR;
  let output;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    output = resolve(directory, 'timings.jsonl');
    writeFileSync(output, JSON.stringify({ type: 'run', schema: 1,
      runId: process.env.GITHUB_RUN_ID ?? 'remote', attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
      sha: process.env.GITHUB_SHA ?? null, observedAt: new Date().toISOString(),
    }) + '\n');
  }
  for await (const { type, data } of source) {
    if (output && type === 'test:summary') {
      appendFileSync(output, JSON.stringify({ type, ...data,
        ...(data.file ? { file: relative(process.cwd(), data.file).replaceAll('\\', '/') } : {}),
      }) + '\n');
    }
  }
}
