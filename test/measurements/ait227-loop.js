// Scratch AIT-227 asynchronous lane. Run only through remote-browser.sh.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserPath } from '../../scripts/install-test-browser.js';

const files = ['orb-reveal', 'visitor-credit-tiers', 'html-preview', 'start2-display-geometry', 'start2-display-matrix', 'confirmation-design'].map(name => `test/browser/${name}.test.js`);
const run = resolve(process.cwd(), '..'), output = process.env.AITHEMA_EVIDENCE_DIR;
if (!/\/ci\.noindex\/aithema-runs\/[^/]+$/u.test(run) || !output) throw new Error('AIT-227 requires a remote run and EVIDENCE_OUT');
const deadline = Date.parse('2026-10-16T05:00:00Z'), windowMs = 30 * 60_000;
const started = Date.now(), executablePath = await browserPath(), durations = [];
const stats = join(output, 'stats.jsonl'), live = join(output, 'live.log');
let active, iteration = 0, failed = false, stopping = false;
const log = value => { const line = `${new Date().toISOString()} ${value}\n`; appendFileSync(live, line); console.log(line.trim()); };
const command = (cmd, args) => new Promise(resolve => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
  child.stdout.on('data', data => text += data); child.stderr.on('data', data => text += data);
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.on('close', () => { clearTimeout(timer); resolve(text); });
});
async function capture(reason) {
  const target = active;
  if (!target || target.capturing) return;
  target.capturing = true;
  const prefix = join(output, `iteration-${iteration}-${reason}`);
  const processes = await command('ps', ['-axo', 'pid,ppid,pgid,lstart,etime,command']);
  const all = processes.split('\n').slice(1).map(line => ({ line, fields: line.trim().split(/\s+/u) }));
  const descendants = new Set([String(target.child.pid)]);
  for (;;) {
    const size = descendants.size;
    for (const row of all) if (descendants.has(row.fields[1])) descendants.add(row.fields[0]);
    if (size === descendants.size) break;
  }
  const rows = all.filter(row => descendants.has(row.fields[0])).map(row => row.line);
  target.browserGroups = [...new Set(all.filter(row => descendants.has(row.fields[0]) && /chrome-headless-shell/u.test(row.line)).map(row => Number(row.fields[2])))];
  writeFileSync(prefix + '-ps.txt', [processes.split('\n')[0], ...rows].join('\n'));
  for (const row of rows) {
    const pid = row.trim().split(/\s+/u)[0];
    const open = await command('lsof', ['-nP', '-p', pid]);
    writeFileSync(prefix + `-lsof-${pid}.txt`, open.split('\n').filter(line => line.includes(run) || /Library\/(Caches|Keychains)|var\/folders|Singleton|LOCK/u.test(line)).join('\n'));
  }
  writeFileSync(prefix + '-jetsam.txt', await command('log', ['show', '--style', 'compact', '--predicate', 'eventMessage CONTAINS "jetsam"', '--last', '2h']));
  log(`CAPTURE reason=${reason} pid=${target.child.pid} start=${new Date(target.start).toISOString()} age_s=${Math.round((Date.now()-target.start)/1000)} trace=${target.trace}`);
}
function kill() {
  if (!active) return;
  const target = active;
  try { process.kill(-target.child.pid, 'SIGTERM'); } catch {}
  // Puppeteer launches Chrome in separate groups. Preserve those group IDs
  // before killing Node, otherwise Chrome can be reparented out of the tree.
  for (const group of target.browserGroups ?? []) try { process.kill(-group, 'SIGTERM'); } catch {}
  setTimeout(() => {
    for (const group of [target.child.pid, ...(target.browserGroups ?? [])]) try { process.kill(-group, 'SIGKILL'); } catch {}
  }, 3000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { stopping = true; await capture(signal); kill(); });
const windowStop = setTimeout(() => { kill(); process.exit(1); }, Math.max(1, deadline-Date.now())); windowStop.unref();
const monitor = setInterval(async () => {
  if (!active) return;
  const age = (Date.now() - active.start)/1000;
  log(`OLDEST pid=${active.child.pid} iteration=${iteration} age_s=${Math.round(age)} trace=${active.trace}`);
  const median = durations.length ? [...durations].sort((a,b)=>a-b)[Math.floor(durations.length/2)] : 260;
  if (age > 3 * median && !active.capturing) await capture('stall');
  // Some file-level test deadlines are shorter than 3x the complete iteration.
  // Capture a quiet protocol/latch step before that teardown removes Chrome.
  try {
    const last = JSON.parse(readFileSync(active.trace, 'utf8').trim().split('\n').at(-1));
    if (Date.now()-last.epoch > 15_000 && !active.capturing) await capture('quiet-step');
  } catch { /* Trace may not exist before the first browser starts. */ }
  if (age >= 840 || Date.now() >= deadline || stopping) { stopping ||= Date.now() >= deadline; await capture('timeout'); kill(); }
}, 10_000);
try {
  while (!stopping && Date.now() - started < windowMs && Date.now() < deadline - 30_000) {
    iteration++;
    const directory = join(run, `iteration-${iteration}`), evidence = join(output, `iteration-${iteration}`), trace = join(evidence, 'trace.jsonl');
    mkdirSync(join(directory, 'home'), { recursive: true }); mkdirSync(join(directory, 'tmp'), { recursive: true }); mkdirSync(evidence, { recursive: true });
    // Only value-free settings enter the test environment. Resolve the shared
    // read-only executable before switching HOME; never copy a user's HOME.
    const childEnv = { PATH: process.env.PATH, HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), CHROME_PATH: executablePath, AITHEMA_BROWSER_TRACE: trace };
    const start = Date.now(), logFile = join(evidence, 'tests.tap');
    let text = '';
    const child = spawn(process.execPath, ['--import', './test/measurements/ait227-trace.js', '--test', '--test-reporter=tap', '--test-concurrency=1', ...files], { env: childEnv, detached: true, stdio: ['ignore','pipe','pipe'] });
    active = { child, start, trace };
    const hardStop = setTimeout(() => {
      kill();
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, Math.min(890_000, deadline-Date.now()-5000));
    child.stdout.on('data', data => { text += data; appendFileSync(logFile, data); });
    child.stderr.on('data', data => { text += data; appendFileSync(logFile, data); });
    const result = await new Promise(resolve => { child.on('error', error => resolve({code:1,error:String(error)})); child.on('close', (code,signal) => resolve({code,signal})); });
    clearTimeout(hardStop);
    const duration = (Date.now()-start)/1000, tests = Number(/^# tests (\d+)/mu.exec(text)?.[1] ?? 0);
    const failureLines = text.split('\n').filter(line => /not ok|error:|failureType:|location:|Error:|testCodeFailure|hookFailed|testTimeoutFailure/u.test(line));
    const record = { epoch: Math.floor(Date.now()/1000), start: Math.floor(start/1000), duration, exit: result.code, signal: result.signal, tests, pid: child.pid, iteration, failingFiles: [...new Set(failureLines.filter(line=>/test\/browser/u.test(line)))], failureLines };
    appendFileSync(stats, JSON.stringify(record)+'\n'); log(JSON.stringify(record));
    active = undefined;
    if (result.code !== 0 || tests === 0) {
      failed = true;
      // remote-browser.sh deletes run on exit: preserve it through EVIDENCE_OUT.
      await cp(run, join(output, `failed-run-${iteration}`), { recursive: true, filter: path => !path.includes('/node_modules') });
      break;
    }
    durations.push(duration);
  }
} finally { clearInterval(monitor); }
process.exitCode = failed ? 1 : 0;
