import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { redeemIdeToken } from '@/lib/ide-tokens'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'

// Mirrors devshell/reconcile-users.sh's bash normalization (lowercase -> collapse
// anything outside a-z0-9_- to '_' -> strip leading non-alphanumerics). Usernames
// created through createUserSchema/LINUX_USERNAME_REGEX are already conformant, so
// this is a no-op for them; it only matters for pre-existing/grandfathered rows.
function normalizeLinuxUsername(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z0-9]+/, '')
}

// Called by the devshell ide-proxy with the global API key (admin scope).
// Note: this endpoint has no per-caller rate limit. Its only caller is the
// devshell's own ide-proxy (never a browser directly), so MC never sees the
// real client IP and any limiter here would just bucket every real user
// behind one shared quota (a single flooder locks everyone out — see I2 in
// the phase 2 security review). The redeemed token is a single-use, 60s-TTL,
// 256-bit random value, which isn't brute-forceable at any request rate.
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
    const db = getDatabase()
    const u = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(claimed.user_id) as { id: number; username: string; role: string } | undefined
    if (!u) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    const target = normalizeLinuxUsername(u.username)
    if (!target) return NextResponse.json({ error: 'username cannot map to a Linux account' }, { status: 403 })

    // The reconciler is first-wins on normalized-username collisions (`ORDER BY id`,
    // see listAllUsersWithKeys) — only the lowest-id user whose name normalizes to
    // `target` actually gets that Linux account. Anyone else must be denied here,
    // or they'd be handed a cookie for an account they don't own (reads the real
    // owner's ~/.claude, ~/.ssh, repos).
    const rows = db.prepare('SELECT id, username FROM users ORDER BY id ASC').all() as Array<{ id: number; username: string }>
    const owner = rows.find(r => normalizeLinuxUsername(r.username) === target)
    if (!owner || owner.id !== u.id) {
      return NextResponse.json({ error: 'not the owner of this Linux account' }, { status: 403 })
    }

    return NextResponse.json({ username: u.username, linux_username: target, role: u.role, workspace_id: claimed.workspace_id })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ide/redeem error')
    return NextResponse.json({ error: 'redeem failed' }, { status: 500 })
  }
}
