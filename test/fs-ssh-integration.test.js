// fs-ssh integration test: run every method against a REAL remote host + ControlMaster reuse.
// Set DSH_ANYWHERE_RELAY=user@host (and optionally DSH_ANYWHERE_KEY=/path/to/key) to run.
// Unset (e.g. in CI) or unreachable → the whole suite skips, so offline CI stays green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshConn } from '../lib/ssh-conn.js'
import { SshFsCore } from '../lib/ssh-fs-core.js'

const LOGIN = process.env.DSH_ANYWHERE_RELAY
const KEY = process.env.DSH_ANYWHERE_KEY
const RELAY = LOGIN && {
  login: LOGIN,
  sshArgs: [
    ...(KEY ? ['-i', KEY] : []),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=6',
  ],
}
let reachable = false
if (RELAY) {
  try {
    const r = await new SshConn(RELAY).run('echo ok')
    reachable = r.code === 0 && r.stdout.toString('utf8').trim() === 'ok'
  } catch { reachable = false }
}
const skip = RELAY && reachable ? false : 'set DSH_ANYWHERE_RELAY=user@host to run integration tests'

const conn = RELAY ? new SshConn(RELAY) : null
const core = RELAY ? new SshFsCore({ conn, cwd: '/tmp' }) : null
const NAME = `dsh-fsit-${process.pid}.txt`

test('all methods e2e (resolve/write/stat/read/list/edit/readBytes/lstat/version guard)', { skip }, async () => {
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

test('missing file: stat→undefined, readText→FS_NOT_FOUND', { skip }, async () => {
  const t = await core.resolve(`/tmp/nope-${process.pid}-does-not-exist`)
  assert.equal(await core.stat(t), undefined)
  await assert.rejects(() => core.readText(t), e => e.code === 'FS_NOT_FOUND')
})

test('fs-ssh over ProxyJump double-hop (hub→relay→target) — how a fleet-enrolled machine is reached', { skip }, async () => {
  // Use the relay as a jump host and its own loopback as the "target", i.e. two hops
  // (equivalent to hub→relay→fleet-machine).
  const user = LOGIN.split('@')[0]
  const viaJump = new SshFsCore({
    conn: new SshConn({
      login: `${user}@127.0.0.1`,
      sshArgs: [
        ...(KEY ? ['-i', KEY] : []),
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', `ProxyJump=${LOGIN}`,
      ],
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

test('ControlMaster reuse: 20 stats are far faster than 20 fresh connections (no handshake)', { skip }, async () => {
  const t = await core.resolve('/tmp')
  const start = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) await core.stat(t)
  const perOpMs = Number(process.hrtime.bigint() - start) / 1e6 / 20
  console.log(`  stat ≈ ${perOpMs.toFixed(1)}ms/op (reused connection)`)
  assert.ok(perOpMs < 400, `stat ${perOpMs}ms/op is high — ControlMaster may not be active`)
})
