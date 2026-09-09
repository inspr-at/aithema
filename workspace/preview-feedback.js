import {
  PREVIEW_ELEMENT_LABEL_CHARS,
  PREVIEW_ELEMENT_REF_CHARS,
  PREVIEW_PROTOCOL,
} from './preview-adapter.js';

function safeText(value, maxChars, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u001F\u007F]/u.test(text) || Array.from(text).length > maxChars) return null;
  return text;
}

export function acceptWorkspacePreviewMessage(event, binding, sourceWindow) {
  if (!event || event.origin !== binding.previewOrigin || event.source !== sourceWindow) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== 'aithema:preview-selection' || data.protocol !== PREVIEW_PROTOCOL) return null;
  if (
    data.projectRef !== binding.projectRef
    || data.artifactRevision !== binding.artifactRevision
    || data.bindingKey !== binding.bindingKey
    || data.nonce !== binding.nonce
  ) return null;
  if (!data.element || typeof data.element !== 'object' || Array.isArray(data.element)) return null;
  const elementRef = safeText(data.element.elementRef, PREVIEW_ELEMENT_REF_CHARS);
  const elementLabel = safeText(data.element.elementLabel, PREVIEW_ELEMENT_LABEL_CHARS, true);
  if (!elementRef || elementLabel == null) return null;
  return Object.freeze({ elementRef, elementLabel });
}

export function bindWorkspacePreviewFeedback(doc = document, win = window) {
  const configNode = doc.getElementById('aithema-preview-binding');
  const frame = doc.querySelector('[data-preview-frame]');
  const form = doc.querySelector('[data-preview-feedback-form]');
  if (!configNode || !frame || !form) return null;
  let binding;
  try {
    binding = JSON.parse(configNode.textContent || 'null');
  } catch {
    return null;
  }
  if (!binding || typeof binding !== 'object') return null;

  const postBinding = () => {
    const target = frame.contentWindow;
    if (!target) return;
    target.postMessage({
      type: 'aithema:preview-bind',
      protocol: PREVIEW_PROTOCOL,
      projectRef: binding.projectRef,
      artifactRevision: binding.artifactRevision,
      bindingKey: binding.bindingKey,
      nonce: binding.nonce,
    }, binding.previewOrigin);
  };

  const onMessage = (event) => {
    const selected = acceptWorkspacePreviewMessage(event, binding, frame.contentWindow);
    if (!selected) return;
    form.elements.element_ref.value = selected.elementRef;
    form.elements.element_label.value = selected.elementLabel;
    const summary = form.querySelector('[data-preview-selection-summary]');
    if (summary) {
      summary.textContent = selected.elementLabel
        ? `${selected.elementLabel} (${selected.elementRef})`
        : selected.elementRef;
    }
    form.hidden = false;
    form.elements.message.disabled = false;
    form.elements.message.focus();
  };

  frame.addEventListener('load', postBinding);
  win.addEventListener('message', onMessage);
  postBinding();
  return Object.freeze({
    destroy() {
      frame.removeEventListener('load', postBinding);
      win.removeEventListener('message', onMessage);
    },
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bindWorkspacePreviewFeedback();
}
