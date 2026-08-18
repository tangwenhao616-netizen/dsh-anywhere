// launcher buildWorldPatch 纯逻辑单测(无网络/无子进程)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorldPatch } from '../lib/launcher.js'

test('buildWorldPatch: windows —— ssh-world + platform + 禁本地 provider + sshArgs', () => {
  const p = buildWorldPatch({ login: 'zyl@127.0.0.1', sshArgs: ['-p', '20002', '-i', '/k/op'], cwd: 'C:\\Users\\zyl', platform: 'windows' })
  assert.ok(p.includes('name: dsh-anywhere/world'), 'insert ssh-world')
  assert.ok(p.includes('platform: "windows"'), 'platform windows')
  assert.ok(p.includes('login: "zyl@127.0.0.1"'), 'login')
  assert.ok(p.includes('- id: fs-sandbox'), 'disable fs-sandbox')
  assert.ok(p.includes('- id: subprocess'), 'disable subprocess')
  assert.ok(p.includes('mode: danger-full-access'), 'sandbox danger')
  assert.ok(p.includes('- "-p"') && p.includes('- "20002"') && p.includes('- "/k/op"'), 'sshArgs 逐项')
})

test('buildWorldPatch: 默认 posix', () => {
  const p = buildWorldPatch({ login: 'ubuntu@host', sshArgs: [], cwd: '/tmp' })
  assert.ok(p.includes('platform: "posix"'))
  assert.ok(p.includes('cwd: "/tmp"'))
  assert.ok(p.includes('workspaceRoot: "/tmp"'))
})

test('buildWorldPatch: ProxyCommand(含空格)作单个 sshArg 项完整保留', () => {
  const pc = 'ProxyCommand=ssh -i /k/relay -W %h:%p ubuntu@relay'
  const p = buildWorldPatch({ login: 'u@127.0.0.1', sshArgs: ['-o', pc], cwd: '/tmp' })
  assert.ok(p.includes(JSON.stringify(pc)), 'ProxyCommand 整串保留')
})
