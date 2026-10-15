// Opt-in investigation of resources that survive component teardown. Timers are
// absent from _getActiveHandles(), so keep their creation stacks via async_hooks.
import { createHook } from 'node:async_hooks';
const resources = new Map();
const hook = createHook({
  init(id, type, trigger, resource) {
    if (!['Timeout', 'MESSAGEPORT', 'TCPWRAP', 'TCPCONNECTWRAP', 'PROCESSWRAP'].includes(type)) return;
    resources.set(id, { type, resource: new WeakRef(resource), stack: new Error().stack });
  },
  destroy(id) { resources.delete(id); },
});
hook.enable();
export function dumpHandles(phase) {
  console.error(`[AIT-193] ${phase}: handles=${process._getActiveHandles().map(h => h.constructor.name).join(',')} resources=${process.getActiveResourcesInfo().join(',')}`);
  for (const [id, entry] of resources) {
    const resource = entry.resource.deref();
    if (!resource || resource._destroyed || resource.hasRef?.() === false) continue;
    console.error(`[AIT-193] ${phase}: ${entry.type} ${id} delay=${resource._idleTimeout ?? ''}\n${entry.stack}`);
  }
}
