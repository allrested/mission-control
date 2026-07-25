#!/usr/bin/env bash
set -e
ssh-keygen -A                     # generate host keys if missing
chmod 2775 /srv/repos 2>/dev/null || true
# Background reconcile loop.
( while true; do /usr/local/bin/reconcile-users.sh || true; sleep "${RECONCILE_INTERVAL:-30}"; done ) &

# Browser IDE proxy (per-user code-server). Needs MC_API_KEY + IDE_PROXY_SECRET.
if [ -n "${IDE_PROXY_SECRET:-}" ] && [ -n "${MC_API_KEY:-}" ]; then
  # Per-user code-server unix sockets live under here. Traverse-only, NOT
  # group-writable: a shared group-writable dir (even sticky) lets any devs
  # member CREATE a socket that doesn't exist yet at another user's path —
  # sticky only stops deleting an existing one. root creates each per-user
  # subdirectory (0700, owned by that user) before spawning into it, so no
  # other user can create anything under /run/ide at all.
  mkdir -p /run/ide
  chown root:root /run/ide
  chmod 0711 /run/ide
  echo "[mc-devshell] starting ide-proxy on :${IDE_PROXY_PORT:-8443}"
  ( cd /opt/ide-proxy && while true; do
      # A restarted proxy has an empty in-memory instance map — without this,
      # the next request per user unlinks their socket and spawns a fresh
      # code-server, orphaning the still-running old one (never swept, never
      # referenced again).
      # Anchored on the socket flag/path, not the full command line — the rest
      # (e.g. code-server's launcher passing its install dir as argv[1]) is
      # incidental and would silently stop matching on a version bump.
      pkill -f -- '--socket /run/ide/' || true
      node server.js || true
      echo "[ide-proxy] exited, restarting in 2s" >&2
      sleep 2
    done ) &
fi

echo "[mc-devshell] starting sshd on :22"
exec /usr/sbin/sshd -D -e
