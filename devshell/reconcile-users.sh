#!/usr/bin/env bash
# Idempotently sync Linux users from Mission Control's user list.
set -euo pipefail
: "${MC_URL:?MC_URL required}"
: "${MC_API_KEY:?MC_API_KEY required}"

json="$(curl -fsS -H "x-api-key: ${MC_API_KEY}" "${MC_URL}/api/users/ssh-keys")" || { echo "reconcile: MC unreachable"; exit 0; }

seen=" "
while IFS= read -r row; do
  [ -z "$row" ] && continue
  uname="$(echo "$row" | jq -r '.username')"
  role="$(echo "$row" | jq -r '.role')"
  # Sanitize to a safe Linux username.
  luser="$(echo "$uname" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_')"
  [ -z "$luser" ] && continue
  seen="${seen}${luser} "

  if ! id "$luser" >/dev/null 2>&1; then
    useradd -m -s /bin/bash -G devs "$luser"
    ln -sfn /srv/repos "/home/${luser}/repos"
    mkdir -p "/home/${luser}/.claude" "/home/${luser}/.codex" "/home/${luser}/.ssh"
  fi
  chmod 700 "/home/${luser}"
  chmod 700 "/home/${luser}/.ssh"

  # Admin → sudo; otherwise ensure not in sudo.
  if [ "$role" = "admin" ]; then usermod -aG sudo "$luser"; else gpasswd -d "$luser" sudo >/dev/null 2>&1 || true; fi
  usermod -U "$luser" >/dev/null 2>&1 || true
  usermod -s /bin/bash "$luser" >/dev/null 2>&1 || true

  akeys="/home/${luser}/.ssh/authorized_keys"
  echo "$row" | jq -r '.public_keys[]?' > "$akeys"
  chown -R "${luser}:${luser}" "/home/${luser}/.ssh" "/home/${luser}/.claude" "/home/${luser}/.codex"
  chmod 600 "$akeys"
done < <(echo "$json" | jq -c '.[]')

# Lock devs-group users no longer present in MC (do not delete homes).
for luser in $(getent group devs | cut -d: -f4 | tr ',' ' '); do
  case "$seen" in
    *" ${luser} "*) : ;;
    *) usermod -L "$luser" >/dev/null 2>&1 || true; usermod -s /usr/sbin/nologin "$luser" >/dev/null 2>&1 || true ;;
  esac
done

# Windows bind-mount safety: ensure shared repos are group-usable.
chgrp -R devs /srv/repos >/dev/null 2>&1 || true
chmod -R g+rwX /srv/repos >/dev/null 2>&1 || true
