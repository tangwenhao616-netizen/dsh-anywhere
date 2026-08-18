// launcher buildWorldPatch 纯逻辑单测(无网络/无子进程)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorldPatch, descFromFleetMachine } from '../lib/launcher.js'

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

test('descFromFleetMachine: Windows fleet 机器(经中继 ProxyCommand 双密钥)', () => {
  const machine = { alias: 'ZYL', os: 'win' }
  const host = { host: '127.0.0.1', port: 20002, user: 'zyl', auth: { keyPath: '/k/op' }, proxyJump: ['relay-jump'] }
  const relay = { host: '1.2.3.4', port: 22, user: 'ubuntu', auth: { keyPath: '/k/id_rsa' } }
  const d = descFromFleetMachine(machine, host, relay)
  assert.equal(d.login, 'zyl@127.0.0.1')
  assert.equal(d.platform, 'windows')
  assert.equal(d.cwd, 'C:\\Users\\zyl')
  assert.ok(d.sshArgs.includes('-p') && d.sshArgs.includes('20002') && d.sshArgs.includes('/k/op'))
  assert.ok(d.sshArgs.some(a => a.includes('ProxyCommand=ssh -i /k/id_rsa') && a.includes('ubuntu@1.2.3.4')), 'ProxyCommand 双密钥经中继')
})

test('buildWorldPatch: 传 port 覆盖 webserver 端口 + 绑 127.0.0.1(避开主 dph 3080)', () => {
  const p = buildWorldPatch({ login: 'u@h', sshArgs: [], cwd: '/tmp' }, 34567)
  assert.ok(p.includes('- id: webserver'), 'webserver 覆盖项')
  assert.ok(p.includes('port: 34567'), '端口')
  assert.ok(p.includes("host: '127.0.0.1'"), '绑 loopback')
  // 不传 port 则无覆盖(默认用 profile 的)
  assert.ok(!buildWorldPatch({ login: 'u@h', sshArgs: [], cwd: '/tmp' }).includes('- id: webserver'))
})

test('descFromFleetMachine: posix 直连机器(无 proxyJump → 无 ProxyCommand)', () => {
  const d = descFromFleetMachine({ os: 'linux' }, { host: '10.0.0.5', port: 22, user: 'bob', auth: { keyPath: '/k' }, proxyJump: [] }, null)
  assert.equal(d.platform, 'posix')
  assert.equal(d.cwd, '/home/bob')
  assert.equal(d.login, 'bob@10.0.0.5')
  assert.ok(!d.sshArgs.some(a => a.includes('ProxyCommand')))
})
