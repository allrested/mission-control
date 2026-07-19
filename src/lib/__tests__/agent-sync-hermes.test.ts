import { describe, it, expect } from 'vitest'
import { yamlBlockScalar } from '../agent-sync'

const CONFIG = `model:
  default: gpt-5.6-sol
  provider: openai-codex
  base_url: https://chatgpt.com/backend-api/codex
terminal:
  backend: local
  timeout: 180
compression:
  enabled: true
`

describe('yamlBlockScalar (hermes config.yaml reader)', () => {
  it('reads scalars from the requested block only', () => {
    expect(yamlBlockScalar(CONFIG, 'model', 'default')).toBe('gpt-5.6-sol')
    expect(yamlBlockScalar(CONFIG, 'model', 'provider')).toBe('openai-codex')
    expect(yamlBlockScalar(CONFIG, 'terminal', 'backend')).toBe('local')
  })

  it('does not leak keys across blocks', () => {
    expect(yamlBlockScalar(CONFIG, 'model', 'backend')).toBeNull()
    expect(yamlBlockScalar(CONFIG, 'compression', 'default')).toBeNull()
  })

  it('returns null for missing blocks or keys', () => {
    expect(yamlBlockScalar(CONFIG, 'nope', 'default')).toBeNull()
    expect(yamlBlockScalar(CONFIG, 'model', 'nope')).toBeNull()
    expect(yamlBlockScalar('', 'model', 'default')).toBeNull()
  })
})
