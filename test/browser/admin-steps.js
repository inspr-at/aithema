// Bound protocol calls too: Puppeteer's page timeout does not cover evaluate,
// screenshots, launch or close. Keep failures attributable to one matrix cell.
export function adminSteps(signal) {
  let context = { state: 'setup', locale: 'de', theme: 'light', width: 390 };
  const at = (state, cell = {}) => { context = { ...context, ...cell, state }; };
  const run = async (operation, work, { timeout = 5_000, cleanup = false } = {}) => {
    const { state, locale, theme, width } = context;
    const label = `admin state=${state} locale=${locale} theme=${theme} width=${width}: ${operation}`;
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (!cleanup) signal?.throwIfAborted();
          return work();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`deadline exceeded (${timeout} ms)`)), timeout);
          if (!cleanup && signal) {
            abort = () => reject(new Error('test cancelled', { cause: signal.reason }));
            signal.addEventListener('abort', abort, { once: true });
          }
        }),
      ]);
    } catch (cause) {
      throw new Error(`${label}: ${cause.message}`, { cause });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
  return { at, run };
}
