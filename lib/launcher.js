/**
 * WorkspaceLauncher —— ① 网页工作区启动器的核心(编排,无 cordis 依赖,可独立测)。
 * 给定一台机器的连法,起一个独立的 `dsh web` 实例(执行世界=那台机器,经 --patch 挂 world)
 * + 一条 cloudflared 快速隧道,返回可点的公网 URL;track 生命周期,可停、可全清。
 *
 * 底座(均已 spike 证实):
 *  - `dsh --profile web --patch <world补丁> --port <N>` 起独立 web 实例(web profile 自带模型)。
 *  - cloudflared `tunnel --url http://127.0.0.1:<N>`,URL 打 stdout/stderr,正则捕获、SIGTERM 杀。
 *  - 空闲端口 = net.createServer listen 0。
 *
 * 依赖注入(便于测试):cloudflaredBin、dshSpawn(argv/env 工厂)、env。
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CF_NOPROXY = '.trycloudflare.com,.argotunnel.com,.cloudflare.com,api.cloudflare.com'

/** 选一个空闲 TCP 端口(OS 分配)。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

/**
 * 从一台机器描述生成 world 执行世界补丁(YAML 文本)。
 * @param {{login:string, sshArgs?:string[], cwd:string, platform?:'posix'|'windows'}} desc
 */
export function buildWorldPatch(desc) {
  const platform = desc.platform === 'windows' ? 'windows' : 'posix'
  const argLines = (desc.sshArgs ?? []).map(a => `          - ${JSON.stringify(a)}`).join('\n')
  return [
    '# 自动生成:workspace 启动器 —— 把本 dsh 实例执行世界搬到目标机器',
    '- id: ui-skin-harbor',
    '  disabled: true',
    '- id: fs-sandbox',
    '  disabled: true',
    '- id: subprocess',
    '  disabled: true',
    '- id: sandbox-policy',
    '  config:',
    '    mode: danger-full-access',
    `    workspaceRoot: ${JSON.stringify(desc.cwd)}`,
    '- insert:',
    '    - id: ssh-world',
    '      name: dsh-anywhere/world',
    '      config:',
    `        login: ${JSON.stringify(desc.login)}`,
    '        sshArgs:',
    argLines,
    `        cwd: ${JSON.stringify(desc.cwd)}`,
    `        platform: ${JSON.stringify(platform)}`,
    '',
  ].join('\n')
}

/**
 * 从一台 fleet 机器 + 它的 dsh-ssh 主机条目,组出 world 连接描述(纯函数)。
 * 经中继的机器(proxyJump 非空且有 relayHost)用 ProxyCommand 双密钥双跳;直连机器则直连。
 * @param {{os?:string}} machine  fleet 机器(取 os 判平台)
 * @param {{host:string, port:number, user:string, auth:{keyPath:string}, proxyJump?:string[]}} machineHost dsh-ssh 条目
 * @param {{host:string, port?:number, user:string, auth:{keyPath:string}}} [relayHost] relay-jump 条目(经中继时需要)
 */
export function descFromFleetMachine(machine, machineHost, relayHost) {
  const platform = machine.os === 'win' ? 'windows' : 'posix'
  const user = machineHost.user
  const sshArgs = [
    '-p', String(machineHost.port),
    '-i', machineHost.auth.keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  if (machineHost.proxyJump && machineHost.proxyJump.length && relayHost) {
    sshArgs.push('-o', `ProxyCommand=ssh -i ${relayHost.auth.keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -W %h:%p ${relayHost.user}@${relayHost.host}`)
  }
  const cwd = platform === 'windows' ? `C:\\Users\\${user}` : `/home/${user}`
  return { login: `${user}@${machineHost.host}`, sshArgs, cwd, platform }
}

/** 起 cloudflared 并捕获快速隧道 URL;resolve({cf, url})。timeoutMs 内没拿到就 reject。 */
export function startCloudflared(bin, port, env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const cf = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { env: { ...env, no_proxy: CF_NOPROXY, NO_PROXY: CF_NOPROXY }, stdio: ['ignore', 'pipe', 'pipe'] })
    let url = null
    const scan = d => {
      if (url) return
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m) { url = m[0]; clearTimeout(timer); resolve({ cf, url }) }
    }
    cf.stdout.on('data', scan); cf.stderr.on('data', scan)
    cf.on('error', e => { clearTimeout(timer); reject(e) })
    const timer = setTimeout(() => { if (!url) { try { cf.kill('SIGKILL') } catch { /* */ } reject(new Error('cloudflared: 未在时限内拿到 URL')) } }, timeoutMs)
    cf.on('close', () => { if (!url) { clearTimeout(timer); reject(new Error('cloudflared 在拿到 URL 前退出')) } })
  })
}

export class WorkspaceLauncher {
  /**
   * @param {{cloudflaredBin:string, dshArgv:string[], env?:object, portReady?:(port:number,signal)=>Promise<void>}} opts
   *   dshArgv: 起 dsh 的 argv(如 ['node','/path/dsh'] 或 ['dsh']);实例会追加 --profile web --patch P --port N。
   *   portReady: 可选,等实例监听就绪(默认轮询 TCP 连接)。
   */
  constructor(opts) {
    this.cloudflaredBin = opts.cloudflaredBin
    this.dshArgv = opts.dshArgv
    this.env = opts.env ?? process.env
    this.portReady = opts.portReady ?? defaultPortReady
    /** @type {Map<string, any>} */
    this.workspaces = new Map()
  }

  /**
   * 为一台机器打开工作区(幂等:已在跑则返回现有)。desc 见 buildWorldPatch。
   * @returns {Promise<{alias:string, port:number, url:string, startedAt:number, status:string}>}
   */
  async open(alias, desc) {
    const existing = this.workspaces.get(alias)
    if (existing && existing.status === 'running') return this._public(existing)

    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const patchPath = join(dir, 'world.patch.yml')
    writeFileSync(patchPath, buildWorldPatch(desc))

    const [cmd, ...baseArgs] = this.dshArgv
    const dsh = spawn(cmd, [...baseArgs, '--profile', 'web', '--patch', patchPath, '--port', String(port)],
      { env: { ...this.env, DSH_PERMISSION_MODE: 'danger-full-access', no_proxy: CF_NOPROXY, NO_PROXY: CF_NOPROXY }, stdio: ['ignore', 'pipe', 'pipe'] })

    const handle = { alias, port, url: null, dsh, cf: null, patchDir: dir, startedAt: Date.now(), status: 'starting' }
    this.workspaces.set(alias, handle)
    dsh.on('close', () => this._reap(alias))

    try {
      await this.portReady(port, dsh)                 // 等 dsh web 监听
      const { cf, url } = await startCloudflared(this.cloudflaredBin, port, this.env)
      handle.cf = cf; handle.url = url; handle.status = 'running'
      cf.on('close', () => { if (handle.status === 'running') this.stop(alias) })
      return this._public(handle)
    } catch (e) {
      this.stop(alias)
      throw e
    }
  }

  list() { return [...this.workspaces.values()].map(w => this._public(w)) }

  stop(alias) {
    const w = this.workspaces.get(alias)
    if (!w) return false
    w.status = 'stopped'
    try { w.cf?.kill('SIGTERM') } catch { /* */ }
    try { w.dsh?.kill('SIGTERM') } catch { /* */ }
    try { rmSync(w.patchDir, { recursive: true, force: true }) } catch { /* */ }
    this.workspaces.delete(alias)
    return true
  }

  stopAll() { for (const a of [...this.workspaces.keys()]) this.stop(a) }

  _reap(alias) {
    const w = this.workspaces.get(alias)
    if (!w) return
    try { w.cf?.kill('SIGTERM') } catch { /* */ }
    try { rmSync(w.patchDir, { recursive: true, force: true }) } catch { /* */ }
    this.workspaces.delete(alias)
  }

  _public(w) { return { alias: w.alias, port: w.port, url: w.url, startedAt: w.startedAt, status: w.status } }
}

/** 默认就绪探测:轮询 TCP 连接目标端口(dsh web 开始监听即成),或 dsh 提前退出则失败。 */
function defaultPortReady(port, dshChild, { timeoutMs = 60000, intervalMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false
    const deadline = Date.now() + timeoutMs
    const onExit = () => { if (!done) { done = true; reject(new Error('dsh web 在监听前退出')) } }
    dshChild.on('close', onExit)
    const tick = () => {
      if (done) return
      const sock = net.connect({ host: '127.0.0.1', port }, () => { done = true; sock.destroy(); dshChild.off('close', onExit); resolve() })
      sock.on('error', () => { sock.destroy(); if (Date.now() > deadline) { done = true; dshChild.off('close', onExit); reject(new Error('dsh web 监听超时')) } else setTimeout(tick, intervalMs) })
    }
    tick()
  })
}
