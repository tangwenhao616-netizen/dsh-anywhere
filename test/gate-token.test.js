// 管理员令牌 gate 单测(fake request,无网络)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireLocalOrToken, tokenOf } from '../lib/gate.js'

const req = (o = {}) => ({
  socket: { remoteAddress: o.addr ?? '127.0.0.1' },
  headers: {
    host: o.host ?? 'localhost:3080',
    ...(o.origin !== undefined ? { origin: o.origin } : {}),
    ...(o.token ? { 'x-fleet-token': o.token } : {}),
    ...(o.fetchSite ? { 'sec-fetch-site': o.fetchSite } : {}),
  },
  url: o.url ?? '/',
})

test('tokenOf: X-Fleet-Token 头 或 ?key=', () => {
  assert.equal(tokenOf(req({ token: 'abc' })), 'abc')
  assert.equal(tokenOf(req({ url: '/x?key=xyz' })), 'xyz')
  assert.equal(tokenOf(req({})), '')
})

test('requireLocalOrToken: 本机(loopback Host)免令牌放行', () => {
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'localhost:3080' }), 'SECRET'), true)
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: '127.0.0.1:3080' }), 'SECRET'), true)
})

test('requireLocalOrToken: 隧道(公网 Host)+ 正确令牌放行', () => {
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'x.trycloudflare.com', token: 'SECRET' }), 'SECRET'), true)
})

test('requireLocalOrToken: 隧道 + 错令牌/无令牌/未设令牌 一律拒', () => {
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'x.trycloudflare.com', token: 'WRONG' }), 'SECRET'), false)
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'x.trycloudflare.com' }), 'SECRET'), false)
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'x.trycloudflare.com', token: 'SECRET' }), ''), false)
})

test('requireLocalOrToken: 非隧道非本机(直连 LAN IP)拒', () => {
  assert.equal(requireLocalOrToken(req({ addr: '192.168.1.50', host: '192.168.1.44:3080', token: 'SECRET' }), 'SECRET'), false)
})

test('requireLocalOrToken: 浏览器跨站(CSRF)拒', () => {
  assert.equal(requireLocalOrToken(req({ addr: '127.0.0.1', host: 'localhost:3080', fetchSite: 'cross-site' }), 'SECRET'), false)
})
