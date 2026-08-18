import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from '../lib/fleet-store.js'
import { mintToken } from '../lib/token.js'
import { FakeProvisioner } from '../lib/provisioner.js'
import { enrollMachine, enrollCore } from '../lib/enroll.js'

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'enroll-'))
  const store = new FleetStore(join(dir, 'dsh-fleet.json'))
  // 默认 seed 一个测试中继(enroll 有"中继未配置即拒"的前置守卫)
  store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
  const sshPath = join(dir, 'dsh-ssh.json')
  return { dir, store, sshPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('happy path: consumes token, allocates port, pushes tunnel key, writes ssh host, records machine', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const { token } = mintToken(c.store, { alias: 'office', os: 'linux', ttlMs: 600000 }, 1000)
    const res = await enrollMachine(
      { store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAAtunnel office' },
      2000,
    )
    assert.equal(res.ok, true)
    assert.equal(res.port, 20001)
    assert.equal(res.relayHost, 'relay.example')
    assert.match(res.operationPublicKey, /^ssh-ed25519 /)
    assert.deepEqual(prov.pushed, [{ pubkey: 'ssh-ed25519 AAAAtunnel office', port: 20001 }])
    const ssh = JSON.parse(readFileSync(c.sshPath, 'utf8'))
    assert.equal(ssh.hosts[0].alias, 'fleet-office')
    assert.equal(ssh.hosts[0].port, 20001)
    assert.deepEqual(ssh.hosts[0].proxyJump, ['relay-jump'])
    const m = c.store.load().machines[0]
    assert.equal(m.alias, 'office')
    assert.equal(m.port, 20001)
    assert.equal(m.status, 'enrolling')
  } finally { c.cleanup() }
})

test('rejects an already-consumed token', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const { token } = mintToken(c.store, { alias: 'office', os: 'linux', ttlMs: 600000 }, 1000)
    await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 2000)
    const again = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 3000)
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'consumed')
    assert.equal(c.store.load().machines.length, 1)
  } finally { c.cleanup() }
})

test('second machine gets the next port', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const a = mintToken(c.store, { alias: 'a', os: 'linux', ttlMs: 600000 }, 1000)
    const b = mintToken(c.store, { alias: 'b', os: 'linux', ttlMs: 600000 }, 1000)
    const r1 = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token: a.token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k1' }, 2000)
    const r2 = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token: b.token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k2' }, 2000)
    assert.equal(r1.port, 20001)
    assert.equal(r2.port, 20002)
  } finally { c.cleanup() }
})

test('rejects when relay not configured, without consuming the token', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    c.store.update(f => { f.relay = { ...f.relay, host: '' } })
    const { token } = mintToken(c.store, { alias: 'x', os: 'linux', ttlMs: 600000 }, 1000)
    const res = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 2000)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'relay-not-configured')
    c.store.update(f => { f.relay = { ...f.relay, host: 'relay.example' } })
    const ok = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 3000)
    assert.equal(ok.ok, true)
  } finally { c.cleanup() }
})

test('enrollCore enrolls directly without a token (approve flow)', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const res = await enrollCore(
      { store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { alias: 'approved-pc', os: 'win', remoteUser: 'Administrator', tunnelPublicKey: 'ssh-ed25519 AAAA win' },
      2000,
    )
    assert.equal(res.ok, true)
    assert.equal(res.port, 20001)
    assert.equal(res.relayHost, 'relay.example')
    assert.match(res.operationPublicKey, /^ssh-ed25519 /)
    assert.deepEqual(prov.pushed, [{ pubkey: 'ssh-ed25519 AAAA win', port: 20001 }])
    const m = c.store.load().machines[0]
    assert.equal(m.alias, 'approved-pc')
    assert.equal(m.os, 'win')
    const ssh = JSON.parse(readFileSync(c.sshPath, 'utf8'))
    assert.equal(ssh.hosts[0].alias, 'fleet-approved-pc')
  } finally { c.cleanup() }
})

test('enrollCore rejects when relay not configured', async () => {
  const c = ctx()
  try {
    c.store.update(f => { f.relay = { ...f.relay, host: '' } })
    const res = await enrollCore({ store: c.store, provisioner: new FakeProvisioner(), sshStorePath: c.sshPath },
      { alias: 'x', os: 'linux', remoteUser: 'u', tunnelPublicKey: 'k' }, 2000)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'relay-not-configured')
  } finally { c.cleanup() }
})
