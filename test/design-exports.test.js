import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from '../contracts/validate.js';
import { exportDesign, renderScreen } from '../runtime/design/index.js';
import { verifyLicenceBoundary } from '../release/lib/licence-boundary.mjs';
import { errorCode, fixtureJson, fixtureText, input, stored } from './fixtures/design/helpers.mjs';

it('(c) HTML export matches golden, inlines exact styles and makes links non-navigable', () => {
  const result = exportDesign(stored());
  const html = result.files['screen.html'];
  assert.equal(html, fixtureText('golden-export.html'));
  assert.equal(result.design_rev, renderScreen(input()).design_rev);
  assert.equal(result.design_input_seq, 7);
  assert.equal((html.match(/<style>/g) ?? []).length, 2);
  for (const { css } of renderScreen(input()).stylesheets) assert.ok(html.includes(`<style>\n${css}</style>`));
  assert.ok(html.includes('<span id="jump" class="link" data-element-ref="jump" data-target-ref="title">Back to title</span>'));
  assert.doesNotMatch(html, /<script\b|<a\b|<link\b|\shref=|\sstyle\s*=|<form\b|<iframe\b|<object\b|<embed\b/i);
  const expected = renderScreen(input()).html
    .replace(/<link rel="stylesheet" href="[^"]+">/g, () => '<style-placeholder>');
  assert.equal(html.replace(/<style>\n[\s\S]*?<\/style>/g, '<style-placeholder>'), expected);
});

it('(c) canonical screens/tokens and inert markdown preserve generated identity', () => {
  const result = exportDesign(stored());
  assert.deepEqual(Object.keys(result.files).sort(), ['screen.html', 'screen.md', 'screens.json', 'tokens.json']);
  const [doc] = JSON.parse(result.files['screens.json']);
  assert.deepEqual(doc, input().screen_ir);
  assert.equal(validate(doc.contract, doc).ok, true);
  const tokenDoc = JSON.parse(result.files['tokens.json']);
  assert.equal(validate(tokenDoc.contract, tokenDoc).ok, true);
  assert.ok(result.files['screen.md'].includes(result.design_rev));
  assert.ok(result.files['screen.md'].includes('&lt;svg onload='));
  assert.doesNotMatch(result.files['screen.md'], /<script\b|<svg\b|\]\(/i);
  assert.deepEqual(exportDesign(stored()), exportDesign(stored()));
});

it('(c) the hostile corpus cannot escape text or the two CSS blocks', () => {
  for (const hostile of fixtureJson('hostile.json').text) {
    const data = input(); data.screen_ir.title = hostile;
    data.screen_ir.nodes = [{ kind: 'text', id: 'title', text: hostile }, { kind: 'link', id: 'link', label: hostile, target: 'title' }];
    const result = exportDesign(stored('a', data));
    const html = result.files['screen.html'];
    assert.doesNotMatch(html, /<script\b|<a\b|<svg\b|<img\b|<link\b|\shref=|\sstyle\s*=/i);
    assert.equal((html.match(/<style>/g) ?? []).length, 2);
    assert.equal((html.match(/<\/style>/g) ?? []).length, 2);
    assert.doesNotMatch(result.files['screen.md'], /<script\b|<svg\b/i);
  }
});

it('(c) export rejects modified input bytes and prohibited token CSS', () => {
  const row = stored(); row.document.data.tokens.color.primary = 'url(x)';
  assert.throws(() => exportDesign(row), errorCode('design_input_invalid'));
  const data = input(); data.tokens.font_family = '</style><script>x</script>';
  assert.throws(() => stored('a', data), errorCode('design_tokens_invalid'));
});

it('(c) export fragments are isolated static files and the licence boundary passes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.ok(verifyLicenceBoundary(root) >= 2);
  const fragments = new URL('../runtime/design/export-fragments/', import.meta.url);
  assert.deepEqual(readdirSync(fragments).sort(), ['LICENSE', 'base-1.css', 'document.html']);
  const css = readFileSync(new URL('base-1.css', fragments), 'utf8');
  assert.doesNotMatch(css, /@import|url\s*\(|<\/style/i);
  const template = readFileSync(new URL('document.html', fragments), 'utf8');
  assert.doesNotMatch(template, /<script\b|\sstyle\s*=|<style\b/i);
  assert.match(readFileSync(new URL('LICENSE', fragments), 'utf8'), /Apache-2\.0 publication requires the rights audit/);
});
