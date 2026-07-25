'use strict'
const http = require('http')
const net = require('net')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const httpProxy = require('http-proxy')
const { signCookie, verifyCookie } = require('./lib.js')

const PORT = Number(process.env.IDE_PROXY_PORT || 8443)
const MC_URL = (process.env.MC_URL || 'http://mission-control:3000').replace(/\/$/, '')
const MC_API_KEY = process.env.MC_API_KEY || ''
const SECRET = process.env.IDE_PROXY_SECRET || ''
const IDLE_MINUTES_RAW = Number(process.env.IDE_IDLE_MINUTES)
const IDLE_MS = (Number.isFinite(IDLE_MINUTES_RAW) && IDLE_MINUTES_RAW > 0 ? IDLE_MINUTES_RAW : 30) * 60 * 1000
const SOCK_DIR = '/run/ide'
const COOKIE = 'mc_ide'
const MANAGED_TTL_MS = 30_000

if (!SECRET || !MC_API_KEY) { console.error('IDE_PROXY_SECRET and MC_API_KEY are required'); process.exit(1) }

const proxy = httpProxy.createProxyServer({ ws: true })
proxy.on('error', (err, _req, res) => { try { res.writeHead && res.writeHead(502); res.end('IDE upstream error') } catch {} })

// username -> { sock, proc, lastSeen, ready, failed, liveSockets }
const instances = new Map()
const spawnLocks = new Map() // username -> Promise (guards concurrent first-hits)
const managedCache = new Map() // username -> { managed, ts }

function parseCookies(h) {
  const out = {}
  try {
    for (const p of String(h || '').split(';')) {
      const i = p.indexOf('=')
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim())
    }
  } catch { return {} }
  return out
}
function sessionUser(req) {
  const c = parseCookies(req.headers.cookie)[COOKIE]
  const v = verifyCookie(c, SECRET, Math.floor(Date.now() / 1000))
  return v ? v.username : null
}
// Managed accounts only: must exist AND be a member of `devs` (the group
// reconcile-users.sh puts every MC-created account in). This excludes root,
// node, daemon, www-data, and any other pre-existing system/service account
// that `id` would otherwise happily report as "exists".
function linuxUserManaged(u) {
  const r = spawnSync('id', ['-nG', '--', u], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim().split(/\s+/).includes('devs')
}
// Cached ~30s so a deprovisioned user (reconciler locks/nologins them, but
// runuser bypasses that) loses IDE + shell access shortly after their MC
// account is removed/demoted, not just at next cookie expiry (up to 12h).
function isManaged(username) {
  const cached = managedCache.get(username)
  const now = Date.now()
  if (cached && now - cached.ts < MANAGED_TTL_MS) return cached.managed
  const managed = linuxUserManaged(username)
  managedCache.set(username, { managed, ts: now })
  return managed
}
function revoke(username) {
  managedCache.set(username, { managed: false, ts: Date.now() })
  const rec = instances.get(username)
  if (rec) { try { rec.proc.kill('SIGTERM') } catch {}; instances.delete(username) }
}

async function redeem(token) {
  const res = await fetch(`${MC_URL}/api/ide/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MC_API_KEY },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) return null
  return res.json()
}

// Each user gets their OWN subdirectory (0700, owned by them), created by
// root right before spawn. /run/ide itself is 0711 root:root (traverse-only,
// not group-writable) — so no other user can create anything under it, let
// alone squat a not-yet-existing socket path (a shared writable dir, even
// sticky, only stops DELETING an existing entry, not creating a missing one).
function sockDir(username) { return `${SOCK_DIR}/${username}` }
function sockPath(username) { return `${sockDir(username)}/s.sock` }

function getIds(username) {
  const uid = spawnSync('id', ['-u', '--', username], { encoding: 'utf8' })
  const gid = spawnSync('id', ['-g', '--', username], { encoding: 'utf8' })
  if (uid.status !== 0 || gid.status !== 0) throw new Error(`cannot resolve uid/gid for ${username}`)
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) }
}

async function ensureInstance(username) {
  const live = instances.get(username)
  if (live && live.ready) { live.lastSeen = Date.now(); return live }
  if (spawnLocks.has(username)) return spawnLocks.get(username)
  const p = (async () => {
    const { uid, gid } = getIds(username)
    const dir = sockDir(username)
    const sock = sockPath(username)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o700)
    fs.chownSync(dir, uid, gid)
    // A unix socket's inode outlives the process that bound it — remove any
    // leftover file from a previous (killed/crashed) instance so bind() doesn't
    // fail with EADDRINUSE. Safe here (unlike a shared dir): this directory is
    // owned by `username` alone, nobody else could have raced to put anything
    // in it (see sockDir comment above).
    try { fs.unlinkSync(sock) } catch {}
    // Run code-server AS the Linux user, over a per-user unix socket (mode 600)
    // inside that user's own directory — no shared TCP port, no shared
    // directory another user could squat a path in. The proxy (this process,
    // running as root) is the only thing that can reach every socket; the
    // code-server auth is disabled because the proxy's cookie check + the
    // socket's own permissions + the owning directory are the real gate.
    // Env is an explicit allowlist, NOT inherited from process.env — this proxy's
    // env holds MC_API_KEY (admin) and IDE_PROXY_SECRET (forges any user's cookie),
    // neither of which the user's shell/terminal may ever see.
    // Absolute path: runuser lives in /usr/sbin, which isn't on the restricted
    // PATH below (that PATH is for code-server's environment, not for finding
    // runuser itself — spawn() resolves the command using options.env.PATH,
    // not the proxy's own PATH, when options.env is set).
    const proc = spawn('/usr/sbin/runuser', ['-u', username, '--',
      'code-server', '--auth', 'none', '--socket', sock, '--socket-mode', '600', `/home/${username}`],
      {
        env: {
          HOME: `/home/${username}`, USER: username, LOGNAME: username,
          PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/bash',
        },
        cwd: `/home/${username}`,
        // Pipe code-server's stdout/stderr into ours so `docker logs` shows it
        // (rather than discarding it, which makes spawn failures undiagnosable).
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
      })
    const rec = { sock, proc, lastSeen: Date.now(), ready: false, failed: null, liveSockets: 0 }
    instances.set(username, rec)
    // spawn(2) failing outright (ENOENT/EACCES/EMFILE) emits 'error', not 'exit' —
    // without this listener it's an uncaught exception that kills the whole proxy.
    proc.on('error', (err) => { rec.failed = err; if (instances.get(username) === rec) instances.delete(username) })
    proc.on('exit', () => { if (instances.get(username) === rec) instances.delete(username) })
    try {
      // Wait for the socket to accept connections (max ~10s).
      await waitSocket(sock, 10000, rec)
      // Belt-and-braces: the directory ownership already guarantees this, but
      // assert it directly on the socket inode too before trusting it.
      if (fs.statSync(sock).uid !== uid) throw new Error(`socket owner mismatch for ${username}`)
    } catch (e) {
      // Don't leave a timed-out/mismatched spawn running unreferenced — kill
      // it now, otherwise a retry spawns a second process and this one's exit
      // handler no longer matches `instances.get(username)`, leaking forever.
      try { proc.kill('SIGKILL') } catch {}
      if (instances.get(username) === rec) instances.delete(username)
      throw e
    }
    rec.ready = true
    return rec
  })().finally(() => spawnLocks.delete(username))
  spawnLocks.set(username, p)
  return p
}

function waitSocket(sock, timeoutMs, rec) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (rec.failed) return reject(rec.failed)
      const s = net.connect(sock)
      s.once('connect', () => { s.destroy(); resolve() })
      s.once('error', () => {
        s.destroy()
        if (rec.failed) return reject(rec.failed)
        if (Date.now() > deadline) reject(new Error('code-server did not start'))
        else setTimeout(tryOnce, 250)
      })
    }
    tryOnce()
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/auth') {
      const token = url.searchParams.get('token') || ''
      const info = await redeem(token).catch(() => null)
      // MC is authoritative: use its linux_username verbatim, no re-derivation here.
      // Still validated as a shape safe to embed in a filesystem path / spawn arg
      // (trust-boundary input check, not a re-derivation of the identity itself).
      if (!info || !info.linux_username || !/^[a-z][a-z0-9_-]{1,30}[a-z0-9]$/.test(info.linux_username)) {
        res.writeHead(401); return res.end('Invalid or expired IDE link. Reopen from Mission Control.')
      }
      const username = info.linux_username
      if (!isManaged(username)) { res.writeHead(503); return res.end('Your dev account is still provisioning — try again in a minute.') }
      const exp = Math.floor(Date.now() / 1000) + 12 * 3600
      const cookie = signCookie(username, exp, SECRET)
      // 'auto' trusts X-Forwarded-Proto from a TLS-terminating reverse proxy in front of us.
      // If nothing in front sets that header (or it can't be trusted), set IDE_COOKIE_SECURE=true explicitly.
      const cookieSecureMode = process.env.IDE_COOKIE_SECURE || 'auto'
      const secure = (cookieSecureMode === 'true' || (cookieSecureMode === 'auto' && req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : ''
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax${secure}`, Location: '/' })
      return res.end()
    }
    // Check the dead-end path BEFORE deriving the session, otherwise a
    // no-cookie request loops: redirect -> /auth-required -> still no cookie -> redirect ...
    if (url.pathname === '/auth-required') { res.writeHead(401); return res.end('No IDE session. Open the IDE from Mission Control.') }
    const username = sessionUser(req)
    if (!username) { res.writeHead(302, { Location: '/auth-required' }); return res.end() }
    if (!isManaged(username)) { revoke(username); res.writeHead(403); return res.end('Your dev account has been deprovisioned.') }
    let inst
    try { inst = await ensureInstance(username) } catch (e) {
      console.error(`[ide-proxy] ensureInstance(${username}) failed:`, e)
      res.writeHead(503); return res.end('Could not start your IDE. Try again shortly.')
    }
    inst.lastSeen = Date.now()
    proxy.web(req, res, { target: { socketPath: inst.sock } })
  } catch (e) {
    try { res.writeHead(500); res.end('Internal error') } catch {}
  }
})

// WebSocket upgrades (code-server's terminal/live features).
server.on('upgrade', async (req, socket, head) => {
  try {
    const username = sessionUser(req)
    if (!username || !isManaged(username)) { socket.destroy(); return }
    let inst
    try { inst = await ensureInstance(username) } catch { socket.destroy(); return }
    inst.lastSeen = Date.now()
    // Count live sockets so the idle sweeper doesn't kill a session mid-use
    // (lastSeen was otherwise only bumped at upgrade time, never per-frame).
    inst.liveSockets++
    socket.on('close', () => { inst.liveSockets = Math.max(0, inst.liveSockets - 1); inst.lastSeen = Date.now() })
    proxy.ws(req, socket, head, { target: { socketPath: inst.sock } })
  } catch {
    try { socket.destroy() } catch {}
  }
})

// Idle sweep. Skips any instance with live WebSocket connections (open
// terminal/editor) — EXCEPT a deprovisioned user, who gets revoked (which
// SIGTERMs the instance and drops the WS) regardless of live sockets; an
// offboarded user with a backgrounded tab must not proxy forever. Also caps
// how long a live socket alone can pin an instance (4x IDLE_MS) — otherwise
// a single held-open tab is an unbounded RAM liability with no idle bound.
setInterval(() => {
  const now = Date.now()
  for (const [u, rec] of instances) {
    if (!isManaged(u)) { revoke(u); continue }
    const idleMs = now - rec.lastSeen
    if (rec.liveSockets > 0 && idleMs < IDLE_MS * 4) continue
    if (idleMs > IDLE_MS) { try { rec.proc.kill('SIGTERM') } catch {} ; instances.delete(u) }
  }
}, 60_000)

server.listen(PORT, () => console.log(`[ide-proxy] listening on :${PORT}`))
