import { readFileSync } from 'node:fs';
import { parseVersion } from './release-version.js';
import pkg from '../package.json' with { type: 'json' };
// Packing injects canonical metadata here. A source checkout uses its package's development version.
let runtime = null;
try { runtime = JSON.parse(readFileSync(new URL('./release-runtime.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// The source fallback reads only this package's own files: release preparation mirrors the reserved
// coordinate's version into package.json (test/fixtures/version-mirrors.js), and every source version
// since the AIT-32 migration is declared inspr-calver-3, so parseVersion fails loudly on drift. Only a
// packed artifact carries a release sequence; a development tree is not that release (AIT-582).
const source = { version: pkg.version, version_scheme: 'inspr-calver-3', release_channel: 'stable', release_sequence: null };
parseVersion(runtime ?? source);
if (runtime && (!['candidate', 'release', 'dry-run'].includes(runtime.mode) || !/^[a-f0-9]{40}$/u.test(runtime.source?.commit))) throw new TypeError('Invalid artifact source commit');
export const releaseInfo = Object.freeze(runtime ?? source);
