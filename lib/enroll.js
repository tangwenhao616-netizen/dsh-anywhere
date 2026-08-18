/**
 * enroll 编排:把 token 校验、端口分配、密钥、推中继、写 dsh-ssh、记档案串起来。
 * 纯函数 + 依赖注入(store / provisioner / sshStorePath),便于测试。
 *
 * 顺序(任一步失败即返回错误,不留半条记录):
 *   0) 中继未配置则拒(不消耗 token)
 *   1) 一次性消耗 token(失败→reason)
 *   2) 分配环回端口(避开已在册 machines 的端口)
 *   3) 在 hub 生成操作密钥对(私钥留 hub)
 *   4) 把机器上报的隧道公钥推到中继(带 permitlisten 锁端口)
 *   5) 写 dsh-ssh 主机条目(agent 立即可用)
 *   6) 记 machine 档案(status=enrolling,待 heartbeat 置 online)
 */
import { randomBytes } from 'node:crypto'
import { consumeToken } from './token.js'
import { allocatePort } from './ports.js'
import { upsertFleetHost } from './ssh-host-writer.js'

/**
 * enroll 核心(不含 token 消耗):中继守卫 + 端口分配 + 操作密钥 + 推中继 +
 * 写 dsh-ssh 主机条目 + 记档案。token 流程(enrollMachine)与 approve 流程共用它。
 * @param {{store, provisioner, sshStorePath:string}} deps
 * @param {{alias:string, os:string, remoteUser:string, tunnelPublicKey:string}} req
 * @param {number} now 毫秒
 * @returns {{ok:true, id, relayHost, relayPort, relayUser, port, operationPublicKey, keepalive}} | {{ok:false, reason}}
 */
export async function enrollCore(deps, req, now) {
  const { store, provisioner, sshStorePath } = deps

  if (!store.load().relay?.host) return { ok: false, reason: 'relay-not-configured' }
  const alias = req.alias
  const hostAlias = `fleet-${alias}`

  const file = store.load()
  const port = allocatePort(file.machines.map(m => m.port), file.relay.portRange)
  const relay = file.relay

  const { operationPublicKey, opPrivKeyPath } = await provisioner.generateOpKeypair(hostAlias)

  // 传输层:frpToken 已配 → 首选 frp(frpc 认 frps,自带重连);否则反向 ssh -R。
  // 隧道公钥**无论哪种模式都推**到中继(permitlisten 锁端口):机器网络若封 frps 端口
  // (真机踩过:有的网络只放行 22),bootstrap 端口预检会自动回退 ssh -R——授权行是
  // 回退的前提,多推无害(仅允许该机器 listen 自己的端口)。
  const useFrp = !!relay.frpToken
  await provisioner.pushTunnelKey(req.tunnelPublicKey, port)

  upsertFleetHost(sshStorePath, {
    alias: hostAlias, host: '127.0.0.1', port, user: req.remoteUser,
    auth: { kind: 'key', keyPath: opPrivKeyPath },
    proxyJump: [relay.jumpAlias], tags: ['fleet'],
    description: '公网入网机器(dsh-fleet)',
  }, now)

  const id = randomBytes(8).toString('hex')
  store.update(f => {
    f.machines = f.machines.filter(m => m.alias !== alias)
    f.machines.push({
      id, alias, os: req.os, remoteUser: req.remoteUser, port,
      tunnelKeyComment: `dsh-fleet:${alias}`, opPrivKeyPath, hostAlias,
      transport: useFrp ? 'frp' : 'ssh-r',
      status: 'enrolling', enrolledAt: now, lastSeen: 0,
    })
  })

  return {
    ok: true, id,
    relayHost: relay.host, relayPort: relay.port, relayUser: relay.tunnelUser,
    port, operationPublicKey,
    keepalive: { serverAliveInterval: 30, serverAliveCountMax: 3 },
    // frp 模式:机器端 bootstrap 见 frpToken 即走 frpc(否则反向 ssh -R)。
    // frpServerAddr 复用 relayHost;remotePort 复用 port,故不再重复。
    ...(useFrp ? { frpToken: relay.frpToken, frpServerPort: relay.frpPort || 443, frpProtocol: relay.frpProtocol || 'tcp' } : {}),
  }
}

/**
 * token 流程:中继守卫 → 一次性消耗 token → enrollCore。
 * @param {{store, provisioner, sshStorePath:string}} deps
 * @param {{token:string, alias?:string, os:string, remoteUser:string, tunnelPublicKey:string}} req
 * @param {number} now 毫秒
 */
export async function enrollMachine(deps, req, now) {
  const { store } = deps
  // 中继未配置则直接拒(在消耗 token 之前,避免误配烧掉一次性 token)
  if (!store.load().relay?.host) return { ok: false, reason: 'relay-not-configured' }
  const consumed = consumeToken(store, req.token, now)
  if (!consumed.ok) return { ok: false, reason: consumed.reason }
  const alias = (req.alias && req.alias.trim()) || consumed.record.alias
  return enrollCore(deps, { alias, os: req.os, remoteUser: req.remoteUser, tunnelPublicKey: req.tunnelPublicKey }, now)
}

/**
 * heartbeat:机器上线回报,置 online + lastSeen。
 * @returns {boolean} 是否命中一台在册机器
 */
export function markOnline(store, id, now) {
  return store.update(f => {
    const m = f.machines.find(x => x.id === id)
    if (!m) return false
    m.status = 'online'; m.lastSeen = now
    return true
  })
}
