/**
 * dsh-fleet 状态存储:一个 JSON 文件 ~/.dsh/dsh-fleet.json,原子写(tmp+rename),
 * 0600。存 relay 配置、pending tokens、machines。纯文件 I/O,无 cordis 依赖,可单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FORMAT_VERSION = 1

/** 中继默认结构。host 留空:社区插件不硬编码任何 IP,由 POST /api/fleet/relay 设置。 */
export const DEFAULT_RELAY = {
  host: '', port: 22, tunnelUser: 'tunnel',
  jumpAlias: 'relay-jump', jumpLogin: '', portRange: [20001, 20999],
}

/** 标准存储路径 <home>/.dsh/dsh-fleet.json。 */
export function storePath() {
  return join(homedir(), '.dsh', 'dsh-fleet.json')
}

/** 空文件默认结构。 */
function emptyFile() {
  return { version: FORMAT_VERSION, relay: { ...DEFAULT_RELAY }, tokens: [], machines: [] }
}

export class FleetStore {
  /** @param {string} [path] 覆盖路径(测试)。 */
  constructor(path) {
    this.path = resolve(path ?? storePath())
  }

  /** 读全量(文件缺失→默认)。 */
  load() {
    if (!existsSync(this.path)) return emptyFile()
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.machines) || !Array.isArray(parsed.tokens)) {
        throw new Error('shape invalid')
      }
      if (!parsed.relay) parsed.relay = { ...DEFAULT_RELAY }
      if (!parsed.relay.portRange) parsed.relay.portRange = [...DEFAULT_RELAY.portRange]
      return parsed
    } catch {
      try { renameSync(this.path, `${this.path}.corrupt-${process.pid}-${process.hrtime.bigint()}`) } catch { /* best effort */ }
      return emptyFile()
    }
  }

  /** 原子写。 */
  save(file) {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  /** load→mutate→save 的便捷封装,回传 mutate 的返回值。 */
  update(mutate) {
    const file = this.load()
    const result = mutate(file)
    this.save(file)
    return result
  }
}
