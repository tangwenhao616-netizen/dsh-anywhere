import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore, DEFAULT_RELAY } from '../lib/fleet-store.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
  return { path: join(dir, 'dsh-fleet.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('absent file loads defaults', () => {
  const { path, cleanup } = tmpStore()
  try {
    const s = new FleetStore(path)
    const f = s.load()
    assert.equal(f.version, 1)
    assert.deepEqual(f.tokens, [])
    assert.deepEqual(f.machines, [])
    assert.equal(f.relay.host, DEFAULT_RELAY.host)
    assert.deepEqual(f.relay.portRange, [20001, 20999])
  } finally { cleanup() }
})

test('save then load round-trips and file is 0600', async () => {
  const { path, cleanup } = tmpStore()
  try {
    const s = new FleetStore(path)
    const f = s.load()
    f.machines.push({ id: 'a', alias: 'x', os: 'linux', remoteUser: 'u', port: 20001,
      tunnelKeyComment: 'dsh-fleet:x', opPrivKeyPath: '/k', hostAlias: 'fleet-x',
      status: 'online', enrolledAt: 1, lastSeen: 2 })
    s.save(f)
    const again = new FleetStore(path).load()
    assert.equal(again.machines.length, 1)
    assert.equal(again.machines[0].alias, 'x')
    const { statSync } = await import('node:fs')
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { cleanup() }
})

test('corrupt file is renamed aside, load returns defaults', async () => {
  const { path, cleanup } = tmpStore()
  try {
    const { writeFileSync, readdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    writeFileSync(path, 'not json{{')
    const f = new FleetStore(path).load()
    assert.deepEqual(f.machines, [])
    assert.ok(readdirSync(dirname(path)).some(n => n.includes('corrupt')))
  } finally { cleanup() }
})
