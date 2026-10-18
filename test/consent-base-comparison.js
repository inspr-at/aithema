// Self-contained callback shared by the browser comparison and its mutation regression.
export function comparePhoneConsentBase(c) {
  const style = c.shadowRoot.querySelector('style'), current = style.textContent;
  const blocks = current.match(/\/\* AIT-327: wide footer start \*\/[\s\S]*?\/\* AIT-327: wide footer end \*\//gu) ?? [];
  const markers = current.match(/\/\* AIT-327: wide footer (?:start|end) \*\//gu) ?? [];
  if (blocks.length !== 1 || markers.length !== 2) throw new Error('Expected exactly one AIT-327 wide footer block');
  style.textContent = current.replace(blocks[0], '');
  const selectors = ['.settings__footer', '.footer-links', '.save-state', '.save-status', '.done', '.consent-items', '.consent-item', '.consent-item input'];
  const measure = () => selectors.flatMap(selector => [...c.shadowRoot.querySelectorAll(selector)].map(n => {
    const b = n.getBoundingClientRect(); return { selector, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
  const base = measure(); style.textContent = current;
  return { base, current: measure() };
}
