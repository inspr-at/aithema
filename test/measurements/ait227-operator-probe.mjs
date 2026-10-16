// Temporary AIT-227 remote diagnostic; loaded with node --import, never a test file.
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import launcher from '../browser/launch.js';

const mode = new URL(import.meta.url).searchParams.has('old') ? 'old' : 'isolated';
const emit = value => console.log('AIT227_PROBE ' + JSON.stringify({ mode, ...value }));
const originalLaunch = ChromeLauncher.prototype.launch;
ChromeLauncher.prototype.launch = function (options) {
  if (mode === 'old') options.env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const allowed = ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_DIRS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH'];
  emit({ launchEnvironment: Object.fromEntries(allowed.map(key => [key, options.env[key] ?? null])) });
  return originalLaunch.call(this, options);
};
const launch = launcher.launch.bind(launcher);
launcher.launch = async options => {
  const browser = await launch(options), newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args), evaluate = page.evaluate.bind(page), $eval = page.$eval.bind(page);
    let delayed = false, snapshots = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (!delayed && /\/api\/sessions\/[^/]+\/credits$/u.test(request.url())) {
        delayed = true;
        emit({ delayedCredits: request.url(), delayMs: 1500 });
        setTimeout(() => request.continue().catch(() => {}), 1500);
      } else void request.continue().catch(() => {});
    });
    page.$eval = async (selector, fn, ...values) => {
      const result = await $eval(selector, fn, ...values);
      // Record the two snapshots used by the unchanged geometry assertion.
      if (typeof fn === 'function' && String(fn).includes("map(s => box")) {
        const snapshot = await evaluate(() => {
          const r = document.querySelector('aithema-session').shadowRoot;
          const entry = r.querySelector('.host-verify'), lead = entry.querySelector('.m-lead-save');
          return { mode: { ...entry.dataset }, lead: lead.textContent, loading: lead.classList.contains('m-credit-status'),
            fontsStatus: document.fonts.status, nodes: ['.m-stack', '.m-mail-tier', '.operator-section'].map(selector => {
              const n = r.querySelector(selector), b = n.getBoundingClientRect();
              return { selector, box: [b.x,b.y,b.width,b.height], font: getComputedStyle(n).font };
            }) };
        });
        const cdp = await page.createCDPSession();
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
        const { nodes } = await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
        const fonts = [];
        for (const node of nodes.filter(node => node.attributes?.some(value => value.split(' ').includes('m-lead-save')) || node.attributes?.includes('operator-login') || node.attributes?.includes('operator-name'))) {
          fonts.push({ attributes: node.attributes, ...(await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })) });
        }
        await cdp.detach();
        emit({ snapshot: ++snapshots, geometry: result, ...snapshot, platformFonts: fonts });
      }
      return result;
    };
    return page;
  };
  return browser;
};
