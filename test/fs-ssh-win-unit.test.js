// fs-ssh-win 纯逻辑 + 错误映射 单测(注入 fake conn.runPowershell,无网络)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshFsCoreWin } from '../lib/ssh-fs-core-win.js'

const b64 = s => Buffer.from(s, 'utf8').toString('base64')
const ps = (stdout, code = 0, stderr = '') => ({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr })
const coreWithConn = (impl, cwd = 'C:\\work') => new SshFsCoreWin({ conn: { runPowershell: impl }, cwd })
const T = p => ({ targetKey: p, displayPath: p })
// 操作判别:probe=有 Get-Item 无 WriteAllBytes;write=有 WriteAllBytes;read=有 ReadAllBytes;list=有 Get-ChildItem
const isProbe = s => s.includes('Get-Item') && !s.includes('WriteAllBytes')

test('resolve: 相对接 cwd + win32 normalize(解析 ..);绝对原样(纯本地,无往返)', async () => {
  const core = coreWithConn(async () => { throw new Error('resolve 不应发起远端调用') })
  assert.equal((await core.resolve('sub\\f.txt')).targetKey, 'C:\\work\\sub\\f.txt')
  assert.equal((await core.resolve('C:\\other\\x.txt')).targetKey, 'C:\\other\\x.txt')
  assert.equal((await core.resolve('a\\..\\b')).targetKey, 'C:\\work\\b')
})

test('contains: Windows 大小写不敏感前缀', () => {
  const core = coreWithConn(async () => ps(''))
  assert.equal(core.contains(T('C:\\a\\b'), T('C:\\A\\B\\c')), true)
  assert.equal(core.contains(T('C:\\a\\b'), T('C:\\a\\bc')), false)
})

test('stat: __ABSENT__→undefined;file 解析类型/大小/版本', async () => {
  assert.equal(await coreWithConn(async () => ps('__ABSENT__\r\n')).stat(T('C:\\x')), undefined)
  const st = await coreWithConn(async () => ps('file\r\n42\r\n638000000000000000:42\r\n')).stat(T('C:\\f'))
  assert.deepEqual(st, { version: '638000000000000000:42', type: 'file', size: 42 })
})

test('readText: __NOFILE__→FS_NOT_FOUND;__B64__ 解码(含中文);二进制→FS_NOT_TEXT', async () => {
  await assert.rejects(() => coreWithConn(async () => ps('__NOFILE__\r\n')).readText(T('C:\\x')), e => e.code === 'FS_NOT_FOUND')
  assert.equal(await coreWithConn(async () => ps('__B64__' + b64('hello 世界') + '\r\n')).readText(T('C:\\f')), 'hello 世界')
  const binB64 = Buffer.from([1, 2, 0, 3]).toString('base64')
  await assert.rejects(() => coreWithConn(async () => ps('__B64__' + binB64)).readText(T('C:\\b')), e => e.code === 'FS_NOT_TEXT')
})

test('writeText: 内容经 stdin(input) 传 base64;返回版本;create', async () => {
  let gotInput
  const core = coreWithConn(async (script, _sig, input) => {
    if (isProbe(script)) return ps('__ABSENT__\r\n')
    if (script.includes('WriteAllBytes')) { gotInput = input; return ps('638000000000000001:11') }
  })
  const o = await core.writeText(T('C:\\f'), 'new content')
  assert.equal(o.operation, 'create')
  assert.equal(o.version, '638000000000000001:11')
  assert.equal(Buffer.from(gotInput, 'base64').toString('utf8'), 'new content')
})

test('writeText: replaceIfVersion 版本不符→FS_STALE_VERSION(不落写)', async () => {
  let wrote = false
  const core = coreWithConn(async (script) => {
    if (isProbe(script)) return ps('file\r\n5\r\nvCUR:5\r\n')
    if (script.includes('ReadAllBytes')) return ps('__B64__' + b64('x'))
    wrote = true; return ps('vNEW:1')
  })
  await assert.rejects(() => core.writeText(T('C:\\f'), 'y', { kind: 'replaceIfVersion', version: 'vOLD:5' }), e => e.code === 'FS_STALE_VERSION')
  assert.equal(wrote, false)
})

test('writeText: createIfAbsent 已存在→FS_NOT_OBSERVED', async () => {
  const core = coreWithConn(async (script) => isProbe(script) ? ps('file\r\n5\r\nv:5\r\n') : ps('v2'))
  await assert.rejects(() => core.writeText(T('C:\\f'), 'x', { kind: 'createIfAbsent' }), e => e.code === 'FS_NOT_OBSERVED')
})

test('listDir: __NOTDIR__→FS_NOT_DIRECTORY;TSV 解析(name base64,含中文)', async () => {
  await assert.rejects(() => coreWithConn(async () => ps('__NOTDIR__\r\n')).listDir(T('C:\\x')), e => e.code === 'FS_NOT_DIRECTORY')
  const line = b64('文件.txt') + '\tfile\t10\t638:10'
  const es = await coreWithConn(async () => ps(line + '\r\n')).listDir(T('C:\\d'))
  assert.equal(es.length, 1)
  assert.equal(es[0].name, '文件.txt')
  assert.equal(es[0].type, 'file')
  assert.equal(es[0].size, 10)
  assert.equal(es[0].target.targetKey, 'C:\\d\\文件.txt')
})

test('editText: old 未找到→FS_EDIT_NOT_FOUND;多处非 replaceAll→FS_AMBIGUOUS_EDIT', async () => {
  const withContent = content => coreWithConn(async (script) => {
    if (isProbe(script)) return ps('file\r\n9\r\nv:9\r\n')
    if (script.includes('ReadAllBytes')) return ps('__B64__' + b64(content))
    return ps('vNEW:1')
  })
  await assert.rejects(() => withContent('hello').editText(T('C:\\f'), { oldString: 'zzz', newString: 'x' }), e => e.code === 'FS_EDIT_NOT_FOUND')
  await assert.rejects(() => withContent('a a a').editText(T('C:\\f'), { oldString: 'a', newString: 'x', replaceAll: false }), e => e.code === 'FS_AMBIGUOUS_EDIT')
})
