// Temporary AIT-515 diagnostic: removed after the fractional-scroll cause is isolated.
export function installClarifyTrace(c) {
  const trace = window.ait515Trace = { active: false, context: '', stage: '', events: [] };
  const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
  const pane = () => c.shadowRoot.querySelector('.analysis-content');
  const record = (kind, detail) => {
    if (!trace.active || trace.events.length >= 10000) return;
    const p = pane(), signals = c.shadowRoot.querySelector('.signals-section');
    trace.events.push({ kind, stage: trace.stage, ...detail,
      scroll: p && ['rect', 'hit', 'scroll-before', 'scroll-after', 'into-view-before', 'into-view-after'].includes(kind)
        ? scroll.get.call(p) : undefined,
      slack: p?.style.getPropertyValue('--aithema-slack-top'),
      signalsHidden: signals?.hidden, stack: new Error().stack.split('\n').slice(2, 8) });
  };
  Object.defineProperty(Element.prototype, 'scrollTop', { ...scroll,
    get() { return scroll.get.call(this); },
    set(value) {
      if (this.matches('.analysis-content')) record('scroll-before', { requested: value });
      scroll.set.call(this, value);
      if (this.matches('.analysis-content')) record('scroll-after', { requested: value });
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'hidden', { ...hidden,
    get() { return hidden.get.call(this); },
    set(value) {
      if (this.matches('.signals-section')) record('hidden-before', { value });
      hidden.set.call(this, value);
      if (this.matches('.signals-section')) record('hidden-after', { value });
    },
  });
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...args) {
    const b = rect.apply(this, args);
    if (this.matches('.question-state,.open-question,.analysis-content,.signals-section,.signals-heading')) {
      record('rect', { node: this.className, question: this.closest('.open-question')?.dataset.questionId,
        x: b.x, y: b.y, width: b.width, height: b.height });
    }
    return b;
  };
  for (const method of ['setProperty', 'removeProperty']) {
    const original = CSSStyleDeclaration.prototype[method];
    CSSStyleDeclaration.prototype[method] = function (...args) {
      if (this === pane()?.style && args[0].startsWith('--aithema-slack-')) record(method, { args });
      return original.apply(this, args);
    };
  }
  const hit = ShadowRoot.prototype.elementFromPoint;
  ShadowRoot.prototype.elementFromPoint = function (...args) {
    const node = hit.apply(this, args);
    record('hit', { args, node: node?.className?.baseVal ?? node?.className });
    return node;
  };
  const intoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    record('into-view-before', { node: this.className, args });
    const result = intoView.apply(this, args);
    record('into-view-after', { node: this.className, args });
    return result;
  };
}
