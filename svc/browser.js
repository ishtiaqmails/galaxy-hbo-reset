'use strict';
/**
 * Shared Chromium launcher for the HBO reset service.
 * One browser process for the whole service; each JOB gets its own isolated
 * BrowserContext (see hboQueue.newIsolatedContext) so accounts never mix and
 * cookies are wiped between jobs.
 *
 * Self-contained: does NOT import nf-reset's browser.js. Running as its own pm2
 * process means this cannot affect the Netflix/Prime services.
 */
const { chromium } = require('playwright');
const settings = require('./settings');

let _browser = null;
let _launching = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
];

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  const cfg = settings.load();
  _launching = chromium
    .launch({ headless: cfg.headless !== false, args: LAUNCH_ARGS })
    .then((b) => {
      _browser = b;
      _launching = null;
      b.on('disconnected', () => {
        _browser = null;
      });
      return b;
    })
    .catch((e) => {
      _launching = null;
      throw e;
    });
  return _launching;
}

/**
 * A fresh, isolated context for one job. Realistic UA + viewport so HBO serves
 * the normal web player. Caller MUST close it in a finally block.
 */
async function newIsolatedContext() {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  ctx.setDefaultTimeout(settings.load().actionTimeout);
  ctx.setDefaultNavigationTimeout(45000);
  // light stealth — HBO's auth sniffs automation signals
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (_) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (_) {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] }); } catch (_) {}
    try { window.chrome = window.chrome || { runtime: {} }; } catch (_) {}
  });
  return ctx;
}

async function closeBrowser() {
  try {
    if (_browser) await _browser.close();
  } catch (_) {}
  _browser = null;
}

module.exports = { getBrowser, newIsolatedContext, closeBrowser };
