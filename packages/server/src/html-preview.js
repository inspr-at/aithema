import { createHash, timingSafeEqual } from 'node:crypto';
import { HTML_MEDIA_TYPE, htmlPreviewHostPolicy, previewDocument, inspectHTML } from '@inspr/aithema-core';
import { NotFoundError } from './storage.js';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function previewDenied(status = 403, head = false) {
  return new Response(head ? null : status === 404 ? 'Not Found' : 'Forbidden', { status, headers: {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
  } });
}
/** An explicit public URL avoids trusting Host/Forwarded headers behind a proxy. */
export function previewConfiguration(previewURL) {
  if (previewURL === undefined) return null;
  htmlPreviewHostPolicy(previewURL); // Shared exact-path validation, including CSP injection defenses.
  const url = new URL(previewURL);
  return Object.freeze({ url: url.href, csp:
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
    `object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${url.origin}` });
}
/** Recheck current ownership, consent, erasure and the precise delegated bytes. */
export function previewArtifact(storage, scope) {
  const session = storage.get(scope.sessionId);
  if (session.tombstone) throw new NotFoundError();
  if (session.consentWithdrawn || session.consentRevision !== scope.consentRevision || !same(session.ownerHash, scope.ownerHash)) return null;
  const artifact = storage.conceptArtifact(scope.sessionId, scope.artifactId);
  if (artifact.erased || !session.concepts?.some(item => item.id === scope.artifactId)) throw new NotFoundError();
  if (artifact.mediaType !== HTML_MEDIA_TYPE || !same(artifact.provenance?.subject?.contentDigest, scope.contentDigest) ||
    !same(`sha-256=:${createHash('sha256').update(artifact.bytes).digest('base64')}:`, scope.contentDigest) ||
    !inspectHTML(artifact.bytes).ok) return null;
  return { session, artifact };
}
export function previewResponse(artifact, configuration, head = false) {
  const bytes = Buffer.from(previewDocument(new TextDecoder().decode(artifact.bytes)));
  return new Response(head ? null : bytes, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
    'content-security-policy': configuration.csp, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-length': String(bytes.length),
    // The bootstrap changes the representation; the raw artifact digest is not its digest.
    'content-digest': `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`,
  } });
}
