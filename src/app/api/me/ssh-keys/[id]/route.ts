import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { deleteUserSshKey } from '@/lib/ssh-keys'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { id } = await params
  const ok = deleteUserSshKey(Number(id), auth.user.id)
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 })
}
