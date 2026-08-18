import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderWinBootstrap } from '../lib/bootstrap-win.js'

test('win bootstrap: request flow + admin authorized_keys + scheduled task + IdentitiesOnly', () => {
  const s = renderWinBootstrap({ baseUrl: 'https://d.trycloudflare.com' })
  assert.ok(s.includes('/api/fleet/request'))
  assert.ok(s.includes('/api/fleet/request-status'))
  assert.ok(s.includes('Invoke-RestMethod'))
  assert.ok(s.includes('administrators_authorized_keys'))
  assert.ok(s.includes('Register-ScheduledTask'))
  assert.ok(s.includes('IdentitiesOnly=yes'))
  assert.ok(s.includes('from="127.0.0.1,::1"'))
  assert.ok(s.includes('OpenSSH.Server'))
  assert.ok(s.includes('配对码'))
  // 不得含 PowerShell 反引号或 ${...}(JS 模板会误伤,PowerShell 语义也会坏)
  assert.ok(!s.includes('`'))
  assert.ok(!s.includes('${'))
})

test('rejects bad baseUrl', () => {
  assert.throws(() => renderWinBootstrap({ baseUrl: "https://x';rm" }), /invalid baseUrl/)
})
