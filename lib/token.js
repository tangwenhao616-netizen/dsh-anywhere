/**
 * 一次性入网 token:高熵、可过期、一次性消耗、可吊销。纯逻辑,store 由调用方注入
 * (需 load()/save()/update())。时间以毫秒注入(now),便于测试。
 */
import { randomBytes } from 'node:crypto'

/** 生成一个 32 字节 hex(64 位十六进制)token 串。 */
function newTokenString() {
  return randomBytes(32).toString('hex')
}

/**
 * 铸造 token 并入库。
 * @param store fleet store
 * @param {{alias:string, os:string, ttlMs:number}} opts
 * @param {number} now 当前毫秒
 */
export function mintToken(store, opts, now) {
  const rec = {
    token: newTokenString(),
    alias: opts.alias, os: opts.os,
    createdAt: now, expiresAt: now + opts.ttlMs, consumed: false,
  }
  store.update(f => { f.tokens.push(rec) })
  return rec
}

/** 查一个 token 记录(不校验)。 */
export function findToken(store, token) {
  return store.load().tokens.find(t => t.token === token)
}

/**
 * 一次性消耗:成功时原子标记 consumed。
 * @returns {{ok:true, record}} | {{ok:false, reason:'unknown'|'expired'|'consumed'}}
 */
export function consumeToken(store, token, now) {
  return store.update(f => {
    const rec = f.tokens.find(t => t.token === token)
    if (!rec) return { ok: false, reason: 'unknown' }
    if (rec.consumed) return { ok: false, reason: 'consumed' }
    if (now > rec.expiresAt) return { ok: false, reason: 'expired' }
    rec.consumed = true
    rec.consumedAt = now
    return { ok: true, record: { ...rec } }
  })
}

/** 列出仍然有效(未消耗、未过期)的 token。 */
export function listTokens(store, now) {
  return store.load().tokens.filter(t => !t.consumed && now <= t.expiresAt)
}

/** 删除一个 token(按台撤回未用的邀请)。 */
export function revokeToken(store, token) {
  store.update(f => { f.tokens = f.tokens.filter(t => t.token !== token) })
}
