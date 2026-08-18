/**
 * mount.js —— SSHFS 挂载管理:把远程机器目录(经隧道)挂成 hub 本地目录。
 *
 * 为什么用挂载而不是 ctx.fs 门面(架构结论,真机验证):dsh 网页栈的文件树
 * (better-sidebar)、会话/工作区路径校验(dsh-workspace)、目录选择器全都直
 * 接用 hub 本地 node:fs——ctx.fs 只覆盖 agent 工具。SSHFS 把远程根挂到 hub
 * 本地路径后,这一整层"本地 fs 假设"对远程机器天然成立:文件树是真的、编辑
 * 器保存是真的、会话校验通过。Windows 机器同样适用(OpenSSH 自带 sftp-server,
 * 家目录呈现为 /C:/Users/<user>)。agent 的命令执行仍走 ssh-world subprocess。
 *
 * 就绪判定:轮询挂载点 readdir 成功(挂载生效前 readdir 空目录也算成功,故先
 * 比对挂载前后 st_dev——设备号变了才是真挂上)。
 */
import { spawn, execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 生成 sshfs argv(纯函数,可测)。
 * @param {{login:string, sshArgs?:string[], sftpRoot?:string}} desc
 *   login 'user@host';sshArgs 透传(-p/-i/-o ProxyCommand=…);sftpRoot 远程根
 *   (Windows 如 '/C:/Users/zyl';posix 空串=登录家目录)。
 * @param {string} mnt 本地挂载点
 */
export function sshfsArgs(desc, mnt) {
  const args = [`${desc.login}:${desc.sftpRoot ?? ''}`, mnt]
  const rest = [...(desc.sshArgs ?? [])]
  // sshfs 不认 -p;转成 -o port=N。其余 -i/-o 原生支持(-i 转 IdentityFile 以防版本差异)。
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-p' && rest[i + 1]) { args.push('-o', `port=${rest[++i]}`) }
    else if (rest[i] === '-i' && rest[i + 1]) { args.push('-o', `IdentityFile=${rest[++i]}`) }
    else if (rest[i] === '-o' && rest[i + 1]) { args.push('-o', rest[++i]) }
  }
  // 断线自动重连(配合中继/机器侧 keepalive 硬化);挂载点操作失败快速报错而非无限挂。
  args.push('-o', 'reconnect', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3')
  return args
}

/** 挂载点当前是否已是 mount(用 mountpoint -q;不在 PATH 时回退比较 st_dev)。 */
export async function isMounted(mnt) {
  try { await run('mountpoint', ['-q', mnt]); return true } catch { /* 非挂载点或无 mountpoint 命令 */ }
  try {
    const [self, parent] = await Promise.all([fsp.stat(mnt), fsp.stat(`${mnt}/..`)])
    return self.dev !== parent.dev
  } catch { return false }
}

/** 卸载(fusermount3 -u;占用时懒卸载 -uz;不存在等静默)。 */
export async function unmountWorkspace(mnt) {
  for (const argv of [['fusermount3', ['-u', mnt]], ['fusermount', ['-u', mnt]], ['fusermount3', ['-uz', mnt]]]) {
    try { await run(argv[0], argv[1]); return true } catch { /* 下一招 */ }
  }
  return !(await isMounted(mnt))
}

/**
 * 挂载一台机器到 mnt(幂等:已挂先卸掉重挂,清上次会话残留)。
 * @param {{login:string, sshArgs?:string[], sftpRoot?:string}} desc
 * @param {string} mnt
 * @param {{sshfsBin?:string, timeoutMs?:number}} [opts]
 */
export async function mountWorkspace(desc, mnt, opts = {}) {
  const bin = opts.sshfsBin ?? 'sshfs'
  const timeoutMs = opts.timeoutMs ?? 30000
  await fsp.mkdir(mnt, { recursive: true })
  if (await isMounted(mnt)) await unmountWorkspace(mnt)   // 残留挂载(可能已死)一律清掉重建

  const child = spawn(bin, sshfsArgs(desc, mnt), { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  // sshfs 默认 daemonize:认证+挂载成功后主进程退出(码 0);失败退出非 0。
  const exited = new Promise(resolve => { child.on('close', code => resolve(code)); child.on('error', () => resolve(-1)) })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isMounted(mnt)) return true
    const code = await Promise.race([exited, new Promise(r => setTimeout(() => r(undefined), 500))])
    if (code !== undefined && code !== 0) {
      throw new Error(`sshfs 挂载失败(exit ${code}):${stderr.trim().slice(0, 300) || '无输出'}`)
    }
  }
  try { child.kill('SIGKILL') } catch { /* */ }
  throw new Error(`sshfs 挂载超时(${timeoutMs}ms):${stderr.trim().slice(0, 300)}`)
}
