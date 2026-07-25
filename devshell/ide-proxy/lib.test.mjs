import assert from 'node:assert'
import { sanitizeUsername, signCookie, verifyCookie } from './lib.js'

// sanitize matches the reconciler
assert.equal(sanitizeUsername('Jane.Doe'), 'jane_doe')
assert.equal(sanitizeUsername('-x'), 'x')
assert.equal(sanitizeUsername('Foo Bar'), 'foo_bar')

// cookie round-trip + tamper + expiry
const S = 'secret'
const now = 1000
const c = signCookie('usera', now + 100, S)
assert.deepEqual(verifyCookie(c, S, now), { username: 'usera', exp: now + 100 })
assert.equal(verifyCookie(c, 'wrong', now), null)                 // bad secret
assert.equal(verifyCookie(c, S, now + 200), null)                 // expired
assert.equal(verifyCookie(c.slice(0, -1) + '0', S, now), null)    // tampered mac
assert.equal(verifyCookie('not|enough', S, now), null)             // malformed (wrong part count)

console.log('ide-proxy lib: all assertions pass')
