import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeProvisioner } from '../lib/provisioner.js'

test('FakeProvisioner records op keypair generation and relay pushes', async () => {
  const p = new FakeProvisioner()
  const kp = await p.generateOpKeypair('fleet-pc')
  assert.match(kp.operationPublicKey, /^ssh-ed25519 /)
  assert.ok(kp.opPrivKeyPath.includes('fleet-pc'))
  await p.pushTunnelKey('ssh-ed25519 AAAAtunnel comment', 20001)
  assert.deepEqual(p.pushed, [{ pubkey: 'ssh-ed25519 AAAAtunnel comment', port: 20001 }])
  await p.removeTunnelKey(20001)
  assert.deepEqual(p.removed, [20001])
})
