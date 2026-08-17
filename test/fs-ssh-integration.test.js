// fs-ssh 集成测:对着真实远程机(中继)跑全部方法 + ControlMaster 连接复用。
// 中继不可达时整组 skip(不让离线 CI 失败)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshConn } from '../lib/ssh-conn.js'
import { SshFsCore } from '../lib/ssh-fs-core.js'

const RELAY = {
  login: 'ubuntu@175.24.133.218',
  sshArgs: ['-i', '/home/wl/.ssh/id_rsa', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'],
}
let reachable = false
try {
  const r = await new SshConn(RELAY).run('echo ok')
  reachable = r.code === 0 && r.stdout.toString('utf8').trim() === 'ok'
} catch { reachable = false }
const skip = reachable ? false : '中继不可达,跳过集成测'

const conn = new SshConn(RELAY)
const core = new SshFsCore({ conn, cwd: '/tmp' })
const NAME = `dsh-fsit-${process.pid}.txt`

test('全方法端到端(resolve/write/stat/read/list/edit/readBytes/lstat/版本守卫)', { skip }, async () => {
  const t = await core.resolve(NAME)
  assert.equal(t.targetKey, `/tmp/${NAME}`)

  const w = await core.writeText(t, 'line1\nline2\n')
  assert.equal(w.operation, 'create'); assert.equal(w.before, null)

  const st = await core.stat(t)
  assert.equal(st.type, 'file'); assert.equal(st.size, 12)

  assert.equal(await core.readText(t), 'line1\nline2\n')

  const bytes = await core.readBytes(t, undefined, 1024)
  assert.equal(Buffer.from(bytes).toString('utf8'), 'line1\nline2\n')

  const ls = await core.listDir(await core.resolve('/tmp'))
  assert.ok(ls.some(e => e.name === NAME && e.type === 'file'))

  const ls2 = await core.lstat(`/tmp/${NAME}`)
  assert.equal(ls2.type, 'file')

  const ed = await core.editText(t, { oldString: 'line2', newString: 'EDITED', replaceAll: false })
  assert.equal(ed.after, 'line1\nEDITED\n')
  assert.equal(await core.readText(t), 'line1\nEDITED\n')

  await assert.rejects(() => core.writeText(t, 'x', { kind: 'replaceIfVersion', version: w.version }),
    e => e.code === 'FS_STALE_VERSION')

  await conn.run(`rm -f -- '/tmp/${NAME}'`)
})

test('缺文件 stat→undefined、readText→FS_NOT_FOUND', { skip }, async () => {
  const t = await core.resolve(`/tmp/nope-${process.pid}-does-not-exist`)
  assert.equal(await core.stat(t), undefined)
  await assert.rejects(() => core.readText(t), e => e.code === 'FS_NOT_FOUND')
})

test('M6: fs-ssh 经 ProxyJump 双跳(hub→中继→目标)工作 —— 即接 fleet 入网机器的连法', { skip }, async () => {
  // 用中继当跳板、中继自己的 127.0.0.1 当"目标机",走两跳(等价 hub→中继→fleet机器)。
  const viaJump = new SshFsCore({
    conn: new SshConn({
      login: 'ubuntu@127.0.0.1',
      sshArgs: ['-i', '/home/wl/.ssh/id_rsa', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ProxyJump=ubuntu@175.24.133.218'],
    }),
    cwd: '/tmp',
  })
  const name = `dsh-m6-${process.pid}.txt`
  const t = await viaJump.resolve(name)
  await viaJump.writeText(t, 'via-proxyjump\n')
  assert.equal(await viaJump.readText(t), 'via-proxyjump\n')
  const st = await viaJump.stat(t)
  assert.equal(st.type, 'file')
  await viaJump.conn.run(`rm -f -- '/tmp/${name}'`)
})

test('ControlMaster 连接复用:20 次 stat 明显快于逐次新连(无握手)', { skip }, async () => {
  const t = await core.resolve('/tmp')
  const start = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) await core.stat(t)
  const perOpMs = Number(process.hrtime.bigint() - start) / 1e6 / 20
  // 复用连接下每次 stat 应远低于一次全新 ssh 握手(通常 <150ms/次)。
  console.log(`  每次 stat ≈ ${perOpMs.toFixed(1)}ms(复用连接)`)
  assert.ok(perOpMs < 400, `每次 stat ${perOpMs}ms 偏高,ControlMaster 可能没生效`)
})
