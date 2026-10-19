'use strict';
/**
 * HBO Max Profiles/Screens Creator — engine.
 *
 * Strategy: DELETE + RECREATE (user's choice).
 * Per job: login (email+password) → read profiles → delete all secondaries →
 * recreate to target with names + DOB + gender + House-of-the-Dragon avatar →
 * set primary name + avatar → set PINs & locks (primary first) →
 * [optional] change account password → verify.
 *
 * Boundaries (same as Netflix/Prime engines):
 *  - Never store the real email / password / PINs. The queue holds them in a
 *    private map and wipes on terminal; only safe fields are returned.
 *  - No CAPTCHA solving / no bot-detection evasion. If HBO challenges with OTP,
 *    fail with a clear code rather than trying to beat it.
 *
 * Everything mapped live twice in the in-app browser on the owner's account.
 * Key lessons baked in:
 *  - DOB + name + PIN need REAL keystrokes (value injection leaves Save disabled
 *    / the "Please enter your birthdate" error). Use pressSequentially / keyboard.
 *  - PIN boxes auto-advance: type with a per-key delay so each digit lands in its
 *    own box (a fast 4-char paste only fills the first box).
 *  - The avatar grid + a11y tree render a few seconds late; wait + one retry.
 *  - Gender is REQUIRED on create.
 *  - "Did you mean …?" email suggestion: keep what was typed (click Continue again).
 *  - Pages load behind a spinner; wait for real content, not just the URL.
 *  - Primary profile id is not reliably in the grid; read it off its edit page.
 */

const settings = require('./settings');

const HOME = 'https://www.hbomax.com/';
const AUTH_LOGIN = 'https://auth.hbomax.com/login';
const ACCOUNT = 'https://auth.hbomax.com/account';
const PLAY = 'https://play.hbomax.com';
const MANAGE = PLAY + '/profile-picker?manageMode=edit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- small helpers --------------------------------------------------------

function mkLog(hooks) {
  const steps = [];
  return {
    steps,
    step(msg, extra) {
      const line = { t: Date.now(), msg, ...(extra || {}) };
      steps.push(line);
      if (hooks && typeof hooks.onStep === 'function') {
        try { hooks.onStep(line); } catch (_) {}
      }
    },
  };
}

class EngineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.safe = message || code;
  }
}

async function settle(page, extraMs = 400) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch (_) {}
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
  await sleep(extraMs);
}

// Click a control by its visible/accessible text, preferring a dialog scope so
// we never hit a look-alike behind a modal (Prime lesson: cards can be submit).
async function clickByText(scope, text, { timeout = 8000 } = {}) {
  const rx = text instanceof RegExp ? text : new RegExp('^\\s*' + text + '\\s*$', 'i');
  const tries = [
    () => scope.getByRole('button', { name: rx }),
    () => scope.getByRole('link', { name: rx }),
    () => scope.getByText(rx, { exact: false }),
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const make of tries) {
      const loc = make().first();
      try {
        if ((await loc.count()) && (await loc.isVisible())) {
          await loc.click({ timeout: 2500 });
          return true;
        }
      } catch (_) {}
    }
    await sleep(250);
  }
  return false;
}

// Type a 4-digit PIN into the HBO pin widget. Works for both the single-field
// and the four-cell variants: focus the first box, then press each digit with a
// delay so the widget auto-advances.
async function typePin(page, pin) {
  // find the pin container's first input/cell
  const candidates = [
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="password"]',
    'input[type="text"]',
  ];
  let first = null;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) { first = loc; break; }
  }
  if (first) {
    await first.click();
  } else {
    // fall back to the center of the page and just type
    await page.mouse.click(400, 400).catch(() => {});
  }
  for (const d of String(pin).split('')) {
    await page.keyboard.press(d, { delay: 40 });
    await sleep(120);
  }
}

// ---- login ----------------------------------------------------------------

// Dismiss a cookie/consent overlay (OneTrust & friends). A fresh datacenter
// context hits these even though a mapping browser that already accepted them
// never shows one — the exact blocker that bit the Prime engine.
async function dismissConsent(page) {
  const sels = [
    '#onetrust-accept-btn-handler',
    'button#truste-consent-button',
    'button[aria-label*="accept" i]',
    'button[title*="accept" i]',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try { if ((await loc.count()) && (await loc.isVisible())) { await loc.click({ timeout: 2000 }); await sleep(300); return true; } } catch (_) {}
  }
  // text fallback inside any dialog/banner
  const ok = await clickByText(page, /^(accept all|accept|agree|got it|i accept|allow all)$/i, { timeout: 1500 });
  if (ok) await sleep(300);
  return ok;
}

async function pageSnippet(page) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    return { url, title, snippet: String(txt).replace(/\s+/g, ' ').trim().slice(0, 280) };
  } catch (_) { return { url: page.url(), title: '', snippet: '' }; }
}

// Compact dump of the form state: which inputs/buttons/headings/alerts are
// actually present and visible. Small enough to carry in the step log.
async function formDump(page) {
  try {
    return await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const inputs = [...document.querySelectorAll('input')].map((i) => ({ type: i.type, ph: i.placeholder || '', id: i.id || '', vis: vis(i), vlen: (i.value || '').length }));
      const buttons = [...document.querySelectorAll('button,[role=button]')].map((b) => ({ text: (b.textContent || '').trim().slice(0, 24), dis: !!(b.disabled || b.getAttribute('aria-disabled') === 'true'), vis: vis(b) })).filter((b) => b.text).slice(0, 12);
      const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => (h.textContent || '').trim()).filter(Boolean).slice(0, 6);
      const alerts = [...document.querySelectorAll('[role=alert],[class*="error" i]')].map((a) => (a.textContent || '').trim()).filter(Boolean).slice(0, 4);
      return { inputs, buttons, headings, alerts };
    });
  } catch (e) { return { dumpErr: e.message }; }
}

async function login(page, email, password, log) {
  // Start from the app home so the sign-in OAuth flow carries a return URL back
  // to play.hbomax.com (navigating straight to /login leaves no return target).
  log.step('login: open home');
  await page.goto(HOME, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 1200);
  await dismissConsent(page);

  // click the header Sign In if we're not already on the auth host
  if (!/auth\.hbomax\.com/.test(page.url())) {
    await clickByText(page, /sign\s*in/i, { timeout: 12000 });
    await settle(page, 1400);
  }
  await dismissConsent(page);

  // if we still don't see a login field, fall back to the direct login URL
  if (!(await page.locator('input[type="text"], input[type="email"], input[inputmode="email"]').count())) {
    await page.goto(AUTH_LOGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page, 1000);
    await dismissConsent(page);
  }
  log.step('login: at sign-in', await pageSnippet(page));

  // email step
  const emailBox = page.locator('input[type="text"], input[type="email"], input[inputmode="email"]').first();
  try { await emailBox.waitFor({ state: 'visible', timeout: 15000 }); }
  catch (_) { throw new EngineError('HBO_LOGIN_FAILED', 'email field not found at ' + page.url()); }
  await emailBox.click();
  await emailBox.fill('');
  await emailBox.pressSequentially(email, { delay: 25 });
  log.step('login: email typed', await formDump(page));
  await clickByText(page, /continue/i, { timeout: 8000 });
  await settle(page, 1500);

  // "Did you mean …?" suggestion — keep the typed address by clicking Continue again
  for (let i = 0; i < 2; i++) {
    const dym = await page.getByText(/did you mean/i).count().catch(() => 0);
    if (!dym) break;
    log.step('login: did-you-mean, keeping typed address');
    await clickByText(page, /continue/i, { timeout: 5000 });
    await settle(page, 1500);
  }

  // Wait for the PASSWORD step — the "Sign In" button only exists there (the
  // email step has a hidden password input in the DOM, so we key off Sign In).
  let onPwStep = false;
  for (let i = 0; i < 16; i++) {
    const signIn = page.getByRole('button', { name: /^sign in$/i }).first();
    const sVis = (await signIn.count()) ? await signIn.isVisible().catch(() => false) : false;
    const pwVis = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    if (sVis && pwVis) { onPwStep = true; break; }
    await sleep(1000);
  }
  if (!onPwStep) {
    const dump = await formDump(page);
    const snap = await pageSnippet(page);
    log.step('login: password step not reached', { ...snap, ...dump });
    const otc = await page.getByText(/one[-\s]?time code|get a code|verify it'?s you/i).count().catch(() => 0);
    if (otc) throw new EngineError('HBO_LOGIN_OTP_REQUIRED', 'one-time-code / verification screen');
    throw new EngineError('HBO_LOGIN_FAILED', 'password step not reached at ' + snap.url);
  }

  // password
  const pwBox = page.locator('input[type="password"]:visible').first();
  await pwBox.click();
  await pwBox.fill('');
  await pwBox.pressSequentially(password, { delay: 20 });
  log.step('login: password typed');
  const signed = await clickByText(page, /^sign in$/i, { timeout: 8000 });
  if (!signed) { await pwBox.press('Enter').catch(() => {}); }
  log.step('login: submitted', { url: page.url(), signed });

  // success = we reach the play app (profile picker or home)
  try {
    await page.waitForURL(/play\.hbomax\.com/, { timeout: 35000 });
  } catch (_) {
    const snap = await pageSnippet(page);
    log.step('login: post-submit stuck', snap);
    const challenge = /captcha|verify|robot|unusual|try again later|too many/i.test(snap.snippet);
    const bad = /incorrect|do(?:esn'?t| not) match|invalid|wrong/i.test(snap.snippet);
    if (bad) throw new EngineError('HBO_LOGIN_FAILED', 'HBO rejected the email/password');
    if (challenge) throw new EngineError('HBO_LOGIN_OTP_REQUIRED', 'challenge page: ' + snap.snippet);
    throw new EngineError('HBO_LOGIN_FAILED', 'Did not reach the app — stuck at ' + snap.url + ' (' + (snap.title || '') + ') ' + snap.snippet);
  }
  await settle(page, 1000);
  log.step('login: signed in', { url: page.url() });
}

// ---- profile reading ------------------------------------------------------

async function gotoManage(page) {
  await page.goto(MANAGE, { waitUntil: 'domcontentloaded' });
  await settle(page, 700);
  // wait for at least one profile tile
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const n = await countProfileTiles(page);
    if (n >= 1) return;
    await sleep(400);
  }
}

// Names of the profile tiles on the manage grid (excludes the "New Profile"/add tile).
async function readGridNames(page) {
  return await page.evaluate(() => {
    const out = [];
    const btns = Array.from(document.querySelectorAll('button,a'));
    for (const b of btns) {
      const al = (b.getAttribute('aria-label') || '').trim();
      const m = al.match(/^Edit\s+(.+?)(?:,|$)/i);
      if (m) {
        let name = m[1].replace(/⁩|⁨/g, '').trim();
        if (name && !/avatar/i.test(name)) out.push(name);
      }
    }
    // de-dupe, keep order
    return [...new Set(out)];
  });
}

async function countProfileTiles(page) {
  const names = await readGridNames(page).catch(() => []);
  return names.length;
}

// Open a profile's edit page by its visible name; returns the edit-profile id.
async function openProfileByName(page, name) {
  await gotoManage(page);
  const tile = page.getByRole('button', { name: new RegExp('Edit\\s+' + escapeRx(name) + '(\\b|,)', 'i') }).first();
  if (!(await tile.count())) {
    // fallback: any element whose text is exactly the name
    await page.getByText(new RegExp('^' + escapeRx(name) + '$'), { exact: false }).first().click();
  } else {
    await tile.click();
  }
  await page.waitForURL(/\/edit-profile\//, { timeout: 15000 });
  await settle(page, 500);
  return currentProfileId(page);
}

function currentProfileId(page) {
  const m = page.url().match(/\/edit-profile\/([^/?#]+)/);
  return m ? m[1] : null;
}

function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Is the currently-open edit page the primary (no Delete Profile control)?
async function editPageIsPrimary(page) {
  const del = await clickableCount(page, /delete profile/i);
  return del === 0;
}

async function clickableCount(page, rx) {
  return await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    let n = 0;
    for (const el of document.querySelectorAll('button,a,[role="button"]')) {
      const t = (el.textContent || '').trim();
      if (re.test(t)) n++;
    }
    return n;
  }, rx.source);
}

// ---- mutations ------------------------------------------------------------

async function deleteOpenProfile(page, log) {
  // on an edit-profile page with a Delete control
  const opened = await clickByText(page, /delete profile/i, { timeout: 8000 });
  if (!opened) throw new EngineError('HBO_DELETE_FAILED', 'Delete control not found');
  // confirm dialog
  const dialog = page.getByRole('dialog');
  const scope = (await dialog.count()) ? dialog : page;
  await sleep(400);
  const confirmed = await clickByText(scope, /delete profile/i, { timeout: 6000 });
  if (!confirmed) throw new EngineError('HBO_DELETE_FAILED', 'Delete confirm button not found');
  await page.waitForURL(/profile-picker/, { timeout: 15000 }).catch(() => {});
  await settle(page, 700);
}

async function deleteAllSecondaries(page, log) {
  let primaryName = null;
  for (let guard = 0; guard < 12; guard++) {
    await gotoManage(page);
    const names = await readGridNames(page);
    const deletable = names.filter((n) => n !== primaryName);
    if (deletable.length === 0) break;
    if (names.length <= 1) break;

    const name = deletable[0];
    await openProfileByName(page, name);
    if (await editPageIsPrimary(page)) {
      primaryName = name;
      log.step('delete: identified primary', { name });
      continue; // try the next one
    }
    await deleteOpenProfile(page, log);
    log.step('delete: removed profile', { name });
  }
  return primaryName;
}

// Pick an avatar from a named category section on the "Choose an Avatar" page.
// Best-effort: returns true if an avatar was chosen.
async function pickAvatarFromCategory(page, category, index, log) {
  // wait for the picker to render (it lags)
  const start = Date.now();
  let ok = false;
  while (Date.now() - start < 12000) {
    const has = await page.getByRole('heading', { name: new RegExp(escapeRx(category), 'i') }).count().catch(() => 0);
    const anyAvatar = await page.locator('button[href="/create-profile"], a[href="/create-profile"]').count().catch(() => 0);
    if (has || anyAvatar) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) return false;

  // Try to click the Nth avatar inside the category's row via DOM walk.
  const clicked = await page.evaluate(({ cat, idx }) => {
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'));
    const h = heads.find((e) => new RegExp(cat, 'i').test((e.textContent || '').trim()));
    if (!h) return false;
    // the row of avatars is usually the next sibling container
    let row = h.nextElementSibling;
    for (let i = 0; i < 3 && row; i++) {
      const btns = row.querySelectorAll('button, a');
      if (btns.length) {
        const pick = btns[Math.min(idx, btns.length - 1)];
        pick.scrollIntoView({ block: 'center' });
        pick.click();
        return true;
      }
      row = row.nextElementSibling;
    }
    return false;
  }, { cat: escapeRx(category), idx: index });

  if (clicked) { await sleep(800); return true; }
  return false;
}

async function createProfile(page, { name, mm, dd, yyyy, gender }, category, avatarIndex, log) {
  await gotoManage(page);
  // open New Profile
  const addOpened =
    (await clickByText(page, /create a new profile/i, { timeout: 4000 })) ||
    (await clickByText(page, /new profile/i, { timeout: 4000 }));
  if (!addOpened) throw new EngineError('HBO_CREATE_FAILED', 'New Profile control not found');
  await page.waitForURL(/avatar-picker/, { timeout: 12000 }).catch(() => {});
  await settle(page, 800);

  // pick a House-of-the-Dragon avatar at creation time (else first avatar)
  let picked = await pickAvatarFromCategory(page, category, avatarIndex, log);
  if (!picked) {
    // fall back: click the very first avatar (two clicks if it only selects)
    const first = page.locator('button[href="/create-profile"], a[href="/create-profile"]').first();
    if (await first.count()) {
      await first.click().catch(() => {});
      await sleep(600);
      if (!/create-profile/.test(page.url())) { await first.click().catch(() => {}); }
    }
  }
  await page.waitForURL(/create-profile/, { timeout: 12000 }).catch(() => {});
  await settle(page, 700);

  // name (real keystrokes)
  const nameBox = page.getByRole('textbox', { name: /profile name/i }).first();
  await nameBox.waitFor({ state: 'visible', timeout: 10000 });
  await nameBox.click();
  await nameBox.fill('');
  await nameBox.pressSequentially(name, { delay: 30 });

  // DOB — real keystrokes into MM / DD / YYYY (value injection leaves the
  // "Please enter your birthdate" error, so we type each field).
  const mmBox = page.getByPlaceholder('MM').first();
  const ddBox = page.getByPlaceholder('DD').first();
  const yyBox = page.getByPlaceholder('YYYY').first();
  await mmBox.click(); await mmBox.pressSequentially(mm, { delay: 60 });
  await ddBox.click(); await ddBox.pressSequentially(dd, { delay: 60 });
  await yyBox.click(); await yyBox.pressSequentially(yyyy, { delay: 60 });

  // gender (REQUIRED) — open dropdown, choose option
  await clickByText(page, /what best describes you|gender/i, { timeout: 5000 });
  await sleep(300);
  const opt = page.getByRole('option', { name: new RegExp(escapeRx(gender), 'i') }).first();
  if (await opt.count()) { await opt.click(); }
  else { await page.getByText(new RegExp('^' + escapeRx(gender) + '$', 'i')).first().click().catch(() => {}); }
  await sleep(300);

  // Save
  const saved = await clickByText(page, /^save$/i, { timeout: 6000 });
  if (!saved) throw new EngineError('HBO_CREATE_FAILED', 'Save button not clickable on create');
  await page.waitForURL(/profile-picker/, { timeout: 15000 }).catch(() => {});
  await settle(page, 700);

  // verify it appears
  const names = await readGridNames(page);
  if (!names.includes(name)) throw new EngineError('HBO_CREATE_FAILED', 'Created profile "' + name + '" did not appear');
  log.step('create: added profile', { name });
}

async function renameOpenProfile(page, name, log) {
  const nameBox = page.getByRole('textbox', { name: /profile name/i }).first();
  if (!(await nameBox.count())) return false;
  await nameBox.click();
  await nameBox.fill('');
  await nameBox.pressSequentially(name, { delay: 30 });
  await clickByText(page, /^done$/i, { timeout: 6000 });
  await page.waitForURL(/profile-picker/, { timeout: 12000 }).catch(() => {});
  await settle(page, 500);
  log.step('rename: set name', { name });
  return true;
}

async function setAvatarOnOpenProfile(page, name, category, index, log) {
  const edit = page.getByRole('button', { name: new RegExp('Edit\\s+' + escapeRx(name) + '\\s+avatar', 'i') }).first();
  const btn = (await edit.count()) ? edit : page.getByRole('button', { name: /avatar/i }).first();
  if (!(await btn.count())) return false;
  await btn.click();
  await page.waitForURL(/avatar-picker/, { timeout: 10000 }).catch(() => {});
  await settle(page, 700);
  const ok = await pickAvatarFromCategory(page, category, index, log);
  await page.waitForURL(/edit-profile/, { timeout: 10000 }).catch(() => {});
  await settle(page, 500);
  log.step('avatar: set', { name, ok });
  return ok;
}

async function lockSecondary(page, name, pin, log) {
  await openProfileByName(page, name);
  const sw = page.getByRole('switch', { name: /lock profile/i }).first();
  if (!(await sw.count())) throw new EngineError('HBO_PIN_FAILED', 'Lock switch not found for ' + name);
  await sw.click();
  await page.waitForURL(/create-pin/, { timeout: 12000 }).catch(() => {});
  await settle(page, 600);
  await typePin(page, pin);
  const saved = await clickByText(page, /^save$/i, { timeout: 6000 });
  if (!saved) throw new EngineError('HBO_PIN_FAILED', 'Save not clickable on create-pin for ' + name);
  await page.waitForURL(/edit-profile/, { timeout: 12000 }).catch(() => {});
  await settle(page, 500);
  log.step('pin: locked secondary', { name });
}

async function resetPrimaryPin(page, primaryName, primaryId, accountPassword, pin, log) {
  await openProfileByName(page, primaryName);
  const opened = await clickByText(page, /reset profile pin/i, { timeout: 6000 });
  if (!opened) {
    // primary may not be locked yet → a Lock switch flow instead
    const sw = page.getByRole('switch', { name: /lock profile/i }).first();
    if (await sw.count()) {
      await sw.click();
      await page.waitForURL(/create-pin/, { timeout: 12000 }).catch(() => {});
      await settle(page, 500);
      await typePin(page, pin);
      await clickByText(page, /^save$/i, { timeout: 6000 });
      await settle(page, 600);
      log.step('pin: locked primary (create)', { name: primaryName });
      return;
    }
    throw new EngineError('HBO_PRIMARY_PIN_FAILED', 'No Reset/Lock control on primary');
  }
  // confirm-password gate
  await page.waitForURL(/confirm-password/, { timeout: 12000 }).catch(() => {});
  await settle(page, 600);
  const pw = page.locator('input[type="password"]').first();
  if (await pw.count()) {
    await pw.click();
    await pw.pressSequentially(accountPassword, { delay: 15 });
    await clickByText(page, /^next$/i, { timeout: 6000 });
  }
  await page.waitForURL(/edit-pin/, { timeout: 15000 }).catch(() => {});
  await settle(page, 600);
  await typePin(page, pin);
  const saved = await clickByText(page, /^save$/i, { timeout: 6000 });
  if (!saved) throw new EngineError('HBO_PRIMARY_PIN_FAILED', 'Save not clickable on edit-pin');
  await settle(page, 700);
  log.step('pin: reset primary', { name: primaryName });
}

async function changeAccountPassword(page, currentPw, newPw, log) {
  await page.goto(ACCOUNT, { waitUntil: 'domcontentloaded' });
  // account page loads behind a spinner
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await page.getByText(/^password$/i).count()) break;
    await sleep(500);
  }
  // click the Password edit pencil (the edit control in the Password row)
  const edited = await clickByText(page, /change.*password|edit.*password/i, { timeout: 3000 });
  if (!edited) {
    // fallback: direct nav to the edit page
    await page.goto('https://auth.hbomax.com/account/edit/password', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForURL(/edit\/password/, { timeout: 12000 }).catch(() => {});
  await settle(page, 700);
  const boxes = page.locator('input[type="password"]');
  if ((await boxes.count()) < 2) throw new EngineError('HBO_PASSWORD_CHANGE_FAILED', 'Password fields not found');
  await boxes.nth(0).click(); await boxes.nth(0).pressSequentially(currentPw, { delay: 15 });
  await boxes.nth(1).click(); await boxes.nth(1).pressSequentially(newPw, { delay: 15 });
  const saved = await clickByText(page, /^save$/i, { timeout: 6000 });
  if (!saved) throw new EngineError('HBO_PASSWORD_CHANGE_FAILED', 'Save not clickable');
  await page.waitForURL(/\/account(\b|$)/, { timeout: 12000 }).catch(() => {});
  await settle(page, 600);
  log.step('password: changed');
}

// ---- orchestrator ---------------------------------------------------------

/**
 * runHboJob(ctx, job, hooks)
 *  job = {
 *    email, password,
 *    names:  [primary, s2, s3, s4, s5],   // length = targetProfiles
 *    pins:   [p1, p2, p3, p4, p5],        // 4-digit strings, same length
 *    newPassword?: '...',                 // optional account-password change
 *    dob?: { mm:'01', dd:'01', yyyy:'1999' }, // defaults 01/01/1999
 *    gender?: 'Prefer not to say',
 *    options?: { targetProfiles, avatarCategory, renamePrimary, dryRun }
 *  }
 * Returns a SAFE result (no secrets).
 */
async function runHboJob(ctx, job, hooks = {}) {
  const cfg = settings.load();
  const log = mkLog(hooks);
  const opt = job.options || {};
  const target = opt.targetProfiles || cfg.targetProfiles; // 5
  const category = opt.avatarCategory || cfg.avatarCategory; // House of The Dragon
  const renamePrimary = opt.renamePrimary !== false;
  const dryRun = !!opt.dryRun;
  const dob = job.dob || { mm: '01', dd: '01', yyyy: '1999' };
  const gender = job.gender || 'Prefer not to say';
  const names = (job.names || []).slice(0, target);
  const pins = (job.pins || []).slice(0, target);

  if (names.length !== target || pins.length !== target) {
    throw new EngineError('HBO_BAD_INPUT', `names and pins must each have ${target} entries`);
  }

  const page = await ctx.newPage();
  const result = { engineVersion: 'v3-pwstep', region: 'pk', dryRun, target, category, primaryName: null, created: [], locked: [], avatarFails: [], passwordChanged: false };

  try {
    await login(page, job.email, job.password, log);

    // read current profiles
    await gotoManage(page);
    const before = await readGridNames(page);
    log.step('profiles: read', { count: before.length, names: before });
    if (before.length === 0) throw new EngineError('HBO_PROFILES_READ_FAILED', 'No profiles visible after login');

    if (dryRun) {
      // find primary without changing anything
      let primaryName = null;
      for (const n of before) {
        await openProfileByName(page, n);
        if (await editPageIsPrimary(page)) { primaryName = n; break; }
      }
      result.primaryName = primaryName;
      result.plan = { delete: before.filter((n) => n !== primaryName), create: names.slice(1), lock: names };
      log.step('dryRun: plan built', result.plan);
      return { ok: true, result, steps: log.steps };
    }

    // 1) delete all secondaries
    const primaryName = await deleteAllSecondaries(page, log);
    result.primaryName = primaryName;
    const primaryId = primaryName ? await openProfileByName(page, primaryName) : null;

    // 2) recreate secondaries to target (names[1..]) with HotD avatar at creation
    for (let i = 1; i < target; i++) {
      await createProfile(
        page,
        { name: names[i], mm: dob.mm, dd: dob.dd, yyyy: dob.yyyy, gender },
        category, (i - 1) % 4, log
      );
      result.created.push(names[i]);
    }

    // 3) primary: rename + set HotD avatar (before locking it)
    if (primaryName) {
      await openProfileByName(page, primaryName);
      const avOk = await setAvatarOnOpenProfile(page, primaryName, category, 4, log);
      if (!avOk) result.avatarFails.push(names[0] + ' (primary avatar)');
      if (renamePrimary && names[0] && names[0] !== primaryName) {
        await openProfileByName(page, primaryName);
        await renameOpenProfile(page, names[0], log);
      }
    }
    const primaryDisplay = renamePrimary ? names[0] : (primaryName || names[0]);

    // 4) PINs & locks — PRIMARY FIRST, then secondaries
    if (primaryName) {
      await resetPrimaryPin(page, primaryDisplay, primaryId, job.password, pins[0], log);
      result.locked.push(primaryDisplay);
    }
    for (let i = 1; i < target; i++) {
      await lockSecondary(page, names[i], pins[i], log);
      result.locked.push(names[i]);
    }

    // 5) optional account-password change (LAST — primary PIN reset needs old pw)
    if (job.newPassword) {
      await changeAccountPassword(page, job.password, job.newPassword, log);
      result.passwordChanged = true;
    }

    // 6) verify
    await gotoManage(page);
    const after = await readGridNames(page);
    result.finalNames = after;
    const expected = [primaryDisplay, ...names.slice(1)];
    const missing = expected.filter((n) => n && !after.includes(n));
    if (after.length !== target || missing.length) {
      throw new EngineError('HBO_VERIFICATION_FAILED', `expected ${target} profiles ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`);
    }
    log.step('verify: OK', { count: after.length, names: after });

    return { ok: true, result, steps: log.steps };
  } catch (e) {
    const code = e instanceof EngineError ? e.code : 'HBO_UNEXPECTED';
    const safe = e instanceof EngineError ? e.safe : (e.message || 'unexpected error');
    log.step('FAILED', { code, safe });
    return { ok: false, failureCode: code, safeFailureMessage: safe, result, steps: log.steps };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { runHboJob, EngineError };
