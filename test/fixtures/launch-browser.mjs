// Minimal CDP executable: deliberately hang on the requested attempts, then
// answer startup commands without starting Chrome or creating a page.
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
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
appendFileSync(record, JSON.stringify({ pid: process.pid, profile }) + '\n');
if (error) { console.error('deliberate non-timeout launch failure'); process.exit(1); }
if (previous.length < Number(hangs)) {
  setInterval(() => {}, 60_000); // The only deliberate hang in these tests.
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
