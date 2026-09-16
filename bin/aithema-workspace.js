#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createWorkspaceServer,
  DEFAULT_SHUTDOWN_GRACE_MS,
} from '../workspace/index.js';

const USAGE = 'Usage: aithema-workspace --config FILE [--speech-config FILE] [--shutdown-grace-ms MILLISECONDS]';
const MAX_SHUTDOWN_GRACE_MS = 300_000;
const SPEECH_CONFIG_KEYS = new Set([
  'kind',
  'providerId',
  'model',
  'allowedModels',
  'endpoint',
  'acceptedMediaTypes',
  'limits',
]);
const SPEECH_LIMIT_KEYS = new Set([
  'maxAudioBytes',
  'maxRequestBytes',
  'maxRecordingMs',
  'maxDurationMs',
  'maxResponseBytes',
  'maxTranscriptChars',
]);

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: 'string' },
        'speech-config': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        'shutdown-grace-ms': { type: 'string' },
      },
    });
  } catch {
    throw new Error('arguments');
  }
  if (parsed.values.help) return { help: true };
  if (!parsed.values.config) throw new Error('arguments');
  if (parsed.values['speech-config'] === '') throw new Error('arguments');

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
    speechConfigPath: parsed.values['speech-config']
      ? resolve(parsed.values['speech-config'])
      : null,
    gracePeriodMs,
    help: false,
  };
}

/**
 * A public speech sidecar intentionally has a narrower schema than the
 * operator-owned speech object. It cannot carry credentials, provider
 * registry entries, policy, identity, or arbitrary future fields.
 * @param {unknown} value
 */
function validatePublicSpeechConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('speech config must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!SPEECH_CONFIG_KEYS.has(key)) throw new Error('speech config contains an unsupported field');
  }
  const limits = value.limits;
  if (limits != null) {
    if (typeof limits !== 'object' || Array.isArray(limits)) {
      throw new Error('speech limits must be an object');
    }
    for (const key of Object.keys(limits)) {
      if (!SPEECH_LIMIT_KEYS.has(key)) throw new Error('speech limits contain an unsupported field');
    }
  }
  return value;
}

/**
 * Merge one strictly public speech object without writing a derived runtime
 * config. The protected config remains the sole owner of registry credentials,
 * policy, and identity.
 * @param {unknown} protectedConfig
 * @param {unknown} publicSpeechConfig
 */
function mergeSpeechConfig(protectedConfig, publicSpeechConfig) {
  if (protectedConfig === null || typeof protectedConfig !== 'object' || Array.isArray(protectedConfig)) {
    throw new Error('workspace config must be an object');
  }
  if (Object.hasOwn(protectedConfig, 'speech')) {
    throw new Error('protected workspace config already owns speech configuration');
  }
  return { ...protectedConfig, speech: validatePublicSpeechConfig(publicSpeechConfig) };
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
    let config = JSON.parse(configText);
    if (options.speechConfigPath) {
      const speechText = await readFile(options.speechConfigPath, 'utf8');
      config = mergeSpeechConfig(config, JSON.parse(speechText));
    }
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
