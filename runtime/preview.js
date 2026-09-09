import { createHash, randomUUID } from 'node:crypto';

export const PREVIEW_LIMITS = Object.freeze({
  maxBindings: 100,
  maxProjectRefChars: 240,
  maxArtifactRevisionChars: 240,
  maxPreviewUrlChars: 2_048,
  maxElementRefChars: 256,
  maxElementLabelChars: 160,
  maxNonceChars: 128,
  nonceTtlMs: 10 * 60 * 1_000,
  maxLiveNonces: 512,
});

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

function codePointLength(value) {
  return Array.from(value).length;
}

function boundedText(value, name, maxChars, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${name} must be a string`), { code: 'preview_invalid' });
  }
  const text = value.trim();
  if (!text) {
    throw Object.assign(new Error(`${name} is required`), { code: 'preview_invalid' });
  }
  if (CONTROL_CHARS.test(text) || codePointLength(text) > maxChars) {
    throw Object.assign(new Error(`${name} is not within the allowed text limits`), { code: 'preview_invalid' });
  }
  return text;
}

function normalizePreviewUrl(value) {
  const text = boundedText(value, 'previewUrl', PREVIEW_LIMITS.maxPreviewUrlChars);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw Object.assign(new Error('previewUrl must be a valid HTTP(S) URL'), { code: 'preview_invalid' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('previewUrl must use HTTP or HTTPS'), { code: 'preview_invalid' });
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw Object.assign(new Error('previewUrl must not include credentials or a fragment'), { code: 'preview_invalid' });
  }
  if (parsed.href.length > PREVIEW_LIMITS.maxPreviewUrlChars) {
    throw Object.assign(new Error('previewUrl is too long'), { code: 'preview_invalid' });
  }
  return { url: parsed.href, origin: parsed.origin };
}

function bindingKey(binding) {
  return createHash('sha256')
    .update(JSON.stringify([binding.projectRef, binding.artifactRevision, binding.previewUrl]))
    .digest('hex');
}

/**
 * Operator-owned project bindings. Absence is the disabled state.
 * @param {unknown} value
 */
export function normalizePreviewBindings(value) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('previewBindings must be an array');
  if (value.length > PREVIEW_LIMITS.maxBindings) throw new Error('too many previewBindings');
  const projectRefs = new Set();
  const bindings = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('preview binding must be an object');
    }
    const projectRef = boundedText(
      item.projectRef,
      'preview binding projectRef',
      PREVIEW_LIMITS.maxProjectRefChars,
    );
    if (projectRefs.has(projectRef)) throw new Error('preview binding projectRef must be unique');
    projectRefs.add(projectRef);
    const artifactRevision = boundedText(
      item.artifactRevision,
      'preview binding artifactRevision',
      PREVIEW_LIMITS.maxArtifactRevisionChars,
    );
    const preview = normalizePreviewUrl(item.previewUrl);
    const normalized = {
      projectRef,
      artifactRevision,
      previewUrl: preview.url,
      previewOrigin: preview.origin,
    };
    return Object.freeze({ ...normalized, bindingKey: bindingKey(normalized) });
  });
  return Object.freeze(bindings);
}

export function normalizePreviewElement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('preview element metadata is required'), { code: 'preview_invalid' });
  }
  return Object.freeze({
    elementRef: boundedText(value.elementRef, 'element_ref', PREVIEW_LIMITS.maxElementRefChars),
    elementLabel: boundedText(
      value.elementLabel,
      'element_label',
      PREVIEW_LIMITS.maxElementLabelChars,
      { optional: true },
    ),
  });
}

function stale(message) {
  return Object.assign(new Error(message), { code: 'stale_preview' });
}

/**
 * Ephemeral non-authority nonce registry. Authorization still comes from the
 * verified actor, current membership, project revision, and current binding.
 */
export class PreviewBindingRegistry {
  constructor(bindings, options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.nonceTtlMs = options.nonceTtlMs ?? PREVIEW_LIMITS.nonceTtlMs;
    this.bindings = new Map();
    this.nonces = new Map();
    this.replace(bindings);
  }

  replace(bindings) {
    const normalized = normalizePreviewBindings(bindings);
    this.bindings = new Map(normalized.map((binding) => [binding.projectRef, binding]));
    this.nonces.clear();
    return normalized;
  }

  bindingFor(projectRef) {
    return this.bindings.get(projectRef) ?? null;
  }

  issue({ actor, projectRef, projectRevision }) {
    const binding = this.bindingFor(projectRef);
    if (!binding) return null;
    this.#prune();
    while (this.nonces.size >= PREVIEW_LIMITS.maxLiveNonces) {
      this.nonces.delete(this.nonces.keys().next().value);
    }
    const nonce = randomUUID();
    const turnId = `preview:${randomUUID()}`;
    const inputRef = `preview-input:${randomUUID()}`;
    const expiresAt = this.now() + this.nonceTtlMs;
    this.nonces.set(nonce, Object.freeze({
      subject: actor.subject,
      projectRef,
      projectRevision,
      bindingKey: binding.bindingKey,
      turnId,
      inputRef,
      expiresAt,
    }));
    return Object.freeze({
      ...binding,
      nonce,
      turnId,
      projectRevision,
      expiresAt,
    });
  }

  consume({ actor, projectRef, projectRevision, nonce, turnId, artifactRevision, bindingKey: submittedKey, element }) {
    this.#prune();
    const safeNonce = boundedText(nonce, 'preview nonce', PREVIEW_LIMITS.maxNonceChars);
    const session = this.nonces.get(safeNonce);
    if (!session) throw stale('preview selection expired; select the element again');
    const current = this.bindingFor(projectRef);
    if (
      !current
      || session.subject !== actor.subject
      || session.projectRef !== projectRef
      || session.projectRevision !== projectRevision
      || session.turnId !== turnId
      || current.bindingKey !== session.bindingKey
      || submittedKey !== current.bindingKey
      || artifactRevision !== current.artifactRevision
    ) {
      throw stale('preview binding or project revision changed; select the element again');
    }
    const normalizedElement = normalizePreviewElement(element);
    this.nonces.delete(safeNonce);
    return Object.freeze({
      bindingKey: current.bindingKey,
      artifactRevision: current.artifactRevision,
      previewOrigin: current.previewOrigin,
      previewUrl: current.previewUrl,
      turnId: session.turnId,
      inputRef: session.inputRef,
      ...normalizedElement,
    });
  }

  #prune() {
    const now = this.now();
    for (const [nonce, session] of this.nonces) {
      if (session.expiresAt <= now) this.nonces.delete(nonce);
    }
  }
}
