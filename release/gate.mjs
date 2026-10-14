import { readFileSync } from 'node:fs';
import { assertReleaseTag, migrationGate } from './lib/version.mjs';
const source = JSON.parse(readFileSync(new URL('./version.json', import.meta.url)));
const [command, input] = process.argv.slice(2);
if (command === 'tag') assertReleaseTag(input, source);
else if (command === 'qualification') {
  const evidence = input ? JSON.parse(readFileSync(input)) : {};
  const gate = migrationGate(source, evidence); console.log(JSON.stringify(gate));
  if (!gate.authoritative) process.exitCode = 1;
} else throw new Error('Usage: node release/gate.mjs tag refs/tags/vVERSION | qualification [evidence.json]');
