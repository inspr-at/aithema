// Only the consent deadlines/backoff/notice use virtual time. Network, frame
// delivery, rendering and Date.now keep their real clocks so visibility is sampled by RAF.
export function installConsentClock() {
  const schedule = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
  const timers = new Map(); let now = 0, serial = 0;
  window.setTimeout = (callback, delay, ...args) => {
    if (callback?.name !== 'consentTimer') return schedule(callback, delay, ...args);
    const id = --serial; timers.set(id, { at: now + delay, callback: () => callback(...args) }); return id;
  };
  window.clearTimeout = id => { if (timers.has(id)) timers.delete(id); else cancel(id); };
  window.clock = { tick(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = end;
  }, pending: () => timers.size };
}
