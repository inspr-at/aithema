/**
 * Opt-in preview-side adapter. It reads only explicit data-aithema-ref and
 * data-aithema-label attributes from the element a human selects.
 */

export const PREVIEW_PROTOCOL = 'aithema.preview-element/1';
export const PREVIEW_ELEMENT_REF_CHARS = 256;
export const PREVIEW_ELEMENT_LABEL_CHARS = 160;

function exactOrigin(value) {
  if (typeof value !== 'string' || value === '*' || !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? value : null;
  } catch {
    return null;
  }
}

function safeText(value, maxChars, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u001F\u007F]/u.test(text) || Array.from(text).length > maxChars) return null;
  return text;
}

function safeBindingMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== 'aithema:preview-bind' || data.protocol !== PREVIEW_PROTOCOL) return null;
  const projectRef = safeText(data.projectRef, 240);
  const artifactRevision = safeText(data.artifactRevision, 240);
  const bindingKey = safeText(data.bindingKey, 64);
  const nonce = safeText(data.nonce, 128);
  if (!projectRef || !artifactRevision || !bindingKey || !nonce) return null;
  return Object.freeze({ projectRef, artifactRevision, bindingKey, nonce });
}

export function previewElementMetadata(element) {
  if (!element || typeof element.getAttribute !== 'function') return null;
  const elementRef = safeText(element.getAttribute('data-aithema-ref'), PREVIEW_ELEMENT_REF_CHARS);
  const elementLabel = safeText(
    element.getAttribute('data-aithema-label'),
    PREVIEW_ELEMENT_LABEL_CHARS,
    true,
  );
  if (!elementRef || elementLabel == null) return null;
  return Object.freeze({ elementRef, elementLabel });
}

/**
 * @param {{
 *   workspaceOrigin: string,
 *   root?: Document | Element,
 *   selfWindow?: Window,
 *   parentWindow?: Window,
 * }} options
 */
export function createPreviewAdapter(options) {
  const workspaceOrigin = exactOrigin(options?.workspaceOrigin);
  if (!workspaceOrigin) throw new Error('workspaceOrigin must be one exact origin');
  const selfWindow = options.selfWindow ?? window;
  const parentWindow = options.parentWindow ?? selfWindow.parent;
  const root = options.root ?? selfWindow.document;
  if (!parentWindow || parentWindow === selfWindow) throw new Error('preview adapter must run inside its workspace frame');

  let liveBinding = null;

  const onMessage = (event) => {
    if (event.origin !== workspaceOrigin || event.source !== parentWindow) return;
    const binding = safeBindingMessage(event.data);
    if (binding) liveBinding = binding;
  };

  const select = (element) => {
    if (!liveBinding) return false;
    const metadata = previewElementMetadata(element);
    if (!metadata) return false;
    parentWindow.postMessage({
      type: 'aithema:preview-selection',
      protocol: PREVIEW_PROTOCOL,
      ...liveBinding,
      element: metadata,
    }, workspaceOrigin);
    if (typeof element.setAttribute === 'function') element.setAttribute('data-aithema-selected', 'true');
    return true;
  };

  const selectedElement = (event) => {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return null;
    const element = target.closest('[data-aithema-ref]');
    if (!element || (typeof root.contains === 'function' && !root.contains(element))) return null;
    return element;
  };

  const onClick = (event) => {
    const element = selectedElement(event);
    if (element) select(element);
  };

  const onKeydown = (event) => {
    if (event?.key !== 'Enter' && event?.key !== ' ') return;
    const element = selectedElement(event);
    if (element) select(element);
  };

  selfWindow.addEventListener('message', onMessage);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);

  return Object.freeze({
    select,
    destroy() {
      liveBinding = null;
      selfWindow.removeEventListener('message', onMessage);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
    },
  });
}
