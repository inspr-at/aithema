#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createWorkspaceServer,
  DEFAULT_SHUTDOWN_GRACE_MS,
} from '../workspace/index.js';

const USAGE = 'Usage: aithema-workspace --config FILE [--shutdown-grace-ms MILLISECONDS]';
const MAX_SHUTDOWN_GRACE_MS = 300_000;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        'shutdown-grace-ms': { type: 'string' },
      },
    });
  } catch {
    throw new Error('arguments');
  }
  if (parsed.values.help) return { help: true };
  if (!parsed.values.config) throw new Error('arguments');

  const graceText = parsed.values['shutdown-grace-ms'];
  const gracePeriodMs = graceText === undefined
    ? DEFAULT_SHUTDOWN_GRACE_MS
    : Number(graceText);
  if (
    !Number.isInteger(gracePeriodMs)
    || gracePeriodMs < 0
    || gracePeriodMs > MAX_SHUTDOWN_GRACE_MS
  ) {
    throw new Error('arguments');
  }
  return {
    configPath: resolve(parsed.values.config),
    gracePeriodMs,
    help: false,
  };
}

async function run() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch {
    console.error(`Aithema workspace requires explicit valid arguments. ${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let workspace;
  try {
    const configText = await readFile(options.configPath, 'utf8');
    const config = JSON.parse(configText);
    workspace = createWorkspaceServer(config);
    if (workspace.config.mode === 'production' && workspace.config.dataDir === ':memory:') {
      throw new Error('production service requires persistent storage');
    }
  } catch {
    console.error('Aithema workspace configuration is unreadable or invalid; refusing to listen.');
    process.exitCode = 2;
    return;
  }

  let listening;
  try {
    listening = await workspace.listen();
  } catch {
    await workspace.close({ gracePeriodMs: 0 }).catch(() => {});
    console.error('Aithema workspace could not open its listening socket.');
    process.exitCode = 1;
    return;
  }

  const publicMount = workspace.config.publicBasePath || '';
  console.log(`Aithema workspace listening at ${listening.url}${publicMount}`);
  console.log('Readiness covers local process, validated configuration, listening socket, and opened SQLite store only; provider and identity reachability are not checked.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      console.log('Repeated shutdown signal received; force-closing lingering HTTP connections.');
      workspace.forceClose();
      return;
    }
    shuttingDown = true;
    console.log(`Shutdown requested by ${signal}; draining for at most ${options.gracePeriodMs}ms.`);
    try {
      await workspace.close({ gracePeriodMs: options.gracePeriodMs });
      console.log('Aithema workspace stopped cleanly.');
    } catch {
      console.error('Aithema workspace shutdown failed.');
      process.exitCode = 1;
      workspace.forceClose();
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

await run();
