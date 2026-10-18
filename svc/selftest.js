'use strict';
/**
 * Offline self-test: verifies the module loads, the browser launches, and a
 * page can navigate — WITHOUT touching any HBO account. Run:  node selftest.js
 */
const { getBrowser, closeBrowser, newIsolatedContext } = require('./browser');
const engine = require('./hboEngine');

(async () => {
  let ok = true;
  try {
    if (typeof engine.runHboJob !== 'function') throw new Error('runHboJob missing');
    console.log('[selftest] engine export OK');
    await getBrowser();
    console.log('[selftest] chromium launched OK');
    const ctx = await newIsolatedContext();
    const page = await ctx.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const title = await page.title();
    console.log('[selftest] navigation OK:', title);
    await ctx.close();
  } catch (e) {
    ok = false;
    console.error('[selftest] FAILED:', e.message);
  } finally {
    await closeBrowser();
    console.log(ok ? '[selftest] ALL GOOD' : '[selftest] PROBLEMS — see above');
    process.exit(ok ? 0 : 1);
  }
})();
