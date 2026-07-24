import { getDatabase } from './db'

const KEY_TYPES = [
  'ssh-ed25519', 'ssh-rsa', 'ssh-dss',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
]

/** True only for a well-formed single-line OpenSSH *public* key. */
export function isValidSshPublicKey(input: string): boolean {
  const s = (input || '').trim()
  if (!s || /PRIVATE KEY/i.test(s)) return false
  const parts = s.split(/\s+/)
  if (parts.length < 2) return false
  if (!KEY_TYPES.includes(parts[0])) return false
  return /^[A-Za-z0-9+/]+={0,3}$/.test(parts[1]) && parts[1].length >= 16
}

/** Trim + collapse internal whitespace so stored keys are canonical. */
export function normalizeSshPublicKey(input: string): string {
  return (input || '').trim().replace(/\s+/g, ' ')
}

export function addUserSshKey(userId: number, workspaceId: number, publicKey: string, label: string | null): { id: number } {
  const info = getDatabase().prepare(
    'INSERT INTO user_ssh_keys (user_id, workspace_id, public_key, label) VALUES (?, ?, ?, ?)'
  ).run(userId, workspaceId, normalizeSshPublicKey(publicKey), label)
  return { id: info.lastInsertRowid as number }
}

export function listUserSshKeys(userId: number): Array<{ id: number; public_key: string; label: string | null; created_at: number }> {
  return getDatabase().prepare(
    'SELECT id, public_key, label, created_at FROM user_ssh_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as any
}

export function deleteUserSshKey(id: number, userId: number): boolean {
  // Scope by user_id so a user can only delete their own keys.
  return getDatabase().prepare('DELETE FROM user_ssh_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

/**
 * For the reconciler: every user + their registered public keys.
 *
 * Intentionally returns users across ALL workspaces/tenants — Phase 1 of the
 * multi-user devshell targets a single shared workspace, so the reconciler
 * (and its Linux-account namespace) is not workspace-scoped either. Scoping
 * this to a workspace/tenant is a follow-up if devshell ever needs to be
 * multi-tenant. `ORDER BY id` makes a normalized-username collision between
 * two users resolve to the same winner (the earlier-created user) every run.
 */
export function listAllUsersWithKeys(): Array<{ username: string; workspace_id: number; role: string; public_keys: string[] }> {
  const db = getDatabase()
  const users = db.prepare('SELECT id, username, workspace_id, role FROM users ORDER BY id').all() as Array<{ id: number; username: string; workspace_id: number; role: string }>
  const keyStmt = db.prepare('SELECT public_key FROM user_ssh_keys WHERE user_id = ?')
  return users.map(u => ({
    username: u.username,
    workspace_id: u.workspace_id,
    role: u.role,
    public_keys: (keyStmt.all(u.id) as Array<{ public_key: string }>).map(k => k.public_key),
  }))
}
