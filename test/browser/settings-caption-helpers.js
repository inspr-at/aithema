// Runs inside the page. Keep independent of the provider-switch fixture so the
// same measurement can be used against the pinned pre-AIT-350 main revision.
export function measureGaugeCaptions() {
  const root = document.querySelector('aithema-session').shadowRoot;
  const box = r => ({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left });
  const clientBox = node => {
    const r = node.getBoundingClientRect(), left = r.left + node.clientLeft, top = r.top + node.clientTop;
    return box({ x: left, y: top, left, top, right: left + node.clientWidth, bottom: top + node.clientHeight, width: node.clientWidth, height: node.clientHeight });
  };
  const intersect = (a, b, x = true, y = true) => {
    const left = x ? Math.max(a.left, b.left) : a.left, right = x ? Math.min(a.right, b.right) : a.right;
    const top = y ? Math.max(a.top, b.top) : a.top, bottom = y ? Math.min(a.bottom, b.bottom) : a.bottom;
    return box({ x: left, y: top, left, top, right: Math.max(left, right), bottom: Math.max(top, bottom), width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
  };
  const loss = (caption, visible) => ({
    top: Math.min(caption.height, Math.max(0, visible.top - caption.top)),
    bottom: Math.min(caption.height, Math.max(0, caption.bottom - visible.bottom)),
    left: Math.min(caption.width, Math.max(0, visible.left - caption.left)),
    right: Math.min(caption.width, Math.max(0, caption.right - visible.right)),
  });
  return [...root.querySelectorAll('dialog.settings [data-gauge]')].map(gauge => {
    const caption = gauge.querySelector('figcaption'), detail = gauge.querySelector('.gauge__detail');
    const rendered = caption.getClientRects().length > 0;
    const hiddenBy = [];
    for (let node = caption; node; node = node.parentElement) {
      if (getComputedStyle(node).display === 'none') hiddenBy.push(node.className || node.tagName.toLowerCase());
    }
    const captionBox = box(caption.getBoundingClientRect()), detailBox = box(detail.getBoundingClientRect());
    const range = document.createRange(); range.selectNodeContents(detail);
    const detailTextBox = box(range.getBoundingClientRect());
    const panel = gauge.closest('.gauge-panel'), panelBox = clientBox(panel);
    let visibleBox = panelBox;
    const clippingContainers = [];
    for (let node = caption.parentElement; node; node = node.parentElement) {
      const css = getComputedStyle(node), clipsX = /hidden|clip|auto|scroll/u.test(css.overflowX), clipsY = /hidden|clip|auto|scroll/u.test(css.overflowY);
      if (!clipsX && !clipsY) continue;
      const bounds = clientBox(node);
      clippingContainers.push({ selector: node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).trim().split(/\s+/u).join('.') : ''),
        box: bounds, overflowX: css.overflowX, overflowY: css.overflowY, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
      visibleBox = intersect(visibleBox, bounds, clipsX, clipsY);
    }
    visibleBox = intersect(visibleBox, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    // The scroll body can clip a caption even when the gauge panel itself fits.
    const clippedPx = loss(captionBox, visibleBox), panelClippedPx = loss(captionBox, panelBox);
    const detailTextClippedPx = loss(detailTextBox, visibleBox);
    return { gauge: gauge.dataset.gauge, label: gauge.querySelector('.gauge__label').textContent, detail: detail.textContent, rendered, hiddenBy,
      captionBox, detailBox, detailTextBox, scrollHeight: caption.scrollHeight, clientHeight: caption.clientHeight,
      detailScrollHeight: detail.scrollHeight, detailClientHeight: detail.clientHeight,
      clippingContainer: { selector: '.gauge-panel', box: panelBox, visibleBox, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight },
      clippingContainers, clipped: Object.values(clippedPx).some(px => px > 0), clippedPx,
      detailTextClipped: Object.values(detailTextClippedPx).some(px => px > 0), detailTextClippedPx,
      panelClipped: Object.values(panelClippedPx).some(px => px > 0), panelClippedPx };
  });
}
