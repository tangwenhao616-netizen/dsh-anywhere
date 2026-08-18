/**
 * subprocess-ssh —— 把 SshSubprocessCore 包成 dsh 的 `ctx.subprocess`（SubprocessRuntime）provider。
 * 默认导出 Service 类，构造即注册 ctx.subprocess。config: { login, sshArgs, cwd }。
 * 与 fs-ssh 用相同 login/sshArgs 时，二者的 SshConn 会共享同一个 ControlMaster socket
 * （controlPath 由 login+args 派生）——即同一条复用连接、同一个执行世界。
 */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshConn } from './ssh-conn.js'
import { SshSubprocessCore } from './ssh-subprocess-core.js'
import { SshSubprocessCoreWin } from './ssh-subprocess-core-win.js'

export default class SshSubprocess extends SubprocessRuntime {
  constructor(ctx, config = {}) {
    super(ctx)
    const conn = config.conn ?? new SshConn({ login: config.login, sshArgs: config.sshArgs ?? [] })
    const Core = config.platform === 'windows' ? SshSubprocessCoreWin : SshSubprocessCore
    this.core = new Core({ conn })
  }
  resolveExecutable(command, env, signal) { return this.core.resolveExecutable(command, env, signal) }
  spawn(spec) { return this.core.spawn(spec) }
  spawnTerminal(spec) { return this.core.spawnTerminal(spec) }
}
