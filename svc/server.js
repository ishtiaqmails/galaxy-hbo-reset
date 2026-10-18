'use strict';
/**
 * HBO Max reset service — standalone HTTP API.
 * Mirrors the nf-reset console shape (x-api-key, /hbo/jobs) but runs as its OWN
 * process on its OWN port, so it cannot affect the Netflix/Prime services.
 *
 * Endpoints (all require header  x-api-key: <HBO_API_KEY>  except /health):
 *   GET  /health                      -> liveness + queue stats
 *   POST /hbo/jobs                     -> enqueue a job (body below)
 *   GET  /hbo/jobs                     -> list jobs (safe views)
 *   GET  /hbo/jobs/:id                 -> one job (incl. step log)
 *   GET  /hbo/jobs/:id/result          -> safe result only
 *   GET  /hbo/settings                 -> global settings
 *   POST /hbo/settings                 -> patch global settings (avatarCategory, maxConcurrent, …)
 *
 * POST /hbo/jobs body:
 *   {
 *     "email": "...", "password": "...",
 *     "names": ["Screen 1","Screen 2","Screen 3","Screen 4","Screen 5"],
 *     "pins":  ["1973","6822","9730","2599","3069"],
 *     "newPassword": "optional-new-account-password",
 *     "dob": { "mm":"01","dd":"01","yyyy":"1999" },
 *     "gender": "Prefer not to say",
 *     "options": { "targetProfiles":5, "avatarCategory":"House of The Dragon",
 *                  "renamePrimary":true, "dryRun":false }
 *   }
 * names[0]/pins[0] are the PRIMARY (account-holder) profile.
 */
const express = require('express');
const queue = require('./hboQueue');
const settings = require('./settings');

const PORT = parseInt(process.env.HBO_PORT || '8891', 10);
const API_KEY = process.env.HBO_API_KEY || '';

const app = express();
app.use(express.json({ limit: '256kb' }));

function auth(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'HBO_API_KEY not configured' });
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hbo-reset', ...queue.stats() });
});

app.post('/hbo/jobs', auth, (req, res) => {
  const b = req.body || {};
  if (!b.email || !b.password) return res.status(400).json({ error: 'email and password required' });
  const cfg = settings.load();
  const target = (b.options && b.options.targetProfiles) || cfg.targetProfiles;
  if (!Array.isArray(b.names) || b.names.length !== target) return res.status(400).json({ error: `names must have ${target} entries` });
  if (!Array.isArray(b.pins) || b.pins.length !== target) return res.status(400).json({ error: `pins must have ${target} entries` });
  if (!b.pins.every((p) => /^\d{4}$/.test(String(p)))) return res.status(400).json({ error: 'each pin must be 4 digits' });
  try {
    const view = queue.enqueue(b);
    res.status(202).json(view);
  } catch (e) {
    res.status(400).json({ error: e.message || 'bad request' });
  }
});

app.get('/hbo/jobs', auth, (_req, res) => res.json(queue.list()));
app.get('/hbo/jobs/:id', auth, (req, res) => {
  const j = queue.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});
app.get('/hbo/jobs/:id/result', auth, (req, res) => {
  const j = queue.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({ id: j.id, status: j.status, failureCode: j.failureCode, safeFailureMessage: j.safeFailureMessage, result: j.result });
});

app.get('/hbo/settings', auth, (_req, res) => res.json(settings.load()));
app.post('/hbo/settings', auth, (req, res) => res.json(settings.save(req.body || {})));

app.listen(PORT, () => {
  console.log(`[hbo-reset] listening on :${PORT}`);
});
