// subprocess-ssh 集成测:对真实远程机跑 resolveExecutable + spawn(退出码/collect/cwd/stdin/terminate)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshConn } from '../lib/ssh-conn.js'
import { SshSubprocessCore } from '../lib/ssh-subprocess-core.js'

const RELAY = {
  login: 'ubuntu@175.24.133.218',
  sshArgs: ['-i', '/home/wl/.ssh/id_rsa', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'],
}
let reachable = false
try { const r = await new SshConn(RELAY).run('echo ok'); reachable = r.code === 0 && r.stdout.toString('utf8').trim() === 'ok' } catch { reachable = false }
const skip = reachable ? false : '中继不可达'

const conn = new SshConn(RELAY)
const subp = new SshSubprocessCore({ conn })
const collect = { maxBytes: 65536, spill: { maxBytes: 1 << 20 } }
const spec = (argv, o = {}) => ({ argv, cwd: o.cwd ?? '/tmp', stdio: { stdin: o.stdin ?? 'ignore', stdout: collect, stderr: collect }, graceMs: 3000, signal: o.signal, env: o.env })
const textOf = reader => reader.readFrom(0).text

test('resolveExecutable: bash → 远程绝对路径;缺失→EXEC_NOT_FOUND', { skip }, async () => {
  const p = await subp.resolveExecutable('bash')
  assert.ok(p.startsWith('/'), `got ${p}`)
  await assert.rejects(() => subp.resolveExecutable('definitely-no-such-bin-xyz'), e => e.code === 'EXEC_NOT_FOUND')
})

test('spawn: stdout/stderr collect + 退出码', { skip }, async () => {
  const h = subp.spawn(spec(['sh', '-c', 'echo OUT; echo ERR 1>&2; exit 3']))
  const out = await h.done
  assert.equal(out.exitCode, 3)
  assert.equal(textOf(h.collected.stdout).trim(), 'OUT')
  assert.equal(textOf(h.collected.stderr).trim(), 'ERR')
})

test('spawn: cwd 在远程生效(pwd)', { skip }, async () => {
  const h = subp.spawn(spec(['pwd'], { cwd: '/tmp' }))
  await h.done
  assert.equal(textOf(h.collected.stdout).trim(), '/tmp')
})

test('spawn: 远程主机名(证明是在远程跑,不是本机)', { skip }, async () => {
  const h = subp.spawn(spec(['uname', '-n']))
  await h.done
  const remoteHost = textOf(h.collected.stdout).trim()
  assert.ok(remoteHost && remoteHost !== (await import('node:os')).hostname(), `remote=${remoteHost}`)
})

test('spawn: stdin {data} 喂给远程进程(cat 回显)', { skip }, async () => {
  const h = subp.spawn(spec(['cat'], { stdin: { data: 'PIPED-IN\n' } }))
  await h.done
  assert.equal(textOf(h.collected.stdout), 'PIPED-IN\n')
})

test('spawn: abort → terminate,done 归位', { skip }, async () => {
  const ac = new AbortController()
  const h = subp.spawn(spec(['sh', '-c', 'sleep 30'], { signal: ac.signal }))
  setTimeout(() => ac.abort(), 300)
  const settled = await Promise.race([h.done.then(() => 'done'), new Promise(r => setTimeout(() => r('timeout'), 8000))])
  assert.equal(settled, 'done')
})

test('M3: grep 在远程文件树搜索(证 search 走 subprocess-ssh)', { skip }, async () => {
  const tag = `SSHWORLD-${process.pid}`
  await conn.run(`printf '%s\\n' '${tag}' > /tmp/m3-grep-${process.pid}.txt`)
  const h = subp.spawn(spec(['grep', '-rl', '--', tag, '/tmp']))
  await h.done
  const hits = textOf(h.collected.stdout)
  assert.ok(hits.includes(`/tmp/m3-grep-${process.pid}.txt`), `grep 命中:${hits}`)
  await conn.run(`rm -f /tmp/m3-grep-${process.pid}.txt`)
})

test('spawnTerminal: 基础 PTY 输出(远程 echo)', { skip }, async () => {
  const th = await subp.spawnTerminal({ argv: ['sh', '-c', 'echo TERMOUT; exit 0'], cwd: '/tmp', rows: 24, cols: 80, graceMs: 3000 })
  let buf = ''
  th.output.on('data', d => { buf += d.toString('utf8') })
  await th.done
  assert.ok(buf.includes('TERMOUT'), `pty output: ${JSON.stringify(buf)}`)
})
