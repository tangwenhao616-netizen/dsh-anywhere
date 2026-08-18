/** RFC5735 127/8、::1、IPv4-mapped ::ffff:127/8 的 loopback 判定(从 dsh-ssh 复制)。 */

/** IPv4 127/8。 */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** socket remoteAddress 是否 loopback。 */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const n = address.toLowerCase()
  if (n === '::1') return true
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice('::ffff:'.length))
  return isIPv4Loopback(n)
}

/** hostname 是否 loopback(localhost / [::1] / 127/8)。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}
