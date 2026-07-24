import { createHash, randomBytes } from 'node:crypto'
import { getDatabase } from './db'

export function hashIdeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function mintIdeToken(userId: number, workspaceId: number, ttlSeconds = 60): { raw: string; expiresAt: number } {
  const raw = randomBytes(32).toString('hex')
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + ttlSeconds
  const db = getDatabase()
  // Opportunistic prune of stale rows.
  db.prepare('DELETE FROM ide_handoff_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(now)
  db.prepare('INSERT INTO ide_handoff_tokens (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashIdeToken(raw), userId, workspaceId, expiresAt)
  return { raw, expiresAt }
}

/** Single-use redeem: returns the bound user once, then the token is spent. */
export function redeemIdeToken(raw: string): { user_id: number; workspace_id: number } | null {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const row = db.prepare(
    'SELECT id, user_id, workspace_id, expires_at, used_at FROM ide_handoff_tokens WHERE token_hash = ?'
  ).get(hashIdeToken(raw)) as { id: number; user_id: number; workspace_id: number; expires_at: number; used_at: number | null } | undefined
  if (!row || row.used_at !== null || row.expires_at < now) return null
  // Atomically claim: only succeeds if still unused.
  const claim = db.prepare('UPDATE ide_handoff_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id)
  if (claim.changes === 0) return null
  return { user_id: row.user_id, workspace_id: row.workspace_id }
}
