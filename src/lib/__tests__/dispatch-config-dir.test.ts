import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDispatchConfigDir } from '../task-dispatch'

describe('resolveDispatchConfigDir (per-agent CLAUDE_CONFIG_DIR / CODEX_HOME)', () => {
  it('returns an existing directory path unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-creds-'))
    expect(resolveDispatchConfigDir(dir)).toBe(dir)
  })

  it('falls back to global (null) for missing/blank/invalid input', () => {
    expect(resolveDispatchConfigDir('')).toBeNull()
    expect(resolveDispatchConfigDir('   ')).toBeNull()
    expect(resolveDispatchConfigDir(undefined)).toBeNull()
    expect(resolveDispatchConfigDir(null)).toBeNull()
    expect(resolveDispatchConfigDir(42)).toBeNull()
    expect(resolveDispatchConfigDir('/no/such/dir/xyz-123')).toBeNull()
  })

  it('rejects a path that exists but is a file, not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-creds-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{}')
    expect(resolveDispatchConfigDir(file)).toBeNull()
  })
})
