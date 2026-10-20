// SQLite's built-in 'now' ignores JavaScript Date mocks. Keep retention
// triggers on the same clock as test timestamps and retirement cutoffs.
export function bindSQLiteClock(storage, now = () => Date.now()) {
  storage.db.function('julianday', value => {
    const at = value === 'now' ? now() : Date.parse(value);
    return Number.isFinite(at) ? at / 86_400_000 + 2_440_587.5 : null;
  });
  return storage;
}
