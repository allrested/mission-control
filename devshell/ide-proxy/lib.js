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
