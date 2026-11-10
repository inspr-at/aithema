// Compact remote evidence: the coordinator wrapper retains summary lines only.
export default async function* unlockReporter(events) {
  const results = []; let passed = 0, failed = 0;
  for await (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const { name, details } = event.data, ok = event.type === 'test:pass';
    if (ok) passed++; else failed++;
    if (!name.startsWith('AIT-463')) continue;
    const error = details?.error?.cause ?? details?.error;
    results.push({ name, result: ok ? 'pass' : 'fail', ...(!ok ? {
      message: error?.message, actual: error?.actual, expected: error?.expected,
    } : {}) });
  }
  yield `ℹ tests ${JSON.stringify(results)}\nℹ pass ${passed}\nℹ fail ${failed}\n`;
}
