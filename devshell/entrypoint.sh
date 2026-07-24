#!/usr/bin/env bash
set -e
ssh-keygen -A                     # generate host keys if missing
chmod 2775 /srv/repos 2>/dev/null || true
# Background reconcile loop.
( while true; do /usr/local/bin/reconcile-users.sh || true; sleep "${RECONCILE_INTERVAL:-30}"; done ) &
echo "[mc-devshell] starting sshd on :22"
exec /usr/sbin/sshd -D -e
