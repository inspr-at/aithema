import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createBinding, beginInvocation, operationScope, normalizedError, PluginError, imageInfo, IPTC_DIGITAL_SOURCE } from '@inspr/aithema-core';
import { manifest } from './manifest.js';
import { prepareBrief } from './brief.js';
import { acquireSlot, cliEnvironment, executablePath, runCodex, producedImage } from './process.js';
export { manifest };

function configuration(binding) {
  const config = binding.routing?.codex;
  if (binding.plugin !== manifest.id || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(binding.model) ||
    !manifest.models[0].efforts.includes(binding.effort) || binding.maxMicro !== 0 ||
    binding.rates.inputMicro !== 0 || binding.rates.outputMicro !== 0 ||
    !config || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).some(key => !['binaryPath', 'codexHome', 'timeoutMs'].includes(key)) ||
    typeof config.binaryPath !== 'string' || !config.binaryPath || /[\0\r\n]/u.test(config.binaryPath) ||
    !(isAbsolute(config.binaryPath) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(config.binaryPath)) ||
    typeof config.codexHome !== 'string' || !isAbsolute(config.codexHome) || /[\0\r\n]/u.test(config.codexHome) ||
    !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 1800000) {
    throw new TypeError('Codex imagegen requires a private CLI binding with zero monetary rates');
  }
  return config;
}
function artifactFor(bytes, brief, model, operation) {
  const { mediaType, width, height } = imageInfo(bytes), edited = operation === 'edit';
  return { bytes, mediaType, width, height, promptDigest: `sha256:${createHash('sha256').update(brief).digest('hex')}`,
    provenance: { version: 1, origin: edited ? 'ai-manipulated' : 'ai-generated', modality: 'image',
      digitalSourceType: IPTC_DIGITAL_SOURCE[edited ? 'manipulated' : 'generated'], generatedAt: new Date().toISOString(),
      generator: { provider: 'codex-imagegen', model }, techniques: ['response-field'],
      assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' },
      subject: { contentDigest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, mediaType } } };
}

/** Server-only factory. CLI configuration is read exclusively from the admitted operator binding.
 * spawnImpl is a trusted local-fixture seam, never request/browser configuration. */
export function createCodexImagegen({ binding, spawnImpl } = {}) {
  binding = createBinding(binding);
  const config = configuration(binding);
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
      invocation.usage({ inputTokens: 0, outputTokens: 0 });
      check();
      if (process.platform === 'win32') throw new PluginError('unavailable');
      const { brief, files } = prepareBrief(operation, spec, feedback, source);
      release = await acquireSlot(scope.signal);
      check();
      const binaryPath = await executablePath(config.binaryPath);
      const accountDirectory = await stat(config.codexHome).catch(() => null);
      if (!accountDirectory?.isDirectory()) throw new PluginError('unavailable');
      directory = await mkdtemp(join(tmpdir(), 'aithema-codex-imagegen-'));
      await mkdir(join(directory, 'references'), { mode: 0o700 });
      await mkdir(join(directory, 'output'), { mode: 0o700 });
      for (const file of files) { check(); await writeFile(join(directory, file.path), file.bytes, { mode: 0o600, flag: 'wx' }); }
      const args = ['exec', '-m', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.effort)}`,
        '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral'];
      if (files.length) args.push('-i', ...files.map(file => join(directory, file.path)));
      check(); invocation.dispatch(); dispatched = true;
      await runCodex({ binaryPath, args, directory, env: cliEnvironment(config.codexHome), brief, signal: scope.signal, spawnImpl });
      check();
      const bytes = await producedImage(directory, new Set(files.map(file => file.path)), scope.signal);
      const artifact = artifactFor(bytes, brief, binding.model, operation);
      check(); completed = true; return artifact;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } catch { completed = false; throw new PluginError('unavailable'); }
      finally {
        release?.();
        try { if (invocation) await invocation.finish(completed); } finally { scope.dispose(); }
      }
    }
  }
  return { id: manifest.id, manifest, binding, billable: true, label: 'Codex image generation',
    bind: next => createCodexImagegen({ binding: next, spawnImpl }),
    generate: (spec, feedback, options) => run('generate', spec, feedback, options),
    edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) {
      const scope = operationScope(options);
      try {
        scope.signal.throwIfAborted();
        if (process.platform === 'win32') return { available: false };
        await executablePath(config.binaryPath);
        const available = (await stat(config.codexHome)).isDirectory();
        scope.signal.throwIfAborted();
        return { available };
      } catch (error) {
        if (scope.signal.aborted) throw normalizedError(error, scope.signal);
        return { available: false };
      } finally { scope.dispose(); }
    },
  };
}
