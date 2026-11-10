// Remote-only full matrix. Use --test-name-pattern to select a variant per remote run.
// Node flags precede this file: remote-browser.sh "$PWD" browser --test-name-pattern='V-inplace en 1440' test/browser/identity-unlock.repro.js
process.env.AITHEMA_AIT470_REPRO = '1';
await import('./identity-unlock.test.js');
