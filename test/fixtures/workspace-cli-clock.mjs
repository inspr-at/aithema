import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock } from 'node:test';

// Test-only preload: the real CLI, HTTP server and SQLite store run unchanged.
// IPC advances the child clock only after the parent's event barriers resolve.
mock.timers.enable({ apis: ['setTimeout'] });
process.on('message', ({ advanceMs }) => {
  mock.timers.tick(advanceMs);
  process.send({ advancedMs: advanceMs });
});
process.channel.unref();

const mutation = process.env.AITHEMA_TEST_SHUTDOWN_MUTATION;
if (mutation) {
  const mutations = {
    early: ['/workspace/server.js', 'setTimeout(forceClose, gracePeriodMs)', 'setTimeout(forceClose, 0)'],
    late: ['/workspace/server.js', 'setTimeout(forceClose, gracePeriodMs)', 'setTimeout(forceClose, gracePeriodMs + 1)'],
    noExpiry: ['/workspace/server.js', 'setTimeout(forceClose, gracePeriodMs)', 'setTimeout(() => {}, gracePeriodMs)'],
    noRepeated: ['/bin/aithema-workspace.js',
      'workspace.forceClose();\n      return;', 'return;'],
  };
  assert.ok(Object.hasOwn(mutations, mutation), 'known shutdown mutation');
  const [suffix, before, after] = mutations[mutation];
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith(suffix)) return loaded;
      const source = loaded.source.toString();
      assert.equal(source.split(before).length, 2, 'exactly one shutdown mutation site');
      return { ...loaded, source: source.replace(before, after) };
    },
  });
}
