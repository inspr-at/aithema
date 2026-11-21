// AIT-611: a test-only teardown drain for the demo host test (not shipped; nothing in packages/ or the
// demo page uses it). The harness tears down the DOM globals after a test; a host read still in flight
// would then answer into a page without `document`. The drain wraps the test's fetch, counts every request
// until it answers and every body read (json/text/...) until it settles, and lets teardown wait until none
// is open, so late answers and their continuations land while the page still exists (as in a browser).
//
// drain(): loops on macrotask turns (setImmediate; the microtask queue is empty after each) until no request
// and no body read is open, then takes one more turn so continuations (e.g. onCredits -> paint) run; a
// follow-up request they start is tracked and waited for too. BOUNDED: an injected deadline timer (default
// 5 s). When it fires, the requests open AT THAT MOMENT settle the drain: it rejects naming them (verb + URL).
// A request finishing after the deadline fired cannot turn the drain into a success.
const BODY_READS = ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'];
const turn = () => new Promise(resolve => setImmediate(resolve));

export function hostDrain({ fetch: inner, timeout = 5000, setTimer = setTimeout, clearTimer = clearTimeout, onDrain } = {}) {
  const open = new Set();
  let drains = 0;
  const track = (label, promise) => {
    const entry = { label }; open.add(entry);
    const done = () => { open.delete(entry); };
    promise.then(done, done);
    return promise;
  };
  const withBodyReads = (response, label) => {
    if (!response || typeof response !== 'object') return response;
    for (const method of BODY_READS) {
      const read = response[method];
      if (typeof read !== 'function') continue;
      // An own property on this one response; the stub's Response class stays untouched.
      Object.defineProperty(response, method, { configurable: true, writable: true, value(...args) {
        return track(`${label} (body ${method})`, Promise.resolve(read.apply(this, args)));
      } });
    }
    return response;
  };
  const fetch = (url, init = {}) => {
    const label = `${init?.method ?? 'GET'} ${url instanceof Request ? url.url : String(url)}`;
    let answer;
    try { answer = Promise.resolve(inner(url, init)); } catch (error) { return Promise.reject(error); }
    return track(label, answer.then(response => withBodyReads(response, label)));
  };
  const drain = () => {
    if (drains++ === 0) onDrain?.();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        // Snapshot now: what is open when the deadline fires decides, not what finishes afterwards.
        const still = [...open].map(entry => entry.label);
        if (still.length) reject(new Error(`host teardown drain: deadline (${timeout} ms) passed with host requests still open: ${still.join(', ')}`));
        else resolve();
      }, timeout);
      (async () => {
        for (;;) {
          await turn();
          if (settled) return;
          if (open.size) continue;
          await turn(); // one more turn: continuations of the last answers run, and may start follow-ups
          if (settled) return;
          if (open.size) continue;
          settled = true; clearTimer(timer); resolve();
          return;
        }
      })();
    });
  };
  return { fetch, drain, open: () => [...open].map(entry => entry.label) };
}
