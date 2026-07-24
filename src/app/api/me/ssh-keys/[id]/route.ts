import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { deleteUserSshKey } from '@/lib/ssh-keys'
import { logAuditEvent } from '@/lib/db'
import { identitySecurityMutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = identitySecurityMutationLimiter(`${auth.user.tenant_id ?? 1}:${auth.user.workspace_id ?? 1}:${auth.user.id}:ssh-key`)
  if (rateCheck) return rateCheck

  const { id } = await params
  const idNum = Number(id)
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  try {
    const ok = deleteUserSshKey(idNum, auth.user.id)
    if (ok) {
      const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
      logAuditEvent({
        action: 'ssh_key_removed',
        actor: auth.user.username,
        actor_id: auth.user.id,
        target_type: 'user_ssh_key',
        target_id: idNum,
        detail: { user_id: auth.user.id, workspace_id: auth.user.workspace_id ?? 1 },
        ip_address: ipAddress,
        workspace_id: auth.user.workspace_id ?? 1,
      })
    }
    return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/me/ssh-keys/[id] error')
    return NextResponse.json({ error: 'Failed to delete SSH key' }, { status: 500 })
  }
}
