/** Buffered event waits; the owning test's timeout bounds missing notifications. */
export function eventProbe() {
  const events = [], waiting = new Set();
  return {
    events,
    record(event) {
      events.push(event);
      for (const waiter of waiting) {
        if (waiter.predicate(event)) { waiting.delete(waiter); waiter.resolve(event); }
      }
    },
    waitFor(predicate, after = 0) {
      const event = events.slice(after).find(predicate);
      if (event) return Promise.resolve(event);
      return new Promise(resolve => waiting.add({ predicate, resolve }));
    },
  };
}

/** Record only after the UI consumer has handled the event and rendered it. */
export async function* observedVoiceEvents(events, record) {
  for await (const event of events) { yield event; record(event); }
}
