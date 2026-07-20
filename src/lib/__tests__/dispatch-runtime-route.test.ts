import { describe, it, expect } from 'vitest'
import { pickRuntimeRoute } from '../task-dispatch'

describe('pickRuntimeRoute (runtime_type → dispatch route)', () => {
  it('routes each runtime to its own executor', () => {
    expect(pickRuntimeRoute('claude', { hermes: true })).toBe('claude')
    expect(pickRuntimeRoute('codex', { hermes: true })).toBe('codex')
    expect(pickRuntimeRoute('hermes', { hermes: true })).toBe('hermes')
  })

  it('is case-insensitive', () => {
    expect(pickRuntimeRoute('Claude', { hermes: true })).toBe('claude')
    expect(pickRuntimeRoute('HERMES', { hermes: true })).toBe('hermes')
  })

  it('falls back to model routing for hermes when the CLI is absent', () => {
    expect(pickRuntimeRoute('hermes', { hermes: false })).toBe('model')
  })

  it('uses model-based routing for openclaw/custom/legacy/unset agents', () => {
    expect(pickRuntimeRoute('openclaw', { hermes: true })).toBe('model')
    expect(pickRuntimeRoute('custom', { hermes: true })).toBe('model')
    expect(pickRuntimeRoute(null, { hermes: true })).toBe('model')
    expect(pickRuntimeRoute(undefined, { hermes: true })).toBe('model')
    expect(pickRuntimeRoute('', { hermes: true })).toBe('model')
  })
})
