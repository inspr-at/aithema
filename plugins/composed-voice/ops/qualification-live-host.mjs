import { fork } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackOrigin } from './qualification-server.mjs';
import { validateQualificationBinding } from './qualification-live-server.mjs';
import { createQualificationHost as browserTemplate } from './qualification-host-template.mjs';

/** Same-host/same-user launcher. Forwards paths only; never opens the keys or
 * control file. Child environment is explicit, without ambient provider keys,
 * agent-host modules, Node preload hooks or production provider initialization. */
export async function launchQualificationHost({ binding: raw, hostOrigin, keysFile, controlFile, runDirectory,
  locale = 'de', consentDecision, forkImpl = fork, fetchImpl = globalThis.fetch } = {}) {
  const binding = validateQualificationBinding(raw), origin = new URL(loopbackOrigin(hostOrigin));
  if (origin.protocol !== 'http:' || !origin.port || ![keysFile, controlFile].every(value => isAbsolute(value ?? '')) ||
    !['en', 'de'].includes(locale) || !consentDecision || typeof consentDecision.contract !== 'string' ||
    !Array.isArray(consentDecision.items) || !['voice-elevenlabs', 'models-international'].every(id => consentDecision.items.includes(id))) {
    throw new TypeError('Explicit loopback port, file paths and operator consent decision required');
  }
  runDirectory ??= join(homedir(), 'ci.noindex', 'aithema-runs');
  if (!isAbsolute(runDirectory)) throw new TypeError('Absolute runDirectory required');
  await mkdir(runDirectory, { recursive: true });
  const directory = await mkdtemp(join(runDirectory, 'qualification-host-'));
  const bindingFile = join(directory, 'binding.json');
  await writeFile(bindingFile, JSON.stringify(binding), { mode: 0o600, flag: 'wx' });
  let child, closing;
  const close = () => closing ??= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
      try { await exit; } finally { clearTimeout(timer); }
    }
    // Only the generated non-secret binding is ephemeral; retain DB/evidence.
    await rm(bindingFile, { force: true });
  })();
  try {
    child = forkImpl(fileURLToPath(new URL('../../../demo/server.js', import.meta.url)), [], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), silent: true, execArgv: [],
      env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
        AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_LISTEN_HOST: origin.hostname === '[::1]' ? '::1' : origin.hostname,
        PORT: origin.port, AITHEMA_PUBLIC_ORIGIN: hostOrigin, AITHEMA_COMPOSED_RELAY_ORIGIN: hostOrigin,
        AITHEMA_COMPOSED_QUALIFICATION_MODULE: fileURLToPath(new URL('./qualification-live-server.mjs', import.meta.url)),
        AITHEMA_COMPOSED_BINDING_FILE: bindingFile, AITHEMA_COMPOSED_KEYS_FILE: keysFile, AITHEMA_COMPOSED_CONTROL_FILE: controlFile,
        AITHEMA_DB: join(directory, 'session.sqlite'), AITHEMA_ADMIN_SOCKET: join(directory, 'admin.sock'),
        AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
      },
    });
    // Never copy server stdout/stderr into evidence; startup errors remain value-free.
    child.stdout?.resume(); child.stderr?.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Qualification host startup timeout')), 30_000);
      const finish = error => { clearTimeout(timer); child.off('message', message); child.off('error', failed); child.off('exit', exited); error ? reject(error) : resolve(); };
      const message = value => { if (value?.url) finish(new URL(value.url).port === origin.port ? undefined : new Error('Qualification host origin mismatch')); };
      const failed = () => finish(new Error('Qualification host startup failed'));
      const exited = () => finish(new Error('Qualification host exited during startup'));
      child.on('message', message); child.once('error', failed); child.once('exit', exited);
    });
    const post = async (path, body, headers = {}) => {
      const response = await fetchImpl(`${hostOrigin}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { ...headers, origin: hostOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Qualification visitor setup refused');
      return response;
    };
    // Normal visitor API issues the owner cookie; no synthetic owner authority.
    const created = await post('/api/sessions', { locale }), session = await created.json();
    const cookie = created.headers.get('set-cookie')?.split(';')[0];
    if (!/^aithema-visitor=[a-zA-Z0-9_-]{1,128}$/u.test(cookie ?? '') || !session.id) throw new Error('Qualification visitor owner setup refused');
    const ownerHeaders = { cookie };
    const documentResponse = await fetchImpl(`${hostOrigin}/api/sessions/${session.id}/consent`, {
      redirect: 'error', signal: AbortSignal.timeout(15_000), headers: ownerHeaders });
    if (!documentResponse.ok || (await documentResponse.json()).contract !== consentDecision.contract) throw new Error('Qualification consent contract changed');
    await post(`/api/sessions/${session.id}/consent`, { granted: true, processing: consentDecision }, ownerHeaders);
    return { hostOrigin, sessionId: session.id, ownerHeaders, close };
  } catch { await close(); throw new Error('Qualification host setup refused; inspect server state privately'); }
}

/** OPS supplies its accounting ports, binding, explicit consent decision and
 * physical Chrome path. This wrapper owns the launched host's shutdown. */
export async function createQualificationHost(options = {}) {
  // Validate accounting before starting a process or opening any file.
  for (const port of ['verifyCeiling', 'verifyReceipt', 'reconcile']) if (typeof options[port] !== 'function') throw new TypeError(`OPS ${port} port required`);
  const host = await launchQualificationHost(options);
  let browser;
  try { browser = browserTemplate({ ...options, ...host }); }
  catch (error) { await host.close(); throw error; }
  return { ...browser, async close() { try { await browser.close(); } finally { await host.close(); } } };
}
