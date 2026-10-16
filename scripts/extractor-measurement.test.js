// Run explicitly on mbp2606 with remote-browser.sh WORKTREE unit <this file>.
// Deliberately outside npm test's globs: the 66-run measurement is opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, release, cpus } from 'node:os';
import { EXTRACTOR_LIMITS, EXTRACTOR_MEDIA_TYPES, extractionResult } from '../packages/core/src/extractor.js';
import { runExtractorProcess, extractorProcessPeakRssBytesForTest, activeExtractorProcessCount } from '../packages/core/src/extractor-process.js';
import { extractorLimitFixture, MiB } from '../test/extractor-limit-fixtures.js';

test('AIT-219: measure generated inputs through the real sandboxed workers, three runs each', { timeout: 600_000 }, async t => {
  assert.match(hostname(), /mbp2606/iu, 'measurements are restricted to mbp2606');
  const original = childProcess.fork;
  let observation;
  t.mock.method(childProcess, 'fork', (path, args, options) => {
    const record = { heapBytes: 0, rssBytes: 0, gc: '' };
    const child = original(path, args, { ...options, stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
      execArgv: [...options.execArgv, '--trace-gc-nvp',
        `--allow-fs-read=${fileURLToPath(new URL('.', import.meta.url))}`,
        '--import', new URL('./extractor-memory-probe.js', import.meta.url).href] });
    record.child = child; observation = record;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      record.gc += chunk;
      const lines = record.gc.split('\n'); record.gc = lines.pop();
      for (const line of lines) for (const match of line.matchAll(/total_size_(?:before|after)=(\d+)/gu)) {
        record.heapBytes = Math.max(record.heapBytes, Number(match[1]));
      }
    });
    child.on('message', message => {
      if (message?.measurement) {
        record.heapBytes = Math.max(record.heapBytes, message.measurement.heapBytes);
        record.rssBytes = message.measurement.rssBytes;
      }
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const rows = [];
  const cases = [2, 5, 10, 15, 20].flatMap(size => ['text-pdf', 'image-pdf', 'docx', 'text'].map(format => [format, size]));
  cases.push(['ooxml-bomb', 20], ['many-objects-pdf', 20]);
  for (const [format, sizeMiB] of cases) {
    const input = extractorLimitFixture(format, sizeMiB * MiB);
    assert.equal(input.length, sizeMiB * MiB);
    const kind = format.includes('pdf') ? 'pdf' : format.includes('ooxml') || format === 'docx' ? 'ooxml' : 'text';
    const workerURL = new URL(`../plugins/extract-${kind}/src/${kind}-extract-child.js`, import.meta.url);
    const mediaType = kind === 'pdf' ? EXTRACTOR_MEDIA_TYPES.pdf : kind === 'ooxml' ? EXTRACTOR_MEDIA_TYPES.docx : 'text/plain';
    const dependencies = kind === 'pdf' ? { unpdf: new URL('../package.json', import.meta.resolve('unpdf')) } : {};
    for (let run = 1; run <= 3; run++) {
      // Bypass only admission's existing byte ceiling to measure candidate
      // inputs BEFORE changing production limits. Real parser, permission
      // sandbox, heap flag, RSS watchdog, serialization and deadline stay on.
      const start = performance.now();
      let raw, error;
      try {
        raw = await runExtractorProcess(workerURL, input, mediaType, EXTRACTOR_LIMITS,
          { signal: new AbortController().signal, deadlineAt: Date.now() + EXTRACTOR_LIMITS.deadlineMs }, workerURL, dependencies);
      } catch (failure) { error = failure.code ?? failure.message; }
      const wallMs = performance.now() - start;
      const result = raw && extractionResult(raw, mediaType, EXTRACTOR_LIMITS);
      const record = observation;
      record.rssBytes = Math.max(record.rssBytes, extractorProcessPeakRssBytesForTest(record.child));
      const row = { format, sizeMiB, run, heapMiB: record.heapBytes / MiB, rssMiB: record.rssBytes / MiB,
        wallMs, status: result?.status ?? 'error', reason: result?.reason ?? error ?? null,
        pagesKept: result?.segments.filter(segment => segment.page !== undefined).length ?? 0,
        segmentsKept: result?.segments.length ?? 0, charsKept: result?.text.length ?? 0, truncated: result?.truncated ?? false };
      rows.push(row); t.diagnostic(JSON.stringify(row));
      assert.equal(activeExtractorProcessCount(), 0);
    }
  }
  const result = { measuredAt: new Date().toISOString(), machine: hostname(), platform: process.platform,
    osRelease: release(), cpu: cpus()[0].model, node: process.version, bounds: EXTRACTOR_LIMITS, rows };
  const out = process.env.AITHEMA_EVIDENCE_DIR;
  assert.ok(out, 'EVIDENCE_OUT is required so all raw measurements are retained');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'extractor-limits-results.json'), JSON.stringify(result, null, 2) + '\n');
  for (const row of rows) {
    assert.ok(row.heapMiB > 0 && row.rssMiB > 0, 'heap and RSS measurements must exist');
    if (['ooxml-bomb', 'many-objects-pdf'].includes(row.format)) {
      assert.ok(row.reason === 'limit' || row.reason === 'deadline', `safety bound: ${JSON.stringify(row)}`);
    }
  }
});
