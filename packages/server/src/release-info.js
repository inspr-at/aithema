import { readFileSync } from 'node:fs';
import { parseVersion } from '../../../release/lib/version.mjs';
import source from '../../../release/version.json' with { type: 'json' };
let runtime = null;
try { runtime = JSON.parse(readFileSync(new URL('../../../release/runtime.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
parseVersion(runtime ?? source);
if (runtime && (!['release', 'dry-run'].includes(runtime.mode) || !/^[a-f0-9]{40}$/u.test(runtime.source?.commit))) throw new TypeError('Invalid artifact source commit');
export const releaseInfo = Object.freeze(runtime ?? source);
