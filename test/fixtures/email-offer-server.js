// AIT-507 uses the same injected wall clock in the browser and fixture server.
const WallDate = Date;
globalThis.Date = class extends WallDate {
  constructor(...args) { super(...(args.length ? args : [100_000])); }
  static now() { return 100_000; }
};
await import('./no-provider-server.js');
