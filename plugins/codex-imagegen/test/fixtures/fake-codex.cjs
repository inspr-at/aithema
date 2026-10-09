#!/usr/bin/env node
// Local executable fixture only. It never loads Codex or contacts a provider.
const { readFileSync, writeFileSync, mkdirSync, statSync, symlinkSync, truncateSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=';
const WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
async function main() {
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk.toString('utf8');
  if (!brief.trim()) process.exit(0); // Reproduce the real CLI's dangerous empty-stdin success.
  const args = process.argv.slice(2), index = args.indexOf('-i');
  const references = index < 0 ? [] : args.slice(index + 1).map(path => ({ path,
    bytes: readFileSync(path).toString('base64'), mode: statSync(path).mode & 0o777 }));
  const mode = /fixture-mode:(\w+)/u.exec(brief)?.[1] ?? 'success';
  const record = { pid: process.pid, args, brief, cwd: process.cwd(), mode: statSync(process.cwd()).mode & 0o777,
    codexHome: process.env.CODEX_HOME, references };
  if (['ignoreterm', 'descendant', 'orphan'].includes(mode)) process.on('SIGTERM', () => {});
  if (['descendant', 'orphan'].includes(mode)) {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore' });
    record.descendantPid = child.pid;
    // Keep the leader from waiting on this handle after the orphan-mode explicit exit.
    child.unref();
  }
  mkdirSync(process.env.FAKE_TRACE_DIR, { recursive: true });
  writeFileSync(join(process.env.FAKE_TRACE_DIR, `${process.pid}.json`), JSON.stringify(record));
  if (['hang', 'ignoreterm', 'descendant'].includes(mode)) { setInterval(() => {}, 1000); return; }
  if (mode === 'none') return;
  if (mode === 'nonzero') { process.stderr.write('private-provider-detail'); process.exit(7); }
  const output = join(process.cwd(), 'output', 'render.png');
  if (mode === 'bad') { writeFileSync(output, 'not an image'); return; }
  if (mode === 'oversize') { writeFileSync(output, ''); truncateSync(output, 12 * 1024 * 1024 + 1); return; }
  if (mode === 'symlink') {
    const target = join(process.env.FAKE_TRACE_DIR, 'external.png');
    writeFileSync(target, Buffer.from(PNG, 'base64')); symlinkSync(target, output); return;
  }
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 150));
  if (mode === 'webp') writeFileSync(join(process.cwd(), 'render.WEBP'), Buffer.from(WEBP, 'base64'));
  else if (mode === 'jpeg') writeFileSync(join(process.cwd(), 'render.JPEG'), Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217,
  ])); // Header fixture: the contract's imageInfo is not a pixel decoder.
  else writeFileSync(output, Buffer.from(PNG, 'base64'));
  if (mode === 'many') {
    mkdirSync(join(process.cwd(), 'nested')); writeFileSync(join(process.cwd(), 'nested', 'extra.jpg'), Buffer.from(PNG, 'base64'));
  }
  if (mode === 'orphan') process.exit(0);
}
main().catch(() => process.exit(9));
