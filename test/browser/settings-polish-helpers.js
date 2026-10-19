import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureGaugeCaptions } from './settings-caption-helpers.js';

// AIT-362 shares AIT-350's real editor, offline catalog, browser and pinned host
// font stack. Gather all failures before asserting so red-before proves each cue.
export async function checkSettingsPolish(page, { evidence, shot, settle, regression }) {
  const checks = [], failures = [];
  const record = (context, name, actual, expected) => {
    checks.push({ ...context, assert: name, actual, expected, pass: actual === expected });
    if (actual !== expected) failures.push({ ...context, assert: name, actual, expected });
  };
  // Tick fixes phone width only: the shorter General content needs a shorter
  // phone viewport to exercise the requested S1 state without product filler.
  for (const [width, height, theme, state] of [
    [1280, 800, 'light', 's1-model'], [1280, 800, 'dark', 's1-model'],
    [390, 844, 'light', 's1-model'], [390, 740, 'light', 's1-general'],
    [390, 844, 'light', 's2-bottom'], [1440, 900, 'light', 's3-fits'],
    [1280, 800, 'light', 's4-visuals'], [1280, 800, 'dark', 's4-visuals'],
    [390, 844, 'light', 's4-visuals'], [1440, 900, 'light', 's5-voice'],
  ]) {
    const context = { width, height, theme, locale: 'de', state };
    await page.setViewport({ width, height }); await page.select('#theme', theme);
    await page.evaluate(async state => {
      const f = window.ait350; await f.reset('de');
      if (state === 's1-general') f.q('[data-tab=general]').click();
      const body = f.q('.settings__body'); body.scrollTop = state === 's2-bottom' ? body.scrollHeight : 0;
      if (state.startsWith('s4') || state.startsWith('s5')) {
        const name = state.startsWith('s4') ? 'visuals' : 'voice';
        if (innerWidth < 600) {
          const button = f.q(`#settings-select-${name}`);
          body.scrollTop = button.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + body.scrollTop + 16;
        }
        f.q(`#settings-select-${name}`).click();
      }
    }, state);
    await settle();
    await shot(`ait362-${width}-${theme}-de-${state}`);
    const observed = await page.evaluate(() => {
      const f = window.ait350, body = f.q('.settings__body');
      const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const nodes = [...body.querySelectorAll('*')].filter(n => n.getClientRects().length);
      const before = nodes.flatMap(box), scrollHeight = body.scrollHeight;
      const css = getComputedStyle(body), b = body.getBoundingClientRect(), dialog = f.dialog.getBoundingClientRect();
      const hitPoint = [b.x + body.clientWidth / 2, b.top + body.clientTop + body.clientHeight - 12];
      const hit = f.root.elementFromPoint(...hitPoint);
      const tokenProbe = document.createElement('span'); tokenProbe.style.color = 'var(--aithema-line)';
      f.dialog.append(tokenProbe); const lineColor = getComputedStyle(tokenProbe).color; tokenProbe.remove();
      const result = { maskImage: css.maskImage,
        background: css.backgroundColor, backgroundImage: css.backgroundImage,
        hitsContent: Boolean(hit && body.contains(hit)),
        noEdgeRule: css.borderTopWidth === '0px' && css.borderBottomWidth === '0px' && css.boxShadow === 'none',
        footerHairline: getComputedStyle(f.q('.settings-context')).borderTopWidth,
        footerHairlineStyle: getComputedStyle(f.q('.settings-context')).borderTopStyle,
        footerHairlineColor: getComputedStyle(f.q('.settings-context')).borderTopColor,
        lineColor,
        transition: css.transitionDuration, scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight,
        topMargin: dialog.top, bottomMargin: innerHeight - dialog.bottom, dialogHeight: dialog.height,
        moreBelow: body.scrollTop + body.clientHeight < body.scrollHeight - 1 };
      body.style.maskImage = result.moreBelow ? 'none' : 'linear-gradient(to bottom, #000 calc(100% - 24px), transparent)';
      const after = nodes.flatMap(box);
      result.movementPx = Math.max(0, ...before.map((v, i) => Math.abs(v - after[i])));
      result.scrollHeightDelta = body.scrollHeight - scrollHeight;
      result.sameHitTarget = f.root.elementFromPoint(...hitPoint) === hit;
      body.style.removeProperty('mask-image');
      return result;
    });
    checks.push({ ...context, measurement: 'mask', ...observed });
    record(context, 'body is transparent', observed.background, 'rgba(0, 0, 0, 0)');
    record(context, 'body has no background image', observed.backgroundImage, 'none');
    record(context, 'mask on/off follows more below', observed.maskImage,
      observed.moreBelow ? 'linear-gradient(rgb(0, 0, 0) calc(100% - 24px), rgba(0, 0, 0, 0))' : 'none');
    if (state.startsWith('s1')) record(context, 'S1 overflows', observed.moreBelow, true);
    if (state === 's2-bottom') record(context, 'S2 is at bottom', observed.moreBelow, false);
    if (state === 's3-fits') {
      record(context, 'S3 has no overflow', observed.scrollHeight <= observed.clientHeight, true);
      record(context, 'S3 top margin >=24px', observed.topMargin >= 24, true);
      record(context, 'S3 bottom margin >=24px', observed.bottomMargin >= 24, true);
      record(context, 'S3 dialog <= viewport minus 48px', observed.dialogHeight <= height - 48, true);
      record(context, 'S3 accepted +16px height', observed.dialogHeight, 768);
    }
    if (width === 1280) record(context, '1280x800 unchanged 47rem height', observed.dialogHeight, 752);
    record(context, 'mask centre hits content', observed.hitsContent, true);
    record(context, 'mask preserves hit target', observed.sameHitTarget, true);
    record(context, 'no body edge rule or shadow', observed.noEdgeRule, true);
    record(context, 'main footer hairline px', observed.footerHairline, '1px');
    record(context, 'main footer hairline style', observed.footerHairlineStyle, 'solid');
    record(context, 'main footer hairline token', observed.footerHairlineColor, observed.lineColor);
    record(context, 'body children movementPx', observed.movementPx, 0);
    record(context, 'scrollHeight delta px', observed.scrollHeightDelta, 0);
    record(context, 'reduced motion transition', observed.transition, '0s');

    if (state.startsWith('s4') || state.startsWith('s5')) {
      const menus = await page.evaluate(() => {
        const f = window.ait350, body = f.q('.settings__body');
        return [...f.dialog.querySelectorAll('.select')].map(select => {
          const menu = f.q('#' + select.querySelector('.select__button').getAttribute('aria-controls')), wasHidden = menu.hidden; menu.hidden = false;
          const rows = [...menu.querySelectorAll('[role=option]')];
          const boxes = () => rows.flatMap(n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
          const before = boxes(), selection = rows.map(n => n.getAttribute('aria-selected'));
          rows.forEach(n => n.setAttribute('aria-selected', String(n.getAttribute('aria-selected') !== 'true')));
          const after = boxes(); rows.forEach((n, i) => n.setAttribute('aria-selected', selection[i]));
          const details = [...menu.querySelectorAll('.option-label small')].filter(n => n.getClientRects().length && n.textContent).map(n => {
            const css = getComputedStyle(n), name = n.parentElement.querySelector('strong');
            return { borderLeftWidth: parseFloat(css.borderLeftWidth), paddingLeft: parseFloat(css.paddingLeft),
              fontSize: parseFloat(css.fontSize), muted: css.color === getComputedStyle(f.dialog).getPropertyValue('--aithema-muted').trim(),
              belowName: n.getBoundingClientRect().top >= name.getBoundingClientRect().bottom };
          });
          const names = rows.map(n => {
            const strong = n.querySelector('strong'), range = document.createRange(); range.selectNodeContents(strong);
            const rects = [...range.getClientRects()], lines = new Set(rects.map(r => r.y)).size;
            return { text: strong.textContent, lines, labelWidth: n.querySelector('.option-label').getBoundingClientRect().width, width: strong.getBoundingClientRect().width };
          });
          const b = body.getBoundingClientRect(), m = menu.getBoundingClientRect();
          const bottomOption = rows.at(-1), ancestors = [];
          for (let node = bottomOption; node; node = node.parentElement) {
            const css = getComputedStyle(node);
            ancestors.push({ node: node.id || node.className, maskImage: css.maskImage,
              webkitMaskImage: css.webkitMaskImage, opacity: css.opacity });
            if (node === f.dialog) break;
          }
          const result = { name: select.dataset.select, open: !wasHidden, details, names,
            rowHeights: rows.map(n => n.getBoundingClientRect().height),
            movementPx: Math.max(0, ...before.map((v, i) => Math.abs(v - after[i]))),
            reservedCheck: rows.every(n => getComputedStyle(n.querySelector('.option-check')).width === '16px'),
            insideBody: m.top >= b.top && m.bottom <= b.bottom,
            bottomOption: bottomOption?.textContent, ancestors,
            fullOpacity: ancestors.length > 0 && ancestors.at(-1).node === f.dialog.className &&
              ancestors.every(a => a.maskImage === 'none' && a.webkitMaskImage === 'none' && a.opacity === '1') };
          menu.hidden = wasHidden; return result;
        });
      });
      for (const menu of menus) {
        checks.push({ ...context, measurement: 'menu', ...menu });
        record(context, `${menu.name}: detail border-left px`, menu.details.every(d => d.borderLeftWidth === 0), true);
        record(context, `${menu.name}: detail padding-left px`, menu.details.every(d => d.paddingLeft === 0), true);
        record(context, `${menu.name}: details under name at .72rem`, menu.details.every(d => d.belowName && Math.abs(d.fontSize - 11.52) < .01), true);
        record(context, `${menu.name}: names use full label width and at most two lines`, menu.names.every(n => n.width === n.labelWidth && n.lines <= 2), true);
        record(context, `${menu.name}: option rows >=44px`, menu.rowHeights.every(h => h >= 44), true);
        record(context, `${menu.name}: selection movementPx`, menu.movementPx, 0);
        record(context, `${menu.name}: reserved 1rem check`, menu.reservedCheck, true);
        if (menu.open) {
          record(context, `${menu.name}: open menu inside body`, menu.insideBody, true);
          record(context, `${menu.name}: bottom option full opacity with no masked ancestors through dialog`, menu.fullOpacity, true);
        }
        if (width === 1280 && menu.name === 'visuals') record(context, 'Codex image generation lines', menu.names.find(n => n.text === 'Codex image generation')?.lines, 1);
      }
    }
    if ([1280, 1440].includes(width) && !state.startsWith('s4') && !state.startsWith('s5')) {
      const gaugeCaptions = await page.evaluate(measureGaugeCaptions);
      checks.push({ ...context, measurement: 'gaugeCaptions', gaugeCaptions });
      record(context, 'AIT-350 gaugeCaptions: 0 clipped px', gaugeCaptions.every(c => c.rendered && !c.clipped && !c.detailTextClipped), true);
    }
  }
  // Force the viewport clamp to win over 48rem, rather than checking a
  // naturally shorter dialog only. Restore the pinned font before any evidence.
  await page.setViewport({ width: 1440, height: 850 });
  const clamp = await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
    const b = window.ait350.dialog.getBoundingClientRect();
    const result = { height: b.height, top: b.top, bottom: innerHeight - b.bottom };
    document.documentElement.style.removeProperty('font-size');
    return result;
  });
  const clampContext = { width: 1440, height: 850, state: 'tall-desktop-clamp', rootFontPx: 20 };
  checks.push({ ...clampContext, measurement: 'margins', dialogHeight: clamp.height, topMargin: clamp.top, bottomMargin: clamp.bottom });
  record(clampContext, 'dialog <= viewport minus 48px', clamp.height <= 802, true);
  record(clampContext, 'top and bottom margins >=24px', clamp.top >= 24 && clamp.bottom >= 24, true);
  await page.setViewport({ width: 1440, height: 900 });
  // Content growth/shrink must update the cue while the viewport stays fixed.
  const context = { width: 1440, height: 900, theme: 'light', locale: 'de', state: 'resize-observer' };
  // Observe actual nodes, and exercise panel-only growth while the body stays fixed.
  const observedNodes = await page.evaluate(async () => {
    const NativeObserver = window.ResizeObserver, nodes = [];
    window.ResizeObserver = class extends NativeObserver {
      observe(node, options) { nodes.push(node); return super.observe(node, options); }
    };
    try { await window.ait350.reset('de'); } finally { window.ResizeObserver = NativeObserver; }
    const f = window.ait350, panel = f.q('[data-panel=model]'), body = f.q('.settings__body');
    panel.style.minHeight = '1200px';
    return { panel: nodes.includes(panel), body: nodes.includes(body), bodyHeight: body.clientHeight };
  });
  record(context, 'ResizeObserver observes actual model panel', observedNodes.panel, true);
  record(context, 'ResizeObserver observes actual scroll body', observedNodes.body, true);
  await settle();
  record(context, 'content growth shows mask', await page.evaluate(() => getComputedStyle(window.ait350.q('.settings__body')).maskImage !== 'none'), true);
  await page.evaluate(() => { window.ait350.q('[data-panel=model]').style.removeProperty('min-height'); }); await settle();
  record(context, 'content shrink hides mask', await page.evaluate(() => getComputedStyle(window.ait350.q('.settings__body')).maskImage), 'none');
  record(context, 'content resize keeps body height', await page.evaluate(() => window.ait350.q('.settings__body').clientHeight), observedNodes.bodyHeight);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]); await settle();
  const duration = await page.evaluate(() => parseFloat(getComputedStyle(window.ait350.q('.settings__body')).transitionDuration));
  record(context, 'paint transition <=120ms', duration <= .12, true);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (evidence) await writeFile(join(evidence, 'ait362-checks.json'), JSON.stringify({ ticket: 'AIT-362', capture: 'viewport', motion: 'reduced and settled',
    blurredBeforeCapture: true, fontStack: 'unchanged host Chrome baseline', reference: 'CI Linux Chrome',
    platformNote: 'mbp2606 macOS font metrics can fit the 1280x800 S1 content without overflow; CI Linux Chrome is the reference. S1 General uses 390x740; other phone states use 390x844.',
    gutterDecision: 'Tick v1.1 call (b) permits the scrollbar to fade; the overlay gutter assertion is superseded by the body mask.', checks, ait350: regression, failures }, null, 2));
  assert.deepEqual(failures, [], 'AIT-362 Tick spec v1.1');
}
