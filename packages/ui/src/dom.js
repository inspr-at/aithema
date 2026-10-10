// Small DOM helpers shared by the session element and its host surface panels.
export function node(tag, className, text) {
  const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n;
}
export function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
// Keyed children: an item whose key survives keeps its node (and with it focus and the
// pointer anchor); nodes move only when the order changed.
export function reconcile(parent, entries, create, update) {
  const old = new Map([...parent.children].map(node => [node.dataset.key, node]));
  let next = parent.firstElementChild;
  for (const [key, value] of entries) {
    let node = old.get(key); old.delete(key);
    if (!node) { node = create(value); node.dataset.key = key; }
    update(node, value);
    if (node !== next) parent.insertBefore(node, next); else next = next.nextElementSibling;
  }
  for (const node of old.values()) node.remove();
}
// Two states share one grid cell, so switching never resizes or moves anything; the
// inactive one is invisible and inert (out of the tab order and the accessibility tree).
export function showOne(active, ...inactive) {
  active.toggleAttribute('inert', false); active.style.visibility = '';
  for (const other of inactive) { other.toggleAttribute('inert', true); other.style.visibility = 'hidden'; }
}
export const fill = (template, values) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
