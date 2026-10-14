import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from './lib/digest.mjs';
export function verifyPresentation(root) {
  const pin = JSON.parse(readFileSync(join(root, 'release/presentation.json'))), dir = join(root, pin.path);
  const bytes = readFileSync(join(dir, 'manifest.json'));
  if (!/^[a-f0-9]{40}$/u.test(pin.revision) || sha256(bytes) !== pin.manifest_sha256) throw new Error('Presentation manifest pin mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.repository !== pin.repository || manifest.revision !== pin.revision || manifest.expectedConfigSha256 !== pin.config_sha256 || manifest.schema !== 'inspr.calver-display.v3') throw new Error('Presentation source pin mismatch');
  const expected = ['manifest.json', ...manifest.files.map(file => file.outputPath)].sort();
  if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify(expected)) throw new Error('Presentation file closure mismatch');
  for (const file of manifest.files) {
    if (!/^[a-z][a-z.-]+$/u.test(file.outputPath)) throw new Error('Invalid presentation path');
    const path = join(dir, file.outputPath), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || sha256(readFileSync(path)) !== file.sha256) throw new Error('Presentation payload mismatch');
  }
  if (sha256(readFileSync(join(dir, 'display.json'))) !== pin.config_sha256) throw new Error('Presentation config pin mismatch');
  // Every regular build rejects an untracked payload as well as byte drift.
  const tracked = execFileSync('git', ['ls-files', '-z', '--', pin.path], { cwd: root }).toString().split('\0').filter(Boolean).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(expected.map(path => `${pin.path}/${path}`).sort())) throw new Error('Presentation payload is untracked');
  return pin;
}
