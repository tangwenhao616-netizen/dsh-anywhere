import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshProvisioner } from '../lib/provisioner-ssh.js'

test('generateOpKeypair produces an ed25519 keypair on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'))
  try {
    const prov = new SshProvisioner(() => ({ host: 'h', port: 22, tunnelUser: 't', jumpAlias: 'j', jumpLogin: 'u@h', portRange: [20001, 20999] }), dir)
    const { operationPublicKey, opPrivKeyPath } = await prov.generateOpKeypair('fleet-pc')
    assert.ok(existsSync(opPrivKeyPath))
    assert.ok(existsSync(opPrivKeyPath + '.pub'))
    assert.match(operationPublicKey, /^ssh-ed25519 /)
    assert.match(readFileSync(opPrivKeyPath, 'utf8'), /OPENSSH PRIVATE KEY/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
