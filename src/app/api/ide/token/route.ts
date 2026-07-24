import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mintIdeToken } from '@/lib/ide-tokens'
import { logAuditEvent } from '@/lib/db'
import { identitySecurityMutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

// Base URL of the devshell IDE proxy, e.g. https://dev.example.com:8443
function ideBaseUrl(): string {
  return (process.env.IDE_PUBLIC_URL || '').replace(/\/$/, '')
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = identitySecurityMutationLimiter(`${auth.user.tenant_id ?? 1}:${auth.user.workspace_id ?? 1}:${auth.user.id}:ide-token`)
  if (rateCheck) return rateCheck

  const base = ideBaseUrl()
  if (!base) return NextResponse.json({ error: 'IDE not configured (set IDE_PUBLIC_URL)' }, { status: 503 })
  try {
    const { raw, expiresAt } = mintIdeToken(auth.user.id, auth.user.workspace_id ?? 1)
    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    logAuditEvent({
      action: 'ide_token_minted',
      actor: auth.user.username,
      actor_id: auth.user.id,
      workspace_id: auth.user.workspace_id ?? 1,
      detail: { expires_at: expiresAt },
      ip_address: ipAddress,
    })
    return NextResponse.json({ url: `${base}/auth?token=${encodeURIComponent(raw)}` })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ide/token error')
    return NextResponse.json({ error: 'Failed to mint IDE token' }, { status: 500 })
  }
}
