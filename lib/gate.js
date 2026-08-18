/**
 * dsh-fleet 路由栅栏。关键:经 cloudflare 域名来的请求,socket 是 127.0.0.1(cloudflared
 * 转发)但 Host 头是公网域名——所以不能用 dsh-ssh 那种"Host 必须是 loopback"的判定,
 * 否则域名流量全被拒。这里改为:
 *   - fromTunnelOrLocal:只要 socket 是 loopback(cloudflared 或本机),放行;直连 LAN IP
 *     打 0.0.0.0:3080 的 socket 非 loopback,拒。真正的鉴权由 token(enroll)或同源(UI)负责。
 *   - sameOriginBrowser:防 CSRF——浏览器跨站标记或 Origin 与 Host 不符则拒;curl 无 Origin 放行。
 */
import { timingSafeEqual } from 'node:crypto'
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

/** 从请求取管理员令牌:`X-Fleet-Token` 头,或 `?key=` 查询参数(供浏览器链接直接带)。 */
export function tokenOf(request) {
  const h = request.headers['x-fleet-token']
  if (typeof h === 'string' && h) return h
  try { return new URL(request.url ?? '/', 'http://localhost').searchParams.get('key') || '' } catch { return '' }
}

/** 常量时间比较两个令牌串(长度不等/空直接 false)。 */
function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false }
}

/**
 * 工作区启动器/异地管理用栅栏:本机放行,或经隧道(cloudflared)但**带正确管理员令牌**放行;
 * 非隧道非本机(直连 LAN IP)一律拒;浏览器跨站(CSRF)拒。别人猜到 URL 无令牌也进不来。
 * @param {import('node:http').IncomingMessage} request
 * @param {string} expectedToken 管理员令牌(未设置时=''→隧道侧一律拒,只剩本机可用)
 */
export function requireLocalOrToken(request, expectedToken) {
  if (!sameOriginBrowser(request)) return false
  if (isLocalRequest(request)) return true
  if (!fromTunnelOrLocal(request)) return false
  return tokenEq(tokenOf(request), expectedToken)
}
