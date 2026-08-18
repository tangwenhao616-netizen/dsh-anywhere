import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mintToken, findToken, consumeToken, listTokens, revokeToken } from '../lib/token.js'

/** 内存假 store:load/save 操作一个对象。 */
function fakeStore(initial = { version: 1, relay: {}, tokens: [], machines: [] }) {
  let file = structuredClone(initial)
  return { load: () => structuredClone(file), save: f => { file = structuredClone(f) },
           update(m) { const f = this.load(); const r = m(f); this.save(f); return r }, _peek: () => file }
}

test('mint creates an unconsumed token with ttl', () => {
  const store = fakeStore()
  const now = 1000
  const rec = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 600000 }, now)
  assert.match(rec.token, /^[0-9a-f]{48,}$/)
  assert.equal(rec.consumed, false)
  assert.equal(rec.expiresAt, now + 600000)
  assert.equal(store._peek().tokens.length, 1)
})

test('consume succeeds once, then rejects reuse', () => {
  const store = fakeStore()
  const now = 1000
  const { token } = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 600000 }, now)
  const first = consumeToken(store, token, now + 10)
  assert.equal(first.ok, true)
  assert.equal(first.record.alias, 'pc')
  const second = consumeToken(store, token, now + 20)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'consumed')
})

test('consume rejects unknown and expired', () => {
  const store = fakeStore()
  const now = 1000
  const { token } = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 100 }, now)
  assert.equal(consumeToken(store, 'nope', now).ok, false)
  assert.equal(consumeToken(store, 'nope', now).reason, 'unknown')
  const late = consumeToken(store, token, now + 200)
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'expired')
})

test('list hides consumed and expired; revoke removes', () => {
  const store = fakeStore()
  const now = 1000
  const a = mintToken(store, { alias: 'a', os: 'linux', ttlMs: 600000 }, now)
  mintToken(store, { alias: 'b', os: 'linux', ttlMs: 1 }, now)
  const live = listTokens(store, now + 100)
  assert.deepEqual(live.map(t => t.alias), ['a'])
  revokeToken(store, a.token)
  assert.equal(listTokens(store, now + 100).length, 0)
})
