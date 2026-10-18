'use strict';
/**
 * Global, console-wide settings for the HBO Max reset service.
 * Mirrors the nf-reset/pv pattern: one global avatar category + concurrency,
 * overridable per-job via options. Persisted to settings.json so the dashboard
 * (later phase) can change them without a redeploy.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'settings.json');

const DEFAULTS = {
  // Which avatar collection to pull profile avatars from. The engine scrolls to
  // this section on the HBO avatar picker and picks a (rotating) avatar from it.
  // Exact HBO section heading text, case-insensitive.
  avatarCategory: 'House of The Dragon',
  // Max HBO jobs running at once (each uses its own isolated browser context).
  maxConcurrent: 2,
  // HBO allows up to 5 profiles total (1 primary + 4). Default target set size.
  targetProfiles: 5,
  // Per-action default timeout (ms). Kept tight so a missing element fails fast.
  actionTimeout: 20000,
  // Headless browser. Set false only for local debugging.
  headless: true,
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, DEFAULTS };
