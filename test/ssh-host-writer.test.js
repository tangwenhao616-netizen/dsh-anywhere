import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertFleetHost, removeFleetHost } from '../lib/ssh-host-writer.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'sshw-'))
  return { path: join(dir, 'dsh-ssh.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const entry = {
  alias: 'fleet-pc', host: '127.0.0.1', port: 20001, user: 'wl',
  auth: { kind: 'key', keyPath: '/home/wl/.dsh/fleet/keys/pc.op' },
  proxyJump: ['relay-jump'], tags: ['fleet'], description: '公网入网机器(dsh-fleet)',
}

test('upsert creates file and inserts a valid entry, 0600', () => {
  const { path, cleanup } = tmp()
  try {
    upsertFleetHost(path, entry, 1000)
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.version, 1)
    assert.equal(f.hosts.length, 1)
    const h = f.hosts[0]
    assert.equal(h.alias, 'fleet-pc')
    assert.equal(h.port, 20001)
    assert.deepEqual(h.proxyJump, ['relay-jump'])
    assert.equal(h.auth.kind, 'key')
    assert.equal(h.createdAt, 1000)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { cleanup() }
})

test('upsert preserves other hosts and replaces same alias', () => {
  const { path, cleanup } = tmp()
  try {
    writeFileSync(path, JSON.stringify({ version: 1, hosts: [
      { alias: 'target-22', host: '192.168.1.22', port: 22, user: 'x', auth: { kind: 'password', password: 'p' }, proxyJump: [], tags: [], createdAt: 1, updatedAt: 1 },
    ] }, null, 2))
    upsertFleetHost(path, entry, 1000)
    upsertFleetHost(path, { ...entry, port: 20002 }, 2000)
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.hosts.length, 2)
    const h = f.hosts.find(x => x.alias === 'fleet-pc')
    assert.equal(h.port, 20002)
    assert.equal(h.createdAt, 1000)
    assert.equal(h.updatedAt, 2000)
  } finally { cleanup() }
})

test('remove deletes only the named alias', () => {
  const { path, cleanup } = tmp()
  try {
    upsertFleetHost(path, entry, 1000)
    removeFleetHost(path, 'fleet-pc')
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.hosts.length, 0)
    removeFleetHost(path, 'nonexistent')
  } finally { cleanup() }
})
