/**
 * dsh-fleet 路由族。三类:
 *   公开(经域名/隧道可达,token 鉴权):
 *     GET  /join            返回 join 脚本(?token= 必带且有效)
 *     POST /api/fleet/enroll 换证(body.token 一次性消耗)
 *     POST /api/fleet/heartbeat 上线回报(body.id)
 *   特权(浏览器 UI,fromTunnelOrLocal + 同源):
 *     POST /api/fleet/token  铸造 token,返回一行入网命令
 *     GET  /api/fleet/list   机器 + 有效 token 列表
 *     POST /api/fleet/revoke 吊销一台(body.alias)
 *     POST /api/fleet/relay  设置中继(社区插件不硬编码,用户配自己的 VPS)
 *
 * 全部 handler 形如 (req,res)=>Promise<void>,由 index.js 经 ctx.webServer.register 挂上。
 */
import { fromTunnelOrLocal, sameOriginBrowser, isLocalRequest } from './gate.js'
import { mintToken, listTokens, revokeToken, findToken } from './token.js'
import { enrollMachine, markOnline } from './enroll.js'
import { registerRequest, getRequestStatus, listRequests, approveRequest, rejectRequest, sweepRequests } from './requests.js'
import { renderLinuxJoinScript } from './join-template.js'
import { renderNixBootstrap } from './bootstrap-nix.js'
import { renderWinBootstrap } from './bootstrap-win.js'
import { renderFleetPanel } from './panel.js'
import { removeFleetHost } from './ssh-host-writer.js'

const MAX_BODY = 64 * 1024

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}
async function readJson(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    const buf = chunk
    size += buf.length
    if (size > MAX_BODY) return undefined
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch { return undefined }
}

/** 极简说明页(浏览器打开 /join 时展示要跑的命令;不是 dph 主界面)。 */
function joinPageHtml(b) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>加入 dsh 车队</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}`
    + `pre{background:#f4f4f5;border-radius:6px;padding:12px;overflow:auto}h1{font-size:20px}.m{color:#666;font-size:14px}</style></head><body>`
    + `<h1>加入 dsh 车队</h1>`
    + `<p class="m">在这台机器上运行下面对应命令:它会提交入网申请并显示配对码;机主在自己的 dph 网页核对配对码后点「通过」,本机即入网。</p>`
    + `<h3>Linux / macOS</h3><pre>curl -fsSL '${b}/join' | bash</pre>`
    + `<h3>Windows(PowerShell)</h3><pre>irm '${b}/join?os=win' | iex</pre>`
    + `<p class="m">需要本机已运行 SSH 服务(Windows 需开启 OpenSSH 服务器)。</p></body></html>`
}

/**
 * @param {{store, provisioner, sshStorePath:string, baseUrl:()=>string, now?:()=>number}} deps
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function makeRoutes(deps) {
  const { store, provisioner, sshStorePath, baseUrl } = deps
  const now = deps.now ?? (() => Date.now())
  const DEFAULT_TTL = 10 * 60 * 1000

  /** 特权栅栏:仅本机(Host 为 loopback)+ 浏览器同源。公网域名(cloudflared)进不来——
   *  管理/批准锁死在本机 1.44,异地经域名只能提交申请、不能批准。 */
  const privileged = (req, res) => {
    if (!isLocalRequest(req) || !sameOriginBrowser(req)) { writeJson(res, 403, { error: 'forbidden: local-only' }); return false }
    return true
  }

  return [
    // ---- 特权:铸造 token
    { kind: 'exact', path: '/api/fleet/token', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(body.alias)) {
        return writeJson(res, 400, { error: 'alias required (letters/digits/._-)' })
      }
      const os = body.os === 'win' || body.os === 'mac' ? body.os : 'linux'
      const ttlMs = Number.isInteger(body.ttlMs) ? body.ttlMs : DEFAULT_TTL
      const rec = mintToken(store, { alias: body.alias, os, ttlMs }, now())
      const url = `${baseUrl()}/join?token=${rec.token}`
      const command = os === 'win'
        ? `powershell: $env:FLEET_TOKEN='${rec.token}'; irm '${baseUrl()}/join?token=${rec.token}&os=win' | iex`
        : `curl -fsSL '${url}' | bash`
      writeJson(res, 200, { token: rec.token, alias: rec.alias, os, expiresAt: rec.expiresAt, url, command })
    } },

    // ---- 特权:列表
    { kind: 'exact', path: '/api/fleet/list', handler: async (req, res) => {
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      sweepRequests(store, now())
      const f = store.load()
      writeJson(res, 200, {
        machines: f.machines.map(m => ({ alias: m.alias, os: m.os, port: m.port, status: m.status, lastSeen: m.lastSeen, enrolledAt: m.enrolledAt })),
        requests: listRequests(store, now()),
        tokens: listTokens(store, now()).map(t => ({ alias: t.alias, os: t.os, expiresAt: t.expiresAt })),
        relay: { host: f.relay?.host ?? '', configured: !!f.relay?.host },
      })
    } },

    // ---- 特权:吊销一台
    { kind: 'exact', path: '/api/fleet/revoke', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.alias !== 'string') return writeJson(res, 400, { error: 'alias required' })
      const m = store.load().machines.find(x => x.alias === body.alias)
      if (m) {
        try { await provisioner.removeTunnelKey(m.port) } catch { /* 中继不可达也要继续本地清理 */ }
        removeFleetHost(sshStorePath, m.hostAlias)
        store.update(f => { f.machines = f.machines.filter(x => x.alias !== body.alias) })
      }
      writeJson(res, 200, { ok: true })
    } },

    // ---- 特权:设置中继(社区插件不硬编码中继,用户在此配置自己的 VPS)
    { kind: 'exact', path: '/api/fleet/relay', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.host !== 'string' || body.host.trim() === '') return writeJson(res, 400, { error: 'host required' })
      store.update(f => {
        f.relay = {
          host: body.host.trim(),
          port: Number.isInteger(body.port) ? body.port : 22,
          tunnelUser: typeof body.tunnelUser === 'string' && body.tunnelUser ? body.tunnelUser : 'tunnel',
          jumpAlias: 'relay-jump',
          jumpLogin: typeof body.jumpLogin === 'string' ? body.jumpLogin : '',
          portRange: Array.isArray(body.portRange) && body.portRange.length === 2 ? body.portRange : (f.relay?.portRange ?? [20001, 20999]),
        }
      })
      writeJson(res, 200, { ok: true, relay: store.load().relay })
    } },

    // ---- 管理页:仅本机可开(1.44),公网域名进不来
    { kind: 'exact', path: '/fleet', handler: async (req, res) => {
      if (!isLocalRequest(req)) return writeJson(res, 403, { error: 'forbidden: local-only' })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
      res.end(renderFleetPanel(baseUrl()))
    } },

    // ---- 公开:join —— 无 token 走「申请→批准」bootstrap;?token= 兼容旧 token 流程
    { kind: 'exact', path: '/join', handler: async (req, res) => {
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const token = url.searchParams.get('token') ?? ''
      const os = url.searchParams.get('os') ?? ''
      const accept = String(req.headers['accept'] ?? '')

      if (token) { // 兼容:token 流程
        const rec = findToken(store, token)
        if (!rec || rec.consumed || now() > rec.expiresAt) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('# 无效或过期的 token\n')
        }
        res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8' })
        return res.end(renderLinuxJoinScript({ baseUrl: baseUrl(), token }))
      }

      if (accept.includes('text/html')) { // 浏览器打开 → 极简说明页
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(joinPageHtml(baseUrl()))
      }

      if (os === 'win') { // Windows PowerShell bootstrap
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(renderWinBootstrap({ baseUrl: baseUrl() }))
      }

      // Linux / macOS 申请流程 bootstrap
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8' })
      res.end(renderNixBootstrap({ baseUrl: baseUrl() }))
    } },

    // ---- 公开:换证
    { kind: 'exact', path: '/api/fleet/enroll', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const body = await readJson(req)
      if (!body || typeof body.token !== 'string' || typeof body.tunnelPublicKey !== 'string' || typeof body.remoteUser !== 'string') {
        return writeJson(res, 400, { error: 'token, remoteUser, tunnelPublicKey required' })
      }
      const os = typeof body.os === 'string' ? body.os : 'linux'
      const result = await enrollMachine({ store, provisioner, sshStorePath },
        { token: body.token, alias: body.alias, os, remoteUser: body.remoteUser, tunnelPublicKey: body.tunnelPublicKey }, now())
      if (!result.ok) return writeJson(res, 403, { error: `enroll rejected: ${result.reason}` })
      writeJson(res, 200, result)
    } },

    // ---- 公开:上线回报
    { kind: 'exact', path: '/api/fleet/heartbeat', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const body = await readJson(req)
      if (!body || typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' })
      const hit = markOnline(store, body.id, now())
      writeJson(res, hit ? 200 : 404, { ok: hit })
    } },

    // ---- 公开:注册入网申请(无 token;排进待批准队列)
    { kind: 'exact', path: '/api/fleet/request', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const body = await readJson(req)
      if (!body || typeof body.name !== 'string' || typeof body.remoteUser !== 'string'
        || typeof body.tunnelPublicKey !== 'string' || typeof body.code !== 'string') {
        return writeJson(res, 400, { error: 'name, os, remoteUser, tunnelPublicKey, code required' })
      }
      const os = body.os === 'win' || body.os === 'mac' ? body.os : 'linux'
      const sourceIp = (req.socket && req.socket.remoteAddress) || 'unknown'
      const r = registerRequest(store, { name: body.name, os, remoteUser: body.remoteUser, tunnelPublicKey: body.tunnelPublicKey, code: body.code, sourceIp }, now())
      if (!r.ok) return writeJson(res, 429, { error: r.reason })
      writeJson(res, 200, { pollId: r.pollId, code: r.code, pollIntervalMs: 3000 })
    } },

    // ---- 公开:机器轮询自己的申请状态(凭 pollId)
    { kind: 'exact', path: '/api/fleet/request-status', handler: async (req, res) => {
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      writeJson(res, 200, getRequestStatus(store, url.searchParams.get('id') ?? '', now()))
    } },

    // ---- 特权:批准一条申请(reqId 仅面板持有,机器无法自我批准)
    { kind: 'exact', path: '/api/fleet/approve', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.reqId !== 'string') return writeJson(res, 400, { error: 'reqId required' })
      const result = await approveRequest({ store, provisioner, sshStorePath }, body.reqId,
        typeof body.alias === 'string' ? body.alias : undefined, now())
      if (!result.ok) return writeJson(res, result.reason === 'relay-not-configured' ? 400 : 409, { error: result.reason })
      writeJson(res, 200, { ok: true })
    } },

    // ---- 特权:拒绝一条申请
    { kind: 'exact', path: '/api/fleet/reject', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.reqId !== 'string') return writeJson(res, 400, { error: 'reqId required' })
      rejectRequest(store, body.reqId)
      writeJson(res, 200, { ok: true })
    } },
  ]
}
