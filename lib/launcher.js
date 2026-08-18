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
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { mountWorkspace, unmountWorkspace } from './mount.js'

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
 *
 * 两种形态:
 *  - **挂载形态(传 mnt,现行)**:文件层走 hub 本地 fs 经 SSHFS 挂载点(网页文件树/
 *    编辑器/会话校验全是 hub node:fs,只有挂载能让它们看到远程真文件——架构结论);
 *    ssh-world 只供 subprocess(fs: false)+ workdir 前缀映射(挂载点→远程真实路径)。
 *  - **纯 ssh 形态(不传 mnt,兼容)**:fs+subprocess 都走 ssh-world(headless/agent 场景)。
 *
 * @param {{login:string, sshArgs?:string[], cwd:string, remoteCwd?:string, platform?:'posix'|'windows'}} desc
 * @param {number} [port] 覆盖 webserver 端口并绑 127.0.0.1(独立实例避开主 dph 的 3080;
 *   profile 层把端口固定在 3080,故必须在本补丁——profile 之后应用——里覆盖)。
 * @param {string} [trustedHost] 本实例自己隧道的域名——加进 connection.trustedHosts,否则经该
 *   隧道访问 /api 会被浏览器信任栅栏 403(保留 ...ctx.webRuntime.trustedHosts 以维持 loopback 信任)。
 * @param {string} [mnt] SSHFS 挂载点(hub 本地路径);传入即挂载形态。
 */
export function buildWorldPatch(desc, port, trustedHost, mnt) {
  const platform = desc.platform === 'windows' ? 'windows' : 'posix'
  const argLines = (desc.sshArgs ?? []).map(a => `          - ${JSON.stringify(a)}`).join('\n')
  const remoteCwd = desc.remoteCwd ?? desc.cwd
  return [
    '# 自动生成:workspace 启动器 —— 把本 dsh 实例执行世界搬到目标机器',
    ...(port ? ['- id: webserver', '  config:', "    host: '127.0.0.1'", `    port: ${port}`] : []),
    ...(trustedHost ? ['- id: connection', '  config:', `    trustedHosts: !!js "['${trustedHost}', ...ctx.webRuntime.trustedHosts]"`] : []),
    '- id: ui-skin-harbor',
    '  disabled: true',
    // 挂载形态保留本地 fs 栈(文件树/编辑器/agent read 经挂载点即远程真文件);纯 ssh 形态禁掉换 ssh fs。
    ...(mnt ? [] : ['- id: fs-sandbox', '  disabled: true']),
    '- id: subprocess',
    '  disabled: true',
    '- id: sandbox-policy',
    '  config:',
    '    mode: danger-full-access',
    `    workspaceRoot: ${JSON.stringify(mnt ?? desc.cwd)}`,
    '- insert:',
    '    - id: ssh-world',
    '      name: dsh-anywhere/world',
    '      config:',
    `        login: ${JSON.stringify(desc.login)}`,
    '        sshArgs:',
    argLines,
    `        cwd: ${JSON.stringify(remoteCwd)}`,
    `        platform: ${JSON.stringify(platform)}`,
    ...(mnt ? [
      '        fs: false',
      '        pathMap:',
      `          from: ${JSON.stringify(mnt)}`,
      `          to: ${JSON.stringify(remoteCwd)}`,
    ] : []),
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
    '-o', 'ConnectTimeout=8',            // 机器隧道断时快速失败(否则 fs 操作一直挂"读取状态中…")
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
  if (machineHost.proxyJump && machineHost.proxyJump.length && relayHost) {
    sshArgs.push('-o', `ProxyCommand=ssh -i ${relayHost.auth.keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -W %h:%p ${relayHost.user}@${relayHost.host}`)
  }
  const cwd = platform === 'windows' ? `C:\\Users\\${user}` : `/home/${user}`
  // sftpRoot:SSHFS 挂载的远程根。Windows OpenSSH 的 SFTP 把盘符呈现为 /C:/…(真机验证);
  // posix 空串 = 登录用户家目录(sshfs login: 语义)。
  const sftpRoot = platform === 'windows' ? `/C:/Users/${user}` : ''
  return { login: `${user}@${machineHost.host}`, sshArgs, cwd, remoteCwd: cwd, sftpRoot, platform }
}

/** 起 cloudflared 并捕获快速隧道 URL;resolve({cf, url})。timeoutMs 内没拿到就 reject。 */
export function startCloudflared(bin, port, env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // --protocol http2:走 TCP 而非默认 QUIC/UDP(某些网络挡 UDP → QUIC 握手超时、隧道 530)。
    const cf = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2', '--no-autoupdate'],
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
   * 挂载架构:先 SSHFS 挂机器到 hub 本地挂载点(文件树/编辑器/会话校验全走它=远程真文件),
   * 再起实例(subprocess 走 ssh-world + workdir 映射),最后自动建好工作区+会话——
   * 用户打开 URL 直接看到机器文件树,Windows/Linux 同一路径。
   * @returns {Promise<{alias:string, port:number, url:string, startedAt:number, status:string}>}
   */
  async open(alias, desc) {
    const existing = this.workspaces.get(alias)
    if (existing && existing.status === 'running') return this._public(existing)

    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const mnt = join(homedir(), '.dsh', 'anywhere', String(alias).replace(/[^A-Za-z0-9._-]/g, '_'))
    const handle = { alias, port, url: null, dsh: null, cf: null, patchDir: dir, mnt, startedAt: Date.now(), status: 'starting' }
    this.workspaces.set(alias, handle)

    try {
      await mountWorkspace(desc, mnt)                  // SSHFS 挂载(幂等,残留自动清)
      // 起隧道拿域名——world 补丁要把它加进 trustedHosts(否则 launched 实例经该隧道访问 /api 被信任栅栏 403)
      const { cf, url } = await startCloudflared(this.cloudflaredBin, port, this.env)
      handle.cf = cf; handle.url = url
      const patchPath = join(dir, 'world.patch.yml')
      writeFileSync(patchPath, buildWorldPatch(desc, port, url.replace(/^https?:\/\//, ''), mnt))

      const [cmd, ...baseArgs] = this.dshArgv
      const dsh = spawn(cmd, [...baseArgs, '--profile', 'web', '--patch', patchPath, '--port', String(port)],
        { env: { ...this.env, DSH_PERMISSION_MODE: 'danger-full-access', no_proxy: CF_NOPROXY, NO_PROXY: CF_NOPROXY }, stdio: ['ignore', 'pipe', 'pipe'] })
      handle.dsh = dsh
      dsh.on('close', () => this._reap(alias))

      await this.portReady(port, dsh)                 // 等 dsh web 监听
      await waitUrlHealthy(url)                         // 等隧道真打通(cloudflared 重连到已起的 backend,避免返回还在 530 的 URL)
      await bootstrapWorkspaceSession(port, mnt)        // 自动建工作区+会话(cwd=挂载点),打开即见文件树
      handle.status = 'running'
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
    if (w.mnt) unmountWorkspace(w.mnt).catch(() => { /* best effort */ })
    this.workspaces.delete(alias)
    return true
  }

  stopAll() { for (const a of [...this.workspaces.keys()]) this.stop(a) }

  _reap(alias) {
    const w = this.workspaces.get(alias)
    if (!w) return
    try { w.cf?.kill('SIGTERM') } catch { /* */ }
    try { rmSync(w.patchDir, { recursive: true, force: true }) } catch { /* */ }
    if (w.mnt) unmountWorkspace(w.mnt).catch(() => { /* best effort */ })
    this.workspaces.delete(alias)
  }

  _public(w) { return { alias: w.alias, port: w.port, url: w.url, startedAt: w.startedAt, status: w.status } }
}

/**
 * 在 launched 实例上自动建好工作区 + 会话(cwd=挂载点)——用户打开 URL 直接看到机器
 * 文件树,绕开只能浏览 hub 的目录选择器。经 loopback 调实例 RPC(loopback 天然过信任栅栏)。
 * best-effort:失败不阻断 open(用户仍可手动建会话)。
 */
export async function bootstrapWorkspaceSession(port, mnt, f = fetch) {
  const rpc = async (method, payload) => {
    const r = await f(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `ws-boot-${method}`, method, payload }),
      signal: AbortSignal.timeout(15000),
    })
    return r.json().catch(() => ({}))
  }
  try {
    await rpc('workspace.create', { path: mnt })
    await rpc('session.create', { cwd: mnt })
    return true
  } catch { return false }
}

/**
 * 轮询公网 URL 直到隧道真打通(cloudflared 先于 backend 起时会先 530/502,backend 起来后
 * 需一小会儿才重连到 origin)。返回是否在时限内变健康(<500)。best-effort,超时也不抛。
 */
export async function waitUrlHealthy(url, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
      if (r.status < 500) return true   // 到达 origin(200/301/403/404 都算隧道通)
    } catch { /* 网络/超时,重试 */ }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
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
