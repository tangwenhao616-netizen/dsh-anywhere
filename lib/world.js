/**
 * dsh-ssh-world —— 一个插件,把一台远程机器变成 dsh 的执行世界:同时注册
 * `ctx.fs`(fs-ssh)与 `ctx.subprocess`(subprocess-ssh),二者共享同一条 ControlMaster
 * SSH 连接。挂上它并禁掉本地 fs/subprocess provider(见 cordis.patch.yml),agent 的
 * read/write/edit/bash/grep 原生工具即透明作用在那台机器的文件/进程上,而模型/记忆在 hub。
 * 与 E2B 集成同构(fs + subprocess 合为一个执行世界),远端换成任意 SSH 可达机器
 * (fleet 入网机器经 -o ProxyJump=<relay> 即可)。
 *
 * peerDependencies:@deepseek-ai/dsh-fs、@deepseek-ai/dsh-subprocess(由 dsh 运行时提供)。
 * 函数插件(named export apply,无 default export)——apply 里 ctx.plugin 挂两个服务类。
 *
 * config:
 *   login    —— 'user@host'
 *   sshArgs  —— 传给 ssh 的参数数组(-i key / -o ProxyJump=… / -o IdentitiesOnly=yes …)
 *   cwd      —— 远程工作目录(须与 sandbox-policy.workspaceRoot 及会话 cwd 同指:一世界不变式)
 *   platform —— 'posix'(默认)| 'windows':远端是 Windows(OpenSSH+PowerShell)时选后者,
 *               fs/subprocess 走 PowerShell 后端。默认 cwd 随平台('/' vs 'C:\\')。
 */
import { SshConn } from './ssh-conn.js'
import SshFileSystem from './fs-ssh.js'
import SshSubprocess from './subprocess-ssh.js'

export const name = 'ssh-world'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{login:string, sshArgs?:string[], cwd?:string, platform?:'posix'|'windows'}} [config]
 */
export function apply(ctx, config = {}) {
  if (!config.login) throw new Error('dsh-ssh-world: config.login (user@host) is required')
  const conn = new SshConn({ login: config.login, sshArgs: config.sshArgs ?? [] })
  const platform = config.platform === 'windows' ? 'windows' : 'posix'
  const cwd = config.cwd ?? (platform === 'windows' ? 'C:\\' : '/')
  ctx.plugin(SshFileSystem, { conn, cwd, platform })
  ctx.plugin(SshSubprocess, { conn, platform })
}
