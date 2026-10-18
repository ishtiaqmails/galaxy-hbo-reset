#!/usr/bin/env bash
# ============================================================================
#  HBO Max reset service — one-command installer.
#  Safe & self-contained: installs into /opt/hbo-reset, runs as its OWN pm2
#  app "hbo-reset-api" on its OWN port. Touches NOTHING of nf-reset / the bot.
#
#  Usage (on the droplet, one line):
#     cd /opt/hbo-reset && bash install.sh
#  or via the bootstrap one-liner in README_DEPLOY.md.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==> HBO reset installer  ($DIR)"

# 1) .env — create on first run with a random API key; never overwrite.
if [ ! -f "$DIR/.env" ]; then
  KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))' 2>/dev/null || openssl rand -hex 24)"
  cat > "$DIR/.env" <<EOF
# HBO reset service config — generated $(date -u +%FT%TZ)
HBO_PORT=8891
HBO_API_KEY=$KEY
EOF
  echo "==> wrote .env (HBO_PORT=8891, new HBO_API_KEY)"
else
  echo "==> .env already present — keeping it"
fi
# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a

# 2) deps
echo "==> npm install"
( cd "$DIR/svc" && npm install --no-audit --no-fund )

# 3) Playwright Chromium (+ OS deps). Skip the download if already present.
echo "==> ensuring Playwright Chromium"
( cd "$DIR/svc" && npx --yes playwright install chromium ) || true
( cd "$DIR/svc" && npx --yes playwright install-deps chromium ) 2>/dev/null || \
  echo "    (install-deps needs root; if the browser fails to launch, run: sudo npx playwright install-deps chromium)"

# 4) pm2 start/reload — its own app, env passed through.
echo "==> starting pm2 app hbo-reset-api"
if command -v pm2 >/dev/null 2>&1; then
  pm2 start "$DIR/svc/server.js" --name hbo-reset-api \
      --update-env --time \
      -- >/dev/null 2>&1 || true
  # ensure env vars reach the process
  HBO_PORT="${HBO_PORT:-8891}" HBO_API_KEY="${HBO_API_KEY}" \
    pm2 restart hbo-reset-api --update-env >/dev/null 2>&1 || \
    pm2 start "$DIR/svc/server.js" --name hbo-reset-api --update-env --time
  pm2 save >/dev/null 2>&1 || true
else
  echo "    pm2 not found — starting with node (foreground). Install pm2 for production:  npm i -g pm2"
fi

# 5) health check
sleep 2
PORT="${HBO_PORT:-8891}"
echo "==> health:"
curl -fsS "http://127.0.0.1:${PORT}/health" && echo || echo "    (not responding yet — check: pm2 logs hbo-reset-api)"

echo
echo "==> DONE."
echo "    Service:  hbo-reset-api   (pm2)"
echo "    Port:     ${PORT}"
echo "    API key:  in $DIR/.env  (HBO_API_KEY)"
echo "    Test:     curl -s http://127.0.0.1:${PORT}/health"
