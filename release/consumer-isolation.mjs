// Preloaded in the installed host before any package import (ESM or CommonJS).
import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(process.cwd());
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('node:')) return result;
    if (!result.url.startsWith('file:')) throw new Error('Host import must be a builtin or installed file');
    const path = relative(root, realpathSync(fileURLToPath(result.url)));
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
      throw new Error('Host import escaped temporary host: ' + specifier);
    }
    return result;
  },
});
