import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
test('every consumer-guide import resolves through a real package export', async () => {
  const guide = readFileSync(new URL('../docs/embedding.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```js\n([\s\S]*?)```/gu)]; assert.ok(examples.length >= 3);
  let imports = 0;
  for (const [, example] of examples) {
    for (const match of example.matchAll(/import\s+(?:\{([^}]+)\}\s+from\s+)?['"]([^'"]+)['"]/gu)) {
      const module = await import(match[2]); imports++;
      for (const field of (match[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const symbol = field.split(/\s+as\s+/u)[0]; assert.ok(Object.hasOwn(module, symbol), `${match[2]} exports ${symbol}`);
      }
    }
  }
  assert.ok(imports >= 5); await window.happyDOM.close();
});
