// A file-labelled deadline for fixture latches that have no Puppeteer timeout.
import { appendFileSync } from 'node:fs';
let sequence = 0;
export async function browserStep(label, operation, timeout = 30_000) {
  const id = `step-${++sequence}`, started = Date.now();
  const trace = phase => {
    if (process.env.AITHEMA_BROWSER_TRACE) appendFileSync(process.env.AITHEMA_BROWSER_TRACE,
      JSON.stringify({ epoch: Date.now(), pid: process.pid, id, name: label, phase, ms: Date.now()-started }) + '\n');
  };
  let timer;
  trace('start');
  try {
    const value = await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded ${timeout} ms`)), timeout);
    })]);
    trace('end');
    return value;
  } catch (error) { trace('error'); throw error; }
  finally { clearTimeout(timer); }
}
