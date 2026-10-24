#!/usr/bin/env bash
# Deploy harvest-mcp v0.2.0 to Cloudflare Workers.
#
# Run from Terminal on the Mac:   bash ~/harvest-mcp/scripts/deploy-v0.2.0.sh
#
# What it does (stops at the first failure):
#   1. Installs dependencies and runs the test suite and type check.
#   2. Sets a fresh SESSION_SECRET on the Worker (required by v0.2.0; existing
#      connections are invalidated by this release anyway).
#   3. Deploys, then smoke-tests the live Worker.
#   4. Pushes the branch and fast-forwards main.
# After it finishes: reconnect the Harvest connector once in Claude
# (Settings > Connectors > Harvest > Disconnect, then Connect).
#
# Rollback if anything looks wrong:   npx --yes wrangler@4 rollback

set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_URL="https://spotlight-harvest-mcp.damon-7de.workers.dev"
BRANCH="v0.2.0-security"
WRANGLER="npx --yes wrangler@4"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  echo "Switching to $BRANCH (was on $current_branch)"
  git checkout "$BRANCH"
fi

echo "== 1/5 Install and test"
npm ci --no-audit --no-fund
npm test
npm run typecheck

echo "== 2/5 Cloudflare login check"
$WRANGLER whoami

echo "== 3/5 Setting a new SESSION_SECRET (value is generated locally and never printed)"
openssl rand -base64 48 | tr -d '\n' | $WRANGLER secret put SESSION_SECRET

echo "== 4/5 Deploying"
$WRANGLER deploy

echo "Smoke test..."
sleep 5
health="$(curl -fsS "$WORKER_URL/health")"
echo "$health" | grep -q '"version":"0.2.0"' || { echo "Health check did not report 0.2.0: $health"; exit 1; }
curl -fsS "$WORKER_URL/.well-known/oauth-authorization-server" | grep -q 'revocation_endpoint' \
  || { echo "OAuth metadata check failed"; exit 1; }
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL/mcp" -H 'Content-Type: application/json' -d '{}')"
[[ "$status" == "401" ]] || { echo "Expected 401 from /mcp without a token, got $status"; exit 1; }
echo "Live Worker is v0.2.0 and requires authorization."

echo "== 5/5 Pushing to GitHub"
git push -u origin "$BRANCH"
git checkout main
git pull --ff-only origin main
git merge --ff-only "$BRANCH"
git push origin main

echo
echo "Done. Next: in Claude, disconnect and reconnect the Harvest connector."
