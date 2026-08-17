// fs-ssh 纯逻辑 + 错误映射 单测(注入 fake conn,无网络)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshFsCore } from '../lib/ssh-fs-core.js'

/** 造一个 SshFsCore,conn.run 由 runImpl 提供(fake 远端)。 */
const coreWithConn = (runImpl, cwd = '/work') => new SshFsCore({ conn: { run: runImpl }, cwd })
const T = p => ({ targetKey: p, displayPath: p })

test('contains: canonical 前缀语义(不误判同前缀兄弟)', () => {
  const core = coreWithConn(async () => ({ code: 0, stdout: Buffer.from(''), stderr: '' }))
  assert.equal(core.contains(T('/a/b'), T('/a/b')), true)
  assert.equal(core.contains(T('/a/b'), T('/a/b/c')), true)
  assert.equal(core.contains(T('/a/b'), T('/a/bc')), false)
  assert.equal(core.contains(T('/a/b'), T('/a')), false)
})

test('processPath / fileUrl', () => {
  const core = coreWithConn(async () => ({}))
  const t = T('/x/y z')
  assert.equal(core.processPath(t), '/x/y z')
  assert.equal(core.fileUrl(t), 'file:///x/y%20z')
})

test('resolve: 相对路径接 cwd 再取远端 realpath', async () => {
  const core = coreWithConn(async () => ({ code: 0, stdout: Buffer.from('/work/sub/f.txt\n'), stderr: '' }))
  const t = await core.resolve('sub/f.txt')
  assert.equal(t.targetKey, '/work/sub/f.txt')
  assert.equal(t.displayPath, '/work/sub/f.txt')
})

test('readText: 缺文件→FS_NOT_FOUND;二进制→FS_NOT_TEXT;非UTF8→FS_NOT_TEXT', async () => {
  const missing = coreWithConn(async () => ({ code: 1, stdout: Buffer.from(''), stderr: 'cat: x: No such file or directory' }))
  await assert.rejects(() => missing.readText(T('/x')), e => e.code === 'FS_NOT_FOUND')
  const binary = coreWithConn(async () => ({ code: 0, stdout: Buffer.from([1, 2, 0, 3]), stderr: '' }))
  await assert.rejects(() => binary.readText(T('/b')), e => e.code === 'FS_NOT_TEXT')
  const badUtf8 = coreWithConn(async () => ({ code: 0, stdout: Buffer.from([0xff, 0xfe, 0x41]), stderr: '' }))
  await assert.rejects(() => badUtf8.readText(T('/u')), e => e.code === 'FS_NOT_TEXT')
})

test('stat: 缺失→undefined;file 解析类型/大小/版本', async () => {
  const absent = coreWithConn(async () => ({ code: 0, stdout: Buffer.from('__ABSENT__\n'), stderr: '' }))
  assert.equal(await absent.stat(T('/x')), undefined)
  const file = coreWithConn(async () => ({ code: 0, stdout: Buffer.from('file\n42\n100:42:7\n'), stderr: '' }))
  assert.deepEqual(await file.stat(T('/f')), { version: '100:42:7', type: 'file', size: 42 })
})

test('writeText: replaceIfVersion 版本不符→FS_STALE_VERSION(不落写)', async () => {
  let wrote = false
  const core = coreWithConn(async (script) => {
    if (script.includes('__ABSENT__')) return { code: 0, stdout: Buffer.from('file\n12\nv1:0:0\n'), stderr: '' }
    wrote = true; return { code: 0, stdout: Buffer.from('v2:0:0'), stderr: '' }
  })
  await assert.rejects(
    () => core.writeText(T('/f'), 'x', { kind: 'replaceIfVersion', version: 'v0:0:0' }),
    e => e.code === 'FS_STALE_VERSION')
  assert.equal(wrote, false)
})

test('writeText: createIfAbsent 已存在→FS_NOT_OBSERVED', async () => {
  const core = coreWithConn(async (script) =>
    script.includes('__ABSENT__') ? { code: 0, stdout: Buffer.from('file\n5\nv:0:0\n'), stderr: '' } : { code: 0, stdout: Buffer.from('v2'), stderr: '' })
  await assert.rejects(() => core.writeText(T('/f'), 'x', { kind: 'createIfAbsent' }), e => e.code === 'FS_NOT_OBSERVED')
})

test('editText: old_string 未找到→FS_EDIT_NOT_FOUND;多处非 replaceAll→FS_AMBIGUOUS_EDIT', async () => {
  // _probe(stat) → 存在;readText → 内容;实际不写(前面就抛)
  const withContent = (content) => coreWithConn(async (script) => {
    if (script.includes('__ABSENT__')) return { code: 0, stdout: Buffer.from('file\n9\nv:0:0\n'), stderr: '' }
    if (script.includes('cat -- ')) return { code: 0, stdout: Buffer.from(content), stderr: '' }
    return { code: 0, stdout: Buffer.from('v2:0:0'), stderr: '' }
  })
  await assert.rejects(() => withContent('hello').editText(T('/f'), { oldString: 'zzz', newString: 'x', replaceAll: false }),
    e => e.code === 'FS_EDIT_NOT_FOUND')
  await assert.rejects(() => withContent('a a a').editText(T('/f'), { oldString: 'a', newString: 'x', replaceAll: false }),
    e => e.code === 'FS_AMBIGUOUS_EDIT')
})
