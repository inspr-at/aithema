// Measurement-only preload: reproduce the old launch path and flags exactly.
// Never used by the browser suite or by CI's shard runner.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import puppeteer from 'puppeteer-core';
import testBrowser from '../browser/launch.js';

assert.match(hostname(), /mbp2606/iu);
assert.equal(process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
testBrowser.launch = puppeteer.launch.bind(puppeteer);
