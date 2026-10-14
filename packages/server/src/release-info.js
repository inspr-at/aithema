import { readFileSync } from 'node:fs';
import { parseVersion } from './release-version.js';
import pkg from '../package.json' with { type: 'json' };
// Packing injects canonical metadata here. A source checkout uses its package's development version.
let runtime = null;
try { runtime = JSON.parse(readFileSync(new URL('./release-runtime.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const source = { version: pkg.version, version_scheme: 'legacy', release_channel: 'stable', release_sequence: null };
parseVersion(runtime ?? source);
if (runtime && (!['release', 'dry-run'].includes(runtime.mode) || !/^[a-f0-9]{40}$/u.test(runtime.source?.commit))) throw new TypeError('Invalid artifact source commit');
export const releaseInfo = Object.freeze(runtime ?? source);
