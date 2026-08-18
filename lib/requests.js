/**
 * 入网申请状态机(申请→批准)。纯逻辑,store + enrollCore 注入。
 *
 * 安全要点:每条申请有两个 id——
 *   - pollId:高熵秘密,注册时**只**回给机器,机器凭它轮询状态/取批准结果。
 *   - reqId :批准用 id,**只**在特权列表里给机主(面板),机器拿不到。
 * 机器拿不到 reqId,故无法调 /approve 自我批准——批准关卡只有机主能过。
 * 配对码 code 是人可读短码,机器打印 + 随申请上报,机主肉眼核对防冒名。
 */
import { randomBytes } from 'node:crypto'
import { enrollCore } from './enroll.js'

const DEFAULT_TTL = 10 * 60 * 1000
const RATE_WINDOW = 60_000
const RATE_MAX = 10

/**
 * 注册一条入网申请。
 * @param store fleet store
 * @param {{name, os, remoteUser, tunnelPublicKey, code, sourceIp}} req
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {{ok:true, pollId, code}} | {{ok:false, reason:'rate-limited'}}
 */
export function registerRequest(store, req, now, ttlMs = DEFAULT_TTL) {
  return store.update(f => {
    if (!f.requests) f.requests = []
    const recent = f.requests.filter(r => r.sourceIp === req.sourceIp && now - r.createdAt < RATE_WINDOW)
    if (recent.length >= RATE_MAX) return { ok: false, reason: 'rate-limited' }
    // 同名 pending 去重(重跑替换)
    f.requests = f.requests.filter(r => !(r.name === req.name && r.status === 'pending'))
    const rec = {
      reqId: randomBytes(9).toString('hex'),
      pollId: randomBytes(32).toString('hex'),
      code: req.code, name: req.name, os: req.os, remoteUser: req.remoteUser,
      tunnelPublicKey: req.tunnelPublicKey, sourceIp: req.sourceIp,
      status: 'pending', createdAt: now, expiresAt: now + ttlMs, result: null, alias: null,
    }
    f.requests.push(rec)
    return { ok: true, pollId: rec.pollId, code: rec.code }
  })
}

/**
 * 机器轮询自己的申请状态(凭 pollId)。
 * @returns {{status:'pending'|'approved'|'rejected'|'unknown'|'expired', result?}}
 */
export function getRequestStatus(store, pollId, now) {
  const r = (store.load().requests || []).find(x => x.pollId === pollId)
  if (!r) return { status: 'unknown' }
  if (r.status === 'pending' && now > r.expiresAt) return { status: 'expired' }
  if (r.status === 'approved') return { status: 'approved', result: r.result }
  return { status: r.status }
}

/** 待批准列表(给面板;含 reqId+code,不含 pollId/隧道公钥)。 */
export function listRequests(store, now) {
  return (store.load().requests || [])
    .filter(r => r.status === 'pending' && now <= r.expiresAt)
    .map(r => ({ reqId: r.reqId, name: r.name, os: r.os, sourceIp: r.sourceIp, code: r.code, createdAt: r.createdAt }))
}

/**
 * 批准一条申请(凭 reqId):校验 pending+未过期 → enrollCore → 回填 result。
 * @param {{store, provisioner, sshStorePath}} deps
 * @returns {{ok:true, result}} | {{ok:false, reason}}
 */
export async function approveRequest(deps, reqId, aliasOverride, now) {
  const { store } = deps
  const r = (store.load().requests || []).find(x => x.reqId === reqId)
  if (!r) return { ok: false, reason: 'unknown' }
  if (r.status !== 'pending') return { ok: false, reason: 'not-pending' }
  if (now > r.expiresAt) return { ok: false, reason: 'expired' }
  const alias = (aliasOverride && aliasOverride.trim()) || r.name
  const result = await enrollCore(deps, { alias, os: r.os, remoteUser: r.remoteUser, tunnelPublicKey: r.tunnelPublicKey }, now)
  if (!result.ok) return result
  store.update(f => {
    const rr = (f.requests || []).find(x => x.reqId === reqId)
    if (rr) { rr.status = 'approved'; rr.result = result; rr.alias = alias }
  })
  return { ok: true, result }
}

/** 拒绝一条申请(删除)。 */
export function rejectRequest(store, reqId) {
  store.update(f => { f.requests = (f.requests || []).filter(r => r.reqId !== reqId) })
}

/** 清理过期 pending 与陈旧 approved(approved 保留一个 TTL 供机器取走结果)。 */
export function sweepRequests(store, now) {
  store.update(f => {
    f.requests = (f.requests || []).filter(r =>
      (r.status === 'pending' && now <= r.expiresAt)
      || (r.status === 'approved' && now - r.createdAt < DEFAULT_TTL))
  })
}
