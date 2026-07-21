import { describe, it, expect } from 'vitest'
import { resolveConfigDirCandidates } from '../task-dispatch'

// Validator stub: treat any non-empty string starting with '/ok' as a valid
// existing dir; everything else invalid → null. Keeps the test filesystem-free.
const validate = (d: unknown): string | null =>
  typeof d === 'string' && d.startsWith('/ok') ? d : null

describe('resolveConfigDirCandidates (credential rotation order + fallback)', () => {
  it('rotation on → returns the validated pool in order', () => {
    expect(resolveConfigDirCandidates(
      { rotation: true, credentialDirs: ['/ok/a', '/ok/b', '/ok/c'], dispatchConfigDir: '/ok/single' },
      validate,
    )).toEqual(['/ok/a', '/ok/b', '/ok/c'])
  })

  it('rotation on → drops invalid dirs but keeps order', () => {
    expect(resolveConfigDirCandidates(
      { rotation: true, credentialDirs: ['/ok/a', '/bad', '/ok/c'], dispatchConfigDir: null },
      validate,
    )).toEqual(['/ok/a', '/ok/c'])
  })

  it('rotation on but empty/all-invalid pool → single dispatchConfigDir path', () => {
    expect(resolveConfigDirCandidates(
      { rotation: true, credentialDirs: ['/bad', '/nope'], dispatchConfigDir: '/ok/single' },
      validate,
    )).toEqual(['/ok/single'])
  })

  it('rotation off → single element from dispatchConfigDir', () => {
    expect(resolveConfigDirCandidates(
      { rotation: false, credentialDirs: ['/ok/a', '/ok/b'], dispatchConfigDir: '/ok/single' },
      validate,
    )).toEqual(['/ok/single'])
  })

  it('rotation off, no dir → [null] (global default)', () => {
    expect(resolveConfigDirCandidates(
      { rotation: false, credentialDirs: undefined, dispatchConfigDir: undefined },
      validate,
    )).toEqual([null])
  })
})
