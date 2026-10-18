import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsStyles } from '../packages/ui/src/settings-styles.js';
import { comparePhoneConsentBase } from './consent-base-comparison.js';

function fixture(css = settingsStyles) {
  const style = { textContent: css }, measured = [];
  const component = { shadowRoot: {
    querySelector(selector) { assert.equal(selector, 'style'); return style; },
    querySelectorAll() {
      measured.push(style.textContent);
      return [{ getBoundingClientRect: () => ({ x: 0, y: 0, width: 390, height: 40 }) }];
    },
  } };
  return { style, measured, component };
}

test('AIT-359: phone base comparison removes exactly the wide footer block and restores styles', () => {
  const { component, style, measured } = fixture();
  const result = comparePhoneConsentBase(component);
  const start = settingsStyles.indexOf('/* AIT-327: wide footer start */');
  const end = settingsStyles.indexOf('/* AIT-327: wide footer end */') + '/* AIT-327: wide footer end */'.length;
  assert.equal(measured[0], settingsStyles.slice(0, start) + settingsStyles.slice(end));
  assert.equal(measured.at(-1), settingsStyles);
  assert.equal(style.textContent, settingsStyles);
  assert.deepEqual(result.current, result.base);
});

for (const [label, css] of [
  ['renamed comments', settingsStyles.replaceAll('AIT-327: wide footer', 'renamed: wide footer')],
  ['missing end', settingsStyles.replace('/* AIT-327: wide footer end */', '/* renamed end */')],
  ['duplicate block', settingsStyles + settingsStyles],
  ['duplicate start', settingsStyles.replace('/* AIT-327: wide footer start */', '/* AIT-327: wide footer start */'.repeat(2))],
  ['duplicate end', settingsStyles.replace('/* AIT-327: wide footer end */', '/* AIT-327: wide footer end */'.repeat(2))],
]) test(`AIT-359: phone base comparison rejects ${label}`, () => {
  const { component, style, measured } = fixture(css);
  assert.throws(() => comparePhoneConsentBase(component), /Expected exactly one AIT-327 wide footer block/u);
  assert.equal(style.textContent, css, 'invalid baseline leaves styles untouched');
  assert.equal(measured.length, 0, 'invalid baseline is never measured');
});
