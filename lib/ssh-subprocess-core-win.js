/**
 * SshSubprocessCoreWin —— dsh `ctx.subprocess`(SubprocessRuntime)的 **Windows** SSH 实现核心。
 * 与 fs-ssh-win 共享同一条 SshConn。实现:
 *   resolveExecutable —— 远程 `Get-Command -CommandType Application`(对应 POSIX `command -v`)。
 *   spawn(spec) —— 经 SshConn.spawnStreamPowershell 起远程进程(`& $exe @args`);stdin、
 *     stdout/stderr(pipe/inherit/collect)、done(退出码)、terminate、waitForExit。
 *     **退出码经 stdout 尾部 `__DSHRC__<n>` 标记回传**(Windows OpenSSH 会把非零码塌成 1),
 *     本地 markerStripper 剥离标记 + 还原精确码,clean 输出下游无感。
 *   spawnTerminal(spec) —— 基础 PTY(`ssh -tt`)。
 *
 * 句柄结构与 POSIX 版一致(pid/stdin/stdout/stderr/collected/done/terminate/waitForExit)。
 */
import { Transform } from 'node:stream'
import { makeCollector } from './ssh-subprocess-core.js'

const execErr = (msg, code) => Object.assign(new Error(msg), { code })
/** PowerShell 表达式:base64(UTF-8) 解回文本(base64 常量,安全)。 */
const dec = bstr => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bstr}'))`

/**
 * 剥离 stdout 尾部的 `__DSHRC__<n>` 退出码标记(始终在流的最末尾)。始终留 HOLD 字节尾部,
 * 其余透传;flush 时从留存尾部按 buffer 定位标记、取码、去标记。二进制安全。
 */
export function markerStripper() {
  const MARKB = Buffer.from('__DSHRC__')
  const HOLD = 64
  let held = Buffer.alloc(0)
  let exitCode = null
  const t = new Transform({
    transform(chunk, _enc, cb) {
      const buf = Buffer.concat([held, chunk])
      if (buf.length > HOLD) { this.push(buf.subarray(0, buf.length - HOLD)); held = buf.subarray(buf.length - HOLD) }
      else held = buf
      cb()
    },
    flush(cb) {
      const i = held.lastIndexOf(MARKB)
      if (i >= 0) {
        const m = held.subarray(i + MARKB.length).toString('utf8').match(/^(-?\d+)/)
        if (m) exitCode = Number(m[1])
        this.push(held.subarray(0, i))
      } else if (held.length) this.push(held)
      cb()
    },
  })
  t.getExitCode = () => exitCode
  return t
}

export class SshSubprocessCoreWin {
  /** @param {{conn:import('./ssh-conn.js').SshConn}} deps */
  constructor(deps) { this.conn = deps.conn }

  async resolveExecutable(command, env, signal) {
    if (!command || command.trim() === '') throw execErr('empty command', 'EXEC_RESOLVE')
    const b = Buffer.from(String(command), 'utf8').toString('base64')
    const script =
      `$c = ${dec(b)}\n` +
      `$g = Get-Command -Name $c -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n` +
      `if ($g) { Write-Output ('__P__' + $g.Source) } else { Write-Output '__NONE__' }`
    const r = await this.conn.runPowershell(script, signal)
    const out = r.stdout.toString('utf8')
    const m = out.match(/__P__(.+)/)
    if (!m) throw execErr(`executable not found: ${command}`, 'EXEC_NOT_FOUND')
    return m[1].trim()
  }

  spawn(spec) {
    const { argv, cwd, stdio, graceMs, signal, env } = spec
    const cleanEnv = env ? Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) : undefined
    const child = this.conn.spawnStreamPowershell([...argv], { cwd, env: cleanEnv })

    // stdin
    if (stdio.stdin === 'ignore') child.stdin.end()
    else if (stdio.stdin && typeof stdio.stdin === 'object' && 'data' in stdio.stdin) child.stdin.end(stdio.stdin.data)

    // stdout 先过退出码标记剥离器,再按模式接线
    const stripper = markerStripper()
    child.stdout.pipe(stripper)

    const wire = (stream, mode, inheritTo) => {
      if (mode === 'pipe') return undefined
      if (mode === 'inherit') { stream.pipe(inheritTo); return undefined }
      return makeCollector(stream, mode)
    }
    const outReader = wire(stripper, stdio.stdout, process.stdout)
    const errReader = wire(child.stderr, stdio.stderr, process.stderr)

    const done = new Promise((resolve) => {
      // child 'close' 在 stdout 'end'(触发 stripper flush 设好 exitCode)之后触发。
      child.on('close', code => resolve({ exitCode: stripper.getExitCode() ?? (code == null ? null : code), signal: null }))
      child.on('error', () => resolve({ exitCode: null, signal: null }))
    })
    let killTimer
    const terminate = () => {
      try { child.kill('SIGTERM') } catch { /* */ }
      clearTimeout(killTimer)
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, graceMs)
    }
    if (signal) { if (signal.aborted) terminate(); else signal.addEventListener('abort', terminate, { once: true }) }
    done.then(() => clearTimeout(killTimer))

    return {
      pid: child.pid ?? -1,
      stdin: stdio.stdin === 'pipe' ? child.stdin : undefined,
      stdout: stdio.stdout === 'pipe' ? stripper : undefined,
      stderr: stdio.stderr === 'pipe' ? child.stderr : undefined,
      collected: { ...(outReader ? { stdout: outReader } : {}), ...(errReader ? { stderr: errReader } : {}) },
      done,
      terminate,
      waitForExit: async (sig) => {
        if (!sig) { await done; return true }
        return await Promise.race([done.then(() => true), new Promise(res => sig.addEventListener('abort', () => res(false), { once: true }))])
      },
    }
  }

  /** 基础 PTY over `ssh -tt`(Windows conpty)。foreground 查询/信号 POC 未实现。 */
  async spawnTerminal(spec) {
    const { argv, cwd, env, signal } = spec
    const cleanEnv = env ? Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) : undefined
    const child = this.conn.spawnStreamPowershell([...argv], { cwd, env: cleanEnv, pty: true })
    if (signal?.aborted) { child.kill('SIGKILL') }
    const done = new Promise((resolve) => child.on('close', code => resolve({ exitCode: code == null ? null : code, signal: null })))
    return {
      pid: child.pid ?? -1,
      output: child.stdout,
      done,
      write: async (data) => { await new Promise((res, rej) => child.stdin.write(data, e => e ? rej(e) : res())) },
      inspectForeground: async () => undefined,
      signalForeground: async (sig) => { child.kill(sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); return child.pid ?? -1 },
      terminate: async () => { child.kill('SIGKILL'); await done.catch(() => {}) },
    }
  }
}
