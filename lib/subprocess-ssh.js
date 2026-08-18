/**
 * subprocess-ssh —— 把 SshSubprocessCore 包成 dsh 的 `ctx.subprocess`（SubprocessRuntime）provider。
 * 默认导出 Service 类，构造即注册 ctx.subprocess。config: { login, sshArgs, cwd, platform, pathMap }。
 * 与 fs-ssh 用相同 login/sshArgs 时，二者的 SshConn 会共享同一个 ControlMaster socket
 * （controlPath 由 login+args 派生）——即同一条复用连接、同一个执行世界。
 *
 * pathMap {from, to}:workdir 前缀映射(SSHFS 挂载架构)。会话/agent 的 cwd 是 hub 上的
 * 挂载点路径(如 ~/.dsh/anywhere/ZYL/sub),命令要在远程真实路径跑(C:\Users\zyl\sub 或
 * /home/user/sub)——把 from 前缀换成 to,分隔符按 platform 转。挂载点外的路径原样透传。
 */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshConn } from './ssh-conn.js'
import { SshSubprocessCore } from './ssh-subprocess-core.js'
import { SshSubprocessCoreWin } from './ssh-subprocess-core-win.js'

/** hub 挂载点路径 → 远程真实路径(纯函数,可测)。 */
export function mapWorkdir(p, pathMap, platform) {
  if (!p || !pathMap?.from || !pathMap?.to) return p
  const { from, to } = pathMap
  if (p === from) return to
  if (p.startsWith(from.endsWith('/') ? from : from + '/')) {
    const tail = p.slice(from.length)
    return platform === 'windows' ? to + tail.replaceAll('/', '\\') : to + tail
  }
  return p
}

export default class SshSubprocess extends SubprocessRuntime {
  constructor(ctx, config = {}) {
    super(ctx)
    const conn = config.conn ?? new SshConn({ login: config.login, sshArgs: config.sshArgs ?? [] })
    this.platform = config.platform === 'windows' ? 'windows' : 'posix'
    this.pathMap = config.pathMap
    const Core = this.platform === 'windows' ? SshSubprocessCoreWin : SshSubprocessCore
    this.core = new Core({ conn })
  }
  _spec(spec) {
    if (!this.pathMap || !spec?.cwd) return spec
    return { ...spec, cwd: mapWorkdir(spec.cwd, this.pathMap, this.platform) }
  }
  resolveExecutable(command, env, signal) { return this.core.resolveExecutable(command, env, signal) }
  spawn(spec) { return this.core.spawn(this._spec(spec)) }
  spawnTerminal(spec) { return this.core.spawnTerminal(this._spec(spec)) }
}
