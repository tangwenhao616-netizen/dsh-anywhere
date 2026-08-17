// Level-1 活探针:SshFsCore 对着中继(真实远程机)跑一遍 fs 契约,证明远程读/写/改/列生效。
import { SshFsCore } from '../lib/ssh-fs-core.js'

const core = new SshFsCore({
  login: 'ubuntu@175.24.133.218',
  sshArgs: ['-i', '/home/wl/.ssh/id_rsa', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'],
  cwd: '/tmp',
})
const ok = (c, m) => console.log((c ? '✅' : '❌') + ' ' + m)
const name = `dsh-fs-poc-${process.pid}.txt`

const t = await core.resolve(name)
console.log('resolve →', t.targetKey)
ok(t.targetKey === `/tmp/${name}`, `resolve 相对路径接 cwd + canonical`)

const w = await core.writeText(t, 'hello\nworld\n')
ok(w.operation === 'create' && w.before === null, `writeText 创建 (op=${w.operation}, version=${w.version})`)

const st = await core.stat(t)
ok(st && st.type === 'file' && st.size === 12, `stat → file size=${st?.size} version=${st?.version}`)

const rd = await core.readText(t)
ok(rd === 'hello\nworld\n', `readText 读回内容一致`)

const listing = await core.listDir(await core.resolve('/tmp'))
ok(listing.some(e => e.name === name && e.type === 'file'), `listDir /tmp 含新文件(共 ${listing.length} 项)`)

const ed = await core.editText(t, { oldString: 'world', newString: 'ssh-fs', replaceAll: false })
ok(ed.before === 'hello\nworld\n' && ed.after === 'hello\nssh-fs\n', `editText 字面替换`)

const rd2 = await core.readText(t)
ok(rd2 === 'hello\nssh-fs\n', `edit 后 readText 反映改动`)

// 版本守卫:用旧 version 写应 FS_STALE_VERSION
try {
  await core.writeText(t, 'x', { kind: 'replaceIfVersion', version: w.version })
  ok(false, `版本守卫应拒旧 version`)
} catch (e) { ok(e.code === 'FS_STALE_VERSION', `版本守卫 → ${e.code}`) }

// 清理
await core._ssh(`rm -f -- '/tmp/${name}'`)
console.log('cleaned', name)
