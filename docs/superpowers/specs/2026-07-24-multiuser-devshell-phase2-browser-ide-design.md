# Multi-user dev-shell Phase 2: per-user browser IDE (code-server)

**Date:** 2026-07-24
**Status:** Approved design → ready for implementation planning
**Repo:** `mission-control` (MC additions) + the existing `mc-devshell` container (Phase 1)
**Builds on:** `2026-07-24-multiuser-devshell-design.md` (Phase 1 — per-user SSH + reconciler)

## Goal

Give each Mission Control user a **browser-based VS Code** (code-server) on their
own isolated dev-shell account — usable from a phone (quick fixes, no laptop) and
full-featured on desktop — reached with **one click from Mission Control**, with
**no separate password** and **no SSH client**. The integrated terminal runs as
that Linux user, so `claude`/`codex`/`hermes` use their own `~/.claude` and see
only their home + the shared repos (the Phase 1 isolation).

Concretely:
- In MC, a user clicks **Open IDE** → a browser tab opens their code-server.
- User A's IDE shows `/home/usera` + `~/repos`; user B's shows `/home/userb`; neither can see the other's home. Each terminal is that user's shell with their credentials.
- Works on mobile browser and desktop; MC login is the only auth.

## Non-goals / out of scope

- **TLS termination in the proxy.** Real phone/remote access needs HTTPS (secure
  cookies + browser WebSockets); that's provided by a tunnel / reverse proxy with
  a cert *in front of* `:8443`, not built into the proxy. `localhost` is a secure
  context, so local testing over http works. (Deployment requirement, below.)
- **Sharing/collaboration in one instance** — each user gets their own instance.
- **Admin cross-user IDE** — admins use SSH+sudo (Phase 1) to reach other homes;
  the IDE always routes a user to *their own* instance.
- **Changing Mission Control's hardened runtime** beyond the small additive
  endpoints + UI below.

## Key constraints that shaped the design (decided in brainstorming)

1. **MC's session cookie is host-locked** (`__Host-mc-session`), so it is never
   sent to the IDE on a different origin. → **token handoff**: MC mints a
   short-lived token the proxy redeems, and the proxy issues its *own* session.
2. **A single code-server instance has one identity/home**, so isolation +
   hosted-browser ⇒ **one code-server process per user** (per-user *processes*
   inside the one `mc-devshell` container, not extra containers). Spawned on
   demand, idle-stopped.

## Architecture

```
┌─ mission-control (hardened; small additive changes) ──────────────┐
│  + ide_handoff_tokens table (migration)                            │
│  + POST /api/ide/token   (session-authed) — mint 60s single-use    │
│  + POST /api/ide/redeem  (service-authed, MC_API_KEY) — exchange   │
│  + "Open IDE" button in the SSH Access settings section            │
└────────────────────────────────────────────────────────────────────┘
        ▲ redeem(token) → {username, role}          ▲ /api/users/ssh-keys
        │ (proxy → MC, service key)                 │ (Phase 1 reconciler)
┌─ mc-devshell (Phase 1 container; Phase 2 adds the IDE tier) ───────┐
│  ide-proxy (Node, runs as root)   :8443 → host ${DEVSHELL_IDE_PORT}│
│    /auth?token=…  → redeem at MC → set signed IDE session cookie   │
│    every request → validate cookie → route to user's code-server  │
│    spawn on demand: code-server --auth none --bind 127.0.0.1:<port>│
│                     via runuser -u <linuxuser>, HOME=/home/<user>  │
│    idle sweeper: kill instances idle > IDE_IDLE_MINUTES            │
│  per-user code-server processes (localhost-only; proxy-reachable)  │
│  sshd + reconciler (Phase 1, unchanged)                            │
│  volume mc-homes:/home   ·   bind repos → /srv/repos               │
└────────────────────────────────────────────────────────────────────┘
```

### Components & responsibilities

1. **MC: `ide_handoff_tokens`** (migration) — `id, token_hash, user_id,
   workspace_id, expires_at, used_at, created_at`. Tokens stored **hashed**
   (SHA-256), single-use (`used_at`), short TTL.

2. **MC: `POST /api/ide/token`** (`requireRole('viewer')` — any authenticated
   user) — mint a random token bound to `auth.user`, store its hash with
   `expires_at = now + 60s`, return `{ url: "<devshell-ide-url>/auth?token=<raw>" }`.
   The raw token is returned once, never stored.

3. **MC: `POST /api/ide/redeem`** (`requireRole('admin')` — the proxy uses the
   global `MC_API_KEY`, admin scope) — body `{ token }`. Look up by hash, reject
   if missing / expired / already used; atomically mark `used_at`; return
   `{ username, role, workspace_id }`. One-time.

4. **MC: "Open IDE" button** in `ssh-access-section.tsx` — calls
   `POST /api/ide/token`, then `window.open(resp.url)`.

5. **devshell: `ide-proxy`** (new Node service, `devshell/ide-proxy/`, runs as
   root so it can spawn per-user processes):
   - `GET /auth?token=…` → `POST {MC_URL}/api/ide/redeem` (header
     `x-api-key: MC_API_KEY`) → on success, resolve the Linux username
     (**same sanitization the Phase 1 reconciler uses**), set a signed IDE
     session cookie (HMAC-SHA256 over `username|exp` with `IDE_PROXY_SECRET`,
     `HttpOnly`, `SameSite=Lax`, `Secure` when behind TLS, ~12h), redirect to `/`.
   - Every other request: verify the IDE cookie; 401→redirect to a "session
     expired, reopen from Mission Control" page if absent/invalid.
   - Map cookie's `username` → its code-server instance; **spawn on first use**;
     reverse-proxy HTTP **and** WebSocket upgrades to `127.0.0.1:<port>`.
   - **Never** trust a username/path from the URL — always the validated cookie.

6. **devshell: per-user code-server** — `code-server --auth none
   --bind-addr 127.0.0.1:<port>` launched via `runuser -u <linuxuser> --`,
   `HOME=/home/<user>`, cwd `/home/<user>`. Added to the devshell image. Bound to
   localhost only — reachable *only* through the proxy.

7. **devshell: spawner + idle sweeper** (inside ide-proxy) — track
   `username → { port, pid, lastSeen }`; allocate a free port in
   `IDE_PORT_RANGE` (default 9000–9099); update `lastSeen` on each proxied
   request; a periodic sweep kills instances idle > `IDE_IDLE_MINUTES` (default
   30) and frees the port; next visit re-spawns.

### Token-handoff flow (end to end)

1. User (logged into MC) clicks **Open IDE** → `POST /api/ide/token`.
2. MC stores `sha256(token)` + `user_id` + `expires_at(now+60s)`, returns
   `{url: "https://<devshell-host>:8443/auth?token=<raw>"}`.
3. Browser opens that URL → ide-proxy `POST {MC_URL}/api/ide/redeem {token}`
   with the service API key.
4. MC validates (unexpired, unused), marks used, returns `{username, role}`.
5. Proxy resolves the Linux user, sets its signed IDE session cookie, redirects `/`.
6. Proxy spawns (or reuses) that user's code-server and proxies to it. Done.

### Isolation & security

- Handoff token: random, **hashed at rest**, single-use, 60s TTL — replay/expiry rejected.
- IDE session: HMAC-signed cookie (`IDE_PROXY_SECRET`), validated every request
  incl. WS upgrade; routing keyed on the **validated cookie identity**, never a URL param.
- code-server instances **bound to `127.0.0.1`** — never exposed directly; the
  proxy is the only surface on `:8443`.
- Each instance runs as the user's uid in their `chmod 700` home (Phase 1
  isolation) — user A can't read user B's files through their IDE/terminal.
- The privileged spawner lives in `mc-devshell` (already a separate, non-MC
  container) — a breakout reaches only repos + homes, never MC's control plane.
- Linux-username resolution **must byte-match the Phase 1 reconciler's
  sanitization** (lowercase → `tr -c 'a-z0-9_-' '_'` → strip leading
  non-alnum), or the proxy would spawn for the wrong/absent account.

## Data model

`ide_handoff_tokens`: `id INTEGER PK`, `token_hash TEXT NOT NULL UNIQUE`,
`user_id INTEGER NOT NULL`, `workspace_id INTEGER NOT NULL DEFAULT 1`,
`expires_at INTEGER NOT NULL`, `used_at INTEGER NULL`,
`created_at INTEGER NOT NULL DEFAULT (unixepoch())`. Index on `token_hash`.
Expired/used rows pruned opportunistically on mint.

## Defaults

Token TTL 60s, single-use · IDE session cookie 12h · idle timeout 30 min
(`IDE_IDLE_MINUTES`) · code-server port range 9000–9099 (`IDE_PORT_RANGE`) ·
IDE port published as `${DEVSHELL_IDE_PORT:-8443}`.

## Dependencies on Phase 1

- The reconciler already provisions a Linux account + home for **every** MC user
  (it iterates all users from `/api/users/ssh-keys`; `authorized_keys` is just
  empty for keyless users). So the browser IDE works **without** an SSH key — but
  a brand-new MC user needs **one reconcile cycle** before their account exists.
  The proxy must handle "account not provisioned yet" with a clear retry message,
  not a 500.
- Shared repos, `devs` group, per-user `~/.claude` — all from Phase 1.

## Deployment requirements

- **TLS in front of `:8443`** for real mobile/remote use (secure cookies +
  browser WS). Local testing over `http://localhost:8443` works (localhost is a
  secure context).
- **Port `8443`** currently belongs to the (unused, Dokploy) code-server — retire
  that or set `DEVSHELL_IDE_PORT` to another port.
- `IDE_PROXY_SECRET` and `MC_API_KEY` must be set for the devshell service.

## Success criteria / verification

Scripted (final plan task; reuses the Phase 1 two-user harness — `usera`,
`userb`, `tadmin`):
1. **Handoff + routing:** mint a token as userA (`/api/ide/token` with userA's MC
   session), redeem at the proxy, get the IDE cookie, hit `/` → a running
   code-server responds. Repeat for userB.
2. **Per-user isolation:** `docker exec mc-devshell ps -o user,pid,args | grep code-server`
   → userA's instance runs as **usera**, userB's as **userb**, on distinct
   localhost ports; each instance's `HOME`/cwd is that user's home.
3. **Cross-user denial:** userA's IDE cookie only ever routes to userA's instance.
4. **Token safety:** replay a used token → rejected; expired token → rejected.
5. **No direct exposure:** from outside the container, `curl http://localhost:<port>`
   for a code-server port → refused (127.0.0.1-bound).
6. **Idle shutdown:** after `IDE_IDLE_MINUTES`, the process is gone; revisiting re-spawns it.

Manual: log into MC as userA → Open IDE → editor shows `/home/usera`, terminal
`whoami`=usera, `claude` uses userA's login; userB in a separate browser →
`/home/userb`; both work simultaneously; A can't see B's files.

## Risks / open questions

- **Concurrent spawn race** on the same user's first two requests → guard with a
  per-user spawn lock (in-proxy).
- **Port exhaustion** if many users are active at once → cap concurrent instances;
  log + reject with a clear message past the cap (don't silently fail).
- **code-server resource use** — each instance is a Node process; the idle sweeper
  bounds RAM. Consider per-instance mem limits later.
- **WebSocket + `__Host`/secure cookie** quirks behind a tunnel — validate the WS
  upgrade path early with a real TLS front.
- **First-visit-before-reconcile** — handled by the retry message, but worth an
  explicit "provisioning…" UX.

## Out of scope / future

- Per-instance CPU/mem cgroup limits.
- Reusing the interactive `~/.claude` as the user's MC *agent* dispatch
  credentials (the Phase 1 "credential unification" future-work item).
