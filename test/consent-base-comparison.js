// Self-contained callback shared by the browser comparison and its mutation regression.
export function comparePhoneConsentBase(c) {
  const style = c.shadowRoot.querySelector('style'), current = style.textContent;
  style.textContent = current.replace(/\/\* AIT-327: wide footer start \*\/[\s\S]*?\/\* AIT-327: wide footer end \*\//u, '');
  const selectors = ['.settings__footer', '.footer-links', '.save-state', '.save-status', '.done', '.consent-items', '.consent-item', '.consent-item input'];
  const measure = () => selectors.flatMap(selector => [...c.shadowRoot.querySelectorAll(selector)].map(n => {
    const b = n.getBoundingClientRect(); return { selector, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
  const base = measure(); style.textContent = current;
  return { base, current: measure() };
}
