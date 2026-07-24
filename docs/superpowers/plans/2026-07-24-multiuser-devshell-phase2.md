# Multi-user dev-shell — Phase 2 (browser IDE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One-click, per-user browser VS Code (code-server) reached from Mission Control via token handoff, each instance isolated to that Linux user's home + shared repos, spawned on demand and idle-stopped.

**Architecture:** MC mints a short-lived single-use token; a new root `ide-proxy` in the `mc-devshell` container redeems it against MC, sets its own signed session cookie, spawns/reuses that user's `code-server` (as their Linux user, localhost-bound) and reverse-proxies HTTP + WebSocket to it.

**Tech Stack:** Next.js/TS + better-sqlite3 (MC); Node 22 + `http-proxy` + built-in `crypto`/`child_process` (proxy); code-server; Docker Compose.

## Global Constraints

- pnpm only; host has **no pnpm/node_modules** → verify MC TS via `docker compose build`; pure logic via `node -e`.
- Migrations appended to `src/lib/migrations.ts`; last id is `056_user_ssh_keys` → new id `057_ide_handoff_tokens`.
- Auth: reuse `requireRole` (`@/lib/auth`); global API key = admin scope (used by the proxy for redeem).
- Shell/JS files LF (`.gitattributes` covers `*.sh`; add proxy JS to it if needed).
- **Linux-username resolution in the proxy MUST byte-match the Phase 1 reconciler** (`devshell/reconcile-users.sh`): lowercase → `tr -c 'a-z0-9_-' '_'` → strip leading non-alnum. Extract into a shared JS helper and unit-test it against the same cases as `reconcile-users.test.sh`.
- code-server instances bind `127.0.0.1` only; the proxy is the sole `:8443` surface.
- Token: hashed at rest (SHA-256), single-use, 60s TTL. IDE cookie: HMAC-SHA256, 12h, HttpOnly, SameSite=Lax, Secure-when-TLS.
- No AI attribution trailers; Conventional Commits.

---

## File Structure

**Mission Control:**
- `src/lib/migrations.ts` — MODIFY: migration `057_ide_handoff_tokens`.
- `src/lib/ide-tokens.ts` — CREATE: mint/redeem/hash + pure validators.
- `src/lib/__tests__/ide-tokens.test.ts` — CREATE.
- `src/app/api/ide/token/route.ts` — CREATE: POST mint (session-authed).
- `src/app/api/ide/redeem/route.ts` — CREATE: POST redeem (service-authed).
- `src/components/settings/ssh-access-section.tsx` — MODIFY: add "Open IDE" button.

**devshell:**
- `devshell/Dockerfile` — MODIFY: install code-server + build the proxy; start it.
- `devshell/entrypoint.sh` — MODIFY: launch ide-proxy alongside sshd.
- `devshell/ide-proxy/package.json` — CREATE.
- `devshell/ide-proxy/server.js` — CREATE: the proxy.
- `devshell/ide-proxy/lib.js` — CREATE: pure helpers (username sanitize, cookie sign/verify, port pick).
- `devshell/ide-proxy/lib.test.mjs` — CREATE: node test for the pure helpers.

**Compose:**
- `docker-compose.yml` — MODIFY: publish `${DEVSHELL_IDE_PORT:-8443}:8443`, add `IDE_PROXY_SECRET`, `IDE_IDLE_MINUTES`, `IDE_PORT_RANGE`.

---

## Task 1: `ide_handoff_tokens` migration + ide-tokens lib

**Files:** Modify `src/lib/migrations.ts`; Create `src/lib/ide-tokens.ts`, `src/lib/__tests__/ide-tokens.test.ts`

**Interfaces — Produces:**
- `hashIdeToken(raw: string): string` (sha256 hex)
- `mintIdeToken(userId: number, workspaceId: number, ttlSeconds?: number): { raw: string; expiresAt: number }`
- `redeemIdeToken(raw: string): { user_id: number; workspace_id: number } | null` (single-use, expiry-checked)

- [ ] **Step 1: Migration.** Append to the array in `src/lib/migrations.ts`:

```ts
  {
    id: '057_ide_handoff_tokens',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ide_handoff_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_ide_tokens_hash ON ide_handoff_tokens(token_hash);
      `)
    }
  }
```

- [ ] **Step 2: Failing test** `src/lib/__tests__/ide-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hashIdeToken } from '../ide-tokens'

describe('hashIdeToken', () => {
  it('is a stable 64-char sha256 hex', () => {
    const h = hashIdeToken('abc')
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    expect(hashIdeToken('abc')).toBe(h)
    expect(hashIdeToken('abd')).not.toBe(h)
  })
})
```

- [ ] **Step 3: Run, expect fail.** `pnpm vitest run src/lib/__tests__/ide-tokens.test.ts` → FAIL (module missing). (Host: verify the pure hash via `node -e` reimplementing sha256 hex if pnpm unavailable.)

- [ ] **Step 4: Implement** `src/lib/ide-tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import { getDatabase } from './db'

export function hashIdeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function mintIdeToken(userId: number, workspaceId: number, ttlSeconds = 60): { raw: string; expiresAt: number } {
  const raw = randomBytes(32).toString('hex')
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + ttlSeconds
  const db = getDatabase()
  // Opportunistic prune of stale rows.
  db.prepare('DELETE FROM ide_handoff_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(now)
  db.prepare('INSERT INTO ide_handoff_tokens (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashIdeToken(raw), userId, workspaceId, expiresAt)
  return { raw, expiresAt }
}

/** Single-use redeem: returns the bound user once, then the token is spent. */
export function redeemIdeToken(raw: string): { user_id: number; workspace_id: number } | null {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const row = db.prepare(
    'SELECT id, user_id, workspace_id, expires_at, used_at FROM ide_handoff_tokens WHERE token_hash = ?'
  ).get(hashIdeToken(raw)) as { id: number; user_id: number; workspace_id: number; expires_at: number; used_at: number | null } | undefined
  if (!row || row.used_at !== null || row.expires_at < now) return null
  // Atomically claim: only succeeds if still unused.
  const claim = db.prepare('UPDATE ide_handoff_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id)
  if (claim.changes === 0) return null
  return { user_id: row.user_id, workspace_id: row.workspace_id }
}
```

- [ ] **Step 5: Run tests, expect pass.** `pnpm vitest run src/lib/__tests__/ide-tokens.test.ts` (or `node -e` hash check).

- [ ] **Step 6: Commit** — `git add src/lib/migrations.ts src/lib/ide-tokens.ts src/lib/__tests__/ide-tokens.test.ts && git commit -m "feat: ide_handoff_tokens table + mint/redeem lib"`

---

## Task 2: `/api/ide/token` (mint) + `/api/ide/redeem` (service)

**Files:** Create `src/app/api/ide/token/route.ts`, `src/app/api/ide/redeem/route.ts`

**Interfaces — Consumes:** `mintIdeToken`, `redeemIdeToken` (Task 1); `requireRole`; the identity mutation limiter used in `src/app/api/tokens/rotate/route.ts`.

- [ ] **Step 1: mint route** `src/app/api/ide/token/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mintIdeToken } from '@/lib/ide-tokens'
import { logger } from '@/lib/logger'

// Base URL of the devshell IDE proxy, e.g. https://dev.example.com:8443
function ideBaseUrl(): string {
  return (process.env.IDE_PUBLIC_URL || '').replace(/\/$/, '')
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const base = ideBaseUrl()
  if (!base) return NextResponse.json({ error: 'IDE not configured (set IDE_PUBLIC_URL)' }, { status: 503 })
  try {
    const { raw } = mintIdeToken(auth.user.id, auth.user.workspace_id ?? 1)
    return NextResponse.json({ url: `${base}/auth?token=${encodeURIComponent(raw)}` })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ide/token error')
    return NextResponse.json({ error: 'Failed to mint IDE token' }, { status: 500 })
  }
}
```

- [ ] **Step 2: redeem route** `src/app/api/ide/redeem/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { redeemIdeToken } from '@/lib/ide-tokens'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'

// Called by the devshell ide-proxy with the global API key (admin scope).
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  let body: { token?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || typeof body.token !== 'string' || !body.token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }
  try {
    const claimed = redeemIdeToken(body.token)
    if (!claimed) return NextResponse.json({ error: 'invalid or expired token' }, { status: 401 })
    const u = getDatabase().prepare('SELECT username, role FROM users WHERE id = ?').get(claimed.user_id) as { username: string; role: string } | undefined
    if (!u) return NextResponse.json({ error: 'user not found' }, { status: 404 })
    return NextResponse.json({ username: u.username, role: u.role, workspace_id: claimed.workspace_id })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ide/redeem error')
    return NextResponse.json({ error: 'redeem failed' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Verify** — `pnpm typecheck` (host: rely on the batched `docker compose build`). Confirm `requireRole` usage matches `src/app/api/agents/route.ts`; `auth.user.id`/`.workspace_id` exist.

- [ ] **Step 4: Commit** — `git add src/app/api/ide && git commit -m "feat: IDE token mint + service redeem endpoints"`

---

## Task 3: "Open IDE" button

**Files:** Modify `src/components/settings/ssh-access-section.tsx`

- [ ] **Step 1:** Add to the component (near the SSH help text), inside `SshAccessSection`:

```tsx
  const [ideBusy, setIdeBusy] = useState(false)
  const [ideErr, setIdeErr] = useState<string | null>(null)
  const openIde = async () => {
    setIdeBusy(true); setIdeErr(null)
    try {
      const { url } = await apiFetch<{ url: string }>('/api/ide/token', { method: 'POST' })
      window.open(url, '_blank', 'noopener')
    } catch (e: any) { setIdeErr(e?.message || 'Failed to open IDE') } finally { setIdeBusy(false) }
  }
```

And in the JSX (below the header paragraph):

```tsx
      <div className="flex items-center gap-2">
        <button onClick={openIde} disabled={ideBusy}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
          {ideBusy ? 'Opening…' : 'Open IDE'}
        </button>
        <span className="text-xs text-muted-foreground">Browser VS Code on your isolated dev account.</span>
      </div>
      {ideErr && <p className="text-sm text-red-500">{ideErr}</p>}
```

- [ ] **Step 2: Verify** — `pnpm typecheck` (or batched docker build). Ensure `useState` is imported (it is).

- [ ] **Step 3: Commit** — `git add src/components/settings/ssh-access-section.tsx && git commit -m "feat: Open IDE button in SSH Access settings"`

---

## Task 4: code-server in the devshell image

**Files:** Modify `devshell/Dockerfile`

- [ ] **Step 1:** Add code-server install to `devshell/Dockerfile` (after the CLI installs, before COPY of scripts):

```dockerfile
# Browser IDE (per-user code-server, spawned by ide-proxy)
RUN curl -fsSL https://code-server.dev/install.sh | sh
```

- [ ] **Step 2: Build + verify code-server present.**

Run:
```bash
docker build -t mc-devshell:latest ./devshell
docker run --rm --entrypoint code-server mc-devshell:latest --version && echo CODE_SERVER_OK
```
Expected: a version line then `CODE_SERVER_OK`.

- [ ] **Step 3: Commit** — `git add devshell/Dockerfile && git commit -m "feat: install code-server in mc-devshell image"`

---

## Task 5: `ide-proxy` (auth handoff + spawn + HTTP/WS reverse-proxy + idle sweep)

**Files:** Create `devshell/ide-proxy/package.json`, `devshell/ide-proxy/lib.js`, `devshell/ide-proxy/server.js`, `devshell/ide-proxy/lib.test.mjs`

**Interfaces — Produces (lib.js):** `sanitizeUsername(name)`, `signCookie(username, exp, secret)`, `verifyCookie(value, secret, now)`, `pickPort(used, [lo,hi])`.

- [ ] **Step 1: package.json**

```json
{
  "name": "ide-proxy",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "dependencies": { "http-proxy": "^1.18.1" }
}
```

- [ ] **Step 2: pure helpers** `devshell/ide-proxy/lib.js`:

```js
'use strict'
const crypto = require('crypto')

// MUST match devshell/reconcile-users.sh: lowercase -> [^a-z0-9_-]->_ -> strip leading non-alnum.
function sanitizeUsername(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z0-9]+/, '')
  return s
}

function signCookie(username, exp, secret) {
  const payload = `${username}|${exp}`
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}|${mac}`
}

function verifyCookie(value, secret, now) {
  if (typeof value !== 'string') return null
  const parts = value.split('|')
  if (parts.length !== 3) return null
  const [username, expStr, mac] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < now) return null
  const expected = crypto.createHmac('sha256', secret).update(`${username}|${exp}`).digest('hex')
  const a = Buffer.from(mac), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  const u = sanitizeUsername(username)
  return u ? { username: u, exp } : null
}

function pickPort(used, range) {
  const [lo, hi] = range
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p
  return null
}

module.exports = { sanitizeUsername, signCookie, verifyCookie, pickPort }
```

- [ ] **Step 3: helper test** `devshell/ide-proxy/lib.test.mjs`:

```js
import assert from 'node:assert'
import { sanitizeUsername, signCookie, verifyCookie, pickPort } from './lib.js'

// sanitize matches the reconciler
assert.equal(sanitizeUsername('Jane.Doe'), 'jane_doe')
assert.equal(sanitizeUsername('-x'), 'x')
assert.equal(sanitizeUsername('Foo Bar'), 'foo_bar')

// cookie round-trip + tamper + expiry
const S = 'secret'
const now = 1000
const c = signCookie('usera', now + 100, S)
assert.deepEqual(verifyCookie(c, S, now), { username: 'usera', exp: now + 100 })
assert.equal(verifyCookie(c, 'wrong', now), null)                 // bad secret
assert.equal(verifyCookie(c, S, now + 200), null)                 // expired
assert.equal(verifyCookie(c.slice(0, -1) + '0', S, now), null)    // tampered mac

// port pick
assert.equal(pickPort(new Set([9000, 9001]), [9000, 9002]), 9002)
assert.equal(pickPort(new Set([9000, 9001, 9002]), [9000, 9002]), null)
console.log('ide-proxy lib: all assertions pass')
```

- [ ] **Step 4: Run the helper test.** `node devshell/ide-proxy/lib.test.mjs` → `all assertions pass`.

- [ ] **Step 5: the proxy** `devshell/ide-proxy/server.js`:

```js
'use strict'
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')
const httpProxy = require('http-proxy')
const { sanitizeUsername, signCookie, verifyCookie, pickPort } = require('./lib.js')

const PORT = Number(process.env.IDE_PROXY_PORT || 8443)
const MC_URL = (process.env.MC_URL || 'http://mission-control:3000').replace(/\/$/, '')
const MC_API_KEY = process.env.MC_API_KEY || ''
const SECRET = process.env.IDE_PROXY_SECRET || ''
const IDLE_MS = Number(process.env.IDE_IDLE_MINUTES || 30) * 60 * 1000
const RANGE = (process.env.IDE_PORT_RANGE || '9000-9099').split('-').map(Number)
const COOKIE = 'mc_ide'

if (!SECRET || !MC_API_KEY) { console.error('IDE_PROXY_SECRET and MC_API_KEY are required'); process.exit(1) }

const proxy = httpProxy.createProxyServer({ ws: true })
proxy.on('error', (err, _req, res) => { try { res.writeHead && res.writeHead(502); res.end('IDE upstream error') } catch {} })

// username -> { port, proc, lastSeen }
const instances = new Map()
const spawnLocks = new Map() // username -> Promise (guards concurrent first-hits)

function parseCookies(h) {
  const out = {}
  for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()) }
  return out
}
function sessionUser(req) {
  const c = parseCookies(req.headers.cookie)[COOKIE]
  const v = verifyCookie(c, SECRET, Math.floor(Date.now() / 1000))
  return v ? v.username : null
}
function linuxUserExists(u) {
  const r = require('child_process').spawnSync('id', ['--', u], { stdio: 'ignore' })
  return r.status === 0
}

async function redeem(token) {
  const res = await fetch(`${MC_URL}/api/ide/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MC_API_KEY },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) return null
  return res.json()
}

async function ensureInstance(username) {
  const live = instances.get(username)
  if (live) { live.lastSeen = Date.now(); return live }
  if (spawnLocks.has(username)) return spawnLocks.get(username)
  const p = (async () => {
    const used = new Set([...instances.values()].map(i => i.port))
    const port = pickPort(used, RANGE)
    if (port == null) throw new Error('no free IDE port (capacity reached)')
    // Run code-server AS the Linux user, localhost-only, no code-server auth (proxy is the gate).
    const proc = spawn('runuser', ['-u', username, '--',
      'code-server', '--auth', 'none', '--bind-addr', `127.0.0.1:${port}`, `/home/${username}`],
      { env: { ...process.env, HOME: `/home/${username}` }, stdio: 'ignore', detached: false })
    const rec = { port, proc, lastSeen: Date.now() }
    instances.set(username, rec)
    proc.on('exit', () => { if (instances.get(username) === rec) instances.delete(username) })
    // Wait for the port to accept connections (max ~10s).
    await waitPort(port, 10000)
    return rec
  })().finally(() => spawnLocks.delete(username))
  spawnLocks.set(username, p)
  return p
}

function waitPort(port, timeoutMs) {
  const net = require('net')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve() })
      s.once('error', () => { s.destroy(); if (Date.now() > deadline) reject(new Error('code-server did not start')); else setTimeout(tryOnce, 250) })
    }
    tryOnce()
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/auth') {
    const token = url.searchParams.get('token') || ''
    const info = await redeem(token).catch(() => null)
    if (!info || !info.username) { res.writeHead(401); return res.end('Invalid or expired IDE link. Reopen from Mission Control.') }
    const username = sanitizeUsername(info.username)
    if (!username || !linuxUserExists(username)) { res.writeHead(503); return res.end('Your dev account is still provisioning — try again in a minute.') }
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600
    const cookie = signCookie(username, exp, SECRET)
    const secure = (process.env.IDE_COOKIE_SECURE || 'auto') === 'true' ? '; Secure' : ''
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax${secure}`, Location: '/' })
    return res.end()
  }
  const username = sessionUser(req)
  if (!username) { res.writeHead(302, { Location: '/auth-required' }); return res.end() }
  if (url.pathname === '/auth-required') { res.writeHead(401); return res.end('No IDE session. Open the IDE from Mission Control.') }
  let inst
  try { inst = await ensureInstance(username) } catch (e) { res.writeHead(503); return res.end(String(e.message || e)) }
  inst.lastSeen = Date.now()
  proxy.web(req, res, { target: `http://127.0.0.1:${inst.port}` })
})

// WebSocket upgrades (code-server's terminal/live features).
server.on('upgrade', async (req, socket, head) => {
  const username = sessionUser(req)
  if (!username) { socket.destroy(); return }
  let inst
  try { inst = await ensureInstance(username) } catch { socket.destroy(); return }
  inst.lastSeen = Date.now()
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${inst.port}` })
})

// Idle sweep.
setInterval(() => {
  const now = Date.now()
  for (const [u, rec] of instances) {
    if (now - rec.lastSeen > IDLE_MS) { try { rec.proc.kill('SIGTERM') } catch {} ; instances.delete(u) }
  }
}, 60_000)

server.listen(PORT, () => console.log(`[ide-proxy] listening on :${PORT}`))
```

- [ ] **Step 6: Commit** — `git add devshell/ide-proxy && git commit -m "feat: ide-proxy (token handoff, per-user code-server spawn, HTTP/WS proxy, idle sweep)"`

---

## Task 6: wire ide-proxy into the image/entrypoint + compose

**Files:** Modify `devshell/Dockerfile`, `devshell/entrypoint.sh`, `docker-compose.yml`

- [ ] **Step 1: Dockerfile** — install proxy deps + copy it. Add before the entrypoint COPY:

```dockerfile
COPY ide-proxy /opt/ide-proxy
RUN cd /opt/ide-proxy && npm install --omit=dev --no-audit --no-fund
```

- [ ] **Step 2: entrypoint** — in `devshell/entrypoint.sh`, before `exec /usr/sbin/sshd -D -e`, start the proxy in the background:

```bash
# Browser IDE proxy (per-user code-server). Needs MC_API_KEY + IDE_PROXY_SECRET.
if [ -n "${IDE_PROXY_SECRET:-}" ] && [ -n "${MC_API_KEY:-}" ]; then
  echo "[mc-devshell] starting ide-proxy on :${IDE_PROXY_PORT:-8443}"
  ( cd /opt/ide-proxy && node server.js >> /tmp/ide-proxy.log 2>&1 ) &
fi
```

- [ ] **Step 3: compose** — add to the `mc-devshell` service in `docker-compose.yml`:

```yaml
    # (add under the existing environment: list)
      - MC_API_KEY=${MC_API_KEY:?set MC_API_KEY in .env}
      - IDE_PROXY_SECRET=${IDE_PROXY_SECRET:?set IDE_PROXY_SECRET in .env}
      - IDE_IDLE_MINUTES=${IDE_IDLE_MINUTES:-30}
      - IDE_PORT_RANGE=${IDE_PORT_RANGE:-9000-9099}
    # (add under the existing ports: list)
      - "${DEVSHELL_IDE_PORT:-8443}:8443"
```
And in `mission-control`'s environment, add `- IDE_PUBLIC_URL=${IDE_PUBLIC_URL:-}` (the browser-reachable devshell IDE base URL).

- [ ] **Step 4: Build + boot.**

```bash
docker build -t mc-devshell:latest ./devshell
docker compose up -d mc-devshell
sleep 5 && docker exec mc-devshell sh -c 'pgrep -f "node server.js" >/dev/null && echo PROXY_UP'
```
Expected: `PROXY_UP`.

- [ ] **Step 5: Commit** — `git add devshell/Dockerfile devshell/entrypoint.sh docker-compose.yml && git commit -m "feat: run ide-proxy in mc-devshell; publish IDE port + config"`

---

## Task 7: end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Set env + bring up the stack.** In `.env`: `IDE_PROXY_SECRET=$(openssl rand -hex 32)`, `MC_API_KEY=<the generated key>`, `IDE_PUBLIC_URL=http://localhost:8443`. `docker compose up -d mission-control mc-devshell`.

- [ ] **Step 2: Seed two users (Phase 1 method)** — insert `usera`/`userb` into MC (`users`) + register keys or just let the reconciler create their homes; wait one reconcile cycle; confirm `docker exec mc-devshell getent passwd | grep -E 'usera|userb'`.

- [ ] **Step 3: Handoff + isolation checks** (mint via MC as each user; the mint route needs an MC session — for the scripted test, insert a token row directly with `mintIdeToken` semantics or call `/api/ide/token` with a seeded session cookie):

```bash
# Redeem path + spawn (using a token minted for usera):
curl -s "http://localhost:8443/auth?token=$TOKEN_A" -c /tmp/cjar_a -i | grep -i set-cookie && echo AUTH_OK
curl -s -b /tmp/cjar_a http://localhost:8443/ -o /dev/null -w '%{http_code}\n'   # 200 from code-server
docker exec mc-devshell ps -o user,args | grep '[c]ode-server' # usera + userb on distinct ports as distinct users
# localhost-only: a code-server port is not reachable from outside the container
docker exec mc-devshell sh -c 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9000 || true'  # reachable inside
# replay: reusing $TOKEN_A now → 401
curl -s "http://localhost:8443/auth?token=$TOKEN_A" -o /dev/null -w 'replay=%{http_code}\n'  # 401
```
Assert: `AUTH_OK`, code-server returns 200 for userA; two instances as `usera`/`userb`; replay 401.

- [ ] **Step 4: Idle** — set `IDE_IDLE_MINUTES=0.05` temporarily (or send SIGTERM manually), confirm the instance is swept and re-spawns on next visit.

- [ ] **Step 5: Manual note** — record the browser flow to run by hand (MC → Open IDE → editor on `/home/usera`, terminal `whoami`=usera).

- [ ] **Step 6: Commit any fixes; final commit** — `git commit -am "test: phase 2 browser IDE end-to-end verification notes"` (if verification produced fixes).

---

## Self-Review

**Spec coverage:** token handoff (T1–T2) ✅ · Open IDE UI (T3) ✅ · code-server in image (T4) ✅ · per-user spawn-as-user + HTTP/WS proxy + idle sweep + spawn-lock + port alloc (T5) ✅ · entrypoint/compose wiring + published port + secrets (T6) ✅ · isolation/replay/localhost/idle verification (T7) ✅ · username sanitize matches Phase 1 reconciler (T5 lib + test) ✅ · account-not-provisioned handled (T5 `/auth` 503) ✅.

**Placeholder scan:** `$TOKEN_A`, `<the generated key>`, `9000` are concrete test inputs, not code placeholders. All code steps carry full code.

**Type/interface consistency:** `mintIdeToken`/`redeemIdeToken`/`hashIdeToken` names match across T1–T2; `sanitizeUsername`/`signCookie`/`verifyCookie`/`pickPort` defined in T5 lib and used in T5 server + T5 test; cookie name `mc_ide` consistent; port range env `IDE_PORT_RANGE` consistent T5/T6.

## Notes for the executor
- The MC-side mint route requires `IDE_PUBLIC_URL`; the redeem route uses the global API key (admin). The proxy needs `MC_API_KEY` + `IDE_PROXY_SECRET`.
- Retire the Dokploy code-server on 8443 or set `DEVSHELL_IDE_PORT` to avoid a port clash.
- TLS in front of `:8443` is a deployment requirement for real mobile use (spec).
