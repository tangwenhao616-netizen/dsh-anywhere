// subprocess-ssh integration test: run resolveExecutable + spawn (exit code / collect / cwd /
// stdin / terminate) against a REAL remote host.
// Set DSH_ANYWHERE_RELAY=user@host (and optionally DSH_ANYWHERE_KEY=/path/to/key) to run.
// Unset (e.g. in CI) or unreachable → the whole suite skips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshConn } from '../lib/ssh-conn.js'
import { SshSubprocessCore } from '../lib/ssh-subprocess-core.js'

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
  try { const r = await new SshConn(RELAY).run('echo ok'); reachable = r.code === 0 && r.stdout.toString('utf8').trim() === 'ok' } catch { reachable = false }
}
const skip = RELAY && reachable ? false : 'set DSH_ANYWHERE_RELAY=user@host to run integration tests'

const conn = RELAY ? new SshConn(RELAY) : null
const subp = RELAY ? new SshSubprocessCore({ conn }) : null
const collect = { maxBytes: 65536, spill: { maxBytes: 1 << 20 } }
const spec = (argv, o = {}) => ({ argv, cwd: o.cwd ?? '/tmp', stdio: { stdin: o.stdin ?? 'ignore', stdout: collect, stderr: collect }, graceMs: 3000, signal: o.signal, env: o.env })
const textOf = reader => reader.readFrom(0).text

test('resolveExecutable: bash → remote absolute path; missing → EXEC_NOT_FOUND', { skip }, async () => {
  const p = await subp.resolveExecutable('bash')
  assert.ok(p.startsWith('/'), `got ${p}`)
  await assert.rejects(() => subp.resolveExecutable('definitely-no-such-bin-xyz'), e => e.code === 'EXEC_NOT_FOUND')
})

test('spawn: stdout/stderr collect + exit code', { skip }, async () => {
  const h = subp.spawn(spec(['sh', '-c', 'echo OUT; echo ERR 1>&2; exit 3']))
  const out = await h.done
  assert.equal(out.exitCode, 3)
  assert.equal(textOf(h.collected.stdout).trim(), 'OUT')
  assert.equal(textOf(h.collected.stderr).trim(), 'ERR')
})

test('spawn: cwd takes effect on the remote (pwd)', { skip }, async () => {
  const h = subp.spawn(spec(['pwd'], { cwd: '/tmp' }))
  await h.done
  assert.equal(textOf(h.collected.stdout).trim(), '/tmp')
})

test('spawn: remote hostname (proves it runs remotely, not locally)', { skip }, async () => {
  const h = subp.spawn(spec(['uname', '-n']))
  await h.done
  const remoteHost = textOf(h.collected.stdout).trim()
  assert.ok(remoteHost && remoteHost !== (await import('node:os')).hostname(), `remote=${remoteHost}`)
})

test('spawn: stdin {data} fed to the remote process (cat echoes it back)', { skip }, async () => {
  const h = subp.spawn(spec(['cat'], { stdin: { data: 'PIPED-IN\n' } }))
  await h.done
  assert.equal(textOf(h.collected.stdout), 'PIPED-IN\n')
})

test('spawn: abort → terminate, done settles', { skip }, async () => {
  const ac = new AbortController()
  const h = subp.spawn(spec(['sh', '-c', 'sleep 30'], { signal: ac.signal }))
  setTimeout(() => ac.abort(), 300)
  const settled = await Promise.race([h.done.then(() => 'done'), new Promise(r => setTimeout(() => r('timeout'), 8000))])
  assert.equal(settled, 'done')
})

test('grep searches the remote file tree (proves search goes through subprocess-ssh)', { skip }, async () => {
  const tag = `SSHWORLD-${process.pid}`
  await conn.run(`printf '%s\\n' '${tag}' > /tmp/m3-grep-${process.pid}.txt`)
  const h = subp.spawn(spec(['grep', '-rl', '--', tag, '/tmp']))
  await h.done
  const hits = textOf(h.collected.stdout)
  assert.ok(hits.includes(`/tmp/m3-grep-${process.pid}.txt`), `grep hits: ${hits}`)
  await conn.run(`rm -f /tmp/m3-grep-${process.pid}.txt`)
})

test('spawnTerminal: basic PTY output (remote echo)', { skip }, async () => {
  const th = await subp.spawnTerminal({ argv: ['sh', '-c', 'echo TERMOUT; exit 0'], cwd: '/tmp', rows: 24, cols: 80, graceMs: 3000 })
  let buf = ''
  th.output.on('data', d => { buf += d.toString('utf8') })
  await th.done
  assert.ok(buf.includes('TERMOUT'), `pty output: ${JSON.stringify(buf)}`)
})
