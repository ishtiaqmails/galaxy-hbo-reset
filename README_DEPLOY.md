# HBO Max — Profiles/Screens Creator service

Self-contained automation that sits **beside** your `nf-reset` droplet service.
It runs as its **own** pm2 app (`hbo-reset-api`) on its **own** port (`8891`),
in its **own** folder (`/opt/hbo-reset`). It imports nothing from Netflix/Prime,
so it **cannot** affect them.

Same shape as your other two: `*Engine.js` + `*Queue.js` + `/hbo/jobs` endpoints,
x-api-key auth, one isolated browser context per job, secrets never stored.

---

## 1) Deploy (one command, on the droplet)

Paste this single line into the DigitalOcean console:

```
cd /opt && git clone https://github.com/ishtiaqmails/galaxy-hbo-reset hbo-reset && cd hbo-reset && bash install.sh
```

The installer: creates `.env` with a fresh random `HBO_API_KEY`, installs deps,
installs Playwright Chromium, starts `pm2 hbo-reset-api` on port 8891, and prints
a health check. Re-run `bash install.sh` any time to update after a `git pull`.

To update later:
```
cd /opt/hbo-reset && git pull && bash install.sh
```

Grab the API key when you need it:
```
grep HBO_API_KEY /opt/hbo-reset/.env
```

---

## 2) Test it (no bot needed)

```
KEY=$(grep HBO_API_KEY /opt/hbo-reset/.env | cut -d= -f2)

# dry run — logs in, reads profiles, builds a plan, CHANGES NOTHING
curl -s -X POST http://127.0.0.1:8891/hbo/jobs \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"email":"ACCOUNT_EMAIL","password":"ACCOUNT_PASSWORD",
       "names":["Screen 1","Screen 2","Screen 3","Screen 4","Screen 5"],
       "pins":["1973","6822","9730","2599","3069"],
       "options":{"dryRun":true}}'

# then poll:  curl -s http://127.0.0.1:8891/hbo/jobs/<id> -H "x-api-key: $KEY"
```

Set `"dryRun":false` for a real run. Add `"newPassword":"..."` to also change the
account password (optional). `names[0]`/`pins[0]` are the **primary** profile.

---

## 3) Endpoints

| Method | Path | Notes |
|---|---|---|
| GET  | `/health` | no key; liveness + queue stats |
| POST | `/hbo/jobs` | enqueue; returns job id |
| GET  | `/hbo/jobs` | list (safe views) |
| GET  | `/hbo/jobs/:id` | one job incl. `steps[]` log |
| GET  | `/hbo/jobs/:id/result` | safe result only |
| GET/POST | `/hbo/settings` | global avatarCategory / maxConcurrent / … |

All except `/health` require header `x-api-key: <HBO_API_KEY>`.

**Failure codes:** `HBO_LOGIN_FAILED`, `HBO_LOGIN_OTP_REQUIRED`,
`HBO_PROFILES_READ_FAILED`, `HBO_DELETE_FAILED`, `HBO_CREATE_FAILED`,
`HBO_PIN_FAILED`, `HBO_PRIMARY_PIN_FAILED`, `HBO_PASSWORD_CHANGE_FAILED`,
`HBO_VERIFICATION_FAILED`.

---

## 4) What a job does (delete + recreate)

1. Login (email + password; keeps the typed email past the "Did you mean…?" hint).
2. Read profiles, detect the primary (the one with no **Delete** control).
3. Delete every secondary.
4. Recreate Screen 2…N — real-keystroke name + DOB `01/01/1999` + gender
   *Prefer not to say* + a **House of the Dragon** avatar chosen at creation.
5. Primary: set a House-of-Dragon avatar, rename to `names[0]`.
6. Set PINs & locks — **primary first** (Reset PIN → account-password gate → new
   PIN), then each secondary (Lock toggle → Create PIN).
7. *(optional)* change the account password — done **last**.
8. Verify count + names.

Baked-in lessons from the live mapping: DOB/name/PIN use **real keystrokes**
(value injection leaves Save disabled); PIN digits typed one-per-box; the avatar
grid renders late (wait + retry); gender is required; pages load behind a spinner;
the primary id is read off its edit page, not the grid.

---

## 5) Later — bot + dashboard (Phase 3, not in this drop)

Mirror the Prime wiring exactly: a `hbo_profiles` delivery type, `hboBridge.js`
(calls `http://127.0.0.1:8891/hbo/jobs` with the key from `bot_settings`), a
"HBO Max Profiles/Screens Creator" bot service (ask email → password → confirm →
run → deliver 5 screens), and a galaxydash "HBO Max" section reading its jobs.
Say the word and I'll build those the same way.
