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
  if (live && live.ready) { live.lastSeen = Date.now(); return live }
  if (spawnLocks.has(username)) return spawnLocks.get(username)
  const p = (async () => {
    const used = new Set([...instances.values()].map(i => i.port))
    const port = pickPort(used, RANGE)
    if (port == null) throw new Error('no free IDE port (capacity reached)')
    // Run code-server AS the Linux user, localhost-only, no code-server auth (proxy is the gate).
    const proc = spawn('runuser', ['-u', username, '--',
      'code-server', '--auth', 'none', '--bind-addr', `127.0.0.1:${port}`, `/home/${username}`],
      { env: { ...process.env, HOME: `/home/${username}` }, stdio: 'ignore', detached: false })
    const rec = { port, proc, lastSeen: Date.now(), ready: false, failed: null }
    instances.set(username, rec)
    // spawn(2) failing outright (ENOENT/EACCES/EMFILE) emits 'error', not 'exit' —
    // without this listener it's an uncaught exception that kills the whole proxy.
    proc.on('error', (err) => { rec.failed = err; if (instances.get(username) === rec) instances.delete(username) })
    proc.on('exit', () => { if (instances.get(username) === rec) instances.delete(username) })
    // Wait for the port to accept connections (max ~10s).
    await waitPort(port, 10000, rec)
    rec.ready = true
    return rec
  })().finally(() => spawnLocks.delete(username))
  spawnLocks.set(username, p)
  return p
}

function waitPort(port, timeoutMs, rec) {
  const net = require('net')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (rec.failed) return reject(rec.failed)
      const s = net.connect(port, '127.0.0.1')
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
      if (!info || !info.username) { res.writeHead(401); return res.end('Invalid or expired IDE link. Reopen from Mission Control.') }
      const username = sanitizeUsername(info.username)
      if (!username || !linuxUserExists(username)) { res.writeHead(503); return res.end('Your dev account is still provisioning — try again in a minute.') }
      const exp = Math.floor(Date.now() / 1000) + 12 * 3600
      const cookie = signCookie(username, exp, SECRET)
      // 'auto' trusts X-Forwarded-Proto from a TLS-terminating reverse proxy in front of us.
      // If nothing in front sets that header (or it can't be trusted), set IDE_COOKIE_SECURE=true explicitly.
      const cookieSecureMode = process.env.IDE_COOKIE_SECURE || 'auto'
      const secure = (cookieSecureMode === 'true' || (cookieSecureMode === 'auto' && req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : ''
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
  } catch (e) {
    try { res.writeHead(500); res.end('Internal error') } catch {}
  }
})

// WebSocket upgrades (code-server's terminal/live features).
server.on('upgrade', async (req, socket, head) => {
  try {
    const username = sessionUser(req)
    if (!username) { socket.destroy(); return }
    let inst
    try { inst = await ensureInstance(username) } catch { socket.destroy(); return }
    inst.lastSeen = Date.now()
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${inst.port}` })
  } catch {
    try { socket.destroy() } catch {}
  }
})

// Idle sweep.
setInterval(() => {
  const now = Date.now()
  for (const [u, rec] of instances) {
    if (now - rec.lastSeen > IDLE_MS) { try { rec.proc.kill('SIGTERM') } catch {} ; instances.delete(u) }
  }
}, 60_000)

server.listen(PORT, () => console.log(`[ide-proxy] listening on :${PORT}`))
