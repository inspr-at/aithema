import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createBinding, beginInvocation, operationScope, normalizedError, PluginError, imageInfo, imageCredentials, IPTC_DIGITAL_SOURCE } from '@inspr/aithema-core';
import { manifest } from './manifest.js';
import { prepareBrief } from './brief.js';
import { acquireSlot, cliEnvironment, executablePath, runCodex, producedImage } from './process.js';
import { codexArgs, checkCLI, validateCodexHome } from './cli.js';
export { manifest };

function configuration(binding) {
  const config = binding.routing?.codex;
  if (binding.plugin !== manifest.id || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(binding.model) ||
    !manifest.models[0].efforts.includes(binding.effort) || binding.maxMicro !== 0 ||
    binding.rates.inputMicro !== 0 || binding.rates.outputMicro !== 0 ||
    !config || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).some(key => !['binaryPath', 'codexHome', 'timeoutMs', 'trustedPromptsOnly'].includes(key)) ||
    config.trustedPromptsOnly !== true ||
    typeof config.binaryPath !== 'string' || !config.binaryPath || /[\0\r\n]/u.test(config.binaryPath) ||
    !(isAbsolute(config.binaryPath) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(config.binaryPath)) ||
    typeof config.codexHome !== 'string' || !isAbsolute(config.codexHome) || /[\0\r\n]/u.test(config.codexHome) ||
    !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 1800000) {
    throw new TypeError('Codex imagegen requires a private CLI binding with zero monetary rates and trustedPromptsOnly === true');
  }
  return config;
}
function artifactFor(bytes, brief, model, operation, spec) {
  const { mediaType, width, height } = imageInfo(bytes), edited = operation === 'edit';
  const [requestedWidth, requestedHeight] = (spec.size ?? '1536x1024').split('x').map(Number);
  // Header-derived dimensions have a 5% per-axis tolerance, never above 4096.
  if (width > 4096 || height > 4096) throw new PluginError('limit');
  if (mediaType !== `image/${spec.format ?? 'png'}` ||
    Math.abs(width - requestedWidth) > requestedWidth * 0.05 ||
    Math.abs(height - requestedHeight) > requestedHeight * 0.05) throw new PluginError('invalid-output');
  const promptDigest = `sha256:${createHash('sha256').update(brief).digest('hex')}`;
  return { bytes, mediaType, width, height, promptDigest,
    provenance: { version: 1, origin: edited ? 'ai-manipulated' : 'ai-generated', modality: 'image',
      digitalSourceType: IPTC_DIGITAL_SOURCE[edited ? 'manipulated' : 'generated'], generatedAt: new Date().toISOString(),
      generator: { provider: 'codex-imagegen', model }, promptDigest, techniques: ['response-field', 'sidecar'],
      credentials: imageCredentials(bytes),
      assurances: { digitallySigned: false, imperceptibleWatermark: 'unknown', watermarkSource: null },
      subject: { contentDigest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, mediaType } } };
}

/** Server-only factory. CLI configuration is read exclusively from the admitted operator binding.
 * spawnImpl is a trusted local-fixture seam, never request/browser configuration. */
export function createCodexImagegen({ binding, spawnImpl } = {}) {
  binding = createBinding(binding);
  const config = configuration(binding);
  let checkedBinary;
  async function startup(binaryPath, directory, signal) {
    const info = await stat(binaryPath);
    const signature = `${binaryPath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (checkedBinary === signature) return;
    const probeHome = await mkdtemp(join(directory, 'cli-startup-'));
    try {
      // Help/features need no auth. Use an empty temporary home so probing can
      // neither load account config nor create helpers/caches in its auth home.
      await checkCLI({ binding, binaryPath, directory, env: cliEnvironment(probeHome, directory), signal, spawnImpl });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PluginError('unavailable');
    } finally { await rm(probeHome, { recursive: true, force: true }); }
    checkedBinary = signature;
  }
  async function run(operation, spec, feedback, options, source) {
    const started = performance.now(), deadlineAt = Math.min(options?.deadlineAt ?? Infinity, Date.now() + config.timeoutMs);
    const scope = operationScope({ signal: options?.signal, deadlineAt });
    let invocation, directory, release, completed = false, dispatched = false;
    const check = () => { scope.signal.throwIfAborted(); if (Date.now() >= deadlineAt) throw new PluginError('deadline'); };
    try {
      if (typeof options?.report !== 'function') throw new PluginError('not-admitted');
      // Settlement waits for group reaping and filesystem cleanup, rather than the abort event.
      invocation = await beginInvocation({ ...options, signal: undefined, report: terminal => options.report(dispatched ?
        { ...terminal, chargedMicro: 0, durationMs: Math.max(0, Math.round(performance.now() - started)) } : terminal) });
      check();
      if (process.platform === 'win32') throw new PluginError('unavailable');
      const { brief, files } = prepareBrief(operation, spec, feedback, source);
      release = await acquireSlot(scope.signal);
      check();
      const binaryPath = await executablePath(config.binaryPath);
      await validateCodexHome(config.codexHome).catch(() => { throw new PluginError('unavailable'); });
      directory = await mkdtemp(join(tmpdir(), 'aithema-codex-imagegen-'));
      await mkdir(join(directory, 'references'), { mode: 0o700 });
      await mkdir(join(directory, 'output'), { mode: 0o700 });
      for (const file of files) { check(); await writeFile(join(directory, file.path), file.bytes, { mode: 0o600, flag: 'wx' }); }
      await startup(binaryPath, directory, scope.signal);
      await validateCodexHome(config.codexHome).catch(() => { throw new PluginError('unavailable'); });
      const args = codexArgs(binding);
      if (files.length) args.push('-i', ...files.map(file => join(directory, file.path)));
      check();
      await runCodex({ binaryPath, args, directory, env: cliEnvironment(config.codexHome, directory), brief,
        signal: scope.signal, spawnImpl, onSpawn: () => { invocation.dispatch(); dispatched = true; } });
      check();
      const bytes = await producedImage(directory, new Set(files.map(file => file.path)), scope.signal);
      const artifact = artifactFor(bytes, brief, binding.model, operation, spec);
      check(); completed = true; return artifact;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally {
      try {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } catch { completed = false; throw new PluginError('unavailable'); }
        // A deadline/cancellation during cleanup is still a dispatched failure.
        if (completed) {
          try { check(); }
          catch (error) { completed = false; throw normalizedError(error, scope.signal); }
        }
      }
      finally {
        release?.();
        try {
          if (completed) invocation.usage({ inputTokens: 0, outputTokens: 0 });
          if (invocation) await invocation.finish(completed);
        } finally { scope.dispose(); }
      }
    }
  }
  return { id: manifest.id, manifest, binding, billable: true, label: 'Codex image generation',
    bind: next => createCodexImagegen({ binding: next, spawnImpl }),
    generate: (spec, feedback, options) => run('generate', spec, feedback, options),
    edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) {
      const scope = operationScope(options);
      let directory, release;
      try {
        scope.signal.throwIfAborted();
        if (process.platform === 'win32') return { available: false };
        const binaryPath = await executablePath(config.binaryPath);
        await validateCodexHome(config.codexHome);
        release = await acquireSlot(scope.signal);
        directory = await mkdtemp(join(tmpdir(), 'aithema-codex-imagegen-'));
        await startup(binaryPath, directory, scope.signal);
        scope.signal.throwIfAborted();
        return { available: true };
      } catch (error) {
        if (scope.signal.aborted) throw normalizedError(error, scope.signal);
        return { available: false };
      } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        finally { release?.(); scope.dispose(); }
      }
    },
  };
}
