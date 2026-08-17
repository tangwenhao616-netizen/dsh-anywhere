/**
 * SshConn —— 面向一台远程机器的共享 SSH 连接层(fs-ssh 与 subprocess-ssh 共用)。
 * 用 OpenSSH **ControlMaster**:首次连接建一个 master(走一次握手),之后所有命令
 * 复用同一条连接(ControlPath socket),消掉 POC 里"每个 fs 操作起一次 ssh"的握手开销
 * (即用户感知的"卡")。零 npm 依赖,只用系统 ssh + node child_process。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 造一个带 code 的错误(FS_ 或 EXEC_ 前缀)。 */
const codedErr = (msg, code) => Object.assign(new Error(msg), { code })

export class SshConn {
  /**
   * @param {{login:string, sshArgs?:string[], controlDir?:string, persistSeconds?:number}} config
   */
  constructor(config) {
    this.login = config.login
    this.baseArgs = config.sshArgs ?? []
    const dir = config.controlDir ?? join(homedir(), '.dsh', 'ssh-world')
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* best effort */ }
    // 每个 target(login+args)一个稳定 control socket。
    const key = createHash('sha256').update(this.login + '\0' + this.baseArgs.join('\0')).digest('hex').slice(0, 16)
    this.controlPath = join(dir, `cm-${key}`)
    this.persist = config.persistSeconds ?? 300
  }

  /** ControlMaster 选项 + 用户 sshArgs。 */
  _mux() {
    return [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', `ControlPersist=${this.persist}`,
      ...this.baseArgs,
    ]
  }

  /**
   * 在远程跑一段 bash 脚本(fs 用:路径/内容 base64 进脚本);返回 {code, stdout:Buffer, stderr}。
   * @param {string} script
   * @param {AbortSignal} [signal]
   */
  run(script, signal) {
    return this._spawnCollect([...this._mux(), this.login, script], undefined, signal)
  }

  /**
   * 在远程执行一个程序(subprocess 用:显式 argv,不经 shell 拼接)。
   * cwd/env 由调用方在 argv 前用 `cd`/`env` 或直接传 spec 决定;这里只负责把 argv 送到远程。
   * 为避免远程 shell 二次解析,argv 逐个 base64,由远程 helper 还原后 exec。
   * @param {string[]} argv 远程要执行的程序及参数
   * @param {{cwd?:string, env?:Record<string,string>, input?:string, signal?:AbortSignal}} [opts]
   */
  execArgv(argv, opts = {}) {
    const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
    // 远程:重建 argv 到位置参数,设置 cwd/env,exec。全部 base64 传输,零注入。
    const parts = argv.map(a => `"$(printf %s '${b64(a)}' | base64 -d)"`).join(' ')
    const cwdCmd = opts.cwd ? `cd "$(printf %s '${b64(opts.cwd)}' | base64 -d)" && ` : ''
    const envCmd = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `export ${k.replace(/[^A-Za-z0-9_]/g, '')}="$(printf %s '${b64(v)}' | base64 -d)"; `).join('')
      : ''
    const script = `${envCmd}${cwdCmd}exec ${parts}`
    return this._spawnCollect([...this._mux(), this.login, script], opts.input, opts.signal)
  }

  /** 起一个流式的远程进程(subprocess spawn 用),返回子进程句柄供上层包装。 */
  spawnStream(argv, opts = {}) {
    const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
    const parts = argv.map(a => `"$(printf %s '${b64(a)}' | base64 -d)"`).join(' ')
    const cwdCmd = opts.cwd ? `cd "$(printf %s '${b64(opts.cwd)}' | base64 -d)" && ` : ''
    const envCmd = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `export ${k.replace(/[^A-Za-z0-9_]/g, '')}="$(printf %s '${b64(v)}' | base64 -d)"; `).join('')
      : ''
    const ttyArgs = opts.pty ? ['-tt'] : []
    const child = spawn('ssh', [...ttyArgs, ...this._mux(), this.login, `${envCmd}${cwdCmd}exec ${parts}`],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    return child
  }

  _spawnCollect(args, input, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const out = []; let err = ''
      child.stdout.on('data', d => out.push(d))
      child.stderr.on('data', d => { err += d.toString('utf8') })
      const onAbort = () => { child.kill('SIGKILL'); reject(codedErr('aborted', 'FS_ABORTED')) }
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }) }
      child.on('error', e => reject(codedErr(`ssh spawn failed: ${e.message}`, 'FS_IO_ERROR')))
      child.on('close', code => { if (signal) signal.removeEventListener('abort', onAbort); resolve({ code, stdout: Buffer.concat(out), stderr: err }) })
      if (input !== undefined) { child.stdin.end(input) } else { child.stdin.end() }
    })
  }

  /** 关闭复用连接(测试/清理用)。 */
  close() {
    try { spawn('ssh', ['-o', `ControlPath=${this.controlPath}`, '-O', 'exit', this.login], { stdio: 'ignore' }) } catch { /* best effort */ }
  }
}
