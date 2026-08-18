/**
 * 真 Provisioner:
 *   generateOpKeypair —— 在 hub 本地 ssh-keygen 生成操作密钥对,私钥存
 *     ~/.dsh/fleet/keys/<alias>.op,回传公钥文本 + 私钥路径。
 *   pushTunnelKey —— ssh 到中继,用 hub 现有账号(ProxyJump 同一账号),把机器隧道公钥
 *     以 restrict,permitlisten="127.0.0.1:<port>" 前缀追加进 tunnel 账号 authorized_keys。
 *   removeTunnelKey —— 删掉带该端口 permitlisten 标记的行。
 *
 * 说明:pushTunnelKey/removeTunnelKey 依赖 hub 能免密 ssh 到中继(现状已具备)。中继登录
 * 目标由 relay() 提供:relay.jumpLogin(如 'ubuntu@1.2.3.4');未配则回退 root@<host>。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class SshProvisioner {
  /**
   * @param {()=>object} relay 返回 relay 配置(host/port/tunnelUser/jumpLogin/portRange)
   * @param {string} [keyDir] 覆盖密钥目录(测试)
   */
  constructor(relay, keyDir) {
    this.relay = relay
    this.keyDir = keyDir ?? join(homedir(), '.dsh', 'fleet', 'keys')
  }

  async generateOpKeypair(hostAlias) {
    if (!existsSync(this.keyDir)) mkdirSync(this.keyDir, { recursive: true, mode: 0o700 })
    const opPrivKeyPath = join(this.keyDir, `${hostAlias}.op`)
    if (!existsSync(opPrivKeyPath)) {
      await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', opPrivKeyPath, '-C', `dsh-fleet-op:${hostAlias}`])
    }
    const operationPublicKey = readFileSync(opPrivKeyPath + '.pub', 'utf8').trim()
    return { operationPublicKey, opPrivKeyPath }
  }

  /** 中继登录串与端口。 */
  _jump() {
    const r = this.relay() || {}
    return { login: r.jumpLogin || `root@${r.host}`, port: r.port ?? 22 }
  }

  /**
   * 经中继上的 root 助手(relay-init.sh 装的 /usr/local/sbin/dsh-fleet-authkeys,
   * 窄 NOPASSWD)增加一台机器的隧道授权键。助手内部强制 restrict,permitlisten 前缀,
   * 并校验端口区间与 key 字符,故非交互、且注入不了 authorized_keys 选项。
   */
  async pushTunnelKey(pubkey, port) {
    const { login, port: p } = this._jump()
    const parts = String(pubkey).trim().split(/\s+/)
    const keytype = parts[0] ?? ''
    const keybody = parts[1] ?? ''
    const comment = `dsh-fleet-${port}`
    const remote = `sudo /usr/local/sbin/dsh-fleet-authkeys add ${port} ${shq(keytype)} ${shq(keybody)} ${shq(comment)}`
    await run('ssh', ['-p', String(p), '-o', 'StrictHostKeyChecking=accept-new', login, remote])
  }

  async removeTunnelKey(port) {
    const { login, port: p } = this._jump()
    const remote = `sudo /usr/local/sbin/dsh-fleet-authkeys remove ${port}`
    await run('ssh', ['-p', String(p), '-o', 'StrictHostKeyChecking=accept-new', login, remote])
  }
}

/** 单引号安全包裹(shell)。 */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }
