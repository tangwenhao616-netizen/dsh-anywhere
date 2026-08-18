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

test('win bootstrap: frp 路径(解析 FrpToken + 下载 frpc.exe + 写 frpc.toml + 计划任务跑 frpc)', () => {
  const s = renderWinBootstrap({ baseUrl: 'https://d.trycloudflare.com' })
  assert.ok(s.includes('$FrpToken = $result.frpToken'), '解析 frpToken')
  assert.ok(s.includes('if ($FrpToken)'), 'frp-或-sshR 分支')
  assert.ok(s.includes('/api/fleet/frpc?os=win'), '下载 frpc.exe')
  assert.ok(s.includes('loginFailExit = false'), '断线不退出、持续重连')
  assert.ok(s.includes('name = "dsh-fleet-'), '代理名按端口唯一')
  assert.ok(s.includes('New-ScheduledTaskAction -Execute $frpcExe'), '计划任务跑 frpc')
  assert.ok(s.includes('Set-Content'), '写 frpc.toml')
  // frp 分支同样不得引入反引号或 ${...}
  assert.ok(!s.includes('`'), '无反引号')
  assert.ok(!s.includes('${'), '无 ${...}')
})

test('rejects bad baseUrl', () => {
  assert.throws(() => renderWinBootstrap({ baseUrl: "https://x';rm" }), /invalid baseUrl/)
})
