// Evidence-only reporter: retain complete spec output and nested assertions.
import { spec } from 'node:test/reporters';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export default async function* report(source) {
  const directory = process.env.AITHEMA_EVIDENCE_DIR;
  if (!directory) throw new Error('AITHEMA_EVIDENCE_DIR is required for r4 evidence');
  mkdirSync(directory, { recursive: true });
  const events = join(directory, 'r4-timings.jsonl');
  async function* capture() {
    for await (const event of source) {
      const { type, data } = event;
      if (type === 'test:fail' || type === 'test:summary') {
        const file = data.file && (isAbsolute(data.file) ? relative(process.cwd(), data.file) : data.file);
        const record = type === 'test:summary' ? { type, ...data, file } : {
          type, file, name: data.name, nesting: data.nesting,
          error: data.details.error?.cause?.stack ?? data.details.error?.stack,
        };
        appendFileSync(events, JSON.stringify(record) + '\n');
      }
      yield event;
    }
  }
  for await (const chunk of spec(capture())) {
    appendFileSync(join(directory, 'r4-spec.log'), chunk);
    yield chunk;
  }
}
