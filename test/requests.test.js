import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from '../lib/fleet-store.js'
import { FakeProvisioner } from '../lib/provisioner.js'
import { registerRequest, getRequestStatus, listRequests, approveRequest, rejectRequest } from '../lib/requests.js'

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'req-'))
  const store = new FleetStore(join(dir, 'dsh-fleet.json'))
  store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
  return { dir, store, sshPath: join(dir, 'dsh-ssh.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const REQ = { name: 'pc', os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAA k', code: '7F3A-91', sourceIp: '127.0.0.1' }

test('register returns pollId+code; status pending; list gives reqId not pollId/pubkey', () => {
  const c = ctx()
  try {
    const r = registerRequest(c.store, REQ, 1000)
    assert.equal(r.ok, true)
    assert.match(r.pollId, /^[0-9a-f]{64}$/)
    assert.equal(r.code, '7F3A-91')
    assert.equal(getRequestStatus(c.store, r.pollId, 1100).status, 'pending')
    const list = listRequests(c.store, 1100)
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'pc')
    assert.equal(list[0].code, '7F3A-91')
    assert.ok(list[0].reqId)
    assert.equal(list[0].pollId, undefined)
    assert.equal(list[0].tunnelPublicKey, undefined)
  } finally { c.cleanup() }
})

test('approve runs enrollCore; machine poll then gets relay params + op pubkey', async () => {
  const c = ctx()
  try {
    const r = registerRequest(c.store, REQ, 1000)
    const reqId = listRequests(c.store, 1100)[0].reqId
    const deps = { store: c.store, provisioner: new FakeProvisioner(), sshStorePath: c.sshPath }
    const ap = await approveRequest(deps, reqId, undefined, 1200)
    assert.equal(ap.ok, true)
    assert.equal(ap.result.port, 20001)
    const st = getRequestStatus(c.store, r.pollId, 1300)
    assert.equal(st.status, 'approved')
    assert.equal(st.result.port, 20001)
    assert.equal(st.result.relayHost, 'relay.example')
    assert.match(st.result.operationPublicKey, /^ssh-ed25519 /)
    assert.equal(c.store.load().machines[0].alias, 'pc')
    assert.equal(listRequests(c.store, 1300).length, 0)
  } finally { c.cleanup() }
})

test('approve honors alias override', async () => {
  const c = ctx()
  try {
    registerRequest(c.store, REQ, 1000)
    const reqId = listRequests(c.store, 1100)[0].reqId
    const deps = { store: c.store, provisioner: new FakeProvisioner(), sshStorePath: c.sshPath }
    await approveRequest(deps, reqId, 'my-office', 1200)
    assert.equal(c.store.load().machines[0].alias, 'my-office')
  } finally { c.cleanup() }
})

test('approve rejects unknown & expired; reject removes', async () => {
  const c = ctx()
  try {
    const deps = { store: c.store, provisioner: new FakeProvisioner(), sshStorePath: c.sshPath }
    assert.equal((await approveRequest(deps, 'nope', undefined, 1200)).reason, 'unknown')
    registerRequest(c.store, REQ, 1000, 100)
    const reqId = listRequests(c.store, 1050)[0].reqId
    assert.equal((await approveRequest(deps, reqId, undefined, 2000)).reason, 'expired')
    registerRequest(c.store, { ...REQ, name: 'pc2' }, 3000)
    const reqId2 = listRequests(c.store, 3050).find(x => x.name === 'pc2').reqId
    rejectRequest(c.store, reqId2)
    assert.equal(listRequests(c.store, 3050).some(x => x.name === 'pc2'), false)
  } finally { c.cleanup() }
})

test('rate limit by sourceIp', () => {
  const c = ctx()
  try {
    for (let i = 0; i < 10; i++) assert.equal(registerRequest(c.store, { ...REQ, name: `m${i}` }, 1000).ok, true)
    const over = registerRequest(c.store, { ...REQ, name: 'm11' }, 1000)
    assert.equal(over.ok, false)
    assert.equal(over.reason, 'rate-limited')
  } finally { c.cleanup() }
})
