/**
 * 把入网机器写成一条 dsh-ssh 主机条目(~/.dsh/dsh-ssh.json)。这是 dsh-fleet 与
 * dsh-ssh 的唯一耦合点:文件级。dsh-ssh 的 HostStore 每次操作都重读该文件,故新写
 * 的条目无需重启即被 agent 工具看到。原子写、0600(内含 keyPath,虽非密码也保守处理)。
 *
 * 条目形状必须匹配 dsh-ssh 的 schema:alias/host/port/user/auth{kind,keyPath}/
 * proxyJump[]/tags[]/createdAt/updatedAt。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FORMAT_VERSION = 1

/** dsh-ssh 主机表标准路径。 */
export function sshStorePath() {
  return join(homedir(), '.dsh', 'dsh-ssh.json')
}

function load(path) {
  if (!existsSync(path)) return { version: FORMAT_VERSION, hosts: [] }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.hosts)) {
    throw new Error('dsh-ssh.json shape invalid')
  }
  return parsed
}

function save(path, file) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * upsert 一条 fleet 主机条目(按 alias)。保留同 alias 的 createdAt。
 * @param {string} path dsh-ssh.json 路径
 * @param {object} entry 见文件头形状(不含时间戳)
 * @param {number} now 毫秒
 */
export function upsertFleetHost(path, entry, now) {
  const abs = resolve(path)
  const file = load(abs)
  const existing = file.hosts.find(h => h.alias === entry.alias)
  const record = {
    alias: entry.alias,
    host: entry.host,
    port: entry.port,
    user: entry.user,
    auth: { kind: 'key', keyPath: entry.auth.keyPath },
    proxyJump: [...(entry.proxyJump ?? [])],
    tags: [...(entry.tags ?? [])],
    description: entry.description,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  }
  file.hosts = file.hosts.filter(h => h.alias !== entry.alias)
  file.hosts.push(record)
  save(abs, file)
}

/** 删除一条 fleet 主机条目(幂等)。 */
export function removeFleetHost(path, alias) {
  const abs = resolve(path)
  if (!existsSync(abs)) return
  const file = load(abs)
  file.hosts = file.hosts.filter(h => h.alias !== alias)
  save(abs, file)
}
