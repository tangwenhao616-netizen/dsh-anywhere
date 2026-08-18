/**
 * SshSubprocessCore —— dsh `ctx.subprocess`(SubprocessRuntime)的 SSH 实现核心。
 * 与 fs-ssh 共享同一条 SshConn(ControlMaster)。实现:
 *   resolveExecutable —— 远程 `command -v` 查绝对路径。
 *   spawn(spec) —— 远程进程(bash/grep 工具走它);stdin(ignore/pipe/{data})、
 *     stdout/stderr(pipe/inherit/collect,collect 带 offset 读 + 可选 spill)、
 *     done(退出码)、terminate(SIGTERM→grace→SIGKILL,杀本地 ssh 子进程,SIGHUP 传远端)、
 *     waitForExit。pid = 本地 ssh 代理进程(远端 pid 需远程上报,POC 用代理)。
 *   spawnTerminal(spec) —— 基础 PTY(`ssh -tt`):output/write/done/terminate;
 *     inspectForeground/signalForeground 走远程 ps/kill 尽力而为(POC 限制)。
 *
 * 无 npm 依赖。远端进程组精确身份栅栏、macOS session 枚举等属 provider 局限(见 README)。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createWriteStream, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execErr = (msg, code) => Object.assign(new Error(msg), { code })

/** 有界收集器:内存保留尾部 maxBytes,可选把整流写 spill 文件;offset-based 读。 */
export function makeCollector(stream, collect) {
  let total = 0
  let tail = Buffer.alloc(0)
  const maxTail = collect.maxBytes
  let spillPath
  let spillStream
  let spillOver = false
  if (collect.spill) {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ssh-subp-'))
      spillPath = join(dir, 'stream')
      spillStream = createWriteStream(spillPath)
    } catch { spillPath = undefined }
  }
  stream.on('data', chunk => {
    total += chunk.length
    if (spillStream && !spillOver) {
      if (total > (collect.spill.maxBytes ?? Infinity)) { spillOver = true; try { spillStream.end() } catch { /* */ } spillPath = undefined }
      else spillStream.write(chunk)
    }
    tail = tail.length + chunk.length <= maxTail ? Buffer.concat([tail, chunk]) : Buffer.concat([tail, chunk]).subarray(-maxTail)
  })
  stream.on('end', () => { try { spillStream?.end() } catch { /* */ } })
  return {
    readFrom(fromByte) {
      const tailStart = total - tail.length
      if (fromByte < tailStart) return { text: tail.toString('utf8'), nextOffset: total, lossy: true, ...(spillPath ? { spillPath } : {}) }
      return { text: tail.subarray(fromByte - tailStart).toString('utf8'), nextOffset: total, lossy: false, ...(spillPath ? { spillPath } : {}) }
    },
  }
}

export class SshSubprocessCore {
  /** @param {{conn:import('./ssh-conn.js').SshConn}} deps */
  constructor(deps) { this.conn = deps.conn }

  async resolveExecutable(command, env, signal) {
    if (!command || command.trim() === '') throw execErr('empty command', 'EXEC_RESOLVE')
    // command -v 是 shell 内建,必须走 shell(不能 exec);路径 base64 防注入。
    const b64 = Buffer.from(String(command), 'utf8').toString('base64')
    const r = await this.conn.run(`command -v -- "$(printf %s '${b64}' | base64 -d)"`, signal)
    const path = r.stdout.toString('utf8').trim()
    if (r.code !== 0 || !path) throw execErr(`executable not found: ${command}`, 'EXEC_NOT_FOUND')
    return path
  }

  /** @param {import('node:stream')} */
  spawn(spec) {
    const { argv, cwd, stdio, graceMs, signal, env } = spec
    const cleanEnv = env ? Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) : undefined
    const child = this.conn.spawnStream([...argv], { cwd, env: cleanEnv })

    // stdin
    if (stdio.stdin === 'ignore') child.stdin.end()
    else if (stdio.stdin && typeof stdio.stdin === 'object' && 'data' in stdio.stdin) child.stdin.end(stdio.stdin.data)
    // 'pipe' → 保留 child.stdin 供 handle.stdin

    // stdout/stderr:'pipe'→原样暴露;'inherit'→接到父进程流;SubprocessCollect→有界收集器
    const wire = (stream, mode, inheritTo) => {
      if (mode === 'pipe') return undefined
      if (mode === 'inherit') { stream.pipe(inheritTo); return undefined }
      return makeCollector(stream, mode)
    }
    const outReader = wire(child.stdout, stdio.stdout, process.stdout)
    const errReader = wire(child.stderr, stdio.stderr, process.stderr)

    const done = new Promise((resolve) => {
      child.on('close', code => resolve({ exitCode: code == null ? null : code, signal: null }))
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
      stdout: stdio.stdout === 'pipe' ? child.stdout : undefined,
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

  /** 基础 PTY over `ssh -tt`。foreground 检查/信号走远程 ps/kill,尽力而为(POC 限制)。 */
  async spawnTerminal(spec) {
    const { argv, cwd, env, signal } = spec
    const cleanEnv = env ? Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) : undefined
    const child = this.conn.spawnStream([...argv], { cwd, env: cleanEnv, pty: true })
    if (signal?.aborted) { child.kill('SIGKILL') }
    const done = new Promise((resolve) => child.on('close', code => resolve({ exitCode: code == null ? null : code, signal: null })))
    return {
      pid: child.pid ?? -1,
      output: child.stdout,
      done,
      write: async (data) => { await new Promise((res, rej) => child.stdin.write(data, e => e ? rej(e) : res())) },
      inspectForeground: async () => undefined, // POC:远端前台组查询未实现
      signalForeground: async (sig) => { child.kill(sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); return child.pid ?? -1 },
      terminate: async () => { child.kill('SIGKILL'); await done.catch(() => {}) },
    }
  }
}
