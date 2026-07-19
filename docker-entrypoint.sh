#!/bin/sh
set -e

. /app/scripts/load-env.sh

# --- Load .env as literal configuration if present ---
if [ -f /app/.env ]; then
  printf '[entrypoint] Loading .env\n'
  load_env_file /app/.env
fi

# --- Helper: generate a random hex secret ---
generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

SECRETS_FILE="/app/.data/.generated-secrets"

# Ensure secrets file has restrictive permissions if it exists
if [ -f "$SECRETS_FILE" ]; then
  chmod 600 "$SECRETS_FILE"
fi

# Load previously generated secrets if they exist
if [ -f "$SECRETS_FILE" ]; then
  printf '[entrypoint] Loading persisted secrets from .data\n'
  load_env_file "$SECRETS_FILE"
fi

# --- AUTH_SECRET ---
if [ -z "$AUTH_SECRET" ] || [ "$AUTH_SECRET" = "random-secret-for-legacy-cookies" ]; then
  AUTH_SECRET=$(generate_secret)
  printf '[entrypoint] Generated new AUTH_SECRET\n'
  printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET" >> "$SECRETS_FILE"
  export AUTH_SECRET
fi

# --- API_KEY ---
if [ -z "$API_KEY" ] || [ "$API_KEY" = "generate-a-random-key" ]; then
  API_KEY=$(generate_secret)
  printf '[entrypoint] Generated new API_KEY\n'
  printf 'API_KEY=%s\n' "$API_KEY" >> "$SECRETS_FILE"
  export API_KEY
fi

# --- Hermes autostart (gateway + web dashboard) ---
# Hermes lives on the data volume ($HOME=/app/.data) when installed via the
# dashboard. Started in the background so channels (Telegram/WhatsApp) survive
# container recreation. Set HERMES_AUTOSTART=false to disable.
HERMES_BIN="$HOME/.local/bin/hermes"
if [ "${HERMES_AUTOSTART:-true}" != "false" ] && [ -x "$HERMES_BIN" ]; then
  mkdir -p "$HOME/.hermes/logs"
  printf '[entrypoint] Starting hermes gateway\n'
  "$HERMES_BIN" gateway run >> "$HOME/.hermes/logs/gateway-entrypoint.log" 2>&1 &
  printf '[entrypoint] Starting hermes dashboard on :9119\n'
  "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open --skip-build >> "$HOME/.hermes/logs/dashboard-entrypoint.log" 2>&1 &
fi

printf '[entrypoint] Starting server\n'
exec node server.js
