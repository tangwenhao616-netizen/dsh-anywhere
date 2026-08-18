import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromTunnelOrLocal, sameOriginBrowser, isLocalRequest } from '../lib/gate.js'

/** 造一个假 IncomingMessage。 */
function req({ remoteAddress = '127.0.0.1', host = 'localhost', origin, secFetchSite } = {}) {
  return { socket: { remoteAddress }, headers: {
    host, ...(origin !== undefined ? { origin } : {}),
    ...(secFetchSite !== undefined ? { 'sec-fetch-site': secFetchSite } : {}) } }
}

test('fromTunnelOrLocal: cloudflared/localhost socket passes regardless of Host', () => {
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com' })), true)
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '::1', host: 'localhost' })), true)
})

test('fromTunnelOrLocal: raw LAN socket is rejected', () => {
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '192.168.1.50', host: '192.168.1.44:3080' })), false)
})

test('isLocalRequest: localhost passes; via-domain (cloudflared) rejected; raw-LAN rejected', () => {
  // 本机 localhost
  assert.equal(isLocalRequest(req({ remoteAddress: '127.0.0.1', host: 'localhost:3080' })), true)
  assert.equal(isLocalRequest(req({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3080' })), true)
  // 经 cloudflare 域名:socket 是 loopback(cloudflared)但 Host 是公网域名 → 拒
  assert.equal(isLocalRequest(req({ remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com' })), false)
  // 直连 LAN IP → 拒
  assert.equal(isLocalRequest(req({ remoteAddress: '192.168.1.50', host: '192.168.1.44:3080' })), false)
})

test('sameOriginBrowser: cross-site marker rejected; matching origin ok; no-origin ok', () => {
  assert.equal(sameOriginBrowser(req({ host: 'd.com', secFetchSite: 'cross-site', origin: 'https://evil.com' })), false)
  assert.equal(sameOriginBrowser(req({ host: 'd.com', origin: 'https://d.com' })), true)
  assert.equal(sameOriginBrowser(req({ host: 'd.com' })), true)
  assert.equal(sameOriginBrowser(req({ host: 'd.com', origin: 'https://evil.com' })), false)
})
