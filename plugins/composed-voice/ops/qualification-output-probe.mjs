import { resolve, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Self-contained so Puppeteer can evaluate this exact function in Chrome. */
export async function probeOutputDevice() {
  let context, oscillator;
  const evidence = { verified: false, labelledAudioOutputs: 0, realAudioOutputs: 0, fakeAudioOutputs: 0,
    realAudioOutputLabels: [], fakeAudioOutputLabels: [], elapsedMs: 0, outputLatency: 0 };
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
    context = new AudioContext();
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
    evidence.verified = evidence.realAudioOutputs > 0 && evidence.elapsedMs >= 500 &&
      Number.isFinite(evidence.outputLatency) && evidence.outputLatency > 0 &&
      ['contextTime', 'performanceTime'].every(key => Number.isFinite(evidence.before[key]) &&
        Number.isFinite(evidence.after[key]) && evidence.after[key] > evidence.before[key]);
  } catch { evidence.failure = 'Output-device APIs unavailable or refused'; }
  finally { oscillator?.stop(); await context?.close().catch(() => {}); }
  return evidence;
}

// Standalone hardware preflight, with the same unmuted fake-capture Chrome flags
// as the runner. No host/account module, keys file or provider is involved.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('node:util');
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { homedir, tmpdir, hostname, userInfo } = await import('node:os');
  const { createServer } = await import('node:http');
  const { launchLocalBrowser } = await import('./qualification-browser.mjs');
  const { values } = parseArgs({ options: { report: { type: 'string' }, 'executable-path': { type: 'string' } } });
  const executablePath = values['executable-path'] ?? process.env.CHROME_PATH;
  if (!isAbsolute(values.report ?? '') || !isAbsolute(executablePath ?? '')) throw new Error('Absolute --report and --executable-path (or CHROME_PATH) required');
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
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--disable-features=AudioServiceSandbox', '--autoplay-policy=no-user-gesture-required'] },
    { deadlineAt: Date.now() + 30_000, controllerPid: process.pid, registerProcessGroup(group) { groups.add(group); } });
    await browser.defaultBrowserContext().overridePermissions(origin, ['microphone']);
    const page = await browser.newPage();
    await page.goto(origin);
    const physicalBrowserMedia = await page.evaluate(probeOutputDevice);
    const report = { host: hostname(), user: userInfo().username, physicalBrowserMedia };
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
