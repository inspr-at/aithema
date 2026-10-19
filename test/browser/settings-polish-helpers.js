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
      const f = window.ait350, body = f.q('.settings__body'), fade = f.q('.settings__fade');
      const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const nodes = [...body.querySelectorAll('*')].filter(n => n.getClientRects().length);
      const before = nodes.flatMap(box), scrollHeight = body.scrollHeight;
      const css = fade && getComputedStyle(fade), r = fade?.getBoundingClientRect(), b = body.getBoundingClientRect();
      const hit = r && f.root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const result = { exists: Boolean(fade), opacity: css ? Number(css.opacity) : null,
        height: r?.height ?? null, pointerEvents: css?.pointerEvents ?? null,
        hitsContent: Boolean(hit && hit !== fade && body.contains(hit)),
        contentWidth: r?.width === body.clientWidth,
        innerBottom: r?.bottom === b.top + body.clientTop + body.clientHeight,
        backgroundMatches: Boolean(css && css.backgroundImage.includes(getComputedStyle(body).backgroundColor)),
        noEdgeRule: [body, fade, f.q('.settings-context')].filter(Boolean).every(n => {
          const s = getComputedStyle(n); return s.borderTopWidth === '0px' && s.borderBottomWidth === '0px' && s.boxShadow === 'none';
        }),
        transition: css?.transitionDuration ?? null, scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight,
        moreBelow: body.scrollTop + body.clientHeight < body.scrollHeight - 1 };
      if (fade) { fade.style.transition = 'none'; fade.style.opacity = result.opacity ? '0' : '1'; }
      const after = nodes.flatMap(box);
      result.movementPx = Math.max(0, ...before.map((v, i) => Math.abs(v - after[i])));
      result.scrollHeightDelta = body.scrollHeight - scrollHeight;
      if (fade) { fade.style.removeProperty('opacity'); fade.style.removeProperty('transition'); }
      return result;
    });
    checks.push({ ...context, measurement: 'fade', ...observed });
    record(context, 'fade exists', observed.exists, true);
    record(context, 'fade opacity follows more below', observed.opacity, observed.moreBelow ? 1 : 0);
    if (state.startsWith('s1')) record(context, 'S1 overflows', observed.moreBelow, true);
    if (state === 's2-bottom') record(context, 'S2 is at bottom', observed.moreBelow, false);
    if (state === 's3-fits') record(context, 'S3 has no overflow', observed.scrollHeight <= observed.clientHeight, true);
    record(context, 'fade height px', observed.height, 24);
    record(context, 'fade pointer-events', observed.pointerEvents, 'none');
    record(context, 'fade centre hits content', observed.hitsContent, true);
    record(context, 'fade excludes scrollbar gutter', observed.contentWidth, true);
    record(context, 'fade at body inner bottom', observed.innerBottom, true);
    record(context, 'fade ends at body background', observed.backgroundMatches, true);
    record(context, 'no edge rule or shadow', observed.noEdgeRule, true);
    record(context, 'body children movementPx', observed.movementPx, 0);
    record(context, 'scrollHeight delta px', observed.scrollHeightDelta, 0);
    record(context, 'reduced motion transition', observed.transition, '0s');

    if (state.startsWith('s4') || state.startsWith('s5')) {
      const menus = await page.evaluate(() => {
        const f = window.ait350, body = f.q('.settings__body'), fade = f.q('.settings__fade');
        return [...f.dialog.querySelectorAll('.select')].map(select => {
          const menu = select.querySelector('.select__menu'), wasHidden = menu.hidden; menu.hidden = false;
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
          const result = { name: select.dataset.select, open: !wasHidden, details, names,
            rowHeights: rows.map(n => n.getBoundingClientRect().height),
            movementPx: Math.max(0, ...before.map((v, i) => Math.abs(v - after[i]))),
            reservedCheck: rows.every(n => getComputedStyle(n.querySelector('.option-check')).width === '16px'),
            insideBody: m.top >= b.top && m.bottom <= b.bottom,
            aboveFade: Boolean(fade && Number(getComputedStyle(menu).zIndex) > Number(getComputedStyle(fade).zIndex)) };
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
          record(context, `${menu.name}: open menu above fade`, menu.aboveFade, true);
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
  // Content growth/shrink must update the cue while the viewport stays fixed.
  const context = { width: 1440, height: 900, theme: 'light', locale: 'de', state: 'resize-observer' };
  await page.evaluate(async () => { await window.ait350.reset('de'); window.ait350.q('[data-panel=model]').style.minHeight = '1200px'; });
  await settle();
  record(context, 'content growth shows fade', await page.evaluate(() => Number(getComputedStyle(window.ait350.q('.settings__fade') ?? window.ait350.q('.settings__body')).opacity)), 1);
  await page.evaluate(() => { window.ait350.q('[data-panel=model]').style.removeProperty('min-height'); }); await settle();
  record(context, 'content shrink hides fade', await page.evaluate(() => Number(getComputedStyle(window.ait350.q('.settings__fade') ?? window.ait350.q('.settings__body')).opacity)), 0);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]); await settle();
  const duration = await page.evaluate(() => parseFloat(getComputedStyle(window.ait350.q('.settings__fade') ?? window.ait350.q('.settings__body')).transitionDuration));
  record(context, 'opacity transition <=120ms', duration <= .12, true);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (evidence) await writeFile(join(evidence, 'ait362-checks.json'), JSON.stringify({ ticket: 'AIT-362', capture: 'viewport', motion: 'reduced and settled',
    blurredBeforeCapture: true, fontStack: 'unchanged host Chrome baseline', checks, ait350: regression, failures }, null, 2));
  assert.deepEqual(failures, [], 'AIT-362 Tick spec v1');
}
