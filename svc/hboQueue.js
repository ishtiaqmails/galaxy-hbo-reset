'use strict';
/**
 * Parallel job queue for HBO resets.
 *  - Each job runs in its own isolated BrowserContext (accounts never mix).
 *  - Secrets (email/password/pins/newPassword) live ONLY in a private map and
 *    are wiped the moment a job reaches a terminal state.
 *  - Public job views never include secrets.
 */
const crypto = require('crypto');
const { newIsolatedContext } = require('./browser');
const { runHboJob } = require('./hboEngine');
const settings = require('./settings');

const _jobs = new Map();     // id -> public job record
const _secrets = new Map();  // id -> { email, password, pins, newPassword }
let _running = 0;
const _pending = [];

function wipeSecrets(id) {
  const s = _secrets.get(id);
  if (s) { for (const k of Object.keys(s)) s[k] = null; }
  _secrets.delete(id);
}

function publicView(j) {
  if (!j) return null;
  return {
    id: j.id, status: j.status, stage: j.stage,
    targetProfiles: j.targetProfiles,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    failureCode: j.failureCode || null,
    safeFailureMessage: j.safeFailureMessage || null,
    result: j.result || null,
    steps: j.steps || [],
  };
}

function enqueue(input) {
  const cfg = settings.load();
  const id = crypto.randomUUID();
  const target = (input.options && input.options.targetProfiles) || cfg.targetProfiles;
  const job = {
    id, status: 'queued', stage: 'QUEUED',
    targetProfiles: target,
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    failureCode: null, safeFailureMessage: null, result: null, steps: [],
    _options: input.options || {},
    _dob: input.dob || null,
    _gender: input.gender || null,
    _names: input.names || [],
  };
  _jobs.set(id, job);
  _secrets.set(id, {
    email: input.email,
    password: input.password,
    pins: input.pins || [],
    newPassword: input.newPassword || null,
  });
  _pending.push(id);
  _drain();
  return publicView(job);
}

function _drain() {
  const cfg = settings.load();
  while (_running < cfg.maxConcurrent && _pending.length) {
    const id = _pending.shift();
    _run(id);
  }
}

async function _run(id) {
  const job = _jobs.get(id);
  const sec = _secrets.get(id);
  if (!job || !sec) return;
  _running++;
  job.status = 'running'; job.stage = 'STARTING'; job.startedAt = Date.now();

  let ctx = null;
  try {
    ctx = await newIsolatedContext();
    const hooks = { onStep: (line) => { job.stage = String(line.msg || '').toUpperCase().slice(0, 40); } };
    const out = await runHboJob(ctx, {
      email: sec.email, password: sec.password,
      names: job._names, pins: sec.pins, newPassword: sec.newPassword,
      dob: job._dob, gender: job._gender, options: job._options,
    }, hooks);

    job.steps = out.steps || [];
    job.result = out.result || null;
    if (out.ok) { job.status = 'completed'; job.stage = 'COMPLETED'; }
    else { job.status = 'failed'; job.stage = 'FAILED'; job.failureCode = out.failureCode; job.safeFailureMessage = out.safeFailureMessage; }
  } catch (e) {
    job.status = 'failed'; job.stage = 'FAILED';
    job.failureCode = 'HBO_RUNNER_ERROR';
    job.safeFailureMessage = (e && e.message) ? e.message : 'runner error';
  } finally {
    job.finishedAt = Date.now();
    try { if (ctx) { await ctx.clearCookies().catch(() => {}); await ctx.close(); } } catch (_) {}
    wipeSecrets(id);
    _running--;
    _drain();
  }
}

function get(id) { return publicView(_jobs.get(id)); }
function list() { return [..._jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicView); }
function stats() {
  const cfg = settings.load();
  return { running: _running, queued: _pending.length, maxConcurrent: cfg.maxConcurrent };
}

module.exports = { enqueue, get, list, stats };
