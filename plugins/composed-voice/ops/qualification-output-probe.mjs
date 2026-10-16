import { resolve, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, userInfo } from 'node:os';

// Output substitutions / alternate service launch paths are forbidden. Sources:
// https://github.com/chromium/chromium/blob/main/media/base/media_switches.cc
// https://github.com/chromium/chromium/blob/main/media/audio/audio_manager_base.cc
// https://github.com/chromium/chromium/blob/main/content/browser/service_host/utility_process_host.cc
// https://github.com/chromium/chromium/blob/main/sandbox/policy/switches.cc
// https://github.com/chromium/chromium/blob/main/content/browser/audio/audio_service.cc
// Generic --no-sandbox does not substitute output. The measured macOS capture
// setup requires disabled AudioServiceSandbox; other AudioService feature or
// service/sandbox/child-executable overrides leave that setup and are refused.
const outputOverrideSwitches = new Set(['mute-audio', 'disable-audio-output', 'fail-audio-stream-creation',
  'alsa-output-device', 'use-cras', 'force-wave-audio', 'utility-cmd-prefix', 'browser-subprocess-path',
  'service-sandbox-type', 'utility-sub-type', 'type']);

export function findRefusedOutputFlags(args) {
  return args.filter(arg => {
    // Chromium base/command_line.cc accepts both Unix switch prefixes.
    const match = /^--?([^=]+)(?:=(.*))?$/u.exec(arg.trim());
    if (!match) return false;
    const [, name, value = ''] = match;
    if (outputOverrideSwitches.has(name) || name.startsWith('audio-service-')) return true;
    return ['enable-features', 'disable-features'].includes(name) && value.split(',').some(feature => {
      const featureName = feature.trim().split(/[<:]/u)[0];
      return featureName.startsWith('AudioService') && !(name === 'disable-features' && featureName === 'AudioServiceSandbox');
    });
  }).map(arg => arg.trim().split('=')[0]);
}

export async function readProcessUid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Local Chrome PID required');
  const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'uid=', '-p', String(pid)], {
    timeout: 5000, maxBuffer: 1024, env: { PATH: process.env.PATH },
  });
  if (!/^\d+$/u.test(stdout.trim())) throw new Error('Chrome UID unavailable');
  const uid = Number(stdout.trim());
  if (!Number.isSafeInteger(uid)) throw new Error('Chrome UID unavailable');
  return uid;
}

/** Read Chrome itself, never requested launch extras or a launcher's spawnargs.
 * Browser.getBrowserCommandLine requires --enable-automation; no fallback.
 * Connected launchers must target this host, under this process's OS user. */
export async function readBrowserEvidence(browser, readUid = readProcessUid) {
  const commandLine = { verified: false, source: 'CDP Browser.getBrowserCommandLine' };
  const browserUser = { verified: false, source: 'ps -o uid= -p <Chrome PID>', probeUid: process.getuid?.() };
  let session;
  try {
    session = await browser.target().createCDPSession();
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string') || !args[0].trim()) throw new Error('Missing command line');
    Object.assign(commandLine, { verified: true, arguments: args });
  } catch { commandLine.failure = 'Actual Chrome command line unavailable or refused'; }
  try {
    let pid = browser.process?.()?.pid;
    browserUser.pidSource = 'browser.process().pid';
    if (pid === undefined) {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const browsers = processInfo.filter(info => info.type === 'browser');
      if (browsers.length !== 1) throw new Error('Unique browser PID required');
      pid = browsers[0].id;
      browserUser.pidSource = 'CDP SystemInfo.getProcessInfo';
    }
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Chrome PID unavailable');
    browserUser.pid = pid;
    const uid = await readUid(pid);
    browserUser.uid = uid;
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(browserUser.probeUid) || uid !== browserUser.probeUid) throw new Error('Chrome user mismatch');
    browserUser.verified = true;
  } catch { browserUser.failure = 'Chrome must run locally as the probe user; UID unavailable or mismatched'; }
  finally { await session?.detach().catch(() => {}); }
  return { commandLine, browserUser };
}

/** Keep only the running user's default output, never the whole OS inventory. */
export function defaultOutputFromProfiler(profile) {
  const defaults = [];
  const visit = items => {
    for (const item of items ?? []) {
      if (item.coreaudio_default_audio_output_device === 'spaudio_yes') defaults.push(item);
      if (Array.isArray(item._items)) visit(item._items);
    }
  };
  visit(profile.SPAudioDataType);
  if (defaults.length !== 1) throw new Error('OS must report exactly one default audio output');
  const device = defaults[0], name = device._name, transport = device.coreaudio_device_transport;
  if (typeof name !== 'string' || !name.trim() || typeof transport !== 'string' || !transport.trim()) throw new Error('OS default audio output name and transport required');
  return { name, transport, builtIn: transport === 'coreaudio_device_type_builtin' };
}

export async function readDefaultOutputDevice() {
  const record = { verified: false, source: 'system_profiler SPAudioDataType -json',
    user: userInfo().username, uid: process.getuid?.(), platform: process.platform, checkedAt: new Date().toISOString() };
  try {
    if (process.platform !== 'darwin') throw new Error('macOS default-output record required');
    const { stdout } = await promisify(execFile)('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], {
      timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: homedir() },
    });
    Object.assign(record, defaultOutputFromProfiler(JSON.parse(stdout)), { verified: true });
  } catch { record.failure = 'OS default audio output unavailable or refused'; }
  return record;
}

export function combineOutputEvidence(rendering, osDefaultOutput, { commandLine, browserUser } = {}) {
  // Chrome's forced fake streams can synthesize positive delay and advancing
  // timestamps. Refuse those explicit overrides independently of the clocks.
  const refusedOutputFlags = findRefusedOutputFlags(commandLine?.arguments ?? []);
  return { ...rendering, osDefaultOutput, commandLine, browserUser, refusedOutputFlags,
    verified: rendering.renderingVerified === true && osDefaultOutput.verified === true &&
      commandLine?.verified === true && browserUser?.verified === true &&
      browserUser.probeUid === osDefaultOutput.uid && refusedOutputFlags.length === 0 };
}

export async function probePhysicalOutput(page, browser) {
  const browserEvidence = await readBrowserEvidence(browser);
  const rendering = await page.evaluate(probeOutputDevice);
  return combineOutputEvidence(rendering, await readDefaultOutputDevice(), browserEvidence);
}

/** Self-contained so Puppeteer can evaluate this exact function in Chrome. */
export async function probeOutputDevice() {
  let context, oscillator;
  const evidence = { renderingVerified: false, labelledAudioOutputs: 0, realAudioOutputs: 0, fakeAudioOutputs: 0,
    realAudioOutputLabels: [], fakeAudioOutputLabels: [], elapsedMs: 0, outputLatency: 0, sinkId: '' };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(device => device.kind === 'audiooutput' && device.label.trim());
    const fakeLabel = label => /^(?:(?:default|communications)(?:\s*[-:–—]\s*|\s+))?fake/iu.test(label.trim());
    const fakeGroups = new Set(outputs.filter(device => fakeLabel(device.label) && device.groupId).map(device => device.groupId));
    const alias = device => ['default', 'communications'].includes(device.deviceId) || /^(?:default|communications)\b/iu.test(device.label.trim());
    const realDevice = outputs.some(device => !alias(device) && !fakeLabel(device.label));
    for (const device of outputs) {
      const fake = fakeLabel(device.label) || alias(device) &&
        (fakeGroups.has(device.groupId) || !realDevice && /^(?:default|communications)$/iu.test(device.label.trim()));
      evidence[fake ? 'fakeAudioOutputLabels' : 'realAudioOutputLabels'].push(device.label);
    }
    evidence.labelledAudioOutputs = outputs.length;
    evidence.realAudioOutputs = evidence.realAudioOutputLabels.length;
    evidence.fakeAudioOutputs = evidence.fakeAudioOutputLabels.length;
  } catch { evidence.enumerationFailure = 'Enumerated labels unavailable'; }
  try {
    context = new AudioContext();
    evidence.sinkId = context.sinkId ?? '';
    oscillator = context.createOscillator();
    const silent = context.createGain(); silent.gain.value = 0;
    oscillator.connect(silent).connect(context.destination); oscillator.start();
    await context.resume();
    const started = performance.now();
    evidence.before = context.getOutputTimestamp();
    await new Promise(resolve => setTimeout(resolve, 550));
    evidence.after = context.getOutputTimestamp();
    evidence.elapsedMs = performance.now() - started;
    evidence.outputLatency = context.outputLatency;
    // Fake capture replaces enumerated outputs as well as inputs. Labels are
    // diagnostics; only the default sink's rendering and the OS record decide.
    evidence.renderingVerified = ['', 'default'].includes(evidence.sinkId) && evidence.elapsedMs >= 500 &&
      Number.isFinite(evidence.outputLatency) && evidence.outputLatency > 0 &&
      ['contextTime', 'performanceTime'].every(key => Number.isFinite(evidence.before[key]) &&
        Number.isFinite(evidence.after[key]) && evidence.after[key] > evidence.before[key]);
  } catch { evidence.failure = 'Output-device APIs unavailable or refused'; }
  finally { oscillator?.stop(); await context?.close().catch(() => {}); }
  return evidence;
}

// Standalone hardware preflight. Optional fake-file capture matches the runner;
// --force-fake-output and --force-missing-output measure refusal controls.
// No host/account module, keys file or provider is involved.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('node:util');
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir, hostname } = await import('node:os');
  const { access, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const { launchLocalBrowser } = await import('./qualification-browser.mjs');
  const { values } = parseArgs({ options: { report: { type: 'string' }, 'executable-path': { type: 'string' },
    'fake-capture-wav': { type: 'string' }, 'force-fake-output': { type: 'boolean', default: false },
    'force-missing-output': { type: 'boolean', default: false } } });
  const executablePath = values['executable-path'] ?? process.env.CHROME_PATH;
  if (!isAbsolute(values.report ?? '') || !isAbsolute(executablePath ?? '')) throw new Error('Absolute --report and --executable-path (or CHROME_PATH) required');
  const wavPath = values['fake-capture-wav'];
  if (wavPath !== undefined) {
    if (!isAbsolute(wavPath)) throw new Error('Absolute --fake-capture-wav required');
    await access(wavPath);
  }
  const args = ['--disable-features=AudioServiceSandbox', '--autoplay-policy=no-user-gesture-required',
    ...(wavPath ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`, '--use-fake-ui-for-media-stream'] : []),
    ...(values['force-fake-output'] ? ['--disable-audio-output'] : []),
    ...(values['force-missing-output'] ? ['--fail-audio-stream-creation'] : [])];
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), 'qualification-output-probe-')), groups = new Set(), controller = new AbortController();
  const timer = setTimeout(() => { for (const group of groups) group.kill(); controller.abort(); }, 30_000);
  const server = createServer((_request, response) => response.end('<!doctype html><title>Output probe</title>'));
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await launchLocalBrowser({ executablePath, headless: true, userDataDir: join(directory, 'chrome'),
      ignoreDefaultArgs: ['--mute-audio'], signal: controller.signal, timeout: 25_000,
      env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR },
      args: [...args] },
    { deadlineAt: Date.now() + 30_000, controllerPid: process.pid, registerProcessGroup(group) { groups.add(group); } });
    await browser.defaultBrowserContext().overridePermissions(origin, ['microphone']);
    const page = await browser.newPage();
    await page.goto(origin);
    const physicalBrowserMedia = await probePhysicalOutput(page, browser);
    const report = { host: hostname(), user: userInfo().username, startedAt, finishedAt: new Date().toISOString(),
      browserVersion: await browser.version(), captureMode: wavPath ? 'fake-file' : 'system',
      captureWavSha256: wavPath ? createHash('sha256').update(await readFile(wavPath)).digest('hex') : null,
      forcedFakeOutput: values['force-fake-output'], forcedMissingOutput: values['force-missing-output'],
      launchArgs: args, physicalBrowserMedia };
    await mkdir(dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(report));
    if (!physicalBrowserMedia.verified) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    for (const group of groups) group.kill();
    await browser?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
}
