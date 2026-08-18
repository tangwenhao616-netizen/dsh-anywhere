// subprocess-ssh-win 纯逻辑单测:resolveExecutable(注入 fake conn)+ markerStripper(退出码剥离)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshSubprocessCoreWin, markerStripper } from '../lib/ssh-subprocess-core-win.js'

const ps = (stdout, code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: '' })
const subpWith = out => new SshSubprocessCoreWin({ conn: { runPowershell: async () => ps(out) } })

test('resolveExecutable: __P__path→路径;__NONE__→EXEC_NOT_FOUND;空→EXEC_RESOLVE', async () => {
  assert.equal(await subpWith('__P__C:\\Windows\\System32\\cmd.exe\r\n').resolveExecutable('cmd'), 'C:\\Windows\\System32\\cmd.exe')
  await assert.rejects(() => subpWith('__NONE__\r\n').resolveExecutable('nope'), e => e.code === 'EXEC_NOT_FOUND')
  await assert.rejects(() => subpWith('').resolveExecutable('   '), e => e.code === 'EXEC_RESOLVE')
})

test('markerStripper: 剥离 __DSHRC__<n> 尾标记 + 提取精确退出码', async () => {
  const collect = (chunks) => new Promise(res => {
    const s = markerStripper(); const out = []
    s.on('data', d => out.push(d))
    s.on('end', () => res({ text: Buffer.concat(out).toString('utf8'), code: s.getExitCode() }))
    for (const c of chunks) s.write(Buffer.from(c))
    s.end()
  })
  // 一次性
  assert.deepEqual(await collect(['hello world__DSHRC__3\n']), { text: 'hello world', code: 3 })
  // 标记跨 chunk
  assert.deepEqual(await collect(['out', 'put__DSH', 'RC__42\n']), { text: 'output', code: 42 })
  // 无标记 → 原样透传,code=null(如被 terminate)
  assert.deepEqual(await collect(['no marker here']), { text: 'no marker here', code: null })
  // 小输出 + code 0
  assert.deepEqual(await collect(['x__DSHRC__0\n']), { text: 'x', code: 0 })
  // 大输出超过 HOLD 尾窗(走流式路径)
  assert.deepEqual(await collect(['A'.repeat(100) + '__DSHRC__5\n']), { text: 'A'.repeat(100), code: 5 })
  // 负码(理论)
  assert.deepEqual(await collect(['e__DSHRC__-1\n']), { text: 'e', code: -1 })
})

test('markerStripper: 二进制输出 + 尾标记(binary-safe)', async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254])
  const s = markerStripper()
  const out = []
  const done = new Promise(res => { s.on('data', d => out.push(d)); s.on('end', res) })
  s.write(bin); s.write(Buffer.from('__DSHRC__9\n')); s.end()
  await done
  assert.deepEqual(new Uint8Array(Buffer.concat(out)), new Uint8Array(bin))
  assert.equal(s.getExitCode(), 9)
})
