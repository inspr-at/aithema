import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeQualificationBudget } from '../plugins/composed-voice/src/persisted-budget.js';
import { runLiveQualification } from '../plugins/composed-voice/src/live-qualification.js';

const { values } = parseArgs({ options: { 'operator-approved': { type: 'boolean', default: false },
  initialize: { type: 'boolean', default: false }, budget: { type: 'string' }, plan: { type: 'string' },
  host: { type: 'string' }, out: { type: 'string' } } });
if (values['operator-approved'] !== true || !values.budget) throw new Error('--operator-approved and --budget required');
if (values.initialize) {
  initializeQualificationBudget({ path: resolve(values.budget) });
  console.log('Initialized shared $25 qualification snapshot; no provider dispatched.');
} else {
  if (!values.plan || !values.host || !values.out) throw new Error('--plan, --host and --out required');
  // Parse the non-secret plan before loading any OPS implementation.
  const plan = JSON.parse(await readFile(resolve(values.plan), 'utf8'));
  const { createQualificationHost } = await import(pathToFileURL(resolve(values.host)).href);
  const host = await createQualificationHost();
  try {
    const report = await runLiveQualification({ operatorApproved: true, budgetPath: resolve(values.budget), plan,
      host, outputDirectory: resolve(values.out) });
    console.log(JSON.stringify({ runId: report.runId, report: resolve(values.out, 'report.json'), blindPreference: 'pending' }));
  } finally { await host.close?.(); }
}
