# Multi-user dev-shell: per-user isolated SSH + browser IDE

**Date:** 2026-07-24
**Status:** Approved design → ready for implementation planning
**Repo:** `mission-control` (+ one new sibling container `mc-devshell`)

## Goal

Let multiple Mission Control users (teammates) do interactive coding — from a
phone or a desktop — each isolated to **their own workspace** and using **their
own Claude Code credentials**, without exposing Mission Control's hardened
control plane or one user's files to another.

Concretely:
- User A connects and sees only their own home + the shared repos. User B cannot
  see user A's home. **Admin sees everything.**
- Each user's interactive `claude` (and `codex`) picks up **their own**
  `~/.claude` / `~/.codex` — the settings.json/credentials they set up.
- Access works from a phone (small fixes, no laptop) and from a desktop (full
  power).

## Non-goals / out of scope

- **9remote** — evaluated and rejected as the multi-user layer: its auth is
  device-pairing (not per-user credentials) and it provides no per-user
  isolation ("all connected users access the same machine"). Isolating it would
  require one instance per user with an auth model that contradicts "SSH with
  their own credentials."
- **Password SSH auth** — public-key only.
- **Credential unification** (interactive `~/.claude` also driving Mission
  Control's automated *agent dispatch* for that user) — desirable but deferred;
  see "Future work."
- Modifying the existing Dokploy-managed `code-server` (fragile; superseded).

## Key constraint that shaped the design

You cannot have (one shared editor instance) + (per-user isolation) + (hosted in
the browser) simultaneously — a single code-server has one home/identity.
Isolation + hosted browser ⇒ **one code-server process per user**. These are
per-user *processes inside one container*, not extra containers.

Likewise, a multi-user SSH login server must be writable, root-capable, and
stateful — the opposite of Mission Control's hardened container (read-only root,
all caps dropped, non-root). Putting it in the MC container would place a
user-facing login server next to every agent credential and the dispatch control
plane. Therefore the dev environment lives in a **dedicated container**.

## Architecture

```
┌─ mission-control (hardened, unchanged runtime) ───────────────┐
│   + user_ssh_keys table (migration)                            │
│   + self-service SSH-key API + settings page                   │
│   + service endpoint listing users+keys (API-key auth)         │
└───────────────────────────────────────────────────────────────┘
              ▲ polls GET /api/users/ssh-keys (reconciler)
              │
┌─ mc-devshell (NEW container) ─────────────────────────────────┐
│   openssh-server + git + claude/codex CLIs                     │
│   reconciler loop  → creates/updates Linux users               │
│   sshd (pubkey-only, AllowGroups devs)   :22 → host :2222      │
│   [phase 2] per-user code-server + auth proxy  → host :8443    │
│   volume mc-homes:/home         (per-user Linux homes)         │
│   bind   <repos-host-dir> → /srv/repos   (shared, 2775 devs)   │
└───────────────────────────────────────────────────────────────┘
```

### Components & responsibilities

1. **`mc-devshell` image** — Debian + Node base with `openssh-server`, `git`,
   `@anthropic-ai/claude-code`, `@openai/codex` installed globally on PATH.
   Purpose: provide an isolated shell/IDE host. Depends on: nothing from MC at
   build time.

2. **Reconciler** (`reconcile-users.sh`, loop from entrypoint) — polls the MC
   service endpoint, and for each MC user idempotently ensures:
   - a Linux user exists (`useradd`, home `/home/<user>`, shell bash),
   - membership in group `devs`,
   - `sudo` group membership iff MC role is `admin`,
   - `~/.ssh/authorized_keys` = that user's registered public key(s), `chmod 700`
     on home and `600` on authorized_keys,
   - `~/repos` symlink → `/srv/repos`, and an empty `~/.claude` skeleton.
   Users present in the OS but absent from MC are **locked** (`usermod -L`,
   shell `/usr/sbin/nologin`), not deleted (homes preserved). Input: JSON from MC.
   Depends on: MC endpoint + a scoped API key.

3. **sshd** — `PubkeyAuthentication yes`, `PasswordAuthentication no`,
   `PermitRootLogin no`, `AllowGroups devs`. Port 22 → published `2222`.

4. **MC: `user_ssh_keys`** (migration) — `id, user_id, workspace_id,
   public_key, label, created_at`. One user may register multiple keys.

5. **MC: self-service key API**
   - `POST /api/me/ssh-keys` (any authenticated user) — add a key (validated as a
     well-formed OpenSSH public key; reject private keys).
   - `GET /api/me/ssh-keys` — list own keys.
   - `DELETE /api/me/ssh-keys/:id` — remove own key.

6. **MC: service endpoint** — `GET /api/users/ssh-keys` — API-key (service)
   auth; returns `[{ username, workspace_id, role, public_keys: [...] }]` for the
   reconciler. Never returns secrets.

7. **MC: "SSH Access" settings page** — manage keys + show connection help
   (`ssh <username>@<host> -p 2222`, and the phase-2 browser-IDE URL).

### Isolation model (standard Unix)

- `/home/<user>` `chmod 700`, owned `user:user` → no cross-user reads.
- `/srv/repos` group `devs`, mode `2775` (setgid) → all users share; new files
  inherit `devs`. Symlinked into each home as `~/repos`.
- **Admin** in `sudo` → reads every home and the whole tree.
- `claude`/`codex` default their config to `$HOME/.claude` / `$HOME/.codex`, so
  each user's credentials are naturally per-user.

## Access paths

- **SSH (phase 1):** VS Code Remote-SSH (desktop full IDE), any terminal, or a
  mobile SSH app — per-user keys, same isolated account, interactive `claude`
  with their creds.
- **Browser IDE (phase 2):** per-user `code-server` spawned on login, fronted by
  a small reverse proxy that authenticates against Mission Control's session and
  routes each user to their own instance. Responsive browser VS Code on mobile
  (small fixes, no laptop); full VS Code on desktop. Integrated terminal =
  interactive `claude` with their `~/.claude`.

## Phasing

- **Phase 1 (ship first):** `mc-devshell` container (sshd + CLIs + isolation),
  `user_ssh_keys` migration, self-service + service key APIs, SSH-key settings
  page, reconciler. Delivers per-user isolated SSH with their own Claude creds.
- **Phase 2:** per-user `code-server` + MC-authenticated proxy on the same
  container (browser IDE, mobile + desktop).

## Security posture

- dev-shell mounts only `/srv/repos` and `/home`; it has **no** access to MC's
  database, agent credentials, or dispatch control plane. A shell breakout
  reaches only repos + homes.
- Pubkey-only SSH; `AllowGroups devs`; no root login.
- Reconciler uses a dedicated, least-privilege service API key (read-only user
  list). Public keys only ever leave MC; private keys never touch MC.

## Success criteria / verification

1. Two MC users each register a key; both provisioned automatically by the
   reconciler.
2. User A SSHes in → sees `~` and `~/repos`; `cat /home/<userB>/…` → permission
   denied. User B symmetric. Admin (sudo) reads both homes.
3. Each user runs `claude` and logs in; their credentials persist in their own
   `~/.claude` and are used on their next session; the other user is unaffected.
4. Both users read/write `/srv/repos`; changes visible to the other.
5. Mission Control container is unchanged and still healthy; dev-shell cannot
   reach MC's DB or credential volume.

## Risks / open questions

- **Windows bind-mount permissions:** Docker Desktop on Windows maps bind-mount
  ownership loosely; `/srv/repos` group/setgid semantics may need a named volume
  or an entrypoint `chown/chmod` pass instead of relying on host perms. Validate
  early.
- **Reconciler cadence vs immediacy:** polling (e.g. 30s) is simplest; a
  push/trigger from MC on key change is a later refinement.
- **User deletion policy:** lock (not delete) on MC user removal to avoid data
  loss; revisit if operators want hard cleanup.
- **Phase-2 proxy auth:** must bind code-server to localhost and only expose via
  the MC-authenticated proxy, so instances aren't reachable unauthenticated.

## Future work

- Credential unification: mount `mc-homes` into Mission Control read-only and set
  each user's agent `dispatchConfigDir` to `/home/<user>/.claude`, so one login
  serves both interactive sessions and automated agent dispatch.
- Optional per-user resource limits (CPU/mem/pids) on spawned code-server.
