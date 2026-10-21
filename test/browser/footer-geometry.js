import assert from 'node:assert/strict';

const tolerancePx = .25;

// Measure the original text ranges too: overflow:hidden, ellipsis or a smaller
// fixed box must not turn an overlong translation into a passing measurement.
export const measureFooterGeometry = (c, { visibleZonesOnly = false, zoneSelectors = ['.footer-info', '.host-credits', '.footer-right'], extraGroups = [] } = {}) => {
  const root = c.shadowRoot, row = root.querySelector('.display-foot__row');
  const rect = node => {
    const b = node.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  };
  const visible = node => {
    if (!node || !node.getClientRects().length || getComputedStyle(node).visibility !== 'visible') return false;
    for (let parent = node; parent && parent !== root; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      // Fully clipped live regions remain accessible, but paint no footer footprint.
      if (style.display === 'none' || Number(style.opacity) === 0 || style.clipPath === 'inset(50%)') return false;
    }
    // The feature list is an intentional 1px screen-reader-only description,
    // not a painted footer item. Keep clipping checks for all visible labels.
    return !node.closest('.footer-popup, .features');
  };
  const outside = (inner, outer) => Math.max(0, outer.left - inner.left, inner.right - outer.right,
    outer.top - inner.top, inner.bottom - outer.bottom);
  const container = rect(row), footprints = new Map(), violations = [];
  let maxOverflowPx = 0, maxOverlapPx = 0;
  for (const selector of zoneSelectors) {
    const zone = root.querySelector(selector), contents = getComputedStyle(zone).display === 'contents';
    if (visibleZonesOnly && !contents && !visible(zone)) continue;
    // A display:contents zone has no parent box: measure each painted child
    // against its own box and the footer row, preserving clipping and spacing checks.
    const fragments = contents ? [...zone.children].filter(visible) : [zone], paintedFragments = [];
    for (const fragment of fragments) {
      const bounds = rect(fragment), painted = { ...bounds };
      const record = (box, limit, item) => {
        const overflow = Math.max(outside(box, limit), outside(box, container));
        maxOverflowPx = Math.max(maxOverflowPx, overflow);
        if (overflow > 0) violations.push({ item, overflowPx: overflow });
        painted.left = Math.min(painted.left, box.left); painted.right = Math.max(painted.right, box.right);
        painted.top = Math.min(painted.top, box.top); painted.bottom = Math.max(painted.bottom, box.bottom);
      };
      record(bounds, container, fragment.className);
      for (const node of fragment.querySelectorAll('*')) if (visible(node)) record(rect(node), bounds, node.className);
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      for (let text; (text = walker.nextNode());) {
        if (!text.textContent.trim() || !visible(text.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        for (const box of range.getClientRects()) record(box, rect(text.parentElement), `${text.parentElement.className}: ${text.textContent}`);
      }
      paintedFragments.push(painted);
    }
    footprints.set(selector, paintedFragments);
  }
  const groups = [
    ['.footer-info', '.host-credits', '.footer-right'],
    ['.ai-notice .speaker-sign', '.display-version', '.ai-notice__label', '.ai-notice__short', '.ai-notice__voice'],
    ['.host-credits__stack', '.host-credits__track'],
    ['.host-credits__amount', '.host-credits__total', '.host-credits__unit'],
    ['.engine', '.status'],
    ['.status__label', '.connection-timer'],
    ...extraGroups,
  ];
  for (const selectors of groups) {
    const items = selectors.flatMap(selector => {
      const node = root.querySelector(selector), contents = node && getComputedStyle(node).display === 'contents';
      if (!contents && !visible(node)) return [];
      return (footprints.get(selector) ?? [rect(node)]).map(box => ({ selector, box }));
    });
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const overlap = Math.max(0, Math.min(Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left),
        Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)));
      maxOverlapPx = Math.max(maxOverlapPx, overlap);
      if (overlap > 0) violations.push({ items: [a.selector, b.selector], overlapPx: overlap });
    }
  }
  return { maxOverflowPx, maxOverlapPx, violations,
    compact: getComputedStyle(root.querySelector('.host-credits__total')).display === 'none',
    legal: !root.querySelector('.host-legal').hidden,
    measureCompact: getComputedStyle(root.querySelector('.host-credits__measure-total')).display === 'none',
    amount: root.querySelector('.host-credits__amount').textContent };
};

export const assertFits = (measurement, label) => {
  assert.ok(measurement.maxOverflowPx <= tolerancePx, `${label}: footer overflow ${JSON.stringify(measurement)}`);
  assert.ok(measurement.maxOverlapPx <= tolerancePx, `${label}: footer overlap ${JSON.stringify(measurement)}`);
};

// Shared AIT-309 legal-target measurement for the fit and held-state matrices.
// Corners sit 1px inside each target; retain centre coverage and hit diagnostics.
export const measureLegalLinks = c => {
  const root = c.shadowRoot;
  const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const row = box(root.querySelector('.display-foot__row')), footer = box(root.querySelector('.display-foot'));
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const inside = (b, outer) => b.left >= outer.left && b.right <= outer.right && b.top >= outer.top && b.bottom <= outer.bottom;
  const links = [...root.querySelector('slot[name="legal"]').assignedElements()].map(link => {
    const rect = box(link), hidden = [], clipping = [];
    for (let node = link; node; node = node.assignedSlot ?? node.parentElement ?? node.getRootNode().host) {
      const style = getComputedStyle(node), bounds = box(node);
      if (node.hidden || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) hidden.push(node.localName);
      if (style.display === 'contents') continue;
      if ((/hidden|clip|scroll|auto/u.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)) ||
          (/hidden|clip|scroll|auto/u.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)) || style.clipPath !== 'none') clipping.push(node.localName);
    }
    const points = [[rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
      [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return { text: link.textContent, rect, visible: link.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      hidden, clipping, insideRow: inside(rect, row), insideFooter: inside(rect, footer), insideViewport: inside(rect, viewport),
      hits: points.slice(0, 4).map(([x, y]) => {
        const describe = n => n ? { tag: n.localName, class: n.className, text: n.textContent.slice(0, 80) } : null;
        return { document: describe(document.elementFromPoint(x, y)), shadow: describe(root.elementFromPoint(x, y)) };
      }),
      unobscured: points.every(([x, y]) => link.contains(document.elementFromPoint(x, y))) };
  });
  return { fit: root.querySelector('.display-foot').dataset.fit, row, footer, viewport, links };
};
