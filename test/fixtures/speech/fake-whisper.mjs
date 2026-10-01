import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
const audio = readFileSync(process.argv[process.argv.indexOf('-f') + 1]);
if (audio.toString('ascii', 0, 4) !== 'RIFF') process.exit(2);
if (mode === 'fail') process.exit(2);
if (mode === 'invalid') { process.stdout.write(Buffer.from([0xff])); process.exit(0); }
if (mode === 'overflow') { process.stdout.write('x'.repeat(200000)); }
else process.stdout.write('Synthetische Sprache\n');
if (mode === 'stall') {
  // Descendant shares inference's process group. Parent crash must kill both.
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, descendant: descendant.pid, supervisor: process.ppid,
    audioPath: process.argv[process.argv.indexOf('-f') + 1] }));
  process.on('SIGTERM', () => {}); // prove group SIGKILL, not polite SIGTERM
  setInterval(() => process.stdout.write('Late output must be suppressed\n'), 100);
}
