import { describe, it, expect } from 'vitest'
import { isUsageLimitError } from '../task-dispatch'

describe('isUsageLimitError (usage-limit failover trigger)', () => {
  it('matches common claude/codex usage-limit wording', () => {
    for (const msg of [
      'Claude usage limit reached. Try again later.',
      'codex usage limit: you have hit your limit',
      'HTTP 429 Too Many Requests',
      'Error 529: overloaded',
      'rate_limit_exceeded',
      'You have exceeded your current quota',
      "You've exceeded your usage limit for this month",
      'insufficient_quota',
    ]) {
      expect(isUsageLimitError(msg), msg).toBe(true)
    }
  })

  it('does not misfire on ordinary task errors', () => {
    for (const msg of [
      'claude CLI exited 1: SyntaxError in file',
      'ENOENT: no such file or directory',
      'Task returned empty response',
      'connection refused',
      '',
      null,
      undefined,
    ]) {
      expect(isUsageLimitError(msg as any), String(msg)).toBe(false)
    }
  })
})
