/**
 * Closed static mapping for the pinned Flow Shell package src and the host
 * module. Paths are allowlisted by exact key. Traversal, node_modules, and
 * secret-shaped names are refused rather than globbed.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLOW_SHELL_TARBALL_URL =
  'https://github.com/inspr-at/flow-shell/releases/download/v0.1.5/inspr-flow-shell-0.1.5.tgz';
export const FLOW_SHELL_TARBALL_SHA256 =
  '17a56f0b2899c91847521672bc9b58b82e85e0259dd69f8e9f416949561641c7';
export const FLOW_SHELL_VERSION = '0.1.5';

const FLOW_PREFIX = '/flow-shell/';
const HOST_SCRIPTS = Object.freeze({
  '/workspace-flow-host.js': 'flow-host.js',
  '/workspace-speech-input.js': 'speech-input.js',
  '/workspace-preview-feedback.js': 'preview-feedback.js',
  '/preview-adapter.js': 'preview-adapter.js',
});

const FLOW_STATIC = Object.freeze({
  'inspr-flow-shell.js': 'text/javascript; charset=utf-8',
  'adapter.js': 'text/javascript; charset=utf-8',
  'forecast.js': 'text/javascript; charset=utf-8',
  'gates.js': 'text/javascript; charset=utf-8',
  'host-layout.js': 'text/javascript; charset=utf-8',
  'identity.js': 'text/javascript; charset=utf-8',
  'intents.js': 'text/javascript; charset=utf-8',
  'sanitize.js': 'text/javascript; charset=utf-8',
  'stages.js': 'text/javascript; charset=utf-8',
  'state.js': 'text/javascript; charset=utf-8',
  'flow-shell.css': 'text/css; charset=utf-8',
  'assets/inspr-logo.svg': 'image/svg+xml',
});

const FORBIDDEN_SEGMENT = /^(?:node_modules|\.env|\.age|\.git|\.data)$/i;

/**
 * @returns {string}
 */
export function flowPackageSrcRoot() {
  const packageJson = fileURLToPath(import.meta.resolve('@inspr/flow-shell/package.json'));
  return realpathSync(join(dirname(packageJson), 'src'));
}

/**
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePathname(pathname) {
  if (typeof pathname !== 'string' || pathname.includes('\0') || pathname.includes('\\')) {
    return null;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 */
function isUnsafeKey(key) {
  if (!key || key.startsWith('/') || key.includes('//') || key.includes('\\') || key.includes('\0')) {
    return true;
  }
  const segments = key.split('/');
  return segments.some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
    || FORBIDDEN_SEGMENT.test(segment)
    || segment.includes('..')
  ));
}

/**
 * @param {string} root
 * @param {string} key
 * @returns {string | null}
 */
function resolveInsideRoot(root, key) {
  try {
    const realRoot = realpathSync(root);
    const candidate = resolve(realRoot, key);
    const rel = relative(realRoot, candidate);
    if (rel.startsWith('..') || rel.split(sep).includes('node_modules')) return null;
    const realFile = realpathSync(candidate);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * @param {string} pathname
 * @returns {{ path: string, contentType: string } | null}
 */
export function resolveFlowStaticAsset(pathname) {
  const decoded = decodePathname(pathname);
  if (!decoded || !decoded.startsWith(FLOW_PREFIX)) return null;
  const key = decoded.slice(FLOW_PREFIX.length);
  if (isUnsafeKey(key) || !Object.hasOwn(FLOW_STATIC, key)) return null;
  const path = resolveInsideRoot(flowPackageSrcRoot(), key);
  if (!path) return null;
  return { path, contentType: FLOW_STATIC[key] };
}

/**
 * @param {string} pathname
 * @returns {{ path: string, contentType: string } | null}
 */
export function resolveHostScript(pathname) {
  const decoded = decodePathname(pathname);
  if (!decoded || !Object.hasOwn(HOST_SCRIPTS, decoded)) return null;
  const path = resolveInsideRoot(
    realpathSync(fileURLToPath(new URL('.', import.meta.url))),
    HOST_SCRIPTS[decoded],
  );
  if (!path) return null;
  return { path, contentType: 'text/javascript; charset=utf-8' };
}

/**
 * @param {string} pathname
 * @returns {{ path: string, contentType: string } | null}
 */
export function resolveWorkspaceStatic(pathname) {
  return resolveFlowStaticAsset(pathname) ?? resolveHostScript(pathname);
}

/**
 * @param {string} path
 * @returns {Buffer}
 */
export function readAllowedStatic(path) {
  return readFileSync(path);
}
