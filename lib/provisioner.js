/**
 * Provisioner 封装 enroll 的两类副作用:
 *   generateOpKeypair(hostAlias) -> { operationPublicKey, opPrivKeyPath }
 *     在 hub 上生成"操作"密钥对(hub→机器),私钥留 hub,回传公钥文本 + 私钥路径。
 *   pushTunnelKey(tunnelPublicKey, port) -> void
 *     把机器上报的"隧道"公钥推到中继 tunnel 账号 authorized_keys,前缀锁死
 *     restrict,permitlisten="127.0.0.1:<port>"。
 *   removeTunnelKey(port) -> void  吊销时从中继删掉该端口对应的授权行。
 *
 * 真实现见 provisioner-ssh.js。这里的 Fake 供纯逻辑测试。
 */

/** 测试用内存实现,记录调用。 */
export class FakeProvisioner {
  constructor() { this.pushed = []; this.removed = []; this.forgotten = [] }
  async generateOpKeypair(hostAlias) {
    return { operationPublicKey: `ssh-ed25519 AAAAop ${hostAlias}`, opPrivKeyPath: `/tmp/keys/${hostAlias}.op` }
  }
  async pushTunnelKey(pubkey, port) { this.pushed.push({ pubkey, port }) }
  async removeTunnelKey(port) { this.removed.push(port) }
  async forgetHostKey(port) { this.forgotten.push(port) }
}
