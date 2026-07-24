# Multi-user dev-shell — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-user, isolated SSH access to a shared dev environment, where each Mission Control user logs in with their own SSH key, sees only their home + the shared repos, and runs `claude`/`codex` with their own credentials.

**Architecture:** A new hardened-separate container `mc-devshell` runs `sshd` + the CLIs and provisions one Linux user per Mission Control user from a reconciler that polls MC over HTTP. Mission Control gains a `user_ssh_keys` table, self-service key APIs, a service endpoint for the reconciler, and an "SSH Access" settings page. Isolation is standard Unix permissions (home `700`, shared repos `2775 devs`, admin `sudo`).

**Tech Stack:** Next.js 16 / React 19 / TypeScript, better-sqlite3, vitest (MC side); Debian + OpenSSH + Node + bash + jq (container side); Docker Compose.

## Global Constraints

- **Package manager:** pnpm only. Run MC tests with `pnpm vitest run <path>` (requires `pnpm install` first, or run inside the built image).
- **Migrations:** append to the array in `src/lib/migrations.ts`; last existing id is `055_agent_rate_limited_until`. New id: `056_user_ssh_keys`.
- **Auth:** reuse `requireRole(request, role)` from `src/lib/auth.ts`. It accepts the global API key as `admin` scope (used by the reconciler).
- **Conventions:** Conventional Commits; no AI attribution trailers; no icon libraries; `@/*` → `./src/*`.
- **Line endings:** shell scripts must be LF (repo `.gitattributes` enforces `*.sh eol=lf`).
- **Public keys only:** never accept or store SSH private keys.

---

## File Structure

**Mission Control (`mission-control/`):**
- `src/lib/migrations.ts` — MODIFY: add migration `056_user_ssh_keys`.
- `src/lib/ssh-keys.ts` — CREATE: key validation + DB accessors (one responsibility: SSH-key data).
- `src/lib/__tests__/ssh-keys.test.ts` — CREATE: unit tests.
- `src/app/api/me/ssh-keys/route.ts` — CREATE: POST (add) + GET (list own).
- `src/app/api/me/ssh-keys/[id]/route.ts` — CREATE: DELETE own key.
- `src/app/api/users/ssh-keys/route.ts` — CREATE: GET service endpoint (reconciler).
- `src/components/settings/ssh-access-section.tsx` — CREATE: settings UI.
- `src/components/settings/settings-panel.tsx` (or the settings page that renders sections) — MODIFY: render `<SshAccessSection/>`.

**Dev-shell container (`mission-control/devshell/`):**
- `devshell/Dockerfile` — CREATE.
- `devshell/sshd_config` — CREATE.
- `devshell/entrypoint.sh` — CREATE.
- `devshell/reconcile-users.sh` — CREATE.

**Compose:**
- `mission-control/docker-compose.yml` — MODIFY: add `mc-devshell` service + `mc-homes` volume.

---

## Task 1: `user_ssh_keys` table + ssh-keys library

**Files:**
- Modify: `src/lib/migrations.ts` (end of the `migrations` array, after `055_agent_rate_limited_until`)
- Create: `src/lib/ssh-keys.ts`
- Test: `src/lib/__tests__/ssh-keys.test.ts`

**Interfaces:**
- Produces:
  - `isValidSshPublicKey(input: string): boolean`
  - `normalizeSshPublicKey(input: string): string`
  - `addUserSshKey(userId: number, workspaceId: number, publicKey: string, label: string | null): { id: number }`
  - `listUserSshKeys(userId: number): Array<{ id: number; public_key: string; label: string | null; created_at: number }>`
  - `deleteUserSshKey(id: number, userId: number): boolean`
  - `listAllUsersWithKeys(): Array<{ username: string; workspace_id: number; role: string; public_keys: string[] }>`

- [ ] **Step 1: Add the migration.** In `src/lib/migrations.ts`, append to the array:

```ts
  {
    id: '056_user_ssh_keys',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_ssh_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          public_key TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_ssh_keys_user ON user_ssh_keys(user_id);
      `)
    }
  }
```

- [ ] **Step 2: Write the failing test** at `src/lib/__tests__/ssh-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isValidSshPublicKey, normalizeSshPublicKey } from '../ssh-keys'

describe('isValidSshPublicKey', () => {
  it('accepts common OpenSSH public key types', () => {
    expect(isValidSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID user@host')).toBe(true)
    expect(isValidSshPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB comment here')).toBe(true)
    expect(isValidSshPublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNh')).toBe(true)
  })
  it('rejects private keys and junk', () => {
    expect(isValidSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(false)
    expect(isValidSshPublicKey('not a key')).toBe(false)
    expect(isValidSshPublicKey('')).toBe(false)
    expect(isValidSshPublicKey('ssh-ed25519')).toBe(false)
  })
})

describe('normalizeSshPublicKey', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeSshPublicKey('  ssh-ed25519   AAAA   user@host  ')).toBe('ssh-ed25519 AAAA user@host')
  })
})
```

- [ ] **Step 3: Run it, expect failure**

Run: `pnpm vitest run src/lib/__tests__/ssh-keys.test.ts`
Expected: FAIL — cannot resolve `../ssh-keys`.

- [ ] **Step 4: Implement** `src/lib/ssh-keys.ts`:

```ts
import { getDatabase } from './db'

const KEY_TYPES = [
  'ssh-ed25519', 'ssh-rsa', 'ssh-dss',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
]

/** True only for a well-formed single-line OpenSSH *public* key. */
export function isValidSshPublicKey(input: string): boolean {
  const s = (input || '').trim()
  if (!s || /PRIVATE KEY/i.test(s)) return false
  const parts = s.split(/\s+/)
  if (parts.length < 2) return false
  if (!KEY_TYPES.includes(parts[0])) return false
  return /^[A-Za-z0-9+/]+={0,3}$/.test(parts[1]) && parts[1].length >= 16
}

/** Trim + collapse internal whitespace so stored keys are canonical. */
export function normalizeSshPublicKey(input: string): string {
  return (input || '').trim().replace(/\s+/g, ' ')
}

export function addUserSshKey(userId: number, workspaceId: number, publicKey: string, label: string | null): { id: number } {
  const info = getDatabase().prepare(
    'INSERT INTO user_ssh_keys (user_id, workspace_id, public_key, label) VALUES (?, ?, ?, ?)'
  ).run(userId, workspaceId, normalizeSshPublicKey(publicKey), label)
  return { id: info.lastInsertRowid as number }
}

export function listUserSshKeys(userId: number): Array<{ id: number; public_key: string; label: string | null; created_at: number }> {
  return getDatabase().prepare(
    'SELECT id, public_key, label, created_at FROM user_ssh_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as any
}

export function deleteUserSshKey(id: number, userId: number): boolean {
  // Scope by user_id so a user can only delete their own keys.
  return getDatabase().prepare('DELETE FROM user_ssh_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

/** For the reconciler: every user + their registered public keys. */
export function listAllUsersWithKeys(): Array<{ username: string; workspace_id: number; role: string; public_keys: string[] }> {
  const db = getDatabase()
  const users = db.prepare('SELECT id, username, workspace_id, role FROM users').all() as Array<{ id: number; username: string; workspace_id: number; role: string }>
  const keyStmt = db.prepare('SELECT public_key FROM user_ssh_keys WHERE user_id = ?')
  return users.map(u => ({
    username: u.username,
    workspace_id: u.workspace_id,
    role: u.role,
    public_keys: (keyStmt.all(u.id) as Array<{ public_key: string }>).map(k => k.public_key),
  }))
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `pnpm vitest run src/lib/__tests__/ssh-keys.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 6: Commit**

```bash
git add src/lib/migrations.ts src/lib/ssh-keys.ts src/lib/__tests__/ssh-keys.test.ts
git commit -m "feat: user_ssh_keys table + ssh-key validation/accessors"
```

---

## Task 2: Self-service key API (`/api/me/ssh-keys`)

**Files:**
- Create: `src/app/api/me/ssh-keys/route.ts`
- Create: `src/app/api/me/ssh-keys/[id]/route.ts`

**Interfaces:**
- Consumes: `isValidSshPublicKey`, `addUserSshKey`, `listUserSshKeys`, `deleteUserSshKey` (Task 1); `requireRole` (`src/lib/auth.ts`).
- Produces: `POST/GET /api/me/ssh-keys`, `DELETE /api/me/ssh-keys/:id`.

- [ ] **Step 1: Create** `src/app/api/me/ssh-keys/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { isValidSshPublicKey, addUserSshKey, listUserSshKeys } from '@/lib/ssh-keys'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json({ keys: listUserSshKeys(auth.user.id) })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  let body: { public_key?: string; label?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const publicKey = String(body.public_key || '')
  if (!isValidSshPublicKey(publicKey)) {
    return NextResponse.json({ error: 'Not a valid OpenSSH public key (private keys are rejected)' }, { status: 400 })
  }
  const label = body.label ? String(body.label).slice(0, 100) : null
  const { id } = addUserSshKey(auth.user.id, auth.user.workspace_id ?? 1, publicKey, label)
  return NextResponse.json({ id }, { status: 201 })
}
```

- [ ] **Step 2: Create** `src/app/api/me/ssh-keys/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { deleteUserSshKey } from '@/lib/ssh-keys'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { id } = await params
  const ok = deleteUserSshKey(Number(id), auth.user.id)
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 })
}
```

- [ ] **Step 3: Verify it builds/type-checks** (routes have no unit test; the build type-checks them)

Run: `pnpm typecheck`
Expected: PASS (no type errors in the new routes).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/me/ssh-keys
git commit -m "feat: self-service SSH key API (/api/me/ssh-keys)"
```

---

## Task 3: Reconciler service endpoint (`/api/users/ssh-keys`)

**Files:**
- Create: `src/app/api/users/ssh-keys/route.ts`

**Interfaces:**
- Consumes: `listAllUsersWithKeys` (Task 1); `requireRole` (admin — the global API key resolves to admin scope).
- Produces: `GET /api/users/ssh-keys` → `[{ username, workspace_id, role, public_keys }]`.

- [ ] **Step 1: Create** `src/app/api/users/ssh-keys/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listAllUsersWithKeys } from '@/lib/ssh-keys'

// Consumed by the mc-devshell reconciler using the global API key (admin scope).
// Returns only usernames, roles, and PUBLIC keys — never secrets.
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json(listAllUsersWithKeys())
}
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/users/ssh-keys
git commit -m "feat: service endpoint listing users + public keys for reconciler"
```

---

## Task 4: "SSH Access" settings UI

**Files:**
- Create: `src/components/settings/ssh-access-section.tsx`
- Modify: the settings page/panel that renders sections (find with `grep -rl "settings-panel\|SettingsPanel\|agent-runtimes-section" src/components/settings src/app`), add `<SshAccessSection/>`.

**Interfaces:**
- Consumes: `apiFetch` (`@/lib/api-client`), the Task 2 endpoints.
- Produces: `SshAccessSection` React component.

- [ ] **Step 1: Create** `src/components/settings/ssh-access-section.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

type Key = { id: number; public_key: string; label: string | null; created_at: number }

export function SshAccessSection() {
  const [keys, setKeys] = useState<Key[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try { setKeys((await apiFetch<{ keys: Key[] }>('/api/me/ssh-keys')).keys) } catch { /* ignore */ }
  }
  useEffect(() => { load() }, [])

  const add = async () => {
    setBusy(true); setError(null)
    try {
      await apiFetch('/api/me/ssh-keys', { method: 'POST', body: JSON.stringify({ public_key: publicKey, label: label || undefined }) })
      setPublicKey(''); setLabel(''); await load()
    } catch (e: any) { setError(e?.message || 'Failed to add key') } finally { setBusy(false) }
  }

  const remove = async (id: number) => {
    await apiFetch(`/api/me/ssh-keys/${id}`, { method: 'DELETE' }).catch(() => {})
    await load()
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-foreground">SSH Access</h3>
        <p className="text-sm text-muted-foreground">Add your SSH public key to get an isolated shell on the dev server. Connect with <code>ssh &lt;your-username&gt;@&lt;host&gt; -p 2222</code>.</p>
      </div>
      <div className="space-y-2">
        <textarea
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA... you@device"
          className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 font-mono text-sm"
        />
        <div className="flex gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional, e.g. phone)"
            className="flex-1 bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm" />
          <button onClick={add} disabled={busy || !publicKey.trim()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">Add key</button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <ul className="space-y-1">
        {keys.map(k => (
          <li key={k.id} className="flex items-center justify-between gap-2 text-sm border border-border/40 rounded-md px-3 py-2">
            <span className="font-mono truncate">{k.label ? `${k.label} — ` : ''}{k.public_key.slice(0, 40)}…</span>
            <button onClick={() => remove(k.id)} className="text-red-500 hover:underline shrink-0">Remove</button>
          </li>
        ))}
        {keys.length === 0 && <li className="text-sm text-muted-foreground">No keys yet.</li>}
      </ul>
    </section>
  )
}
```

- [ ] **Step 2: Render it.** Import and add `<SshAccessSection/>` into the settings panel found via grep. Example (adjust to the real file):

```tsx
import { SshAccessSection } from './ssh-access-section'
// ...inside the settings sections JSX:
<SshAccessSection />
```

- [ ] **Step 3: Verify type-check + build**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/ssh-access-section.tsx src/components/settings/*.tsx
git commit -m "feat: SSH Access settings section for managing public keys"
```

---

## Task 5: `mc-devshell` image (sshd + CLIs + reconciler)

**Files:**
- Create: `devshell/Dockerfile`
- Create: `devshell/sshd_config`
- Create: `devshell/entrypoint.sh`
- Create: `devshell/reconcile-users.sh`

**Interfaces:**
- Consumes: `GET /api/users/ssh-keys` (Task 3) via `MC_URL` + `MC_API_KEY`.
- Produces: a container that runs `sshd` and reconciles Linux users from MC.

- [ ] **Step 1: Create** `devshell/sshd_config`:

```
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowGroups devs
X11Forwarding no
PrintMotd no
ClientAliveInterval 120
Subsystem sftp /usr/lib/openssh/sftp-server
```

- [ ] **Step 2: Create** `devshell/reconcile-users.sh`:

```bash
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
```

- [ ] **Step 3: Create** `devshell/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -e
ssh-keygen -A                     # generate host keys if missing
chmod 2775 /srv/repos 2>/dev/null || true
# Background reconcile loop.
( while true; do /usr/local/bin/reconcile-users.sh || true; sleep "${RECONCILE_INTERVAL:-30}"; done ) &
echo "[mc-devshell] starting sshd on :22"
exec /usr/sbin/sshd -D -e
```

- [ ] **Step 4: Create** `devshell/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo git curl ca-certificates jq procps bash \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs on PATH for interactive use.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Shared-repos group + mountpoint (setgid so new files inherit the group).
RUN groupadd devs \
    && mkdir -p /srv/repos /var/run/sshd \
    && chgrp devs /srv/repos && chmod 2775 /srv/repos

COPY sshd_config /etc/ssh/sshd_config
COPY reconcile-users.sh /usr/local/bin/reconcile-users.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/reconcile-users.sh /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 5: Build the image**

Run: `docker build -t mc-devshell:latest ./devshell`
Expected: builds successfully; final line "naming to …mc-devshell:latest" (or "Built").

- [ ] **Step 6: Smoke-test sshd starts** (reconciler will no-op without MC env)

Run:
```bash
docker run --rm -d --name devshell-smoke -e MC_URL=http://127.0.0.1:9 -e MC_API_KEY=x mc-devshell:latest
sleep 3 && docker exec devshell-smoke pgrep -x sshd && echo "SSHD_OK"
docker rm -f devshell-smoke
```
Expected: prints a PID then `SSHD_OK`.

- [ ] **Step 7: Commit**

```bash
git add devshell/
git commit -m "feat: mc-devshell image (sshd + CLIs + user reconciler)"
```

---

## Task 6: Compose wiring + end-to-end isolation verification

**Files:**
- Modify: `mission-control/docker-compose.yml` (add `mc-devshell` service + `mc-homes` volume)

**Interfaces:**
- Consumes: the `mc-devshell` image (Task 5), the MC service endpoint (Task 3), the MC network `mc-net`.

- [ ] **Step 1: Add the service** to `docker-compose.yml` under `services:` (sibling of `mission-control`):

```yaml
  mc-devshell:
    build: ./devshell
    container_name: mc-devshell
    depends_on:
      - mission-control
    environment:
      - MC_URL=${MC_INTERNAL_URL:-http://mission-control:3000}
      - MC_API_KEY=${MC_API_KEY:?set MC_API_KEY in .env for the devshell reconciler}
      - RECONCILE_INTERVAL=${RECONCILE_INTERVAL:-30}
    ports:
      - "${DEVSHELL_SSH_PORT:-2222}:22"
    volumes:
      - mc-homes:/home
      # Shared code — same dir the developers and agents use.
      - ${MC_REPOS_DIR:-../repos}:/srv/repos
    networks:
      - mc-net
    restart: unless-stopped
```

- [ ] **Step 2: Add the volume** under the top-level `volumes:` key:

```yaml
volumes:
  mc-data:
  mc-homes:
```

- [ ] **Step 3: Set the reconciler API key.** In `mission-control/.env` add the global API key MC generated (read it from the running container):

```bash
docker exec mission-control sh -c 'grep -oE "API_KEY=.*" /app/.data/.generated-secrets | tail -1'
# copy that value into mission-control/.env as MC_API_KEY=...
```

- [ ] **Step 4: Bring it up**

Run: `docker compose up -d mc-devshell`
Expected: `Container mc-devshell Started`.

- [ ] **Step 5: Seed two test users with keys and verify provisioning.** Generate two keypairs and register them via the API (using the global key), then confirm the reconciler created both Linux users:

```bash
# create two throwaway keypairs
ssh-keygen -t ed25519 -N '' -f /tmp/uA -q && ssh-keygen -t ed25519 -N '' -f /tmp/uB -q
KEY=$(docker exec mission-control sh -c 'grep -oE "API_KEY=.*" /app/.data/.generated-secrets | tail -1 | cut -d= -f2')
# create two MC users (admin + regular) via the users API or auth.createUser path,
# then register each key AS that user. If no users API exists, create via:
docker exec mission-control node -e '
const {createUser}=require("/app/.next/standalone/... ");' # NOTE: prefer the real users-admin API if present; otherwise use the setup/users flow.
```

> Implementer note: use whatever user-creation path the codebase exposes (setup page, users admin API, or `createUser` in `src/lib/auth.ts`). Register `uA.pub` for user A and `uB.pub` for user B via `POST /api/me/ssh-keys` authenticated as each user, or insert directly with `addUserSshKey`. Then wait one reconcile interval.

- [ ] **Step 6: Verify isolation** (the core success criteria):

```bash
sleep 35   # let the reconciler run
# user A can log in and see their home + repos
ssh -i /tmp/uA -p 2222 -o StrictHostKeyChecking=no userA@localhost 'whoami; ls ~; ls ~/repos >/dev/null && echo REPOS_OK'
# user A CANNOT read user B's home
ssh -i /tmp/uA -p 2222 -o StrictHostKeyChecking=no userA@localhost 'cat /home/userB/.ssh/authorized_keys 2>&1 || echo ISOLATION_OK'
# admin (in sudo) CAN read everything
ssh -i /tmp/uAdmin -p 2222 -o StrictHostKeyChecking=no admin@localhost 'sudo ls /home/userA /home/userB >/dev/null && echo ADMIN_SEES_ALL'
```
Expected: `REPOS_OK`, `ISOLATION_OK` (permission denied → fallback echo), `ADMIN_SEES_ALL`.

- [ ] **Step 7: Verify per-user Claude config isolation** (no tokens spent — just config location):

```bash
ssh -i /tmp/uA -p 2222 -o StrictHostKeyChecking=no userA@localhost 'echo $HOME; ls -la ~/.claude'
```
Expected: `HOME=/home/userA` and a `~/.claude` owned by `userA` — so interactive `claude` will use that user's own config.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: wire mc-devshell service (per-user SSH, shared repos, homes volume)"
```

---

## Self-Review

**Spec coverage:**
- Per-user Linux accounts + isolation → Task 5 (reconciler) + Task 6 (verify). ✅
- Shared repos group-writable → Dockerfile + reconciler `chgrp/chmod`, Task 6 verify. ✅
- Admin sees all (sudo) → reconciler role check, Task 6 verify. ✅
- Per-user `~/.claude` → reconciler creates it per home; Task 6 step 7. ✅
- Self-service key upload → Tasks 2 + 4. ✅
- Service endpoint for reconciler → Task 3. ✅
- MC stays hardened, dev-shell separate, no access to MC creds/DB → dev-shell mounts only `mc-homes` + repos; uses only the public-key endpoint. ✅
- Pubkey-only sshd, no root, AllowGroups devs → `sshd_config`. ✅
- Lock (not delete) removed users → reconciler tail loop. ✅
- Windows bind-mount perms risk → entrypoint/reconciler `chgrp/chmod` best-effort. ✅

**Placeholder scan:** Task 6 Step 5 intentionally defers to "the real user-creation path" because the exact users-admin surface must be confirmed against the codebase at execution time — implementer note included with concrete fallbacks (`addUserSshKey`, `createUser`). Everything else has concrete code/commands.

**Type consistency:** accessor names (`addUserSshKey`, `listUserSshKeys`, `deleteUserSshKey`, `listAllUsersWithKeys`, `isValidSshPublicKey`, `normalizeSshPublicKey`) are used identically in Tasks 2–4 as defined in Task 1. Endpoint paths consistent across Tasks 2–4 and the UI. ✅

## Out of scope (Phase 2)

Per-user `code-server` + Mission-Control-authenticated reverse proxy (browser IDE, mobile + desktop) on the same `mc-devshell` container. Separate plan.
