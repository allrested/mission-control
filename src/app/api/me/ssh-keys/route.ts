import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { isValidSshPublicKey, addUserSshKey, listUserSshKeys } from '@/lib/ssh-keys'
import { logAuditEvent } from '@/lib/db'
import { identitySecurityMutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    return NextResponse.json({ keys: listUserSshKeys(auth.user.id) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/me/ssh-keys error')
    return NextResponse.json({ error: 'Failed to list SSH keys' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = identitySecurityMutationLimiter(`${auth.user.tenant_id ?? 1}:${auth.user.workspace_id ?? 1}:${auth.user.id}:ssh-key`)
  if (rateCheck) return rateCheck

  let body: { public_key?: string; label?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const publicKey = String(body.public_key || '')
  if (!isValidSshPublicKey(publicKey)) {
    return NextResponse.json({ error: 'Not a valid OpenSSH public key (private keys are rejected)' }, { status: 400 })
  }
  const label = body.label ? String(body.label).slice(0, 100) : null

  try {
    const { id } = addUserSshKey(auth.user.id, auth.user.workspace_id ?? 1, publicKey, label)
    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    logAuditEvent({
      action: 'ssh_key_added',
      actor: auth.user.username,
      actor_id: auth.user.id,
      target_type: 'user_ssh_key',
      target_id: id,
      detail: { user_id: auth.user.id, workspace_id: auth.user.workspace_id ?? 1 },
      ip_address: ipAddress,
      workspace_id: auth.user.workspace_id ?? 1,
    })
    return NextResponse.json({ id }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/me/ssh-keys error')
    return NextResponse.json({ error: 'Failed to add SSH key' }, { status: 500 })
  }
}
