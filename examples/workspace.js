/**
 * Loopback workspace process. Pass a server-owned config file; do not put
 * endpoints or credentials in the browser. Demo config uses the labelled mock.
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
console.log(`Aithema workspace listening at ${url}`);
console.log(`Config: ${pathToFileURL(configPath).href}`);
console.log(`Mode: ${workspace.config.mode}${workspace.config.labelledDemo ? ' (labelled demo/test — not production identity or live AI unless a registry adapter is configured)' : ''}`);
if (workspace.config.labelledDemo && !(config.identity && config.identity.demoHmacSecret)) {
  console.log('Demo signing key is ephemeral for this process. Set identity.demoHmacSecret in a private config to keep demo cookies across restarts.');
}
console.log('This process does not perform live provider or OIDC proof by itself.');
