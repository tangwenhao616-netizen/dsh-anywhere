/**
 * dsh-fleet 路由栅栏。关键:经 cloudflare 域名来的请求,socket 是 127.0.0.1(cloudflared
 * 转发)但 Host 头是公网域名——所以不能用 dsh-ssh 那种"Host 必须是 loopback"的判定,
 * 否则域名流量全被拒。这里改为:
 *   - fromTunnelOrLocal:只要 socket 是 loopback(cloudflared 或本机),放行;直连 LAN IP
 *     打 0.0.0.0:3080 的 socket 非 loopback,拒。真正的鉴权由 token(enroll)或同源(UI)负责。
 *   - sameOriginBrowser:防 CSRF——浏览器跨站标记或 Origin 与 Host 不符则拒;curl 无 Origin 放行。
 */
import { isLoopbackAddress, isLoopbackHostname } from './loopback.js'

/** socket 是否来自隧道(cloudflared)或本机 loopback。机器面(申请/join/换证)用它,允许经公网域名。 */
export function fromTunnelOrLocal(request) {
  const socket = request.socket
  return isLoopbackAddress(socket && socket.remoteAddress)
}

/**
 * 本机访问:socket 是 loopback 且 Host 头是 loopback 主机名(localhost / 127.x)。
 * 经 cloudflare 域名来的请求 socket 虽也是 loopback(cloudflared 转发),但 Host 头是
 * 公网域名 → 判为「非本机」。管理/批准面用它,把特权动作锁死在本机,公网域名进不来。
 */
export function isLocalRequest(request) {
  const socket = request.socket
  if (!isLoopbackAddress(socket && socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try { return isLoopbackHostname(new URL('http://' + host).hostname) } catch { return false }
}

/** 浏览器同源校验(CSRF 防护);非浏览器无 Origin 时放行。 */
export function sameOriginBrowser(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === new URL('http://' + host).host
  } catch {
    return false
  }
}
