#!/usr/bin/env bash
# Idempotently sync Linux users from Mission Control's user list.
#
# This script is the authoritative security boundary: it must defend itself
# against any username Mission Control hands it (including OAuth-derived
# names), not just ones that happen to already be well-formed.
set -euo pipefail
: "${MC_URL:?MC_URL required}"
: "${MC_API_KEY:?MC_API_KEY required}"

json="$(curl -fsS -H "x-api-key: ${MC_API_KEY}" "${MC_URL}/api/users/ssh-keys")" || { echo "reconcile: MC unreachable"; exit 0; }

seen=" "
while IFS= read -r row; do
  [ -z "$row" ] && continue
  uname="$(echo "$row" | jq -r '.username')"
  role="$(echo "$row" | jq -r '.role')"
  # Sanitize to a safe Linux username: lowercase, collapse anything outside
  # a-z0-9_- to '_', then strip leading non-alphanumerics so a normalized
  # name can never start with '-' (which useradd/usermod/id would otherwise
  # parse as an option) or be empty-but-truthy.
  luser="$(printf '%s' "$uname" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_' | sed 's/^[^a-z0-9]*//')"
  if [ -z "$luser" ]; then
    echo "reconcile: skipping unusable username '$uname'"
    continue
  fi
  case "$seen" in
    *" ${luser} "*) echo "reconcile: skipping duplicate normalized username $luser ($uname)"; continue ;;
  esac
  seen="${seen}${luser} "

  # Which MC account owns this Linux home. A username that is deleted in MC and
  # later recreated for a DIFFERENT person must not inherit the previous
  # person's home — their ~/.claude credentials, ~/.ssh and files live there.
  # Root-owned 0600 so the user can't forge it.
  mcid="$(echo "$row" | jq -r '.id // empty')"
  owner_file="/home/${luser}/.mc-owner"

  if id -- "$luser" >/dev/null 2>&1; then
    # Account already exists — only manage accounts WE created (members of
    # devs). Never adopt pre-existing system accounts (node, games, sync, ...)
    # just because a username happened to normalize onto one.
    if ! id -nG -- "$luser" 2>/dev/null | tr ' ' '\n' | grep -qx devs; then
      echo "reconcile: refusing to adopt existing non-devs account '$luser'"
      continue
    fi
    # Same username, different MC account → refuse rather than hand over the
    # old home. An admin resolves it (archive/remove the home, or rename).
    if [ -n "$mcid" ] && [ -s "$owner_file" ]; then
      prev="$(cat "$owner_file" 2>/dev/null)"
      if [ -n "$prev" ] && [ "$prev" != "$mcid" ]; then
        echo "reconcile: '$luser' home belongs to MC user id $prev, not $mcid — refusing to reassign"
        continue
      fi
    fi
  else
    if ! useradd -m -s /bin/bash -G devs -- "$luser"; then
      echo "reconcile: useradd failed for '$luser', skipping"
      continue
    fi
    ln -sfn /srv/repos "/home/${luser}/repos"
    mkdir -p "/home/${luser}/.claude" "/home/${luser}/.codex" "/home/${luser}/.ssh"
  fi
  # A pre-existing home dir (e.g. left over from a locked-out account whose
  # username got reused after a uid rollover) keeps its old owner — useradd -m
  # only chowns on fresh creation. Re-assert ownership every cycle so the
  # account always owns its own home (otherwise a stale uid match could let a
  # different current user read/write into it).
  chown "${luser}:${luser}" "/home/${luser}"
  chmod 700 "/home/${luser}"
  chmod 700 "/home/${luser}/.ssh"

  # Stamp/refresh the ownership marker. Homes provisioned before this existed
  # get claimed by their current MC account on the next cycle (there is no
  # earlier owner to conflict with), so upgrades are seamless.
  if [ -n "$mcid" ]; then
    printf '%s' "$mcid" > "$owner_file" 2>/dev/null || true
    chown root:root "$owner_file" 2>/dev/null || true
    chmod 600 "$owner_file" 2>/dev/null || true
  fi

  # Admin → sudo; otherwise ensure not in sudo.
  if [ "$role" = "admin" ]; then usermod -aG sudo -- "$luser" >/dev/null 2>&1 || true; else gpasswd -d "$luser" sudo >/dev/null 2>&1 || true; fi
  # Pubkey-only account: "*" unlocks PAM's account-locked check without enabling
  # password login (unlike the useradd default "!", which sshd/PAM reject as locked).
  usermod -p '*' -- "$luser" >/dev/null 2>&1 || true
  usermod -s /bin/bash -- "$luser" >/dev/null 2>&1 || true

  akeys="/home/${luser}/.ssh/authorized_keys"
  echo "$row" | jq -r '.public_keys[]?' > "$akeys"
  chown -R "${luser}:${luser}" "/home/${luser}/.ssh" "/home/${luser}/.claude" "/home/${luser}/.codex"
  chmod 600 "$akeys"
done < <(echo "$json" | jq -c '.[]')

# Lock devs-group users no longer present in MC (do not delete homes).
for luser in $(getent group devs | cut -d: -f4 | tr ',' ' '); do
  case "$seen" in
    *" ${luser} "*) : ;;
    *) usermod -L -- "$luser" >/dev/null 2>&1 || true; usermod -s /usr/sbin/nologin -- "$luser" >/dev/null 2>&1 || true
       : > "/home/$luser/.ssh/authorized_keys" 2>/dev/null || true ;;
  esac
done

# Windows bind-mount safety: ensure shared repos are group-usable.
chgrp -R devs /srv/repos >/dev/null 2>&1 || true
chmod -R g+rwX /srv/repos >/dev/null 2>&1 || true
