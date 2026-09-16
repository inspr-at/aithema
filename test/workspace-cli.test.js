import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { trashTemp } from './fixtures/packaging-support.mjs';
import { createWorkspaceServer } from '../workspace/index.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = join(repoRoot, 'bin', 'aithema-workspace.js');

function testConfig(dataDir) {
  return {
    mode: 'test',
    listenHost: '127.0.0.1',
    listenPort: 0,
    dataDir,
    publicBasePath: '/aithema',
    defaultProvider: 'mock',
    identity: {
      kind: 'demo',
      demoHmacSecret: 'fixed-test-only-key',
      defaultSubject: 'runner-test',
      memberships: [{
        subject: 'runner-test',
        party_ref: 'party:runner-test',
        actor_kind: 'human',
        roles: ['requirements_approver'],
        projects: [],
      }],
    },
    providers: { mock: { kind: 'mock' } },
  };
}

function protectedSpeechConfig(dataDir, speech = undefined) {
  const config = testConfig(dataDir);
  config.providers.local = {
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'protected-provider-fixture-key',
    modelId: 'chat-fixture',
    allowedModels: ['chat-fixture'],
    executionLocation: 'local',
    allowedDataClasses: ['unclassified'],
  };
  if (speech !== undefined) config.speech = speech;
  return config;
}

function validPublicSpeechConfig() {
  return {
    kind: 'openai-compatible-transcription',
    providerId: 'local',
    model: 'speech-fixture',
    allowedModels: ['speech-fixture'],
    endpoint: 'http://127.0.0.1:9/v1/audio/transcriptions',
    acceptedMediaTypes: ['audio/webm', 'audio/mp4'],
    limits: { maxAudioBytes: 1024, maxRequestBytes: 2048, maxDurationMs: 1000 },
  };
}

function launch(configPath, gracePeriodMs = 200, speechConfigPath = null) {
  const args = [
    '--config', configPath,
    '--shutdown-grace-ms', String(gracePeriodMs),
  ];
  if (speechConfigPath) args.push('--speech-config', speechConfigPath);
  const child = spawn(executable, args, {
    cwd: '/tmp',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    output: () => ({ stdout, stderr }),
    async waitFor(pattern, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = stdout.match(pattern);
        if (match) return match;
        if (child.exitCode !== null) {
          throw new Error(`workspace exited before expected output: ${stderr || stdout}`);
        }
        await delay(10);
      }
      throw new Error(`timed out waiting for workspace output: ${stderr || stdout}`);
    },
    async waitForExit(timeoutMs = 5_000) {
      if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
      return Promise.race([
        once(child, 'exit').then(([code, signal]) => ({ code, signal })),
        delay(timeoutMs, undefined, { ref: false }).then(() => { throw new Error('workspace child did not exit'); }),
      ]);
    },
  };
}

async function holdRequest(url) {
  const parsed = new URL(url);
  const socket = connect({ host: parsed.hostname, port: Number(parsed.port) });
  await once(socket, 'connect');
  socket.write([
    'POST /aithema/session/demo HTTP/1.1',
    `Host: ${parsed.host}`,
    'Content-Type: application/x-www-form-urlencoded',
    'Content-Length: 100',
    'Connection: keep-alive',
    '',
    'x',
  ].join('\r\n'));
  await delay(25);
  return socket;
}

describe('AIT-22 supported workspace executable', () => {
  it('requires a readable, valid, explicit config without echoing sensitive input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-pack-cli-invalid-'));
    const malformed = join(dir, 'malformed-secret-marker.json');
    const invalid = join(dir, 'invalid.json');
    try {
      writeFileSync(malformed, '{"token":"config-body-secret-marker"', 'utf8');
      writeFileSync(invalid, JSON.stringify({
        mode: 'production',
        dataDir: join(dir, 'data'),
        identity: { kind: 'jwt-jwks', jwks_uri: 'https://user:password@identity.example.invalid/jwks' },
        token: 'config-body-secret-marker',
      }), 'utf8');

      for (const args of [
        [],
        ['--config', join(dir, 'unreadable-credential-marker.json')],
        ['--config', malformed],
        ['--config', invalid],
      ]) {
        const result = spawnSync(executable, args, { cwd: '/tmp', encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.doesNotMatch(output, /config-body-secret-marker|user:password|credential-marker/);
        assert.doesNotMatch(output, /\{"token"/);
      }
    } finally {
      trashTemp(dir);
    }
  });

  it('serves readiness only at the configured mount and shuts down cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-pack-cli-health-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify(testConfig(join(dir, 'data')))}\n`, 'utf8');
    const running = launch(configPath);
    try {
      const match = await running.waitFor(/listening at (http:\/\/\S+)/);
      const mountedUrl = match[1];
      const health = await fetch(`${mountedUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, ready: true });
      const unprefixed = await fetch(`${new URL(mountedUrl).origin}/health`);
      assert.equal(unprefixed.status, 404);
      assert.match(running.output().stdout, /provider and identity reachability are not checked/);
      running.child.kill('SIGTERM');
      const exited = await running.waitForExit();
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      if (running.child.exitCode === null) running.child.kill('SIGKILL');
      trashTemp(dir);
    }
  });

  it('accepts only a public speech sidecar and inherits the protected registry provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-pack-cli-speech-'));
    const configPath = join(dir, 'config.json');
    const speechPath = join(dir, 'speech.json');
    const config = protectedSpeechConfig(join(dir, 'data'));
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, 'utf8');
    writeFileSync(speechPath, `${JSON.stringify(validPublicSpeechConfig())}\n`, 'utf8');
    const running = launch(configPath, 200, speechPath);
    try {
      const match = await running.waitFor(/listening at (http:\/\/\S+)/);
      const health = await fetch(`${match[1]}/health`);
      assert.deepEqual(await health.json(), { ok: true, ready: true });
      const mounted = new URL(match[1]);
      const session = await fetch(`${mounted.origin}${mounted.pathname}/session/demo`, {
        method: 'POST',
        headers: {
          origin: mounted.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ subject: 'runner-test' }),
        redirect: 'manual',
      });
      const cookie = (session.headers.getSetCookie?.() ?? []).find((item) => item.startsWith('aithema_demo='))?.split(';')[0];
      assert.equal(session.status, 303);
      assert.ok(cookie);
      const project = await fetch(`${mounted.origin}${mounted.pathname}/projects`, {
        method: 'POST',
        headers: {
          cookie,
          origin: mounted.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ title: 'Speech sidecar project', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(project.status, 303);
      const page = await (await fetch(new URL(project.headers.get('location'), mounted.origin), {
        headers: { cookie },
      })).text();
      assert.match(page, /id="workspace-speech"/);
      assert.match(page, /speech-fixture/);
      running.child.kill('SIGTERM');
      assert.deepEqual(await running.waitForExit(), { code: 0, signal: null });
    } finally {
      if (running.child.exitCode === null) running.child.kill('SIGKILL');
      trashTemp(dir);
    }
  });

  it('rejects malformed, secret-bearing, unknown, and colliding speech sidecars without echoing input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-pack-cli-speech-invalid-'));
    const configPath = join(dir, 'config.json');
    const speechPath = join(dir, 'speech-secret-marker.json');
    const collisionPath = join(dir, 'collision.json');
    try {
      writeFileSync(configPath, `${JSON.stringify(protectedSpeechConfig(join(dir, 'data')))}\n`, 'utf8');
      writeFileSync(collisionPath, `${JSON.stringify(protectedSpeechConfig(
        join(dir, 'collision-data'), validPublicSpeechConfig(),
      ))}\n`, 'utf8');
      for (const body of [
        '{"apiKey":"speech-sidecar-secret-marker"',
        'null',
        '[]',
        JSON.stringify({ ...validPublicSpeechConfig(), apiKey: 'speech-sidecar-secret-marker' }),
        JSON.stringify({ ...validPublicSpeechConfig(), providers: { replacement: {} } }),
        JSON.stringify({ ...validPublicSpeechConfig(), limits: { ...validPublicSpeechConfig().limits, unknown: 1 } }),
        JSON.stringify({ ...validPublicSpeechConfig(), endpoint: 'https://user:pass@invalid.example/transcriptions' }),
      ]) {
        writeFileSync(speechPath, body, 'utf8');
        const result = spawnSync(executable, ['--config', configPath, '--speech-config', speechPath], {
          cwd: '/tmp', encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /speech-sidecar-secret-marker|user:pass|providers/);
      }
      writeFileSync(speechPath, JSON.stringify(validPublicSpeechConfig()), 'utf8');
      const collision = spawnSync(executable, ['--config', collisionPath, '--speech-config', speechPath], {
        cwd: '/tmp', encoding: 'utf8',
      });
      assert.notEqual(collision.status, 0);
      assert.doesNotMatch(`${collision.stdout}\n${collision.stderr}`, /speech-sidecar-secret-marker/);
    } finally {
      trashTemp(dir);
    }
  });

  it('bounds a held connection, handles repeated signals, and restarts on the same data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-pack-cli-lifecycle-'));
    const dataDir = join(dir, 'data');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify(testConfig(dataDir))}\n`, 'utf8');
    let running;
    let held;
    try {
      running = launch(configPath, 150);
      let match = await running.waitFor(/listening at (http:\/\/\S+)/);
      held = await holdRequest(match[1]);
      const started = Date.now();
      running.child.kill('SIGTERM');
      let exited = await running.waitForExit(2_000);
      assert.deepEqual(exited, { code: 0, signal: null });
      assert.ok(Date.now() - started >= 100, 'held request should drain until the configured deadline');
      assert.ok(Date.now() - started < 1_500, 'held request must be force-closed within the bound');
      held.destroy();

      running = launch(configPath, 5_000);
      match = await running.waitFor(/listening at (http:\/\/\S+)/);
      held = await holdRequest(match[1]);
      const repeatedAt = Date.now();
      running.child.kill('SIGTERM');
      await delay(50);
      running.child.kill('SIGINT');
      exited = await running.waitForExit(1_500);
      assert.deepEqual(exited, { code: 0, signal: null });
      assert.ok(Date.now() - repeatedAt < 1_000, 'repeated signal should force-close immediately');
      assert.match(running.output().stdout, /Repeated shutdown signal/);
      held.destroy();

      running = launch(configPath, 150);
      match = await running.waitFor(/listening at (http:\/\/\S+)/);
      const restarted = await fetch(`${match[1]}/health`);
      assert.deepEqual(await restarted.json(), { ok: true, ready: true });
      running.child.kill('SIGTERM');
      exited = await running.waitForExit();
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      held?.destroy();
      if (running?.child.exitCode === null) running.child.kill('SIGKILL');
      trashTemp(dir);
    }
  });

  it('keeps library shutdown idempotent and closes SQLite once', async () => {
    const workspace = createWorkspaceServer(testConfig(':memory:'));
    const originalClose = workspace.store.close.bind(workspace.store);
    let closeCount = 0;
    workspace.store.close = () => {
      closeCount += 1;
      originalClose();
    };
    await workspace.listen();
    const first = workspace.close({ gracePeriodMs: 100 });
    const second = workspace.close({ gracePeriodMs: 0 });
    assert.equal(first, second);
    await Promise.all([first, second]);
    workspace.forceClose();
    assert.equal(closeCount, 1);
  });
});
