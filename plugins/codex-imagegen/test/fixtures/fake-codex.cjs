#!/usr/bin/env node
// Local executable fixture only. It never loads Codex or contacts a provider.
const { readFileSync, writeFileSync, mkdirSync, statSync, symlinkSync, linkSync, truncateSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=';
const WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
async function main() {
  const args = process.argv.slice(2);
  // Non-rendering startup commands never consume stdin, read references or call
  // a provider. The trace seam can simulate older/rejecting/unsafe CLIs.
  if (args.includes('--help')) {
    if (process.env.FAKE_PROBE_MODE === 'rejectflag') process.exit(2);
    if (process.env.FAKE_PROBE_MODE === 'flood') { process.stdout.write('x'.repeat(65537)); return; }
    if (process.env.FAKE_PROBE_MODE === 'hanghelp') { setInterval(() => {}, 1000); return; }
    const help = 'Run Codex non-interactively\n--config --model --image --sandbox --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --strict-config --disable --enable\n';
    process.stdout.write(process.env.FAKE_PROBE_MODE === 'missingflag' ? help.replace('--ignore-user-config', '') : help);
    return;
  }
  if (args[0] === 'features') {
    if (process.env.FAKE_PROBE_MODE === 'rejectfeature') process.exit(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--enable' || args[i] === '--disable') {
        const name = args[++i];
        if (name === 'shell_tool' && process.env.FAKE_PROBE_MODE === 'missingfeature') continue;
        const enabled = args[i - 1] === '--enable' || name === 'unified_exec' ||
          (name === 'shell_tool' && process.env.FAKE_PROBE_MODE === 'unsafeshell');
        process.stdout.write(`${name} stable ${enabled}\n`);
      }
    }
    return;
  }
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk.toString('utf8');
  if (!brief.trim()) process.exit(0); // Reproduce the real CLI's dangerous empty-stdin success.
  const index = args.indexOf('-i');
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
  if (mode === 'crash') { process.kill(process.pid, 'SIGKILL'); return; }
  const output = join(process.cwd(), 'output', 'render.png');
  if (mode === 'bad') { writeFileSync(output, 'not an image'); return; }
  if (mode === 'oversize') { writeFileSync(output, ''); truncateSync(output, 12 * 1024 * 1024 + 1); return; }
  if (mode === 'symlink') {
    const target = join(process.env.FAKE_TRACE_DIR, 'external.png');
    writeFileSync(target, Buffer.from(PNG, 'base64')); symlinkSync(target, output); return;
  }
  if (mode === 'hardlink') {
    const target = join(process.env.FAKE_TRACE_DIR, 'external.png');
    writeFileSync(target, Buffer.from(PNG, 'base64')); linkSync(target, output); return;
  }
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 150));
  const requested = /Requested size: (\d+)x(\d+); quality: \w+; format: (\w+)/u.exec(brief);
  let width = Number(requested[1]), height = Number(requested[2]);
  if (mode === 'wrongsize') { width = 1; height = 1; }
  if (mode === 'dimensioncap') { width = 4097; }
  if (mode === 'tolerance') { width = Math.floor(width * 1.05); height = Math.ceil(height * 0.95); }
  if (mode === 'beyondtolerance') { width = Math.floor(width * 1.05) + 1; }
  // Header fixtures, just like the existing JPEG fixture: imageInfo is not a
  // pixel decoder. Keep real raster bytes unnecessary for these boundary tests.
  let png = Buffer.from(PNG, 'base64'); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  let webp = Buffer.from(WEBP, 'base64'); webp.writeUInt16LE(width, 26); webp.writeUInt16LE(height, 28);
  const credentialChunk = Buffer.from(process.env.FAKE_CREDENTIAL_CHUNK ?? '', 'base64');
  if (credentialChunk.length) {
    if (requested[3] === 'png') png = Buffer.concat([png.subarray(0, -12), credentialChunk, png.subarray(-12)]);
    else { webp = Buffer.concat([webp, credentialChunk]); webp.writeUInt32LE(webp.length - 8, 4); }
  }
  if (mode === 'webp' || (requested[3] === 'webp' && mode !== 'wrongformat')) writeFileSync(join(process.cwd(), 'render.WEBP'), webp);
  else if (mode === 'jpeg') writeFileSync(join(process.cwd(), 'render.JPEG'), Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217,
  ])); // Header fixture: the contract's imageInfo is not a pixel decoder.
  else writeFileSync(output, png);
  if (mode === 'many') {
    mkdirSync(join(process.cwd(), 'nested')); writeFileSync(join(process.cwd(), 'nested', 'extra.jpg'), Buffer.from(PNG, 'base64'));
  }
  if (mode === 'extratext') writeFileSync(join(process.cwd(), 'output', 'notes.txt'), 'extra');
  if (mode === 'extraextensionless') writeFileSync(join(process.cwd(), 'output', 'extra'), png);
  if (mode === 'orphan') process.exit(0);
}
main().catch(() => process.exit(9));
