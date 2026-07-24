import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listAllUsersWithKeys } from '@/lib/ssh-keys'
import { logger } from '@/lib/logger'

// Consumed by the mc-devshell reconciler using the global API key (admin scope).
// Returns only usernames, roles, and PUBLIC keys — never secrets.
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    return NextResponse.json(listAllUsersWithKeys())
  } catch (error) {
    logger.error({ err: error }, 'GET /api/users/ssh-keys error')
    return NextResponse.json({ error: 'Failed to list users' }, { status: 500 })
  }
}
