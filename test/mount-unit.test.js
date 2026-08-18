// SSHFS 挂载架构的纯逻辑单测:sshfs argv 生成、workdir 前缀映射、挂载形态补丁、
// 自动建工作区/会话 RPC(注入 fetch,无网络)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sshfsArgs } from '../lib/mount.js'
import { mapWorkdir } from '../lib/subprocess-ssh.js'
import { buildWorldPatch, bootstrapWorkspaceSession } from '../lib/launcher.js'

test('sshfsArgs: login:sftpRoot + -p→port + -i→IdentityFile + -o 透传 + reconnect', () => {
  const desc = {
    login: 'zyl@127.0.0.1', sftpRoot: '/C:/Users/zyl',
    sshArgs: ['-p', '20002', '-i', '/k/op', '-o', 'IdentitiesOnly=yes', '-o', 'ProxyCommand=ssh -W %h:%p u@relay'],
  }
  const a = sshfsArgs(desc, '/home/wl/.dsh/anywhere/ZYL')
  assert.equal(a[0], 'zyl@127.0.0.1:/C:/Users/zyl', '远程源 = login:sftpRoot')
  assert.equal(a[1], '/home/wl/.dsh/anywhere/ZYL', '挂载点')
  assert.ok(a.includes('port=20002'), '-p 转 port=')
  assert.ok(a.includes('IdentityFile=/k/op'), '-i 转 IdentityFile=')
  assert.ok(a.includes('ProxyCommand=ssh -W %h:%p u@relay'), 'ProxyCommand 整串透传')
  assert.ok(a.includes('reconnect'), '断线自动重连')
  assert.ok(a.includes('ServerAliveInterval=15'), 'keepalive')
})

test('sshfsArgs: posix 机器 sftpRoot 空 = 家目录', () => {
  const a = sshfsArgs({ login: 'bob@10.0.0.5', sftpRoot: '', sshArgs: [] }, '/m')
  assert.equal(a[0], 'bob@10.0.0.5:', '空 sftpRoot → 登录家目录')
})

test('mapWorkdir: windows 挂载点前缀 → 远程路径(分隔符转反斜杠)', () => {
  const pm = { from: '/home/wl/.dsh/anywhere/ZYL', to: 'C:\\Users\\zyl' }
  assert.equal(mapWorkdir('/home/wl/.dsh/anywhere/ZYL', pm, 'windows'), 'C:\\Users\\zyl', '恰为挂载点')
  assert.equal(mapWorkdir('/home/wl/.dsh/anywhere/ZYL/proj/src', pm, 'windows'), 'C:\\Users\\zyl\\proj\\src', '子路径')
  assert.equal(mapWorkdir('/tmp/x', pm, 'windows'), '/tmp/x', '挂载点外原样')
  assert.equal(mapWorkdir('/home/wl/.dsh/anywhere/ZYL2/x', pm, 'windows'), '/home/wl/.dsh/anywhere/ZYL2/x', '相似前缀不误匹配')
  assert.equal(mapWorkdir(undefined, pm, 'windows'), undefined, '空原样')
})

test('mapWorkdir: posix 机器(分隔符不变)', () => {
  const pm = { from: '/home/wl/.dsh/anywhere/pi', to: '/home/pi' }
  assert.equal(mapWorkdir('/home/wl/.dsh/anywhere/pi/work', pm, 'posix'), '/home/pi/work')
  assert.equal(mapWorkdir('/home/wl/.dsh/anywhere/pi', pm, 'posix'), '/home/pi')
})

test('buildWorldPatch: 挂载形态(传 mnt)—— fs:false + pathMap + workspaceRoot=mnt + 保留本地 fs 栈', () => {
  const desc = { login: 'zyl@127.0.0.1', sshArgs: [], cwd: 'C:\\Users\\zyl', remoteCwd: 'C:\\Users\\zyl', platform: 'windows' }
  const p = buildWorldPatch(desc, 34567, 'x.trycloudflare.com', '/home/wl/.dsh/anywhere/ZYL')
  assert.ok(p.includes('fs: false'), 'ssh-world 不注册 fs(文件走挂载)')
  assert.ok(p.includes('pathMap:'), 'workdir 映射')
  assert.ok(p.includes('from: "/home/wl/.dsh/anywhere/ZYL"'))
  assert.ok(p.includes('to: "C:\\\\Users\\\\zyl"'))
  assert.ok(p.includes('workspaceRoot: "/home/wl/.dsh/anywhere/ZYL"'), 'sandbox 根=挂载点')
  assert.ok(!p.includes('- id: fs-sandbox'), '挂载形态不禁本地 fs 栈')
  assert.ok(p.includes('- id: subprocess'), '仍禁本地 subprocess(换 ssh 远程执行)')
})

test('buildWorldPatch: 纯 ssh 形态(不传 mnt)保持旧行为', () => {
  const p = buildWorldPatch({ login: 'u@h', sshArgs: [], cwd: '/tmp' }, 1)
  assert.ok(p.includes('- id: fs-sandbox'), '禁本地 fs 栈')
  assert.ok(!p.includes('fs: false'), 'ssh-world 注册 fs')
  assert.ok(!p.includes('pathMap'), '无映射')
  assert.ok(p.includes('workspaceRoot: "/tmp"'))
})

test('bootstrapWorkspaceSession: 按序调 workspace.create + session.create(cwd=挂载点)', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { json: async () => ({ ok: true }) }
  }
  const ok = await bootstrapWorkspaceSession(35000, '/m/ZYL', fakeFetch)
  assert.equal(ok, true)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.endsWith('/api/workspace.create'))
  assert.equal(calls[0].body.method, 'workspace.create')
  assert.equal(calls[0].body.payload.path, '/m/ZYL')
  assert.equal(calls[0].body.type, 'client-request')
  assert.ok(calls[1].url.endsWith('/api/session.create'))
  assert.equal(calls[1].body.payload.cwd, '/m/ZYL')
})

test('bootstrapWorkspaceSession: fetch 失败 → false(不抛,不阻断 open)', async () => {
  const ok = await bootstrapWorkspaceSession(35000, '/m', async () => { throw new Error('conn refused') })
  assert.equal(ok, false)
})
