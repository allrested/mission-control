#!/usr/bin/env bash
set -e
ssh-keygen -A                     # generate host keys if missing
chmod 2775 /srv/repos 2>/dev/null || true
# Background reconcile loop.
( while true; do /usr/local/bin/reconcile-users.sh || true; sleep "${RECONCILE_INTERVAL:-30}"; done ) &

# Browser IDE proxy (per-user code-server). Needs MC_API_KEY + IDE_PROXY_SECRET.
if [ -n "${IDE_PROXY_SECRET:-}" ] && [ -n "${MC_API_KEY:-}" ]; then
  # Per-user code-server unix sockets live here. root:devs + sticky bit: any
  # devs-group member can create their own socket (needed since code-server
  # runs as that user, not root), but the sticky bit stops one user from
  # deleting/replacing another user's socket file. The socket file itself is
  # created with --socket-mode 600 (owner-only), which is what actually blocks
  # a different user from connecting to it.
  mkdir -p /run/ide
  chown root:devs /run/ide
  chmod 1770 /run/ide
  echo "[mc-devshell] starting ide-proxy on :${IDE_PROXY_PORT:-8443}"
  ( cd /opt/ide-proxy && while true; do node server.js || true; echo "[ide-proxy] exited, restarting in 2s" >&2; sleep 2; done ) &
fi

echo "[mc-devshell] starting sshd on :22"
exec /usr/sbin/sshd -D -e
