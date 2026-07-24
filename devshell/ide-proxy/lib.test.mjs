import assert from 'node:assert'
import { sanitizeUsername, signCookie, verifyCookie, pickPort } from './lib.js'

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

// port pick
assert.equal(pickPort(new Set([9000, 9001]), [9000, 9002]), 9002)
assert.equal(pickPort(new Set([9000, 9001, 9002]), [9000, 9002]), null)
console.log('ide-proxy lib: all assertions pass')
