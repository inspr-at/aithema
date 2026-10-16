// Shared display helpers for the two file-based CI shards.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { browserPath } from '../../scripts/install-test-browser.js';
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: 30_000 }, arg);
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
async function mockIdentityReads(page) {
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, identity = document.querySelector('aithema-session')?.session?.identity;
      if ((init.method ?? 'GET') === 'GET' && identity) {
        if (path.endsWith('/identity')) return Response.json({ identity, delivery: true, privacyDocumentConfigured: false });
        if (path === '/api/visitor/email') return Response.json({ visitor: { address: identity.address ?? null }, notice: { version: 'ait-135-v1', deliveryEnabled: true }, privacyDocumentConfigured: false });
      }
      return original(url, init);
    };
  });
}

const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
// Dissolve transforms intentionally drift the painted controls. Offset geometry
// checks the actual layout underneath that animation.
const layoutBoxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const n = c.shadowRoot.querySelector(selector); return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight];
}), selectors);
const statusGeometry = page => shadow(page, c => {
  const n = c.shadowRoot.querySelector('.voice-state'), wave = c.shadowRoot.querySelector('.voice-wave');
  const b = n.getBoundingClientRect(), w = wave.getBoundingClientRect(), style = getComputedStyle(n);
  const range = document.createRange(); range.selectNodeContents(n);
  const lines = [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  const widest = lines.reduce((a, r) => r.width > a.width ? r : a), half = parseFloat(getComputedStyle(wave).getPropertyValue('--voice-label-half'));
  const center = w.x + w.width / 2 + parseFloat(getComputedStyle(wave).getPropertyValue('--voice-label-center'));
  const textBox = { x: Math.min(...lines.map(r => r.x)), y: Math.min(...lines.map(r => r.y)),
    right: Math.max(...lines.map(r => r.x + r.width)), bottom: Math.max(...lines.map(r => r.y + r.height)) };
  return { x: b.x, y: b.y, width: b.width, height: b.height, waveX: w.x, waveWidth: w.width, half, rendered: lines, textBox,
    gaps: [widest.x - (center - half - 16), center + half + 16 - widest.x - widest.width],
    lines: (b.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
    overflow: style.textOverflow, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, visibility: getComputedStyle(wave).visibility };
});
const sameBoxes = (before, after, context) => before.forEach((box, i) => box.forEach((value, n) =>
  assert.ok(Math.abs(value - after[i][n]) <= .5, `${context}: ${i}/${n} shifted ${value} → ${after[i][n]}`)));

// A rendered 1x1 Chrome PNG, independent of its RGB/RGBA colour type and scanline filter.
function pixelRgb(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') { assert.equal(data.readUInt32BE(0), 1); assert.equal(data.readUInt32BE(4), 1); }
    if (name === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}
const finishRevealEntry = page => shadow(page, async c => {
  const animations = c.shadowRoot.querySelector('.band').getAnimations({ subtree: true });
  await Promise.all(animations.filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
});
// Continuity baselines must wait for the first persisted greeting, not just
// the rail's listening/speaking state.
const finishWorkspaceEntry = async page => {
  await until(page, () => { const c = document.querySelector('aithema-session'), w = c.shadowRoot.querySelector('.workspace');
    return c.session.transcript.length > 0 && w.dataset.stage === 'live'
      && w.dataset.understanding === 'present' && !w.hasAttribute('data-reveal'); });
  await shadow(page, async c => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true })
      .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
};
const freezeRevealExit = async page => {
  const point = await shadow(page, c => {
    const band = c.shadowRoot.querySelector('.band'), native = window.setTimeout;
    const holdCleanup = event => {
      if (event.target !== band) return;
      band.removeEventListener('mouseleave', holdCleanup, true);
      window.setTimeout = fn => { globalThis.displayRevealCleanup = fn; return 0; };
    };
    band.addEventListener('mouseleave', holdCleanup, true);
    // Registered after the reveal's close handler: capture its actual exit in this
    // browser event, before a protocol round trip can retire a short transition.
    band.addEventListener('mouseleave', () => {
      window.setTimeout = native;
      globalThis.displayRevealTimeline = band.getAnimations({ subtree: true })
        .filter(animation => animation.animationName !== 'aithema-prism-turn');
      for (const animation of globalThis.displayRevealTimeline) { animation.pause(); animation.currentTime = 0; }
      globalThis.displayRevealPaused = Promise.all(globalThis.displayRevealTimeline.map(animation => animation.ready));
    }, { once: true });
    return [0, innerHeight - 1];
  });
  // A synthetic mouseleave leaves the orb under the pointer and permits re-entry
  // while its old exit animations are paused. Physically leave the whole band.
  await page.mouse.move(...point);
  return shadow(page, async c => {
    await globalThis.displayRevealPaused;
    const band = c.shadowRoot.querySelector('.band'), row = band.querySelector('.aithema-reveal__row');
    const fade = globalThis.displayRevealTimeline.find(a => a.effect.target === row && a.transitionProperty === 'opacity');
    if (!fade) return null;
    const frames = fade.effect.getKeyframes();
    return { phase: band.dataset.aithemaRevealState, from: frames[0].opacity, to: frames.at(-1).opacity, duration: fade.effect.getTiming().duration };
  });
};
const seekReveal = (page, ms) => page.evaluate(ms => {
  for (const animation of globalThis.displayRevealTimeline) animation.currentTime = ms;
}, ms);

// Evidence only: retain the real paint, but eliminate fractional compositor scroll
// origins and wait until fonts, shadow-root transitions and scroll handlers agree.
// Timed animation assertions intentionally keep their explicit screenshot clocks.
export async function settleEvidenceFrame(page) {
  await page.mouse.move(-1, -1);
  return page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const roots = [document], nodes = [];
    for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) {
      nodes.push(node); if (node.shadowRoot) roots.push(node.shadowRoot);
    }
    for (const root of roots.slice().reverse()) root.activeElement?.blur();
    await document.fonts.ready;
    let scrollEvents = 0;
    const scrolled = () => { scrollEvents++; };
    for (const root of roots) root.addEventListener('scroll', scrolled, true);
    try {
      // Transcript first: its scroll handler may update fades and reservation.
      const panes = [...new Set([...nodes.filter(n => n.matches('.transcript-shell')),
        document.scrollingElement, ...nodes.filter(n => n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)])].filter(Boolean);
      const snapshot = () => panes.map(n => [n.scrollTop, n.scrollLeft]);
      const markers = nodes.filter(n => n.matches('.turn:not(.user) .speaker-sign'));
      const geometry = () => markers.map(n => {
        const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      });
      const animations = () => [...new Set(roots.flatMap(root => root.getAnimations()))]
        .filter(a => a.playState === 'running' || a.pending);
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const active = animations();
        if (active.some(a => !Number.isFinite(a.effect.getComputedTiming().endTime))) {
          throw new Error('Evidence has an active infinite animation; use reduced motion for this fixture');
        }
        // Bound the wait as well as the loop (a stalled animation is invalid evidence).
        if (active.length) {
          await frame(); continue;
        }
        for (const n of panes) {
          n.scrollTo({ top: Math.round(n.scrollTop), left: Math.round(n.scrollLeft), behavior: 'instant' });
        }
        const before = JSON.stringify([snapshot(), geometry()]), events = scrollEvents;
        await frame(); await frame();
        const positions = snapshot();
        if (events === scrollEvents && !animations().length &&
            positions.every(pair => pair.every(Number.isInteger)) &&
            before === JSON.stringify([positions, geometry()])) {
          return { scroll: positions, markers: geometry(), settledFrames: 2 };
        }
      }
      throw new Error('Evidence did not reach an integer, scroll-idle marker frame within 5s');
    } finally {
      for (const root of roots) root.removeEventListener('scroll', scrolled, true);
    }
  });
}

// Icon boxes are unpadded SVG bounds. The assistant marker is deliberately absent:
// class I must reproduce exactly; only composer/attachment class R gets tolerance.
export async function captureEvidence(page, options = {}) {
  const frame = await settleEvidenceFrame(page);
  const iconBoxes = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.composer svg')].map(n => {
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }).filter(r => r.width > 0 && r.height > 0));
  const png = await page.screenshot({ fullPage: false, captureBeyondViewport: false, ...options });
  return { png, iconBoxes, frame };
}

const evidenceCommit = process.env.GITHUB_SHA ?? process.env.AITHEMA_COMMIT ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1] ?? 'd886da3';
export { browserPath, mockIdentityReads, shadow, until, settle, boxes, layoutBoxes, statusGeometry, sameBoxes, pixelRgb, finishRevealEntry, finishWorkspaceEntry, freezeRevealExit, seekReveal, evidenceCommit };
