import { existsSync } from 'node:fs'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { syncAgentsFromConfig, syncAgentsFromHermes, previewSyncDiff } from '@/lib/agent-sync'
import { syncLocalAgents } from '@/lib/local-agent-sync'
import { config } from '@/lib/config'
import { isHermesInstalled } from '@/lib/hermes-sessions'
import { logger } from '@/lib/logger'
import { denyUnscopedResourceForStrictWorkspace } from '@/lib/workspace-isolation'

/**
 * POST /api/agents/sync - Trigger agent config sync
 * ?source=local triggers local disk scan; ?source=hermes syncs from the
 * hermes home directory; ?source=openclaw forces openclaw.json.
 * Default: openclaw.json when it exists, otherwise hermes when installed.
 * Requires admin role.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const isolationDeny = denyUnscopedResourceForStrictWorkspace(auth.user, 'runtime_configuration', new URL(request.url).pathname)
  if (isolationDeny) return isolationDeny

  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source')

  try {
    if (source === 'local') {
      const result = await syncLocalAgents(auth.user.workspace_id)
      return NextResponse.json(result)
    }

    // Hermes-first default: openclaw.json is only preferred when it actually
    // exists; a hermes install is otherwise the sync source.
    const useHermes = source === 'hermes'
      || (source !== 'openclaw' && !existsSync(config.openclawConfigPath) && isHermesInstalled())

    const result = useHermes
      ? await syncAgentsFromHermes(auth.user.username, auth.user.workspace_id)
      : await syncAgentsFromConfig(auth.user.username, auth.user.workspace_id)

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json(result)
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/agents/sync error')
    return NextResponse.json({ error: error.message || 'Sync failed' }, { status: 500 })
  }
}

/**
 * GET /api/agents/sync - Preview diff between openclaw.json and MC
 * Shows what would change without writing.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const isolationDeny = denyUnscopedResourceForStrictWorkspace(auth.user, 'runtime_configuration', new URL(request.url).pathname)
  if (isolationDeny) return isolationDeny

  try {
    const diff = await previewSyncDiff(auth.user.workspace_id)
    return NextResponse.json(diff)
  } catch (error: any) {
    logger.error({ err: error }, 'GET /api/agents/sync error')
    return NextResponse.json({ error: error.message || 'Preview failed' }, { status: 500 })
  }
}
