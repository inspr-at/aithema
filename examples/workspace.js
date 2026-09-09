/**
 * Example convenience, not the supported service executable. It defaults to a
 * labelled loopback demo config; production operators use aithema-workspace
 * with an explicit server-owned --config file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWorkspaceServer } from '../workspace/index.js';

const defaultPath = fileURLToPath(new URL('./demo-config.json', import.meta.url));
const configPath = resolve(process.argv[2] ?? defaultPath);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const workspace = createWorkspaceServer(config);
const { url } = await workspace.listen();
const publicMount = workspace.config.publicBasePath || '';
console.log(`Aithema workspace listening at ${url}${publicMount}`);
if (publicMount) {
  console.log(`Public base path: ${publicMount} (prefix-preserving; requests outside this mount are not served)`);
}
console.log(`Config: ${pathToFileURL(configPath).href}`);
console.log(`Mode: ${workspace.config.mode}${workspace.config.labelledDemo ? ' (labelled demo/test — not production identity or live AI unless a registry adapter is configured)' : ''}`);
if (workspace.config.labelledDemo && !(config.identity && config.identity.demoHmacSecret)) {
  console.log('Demo signing key is ephemeral for this process. Set identity.demoHmacSecret in a private config to keep demo cookies across restarts.');
}
if (workspace.config.speech?.enabled) {
  const location = workspace.config.speech.executionLocation
    ? `configured ${workspace.config.speech.executionLocation}`
    : 'configured';
  console.log(`Speech input is enabled for ${workspace.config.speech.providerId} / ${workspace.config.speech.model} (${location} label; not measured network placement).`);
} else {
  console.log('Speech input is disabled until an operator configures a speech provider, model, and exact transcription endpoint.');
}
console.log('This process does not perform live provider or OIDC proof by itself.');
