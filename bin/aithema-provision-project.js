#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { validateMembershipMapping } from '../runtime/identity.js';
import { provisionMappedProject } from '../runtime/provision-project.js';

const USAGE = 'Usage: node bin/aithema-provision-project.js --config FILE --subject ID --project-ref REF --title TITLE [--apply]';

try {
  const { values } = parseArgs({ allowPositionals: false, strict: true, options: {
    config: { type: 'string' }, subject: { type: 'string' }, 'project-ref': { type: 'string' },
    title: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) console.log(USAGE);
  else {
    if (!values.config || !values.subject || !values['project-ref'] || !values.title) throw new Error('arguments');
    const config = JSON.parse(await readFile(values.config, 'utf8'));
    if (config.mode !== 'production' || typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw new Error('config');
    const actor = validateMembershipMapping(config.identity?.memberships).get(values.subject);
    const result = provisionMappedProject({
      databaseFile: config.databaseFile || join(config.dataDir, 'aithema-workspace.sqlite'),
      actor, projectRef: values['project-ref'], title: values.title, apply: values.apply,
    });
    console.log(JSON.stringify(result));
  }
} catch {
  // Configuration may contain credentials. Never print it or nested errors.
  console.error(`Project provisioning refused; check arguments, exact restricted membership and existing database/project state. ${USAGE}`);
  process.exitCode = 1;
}
