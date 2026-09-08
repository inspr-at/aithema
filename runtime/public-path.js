/**
 * Optional native public base path. Empty means the original standalone root.
 * publicOrigin is scheme+host separately; this module never treats origin as a path.
 *
 * Shared origin is a shared trust domain. Cookie Path=/ is not a security
 * boundary and these helpers do not isolate one same-origin app from another.
 */

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Canonical ASCII absolute path with one or more [A-Za-z0-9_-] segments, or empty.
 * Rejects trailing slash, empty/dot segments, percent encoding, backslash, query,
 * fragment, controls, and protocol-relative forms.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePublicBasePath(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Error('publicBasePath must be a string');
  }
  if (!/^[\x21-\x7E]+$/.test(value)) {
    throw new Error('publicBasePath must be a canonical ASCII path');
  }
  if (
    value.includes('%')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('://')
    || value.startsWith('//')
    || !value.startsWith('/')
    || value.endsWith('/')
  ) {
    throw new Error('publicBasePath must be a canonical absolute path or empty');
  }
  const segments = value.slice(1).split('/');
  if (segments.length < 1 || segments.some((segment) => !SEGMENT.test(segment))) {
    throw new Error('publicBasePath must use one or more [A-Za-z0-9_-] segments');
  }
  return value;
}

/**
 * @param {string} [publicBasePath]
 */
export function homePath(publicBasePath = '') {
  return publicBasePath || '/';
}

/**
 * Join a configured mount with an app-absolute path, query, or hash. Does not
 * duplicate a prefix that is already present.
 * @param {string} publicBasePath
 * @param {string} appPath
 */
export function joinMountPath(publicBasePath, appPath) {
  const base = publicBasePath || '';
  if (appPath == null || appPath === '' || appPath === '/') return homePath(base);
  if (typeof appPath !== 'string' || !appPath.startsWith('/') || appPath.startsWith('//')) {
    throw new Error('app path must be a local absolute path');
  }
  if (base && (appPath === base || appPath.startsWith(`${base}/`) || appPath.startsWith(`${base}?`) || appPath.startsWith(`${base}#`))) {
    return appPath;
  }
  return `${base}${appPath}`;
}

/**
 * Exact segment-boundary strip. `/aithema` matches `/aithema` and `/aithema/...`,
 * never `/aithema-other`. Returns null when the request is outside the mount.
 * @param {string} pathname
 * @param {string} publicBasePath
 * @returns {string | null}
 */
export function stripMountPath(pathname, publicBasePath = '') {
  if (typeof pathname !== 'string' || pathname.includes('\\') || pathname.includes('\0')) {
    return null;
  }
  const base = publicBasePath || '';
  if (!base) return pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) {
    const rest = pathname.slice(base.length);
    return rest || '/';
  }
  return null;
}

/**
 * Origin-only join for OIDC redirect URIs. publicOrigin must already be origin.
 * @param {string} origin
 * @param {string} publicBasePath
 * @param {string} appPath
 */
export function joinPublicHref(origin, publicBasePath, appPath) {
  return new URL(joinMountPath(publicBasePath, appPath), origin).href;
}
