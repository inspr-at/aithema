// Test-only preload: advance the wall clock while preserving real elapsed time.
// Usage: node --import './test/fixtures/calendar-clock.js?now=2101-01-01T12:00:00Z' --test ...
const target = new URL(import.meta.url).searchParams.get('now');
if (target) {
  const WallDate = globalThis.Date;
  const epoch = WallDate.parse(target);
  if (!Number.isFinite(epoch)) throw new TypeError('Invalid calendar test clock');
  const offset = epoch - WallDate.now();
  globalThis.Date = class extends WallDate {
    constructor(...args) { super(...(args.length ? args : [WallDate.now() + offset])); }
    static now() { return WallDate.now() + offset; }
  };
  process.env.TZ = 'UTC';
}
