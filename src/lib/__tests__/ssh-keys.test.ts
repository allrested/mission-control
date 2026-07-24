import { describe, it, expect } from 'vitest'
import { isValidSshPublicKey, normalizeSshPublicKey } from '../ssh-keys'

describe('isValidSshPublicKey', () => {
  it('accepts common OpenSSH public key types', () => {
    expect(isValidSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID user@host')).toBe(true)
    expect(isValidSshPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB comment here')).toBe(true)
    expect(isValidSshPublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAI')).toBe(true)
  })
  it('rejects private keys and junk', () => {
    expect(isValidSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(false)
    expect(isValidSshPublicKey('not a key')).toBe(false)
    expect(isValidSshPublicKey('')).toBe(false)
    expect(isValidSshPublicKey('ssh-ed25519')).toBe(false)
  })
})

describe('normalizeSshPublicKey', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeSshPublicKey('  ssh-ed25519   AAAA   user@host  ')).toBe('ssh-ed25519 AAAA user@host')
  })
})
