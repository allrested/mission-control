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
