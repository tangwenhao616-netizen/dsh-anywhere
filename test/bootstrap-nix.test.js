import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNixBootstrap } from '../lib/bootstrap-nix.js'

test('nix bootstrap: request flow + poll + IdentitiesOnly + both service backends', () => {
  const s = renderNixBootstrap({ baseUrl: 'https://d.trycloudflare.com' })
  assert.match(s, /^#!\/usr\/bin\/env bash/)
  assert.ok(s.includes('/api/fleet/request'))
  assert.ok(s.includes('/api/fleet/request-status'))
  assert.ok(s.includes('IdentitiesOnly=yes'))
  assert.ok(s.includes('-R 127.0.0.1:'))
  assert.ok(s.includes('from="127.0.0.1,::1"'))
  assert.ok(s.includes('LaunchAgents'))       // mac launchd
  assert.ok(s.includes('systemctl --user'))   // linux systemd
  assert.ok(s.includes('配对码'))
})

test('rejects bad baseUrl', () => {
  assert.throws(() => renderNixBootstrap({ baseUrl: "https://x';rm -rf" }), /invalid baseUrl/)
})
