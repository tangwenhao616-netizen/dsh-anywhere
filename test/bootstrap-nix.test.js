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

test('nix bootstrap: frp 路径(解析 frpToken + 下载 frpc + 写 frpc.toml + 统一 RUN_CMD)', () => {
  const s = renderNixBootstrap({ baseUrl: 'https://d.trycloudflare.com' })
  assert.ok(s.includes('FRP_TOKEN="$(getf frpToken)"'), '解析 frpToken')
  assert.ok(s.includes('if [ -n "${FRP_TOKEN}" ]'), 'frp-或-sshR 分支')
  assert.ok(s.includes('/api/fleet/frpc'), '下载 frpc')
  assert.ok(s.includes('loginFailExit = false'), '断线不退出、持续重连')
  assert.ok(s.includes('name = "dsh-fleet-${PORT}"'), '代理名按端口唯一(全局不撞名)')
  assert.ok(s.includes('remotePort = ${PORT}'), 'remotePort=分配端口')
  assert.ok(s.includes('RUN_CMD='), 'launchd/systemd/fallback 共用 RUN_CMD')
  assert.ok(s.includes('transport.protocol = "${FRP_PROTO}"'), '协议可配')
})

test('rejects bad baseUrl', () => {
  assert.throws(() => renderNixBootstrap({ baseUrl: "https://x';rm -rf" }), /invalid baseUrl/)
})
