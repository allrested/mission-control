#!/usr/bin/env bash
set -e
ssh-keygen -A                     # generate host keys if missing
chmod 2775 /srv/repos 2>/dev/null || true
# Background reconcile loop.
( while true; do /usr/local/bin/reconcile-users.sh || true; sleep "${RECONCILE_INTERVAL:-30}"; done ) &

# Browser IDE proxy (per-user code-server). Needs MC_API_KEY + IDE_PROXY_SECRET.
if [ -n "${IDE_PROXY_SECRET:-}" ] && [ -n "${MC_API_KEY:-}" ]; then
  echo "[mc-devshell] starting ide-proxy on :${IDE_PROXY_PORT:-8443}"
  ( cd /opt/ide-proxy && node server.js >> /tmp/ide-proxy.log 2>&1 ) &
fi

echo "[mc-devshell] starting sshd on :22"
exec /usr/sbin/sshd -D -e
