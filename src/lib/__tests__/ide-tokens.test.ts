import { describe, it, expect } from 'vitest'
import { hashIdeToken } from '../ide-tokens'

describe('hashIdeToken', () => {
  it('is a stable 64-char sha256 hex', () => {
    const h = hashIdeToken('abc')
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    expect(hashIdeToken('abc')).toBe(h)
    expect(hashIdeToken('abd')).not.toBe(h)
  })
})
