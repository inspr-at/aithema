import { parseArgs } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeQualificationBudget, readPersistedQualificationSnapshot } from '../plugins/composed-voice/src/persisted-budget.js';
import { runLiveQualification, validateQualificationPlan } from '../plugins/composed-voice/src/live-qualification.js';

const { values } = parseArgs({ options: { 'operator-approved': { type: 'boolean', default: false },
  initialize: { type: 'boolean', default: false }, budget: { type: 'string' }, plan: { type: 'string' },
  host: { type: 'string' }, out: { type: 'string' }, 'keys-file': { type: 'string' }, 'sample-timeout-ms': { type: 'string' } } });
if (values['operator-approved'] !== true || !values.budget) throw new Error('--operator-approved and --budget required');
if (values.initialize) {
  initializeQualificationBudget({ path: resolve(values.budget) });
  console.log('Initialized shared $25 qualification snapshot; no provider dispatched.');
} else {
  if (!values.plan || !values.host || !values.out) throw new Error('--plan, --host and --out required');
  if (!isAbsolute(values['keys-file'] ?? '')) throw new Error('Absolute --keys-file required');
  const sampleTimeoutMs = values['sample-timeout-ms'] === undefined ? 20 * 60_000 : Number(values['sample-timeout-ms']);
  if (!Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs < 1 || sampleTimeoutMs > 20 * 60_000) throw new Error('--sample-timeout-ms must be 1..1200000');
  // Parse the non-secret plan before loading any OPS implementation.
  const plan = JSON.parse(await readFile(resolve(values.plan), 'utf8'));
  validateQualificationPlan(plan);
  if (readPersistedQualificationSnapshot(resolve(values.budget)).blocked) throw new Error('Qualification budget blocked');
  const directory = await mkdtemp(join(tmpdir(), 'qualification-control-'));
  let host;
  try {
    const controlCapability = randomBytes(32).toString('hex'), controlFile = join(directory, 'control.json');
    await writeFile(controlFile, JSON.stringify({ capability: controlCapability, runId: plan.runId, budgetPath: resolve(values.budget) }), { mode: 0o600, flag: 'wx' });
    const { createQualificationHost } = await import(pathToFileURL(resolve(values.host)).href);
    // OPS hands the control file to its server at startup. Only Node control
    // requests get the capability; provider keys remain file-only on the server.
    host = await createQualificationHost({ keysFile: values['keys-file'], sampleTimeoutMs, controlFile, controlCapability });
    const report = await runLiveQualification({ operatorApproved: true, budgetPath: resolve(values.budget), plan,
      host, outputDirectory: resolve(values.out) });
    console.log(JSON.stringify({ runId: report.runId, report: resolve(values.out, 'report.json'), blindPreference: 'pending' }));
  } finally {
    try { await host?.close?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
