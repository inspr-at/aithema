import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deepFreeze, PluginError, operationScope } from '@inspr/aithema-core';
import { IMAGE_INPUT_MEDIA_TYPES } from '@inspr/aithema-core/image-input';
import { residentBytes } from '@inspr/aithema-core/extractor-process';
import { extractorManifest } from '@inspr/aithema-core/extractor';

const base = extractorManifest('image-input', IMAGE_INPUT_MEDIA_TYPES);
export const manifest = deepFreeze({ ...base, kinds: ['image-input'], models: base.models.map(model => ({ ...model, operations: ['normalize'] })) });
const refused = reason => ({ status: 'staged-refused', reason });
const workerURL = new URL('./normalize-child.js', import.meta.url);
const modules = createRequire(import.meta.url).resolve.paths('sharp').filter(existsSync);
/** Offline native processing is confined to one short-lived, credential-free child. */
export function createImageInput() {
  return { manifest, health: async () => ({ available: true }),
    async normalize(bytes, metadata = {}, options = {}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected image bytes');
      if (!bytes.length) return refused('empty');
      if (bytes.length > 20 * 1024 * 1024) return refused('size');
      const extension = /\.([a-z0-9]+)$/iu.exec(metadata.filename ?? '')?.[1].toLowerCase();
      if (extension && !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return refused('unsupported');
      // Never enter a general-purpose decoder for SVG, TIFF, HEIF or an unknown
      // format disguised by a client filename/MIME. Only these raster magics pass.
      const starts = signature => signature.every((value, index) => bytes[index] === value);
      const ascii = (start, end) => Buffer.from(bytes.subarray(start, end)).toString('ascii');
      const format = starts([137, 80, 78, 71, 13, 10, 26, 10]) ? 'png' : starts([255, 216, 255]) ? 'jpeg'
        : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'webp' : /^GIF8[79]a$/u.test(ascii(0, 6)) ? 'gif' : null;
      if (!format || extension && (extension === 'jpg' ? 'jpeg' : extension) !== format) return refused('unsupported');
      const scope = operationScope({ ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, (options.now ?? Date.now)() + 10000) });
      let child;
      try {
        scope.signal.throwIfAborted();
        child = fork(workerURL, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', env: {},
          execArgv: ['--no-concurrent-sparkplug', '--max-old-space-size=64', '--permission', '--allow-addons',
            `--allow-fs-read=${resolve(dirname(fileURLToPath(workerURL)), '..')}`, ...modules.map(path => `--allow-fs-read=${resolve(path)}`)] });
        return await new Promise((resolveResult, reject) => {
          let result, failure, sampling = false;
          const kill = () => { if (!child.killed) child.kill('SIGKILL'); };
          const abort = () => { result = refused(scope.signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'); kill(); };
          const watchdog = setInterval(async () => {
            if (sampling || child.killed || !child.pid) return;
            sampling = true;
            try { if (await residentBytes(child.pid) > 384 * 1024 * 1024) { result = refused('limit'); kill(); } }
            catch { if (child.exitCode === null && child.signalCode === null) { result = refused('unavailable'); kill(); } }
            finally { sampling = false; }
          }, 25);
          scope.signal.addEventListener('abort', abort, { once: true });
          child.on('message', message => {
            if (message?.status === 'staged-ready' || message?.status === 'staged-refused') { result = message; kill(); }
          });
          child.on('error', error => { failure = error; kill(); });
          child.once('close', () => {
            clearInterval(watchdog); scope.signal.removeEventListener('abort', abort);
            if (failure) reject(new PluginError('unavailable'));
            else {
              if (result?.status === 'staged-ready') result.digest = createHash('sha256').update(result.bytes).digest('hex');
              resolveResult(result ?? refused('unavailable'));
            }
          });
          if (scope.signal.aborted) abort();
          else child.send({ bytes, extension });
        });
      } finally { scope.dispose(); }
    },
  };
}
