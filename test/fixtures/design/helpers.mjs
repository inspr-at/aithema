import { readFileSync } from 'node:fs';
import { designInputRecord } from '../../../runtime/design/index.js';
import { sid } from '../journal/helpers.mjs';

export const fixtureText = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
export const fixtureJson = (name) => JSON.parse(fixtureText(name));
export const screen = () => fixtureJson('screen.json');
export const tokens = (brand = 'a') => fixtureJson(`tokens-${brand}.json`);
export const generator = () => fixtureJson('generator.json');
export const input = (brand = 'a') => {
  const screen_ir = screen();
  return { screen_ir, tokens: tokens(brand), renderer_version: screen_ir.renderer_version,
    generator_id: screen_ir.generator_id, design_input_seq: 7 };
};
export function submission(brand = 'a', overrides = {}) {
  return designInputRecord({ ...input(brand), sid, generation: 1,
    client_event_id: brand === 'a' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    recorded_at: '2026-09-30T07:00:00Z', ...overrides });
}
export function stored(brand = 'a', overrides = {}) {
  const bytes = submission(brand, overrides);
  return { bytes, document: { ...JSON.parse(bytes), seq: 7 } };
}
export const errorCode = (code) => (error) => error.code === code;
