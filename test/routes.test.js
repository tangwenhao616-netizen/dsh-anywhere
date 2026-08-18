import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FleetStore } from '../lib/fleet-store.js'
import { FakeProvisioner } from '../lib/provisioner.js'
import { makeRoutes } from '../lib/routes.js'

function res() {
  return { statusCode: 0, headers: {}, body: '',
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h) },
    end(b) { this.body = b ?? '' } }
}
function req({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080', origin } = {}) {
  const r = body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([])
  r.method = method; r.url = url; r.socket = { remoteAddress }
  r.headers = { host, ...(origin !== undefined ? { origin } : {}) }
  return r
}
function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'routes-'))
  const store = new FleetStore(join(dir, 'dsh-fleet.json'))
  store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
  const routes = makeRoutes({ store, provisioner: new FakeProvisioner(),
    sshStorePath: join(dir, 'dsh-ssh.json'), baseUrl: () => 'https://d.trycloudflare.com', now: () => 5000 })
  const byPath = Object.fromEntries(routes.map(r => [r.path, r.handler]))
  return { dir, store, byPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('POST /api/fleet/token mints; GET /api/fleet/list shows it', async () => {
  const c = ctx()
  try {
    const r1 = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'http://127.0.0.1:3080', body: { alias: 'pc', os: 'linux' } }), r1)
    assert.equal(r1.statusCode, 200)
    const minted = JSON.parse(r1.body)
    assert.match(minted.token, /^[0-9a-f]+$/)
    assert.ok(minted.command.includes('/join?token='))
    const r2 = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', origin: 'http://127.0.0.1:3080' }), r2)
    const list = JSON.parse(r2.body)
    assert.equal(list.tokens.length, 1)
  } finally { c.cleanup() }
})

test('GET /join returns a shell script for a valid token', async () => {
  const c = ctx()
  try {
    const rt = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'http://127.0.0.1:3080', body: { alias: 'pc', os: 'linux' } }), rt)
    const { token } = JSON.parse(rt.body)
    const rj = res()
    await c.byPath['/join'](req({ url: `/join?token=${token}` }), rj)
    assert.equal(rj.statusCode, 200)
    assert.match(rj.headers['content-type'], /shellscript|text\/plain/)
    assert.ok(rj.body.includes('/api/fleet/enroll'))
  } finally { c.cleanup() }
})

test('POST /api/fleet/enroll consumes token and returns relay params', async () => {
  const c = ctx()
  try {
    const rt = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'http://127.0.0.1:3080', body: { alias: 'pc', os: 'linux' } }), rt)
    const { token } = JSON.parse(rt.body)
    const re = res()
    await c.byPath['/api/fleet/enroll'](req({ method: 'POST', url: '/api/fleet/enroll',
      body: { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAA x' } }), re)
    assert.equal(re.statusCode, 200)
    const out = JSON.parse(re.body)
    assert.equal(out.ok, true)
    assert.equal(out.port, 20001)
    assert.equal(out.relayHost, 'relay.example')
  } finally { c.cleanup() }
})

test('enroll rejects a bad token with 403', async () => {
  const c = ctx()
  try {
    const re = res()
    await c.byPath['/api/fleet/enroll'](req({ method: 'POST', url: '/api/fleet/enroll',
      body: { token: 'deadbeef', os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' } }), re)
    assert.equal(re.statusCode, 403)
  } finally { c.cleanup() }
})

test('privileged routes reject raw-LAN socket', async () => {
  const c = ctx()
  try {
    const r = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', remoteAddress: '192.168.1.50', host: '192.168.1.44:3080' }), r)
    assert.equal(r.statusCode, 403)
  } finally { c.cleanup() }
})

test('POST /api/fleet/relay sets the relay config', async () => {
  const c = ctx()
  try {
    const r = res()
    await c.byPath['/api/fleet/relay'](req({ method: 'POST', url: '/api/fleet/relay', origin: 'http://127.0.0.1:3080', body: { host: '203.0.113.9', jumpLogin: 'ubuntu@203.0.113.9' } }), r)
    assert.equal(r.statusCode, 200)
    assert.equal(c.store.load().relay.host, '203.0.113.9')
    assert.equal(c.store.load().relay.jumpLogin, 'ubuntu@203.0.113.9')
  } finally { c.cleanup() }
})

test('POST /api/fleet/relay 带 frp 参数;未带则保留现值', async () => {
  const c = ctx()
  try {
    const r1 = res()
    await c.byPath['/api/fleet/relay'](req({ method: 'POST', url: '/api/fleet/relay', origin: 'http://127.0.0.1:3080',
      body: { host: '203.0.113.9', frpToken: 'TOK123', frpPort: 443, frpProtocol: 'tcp' } }), r1)
    assert.equal(c.store.load().relay.frpToken, 'TOK123')
    assert.equal(c.store.load().relay.frpPort, 443)
    // 再设一次不带 frp 字段 → 保留
    const r2 = res()
    await c.byPath['/api/fleet/relay'](req({ method: 'POST', url: '/api/fleet/relay', origin: 'http://127.0.0.1:3080',
      body: { host: '203.0.113.9', jumpLogin: 'ubuntu@203.0.113.9' } }), r2)
    assert.equal(c.store.load().relay.frpToken, 'TOK123', 'frpToken 保留')
    assert.equal(c.store.load().relay.frpPort, 443, 'frpPort 保留')
  } finally { c.cleanup() }
})

test('GET /api/fleet/frpc 托管二进制(经隧道可下);缺失 404;裸 LAN 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frpc-'))
  try {
    const store = new FleetStore(join(dir, 'dsh-fleet.json'))
    store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: '', portRange: [20001, 20999] } })
    const frpDir = join(dir, 'frp'); mkdirSync(frpDir, { recursive: true })
    writeFileSync(join(frpDir, 'frpc'), Buffer.from('ELF-LINUX-FAKE'))
    writeFileSync(join(frpDir, 'frpc.exe'), Buffer.from('MZ-WIN-FAKE'))
    const mk = (fd) => Object.fromEntries(makeRoutes({ store, provisioner: new FakeProvisioner(),
      sshStorePath: join(dir, 'dsh-ssh.json'), baseUrl: () => 'https://d.trycloudflare.com', frpDir: fd, now: () => 5000 }).map(r => [r.path, r.handler]))
    const byPath = mk(frpDir)

    const r1 = res()  // linux,经隧道域名(机器入网下载)
    await byPath['/api/fleet/frpc'](req({ url: '/api/fleet/frpc', remoteAddress: '127.0.0.1', host: 'x.trycloudflare.com' }), r1)
    assert.equal(r1.statusCode, 200)
    assert.equal(r1.headers['content-type'], 'application/octet-stream')
    assert.equal(String(r1.body), 'ELF-LINUX-FAKE')

    const r2 = res()  // windows
    await byPath['/api/fleet/frpc'](req({ url: '/api/fleet/frpc?os=win', remoteAddress: '127.0.0.1', host: '127.0.0.1:3080' }), r2)
    assert.equal(r2.statusCode, 200)
    assert.equal(String(r2.body), 'MZ-WIN-FAKE')

    const r3 = res()  // 缺失目录 → 404
    await mk(join(dir, 'nope'))['/api/fleet/frpc'](req({ url: '/api/fleet/frpc', remoteAddress: '127.0.0.1', host: '127.0.0.1:3080' }), r3)
    assert.equal(r3.statusCode, 404)

    const r4 = res()  // 裸 LAN → 403
    await byPath['/api/fleet/frpc'](req({ url: '/api/fleet/frpc', remoteAddress: '192.168.1.9', host: '192.168.1.44:3080' }), r4)
    assert.equal(r4.statusCode, 403)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('request → list → approve → machine enrolled; status pending then approved', async () => {
  const c = ctx()
  try {
    const rr = res()
    await c.byPath['/api/fleet/request'](req({ method: 'POST', url: '/api/fleet/request',
      body: { name: 'office', os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAA x', code: '7F3A-91' } }), rr)
    assert.equal(rr.statusCode, 200)
    const { pollId, code } = JSON.parse(rr.body)
    assert.match(pollId, /^[0-9a-f]{64}$/)
    assert.equal(code, '7F3A-91')

    const rl = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', origin: 'http://127.0.0.1:3080' }), rl)
    const list = JSON.parse(rl.body)
    assert.equal(list.requests.length, 1)
    const reqId = list.requests[0].reqId
    assert.equal(list.requests[0].code, '7F3A-91')
    assert.equal(list.requests[0].pollId, undefined)

    const rs1 = res()
    await c.byPath['/api/fleet/request-status'](req({ url: `/api/fleet/request-status?id=${pollId}` }), rs1)
    assert.equal(JSON.parse(rs1.body).status, 'pending')

    const ra = res()
    await c.byPath['/api/fleet/approve'](req({ method: 'POST', url: '/api/fleet/approve', origin: 'http://127.0.0.1:3080', body: { reqId } }), ra)
    assert.equal(ra.statusCode, 200)

    const rs2 = res()
    await c.byPath['/api/fleet/request-status'](req({ url: `/api/fleet/request-status?id=${pollId}` }), rs2)
    const st = JSON.parse(rs2.body)
    assert.equal(st.status, 'approved')
    assert.equal(st.result.port, 20001)
    assert.equal(st.result.relayHost, 'relay.example')

    const rl2 = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', origin: 'http://127.0.0.1:3080' }), rl2)
    const list2 = JSON.parse(rl2.body)
    assert.equal(list2.requests.length, 0)
    assert.equal(list2.machines[0].alias, 'office')
  } finally { c.cleanup() }
})

test('approve needs reqId + privilege', async () => {
  const c = ctx()
  try {
    const ra = res()
    await c.byPath['/api/fleet/approve'](req({ method: 'POST', url: '/api/fleet/approve', origin: 'http://127.0.0.1:3080', body: {} }), ra)
    assert.equal(ra.statusCode, 400)
    const ra2 = res()
    await c.byPath['/api/fleet/approve'](req({ method: 'POST', url: '/api/fleet/approve', remoteAddress: '192.168.1.9', host: '192.168.1.44:3080', body: { reqId: 'x' } }), ra2)
    assert.equal(ra2.statusCode, 403)
  } finally { c.cleanup() }
})

test('GET /fleet serves the management panel HTML; raw-LAN rejected', async () => {
  const c = ctx()
  try {
    const r = res()
    await c.byPath['/fleet'](req({ url: '/fleet' }), r)
    assert.equal(r.statusCode, 200)
    assert.match(r.headers['content-type'], /text\/html/)
    assert.ok(r.body.includes('待批准'))
    assert.ok(r.body.includes('已入网'))
    assert.ok(r.body.includes('/api/fleet/list'))
    assert.ok(r.body.includes('/join'))
    const r2 = res()
    await c.byPath['/fleet'](req({ url: '/fleet', remoteAddress: '192.168.1.9', host: '192.168.1.44:3080' }), r2)
    assert.equal(r2.statusCode, 403)
  } finally { c.cleanup() }
})

test('GET /join: no-token → request bootstrap; ?os=win placeholder; browser → html', async () => {
  const c = ctx()
  try {
    const r1 = res()
    await c.byPath['/join'](req({ url: '/join' }), r1)
    assert.equal(r1.statusCode, 200)
    assert.ok(r1.body.includes('/api/fleet/request'))
    assert.ok(r1.body.includes('IdentitiesOnly=yes'))
    const r2 = res()
    await c.byPath['/join'](req({ url: '/join?os=win' }), r2)
    assert.ok(r2.body.includes('/api/fleet/request'))
    assert.ok(r2.body.includes('Register-ScheduledTask'))
    const rq = req({ url: '/join' }); rq.headers.accept = 'text/html'
    const r3 = res()
    await c.byPath['/join'](rq, r3)
    assert.match(r3.headers['content-type'], /text\/html/)
    assert.ok(r3.body.includes('curl'))
  } finally { c.cleanup() }
})

test('privileged is local-only: via-domain rejected; machine /request via-domain still ok', async () => {
  const c = ctx()
  try {
    // approve 经 cloudflare 域名(socket loopback 但 Host 是公网域名)→ 403 local-only
    const ra = res()
    await c.byPath['/api/fleet/approve'](req({ method: 'POST', url: '/api/fleet/approve',
      remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com', origin: 'https://rip-dee.trycloudflare.com', body: { reqId: 'x' } }), ra)
    assert.equal(ra.statusCode, 403)
    // /fleet 经域名 → 403(管理页仅本机)
    const rf = res()
    await c.byPath['/fleet'](req({ url: '/fleet', remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com' }), rf)
    assert.equal(rf.statusCode, 403)
    // 机器面 /request 经域名(cloudflared)→ 仍 200(异地机器要能提交申请)
    const rq2 = res()
    await c.byPath['/api/fleet/request'](req({ method: 'POST', url: '/api/fleet/request',
      remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com',
      body: { name: 'remote', os: 'linux', remoteUser: 'u', tunnelPublicKey: 'ssh-ed25519 AAAA r', code: 'XX-YY' } }), rq2)
    assert.equal(rq2.statusCode, 200)
  } finally { c.cleanup() }
})
