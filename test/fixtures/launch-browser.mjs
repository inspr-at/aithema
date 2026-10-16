// Minimal CDP executable: deliberately hang on the requested attempts, then
// answer startup commands without starting Chrome or creating a page.
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
const { AIT_LAUNCH_RECORD: record, AIT_LAUNCH_HANGS: hangs, AIT_LAUNCH_ERROR: error } = process.env;
let previous = [];
try { previous = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
// Retry is invalid if the previous process or its profile survived.
if (previous.length) {
  try { process.kill(previous.at(-1).pid, 0); process.exit(42); } catch {}
  if (existsSync(previous.at(-1).profile)) process.exit(43);
}
mkdirSync(profile, { recursive: true });
writeFileSync(`${profile}/startup-marker`, 'created by failed launch');
appendFileSync(record, JSON.stringify({ pid: process.pid, profile, home: process.env.HOME, tmpdir: process.env.TMPDIR, cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME }) + '\n');
if (error) { console.error('deliberate non-timeout launch failure'); process.exit(1); }
if (previous.length < Number(hangs)) {
  if (process.env.AIT_LAUNCH_HANDSHAKE === '1') {
    // Emit a valid endpoint but never complete its HTTP upgrade. An endpoint
    // discovery timeout alone cannot bound this stage of WS startup.
    const server = createServer(); server.on('upgrade', () => {});
    server.listen(0, '127.0.0.1', () => console.error(`DevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/fake`));
  } else setInterval(() => {}, 60_000); // Deliberate startup hang.
} else {
  const respond = (raw, send) => {
    const { id, method } = JSON.parse(raw);
    send(JSON.stringify({ id, result: method === 'Target.getBrowserContexts' ? { browserContextIds: [] } : {} }));
    if (method === 'Browser.close') process.exit(0);
  };
  if (process.argv.includes('--remote-debugging-pipe')) {
    const input = createReadStream('', { fd: 3 }), output = createWriteStream('', { fd: 4 });
    let buffer = '';
    input.on('data', data => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\0')) !== -1) {
        const message = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        respond(message, reply => output.write(reply + '\0'));
      }
    });
  } else {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.on('listening', () => console.error(`DevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/fake`));
    server.on('connection', socket => socket.on('message', data => respond(data.toString(), reply => socket.send(reply))));
  }
}
