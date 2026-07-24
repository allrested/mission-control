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
