/**
 * fs-ssh —— dsh `ctx.fs`（FileSystem）的 SSH provider。`SshFileSystem extends FileSystem`
 * （@deepseek-ai/dsh-fs，声明为 peerDependency，由 dsh 运行时提供),薄委托到 SshFsCore,
 * 给 targetKey/version 打 brand、核心错误转 FsError。
 * config: { conn?, login?, sshArgs?, cwd? } —— 传入共享 conn(与 subprocess-ssh 同一条
 * ControlMaster 连接),或用 login/sshArgs 自建。
 */
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { SshFsCore } from './ssh-fs-core.js'
import { SshFsCoreWin } from './ssh-fs-core-win.js'

async function wrapErr(fn) {
  try { return await fn() }
  catch (e) { if (e instanceof FsError) throw e; throw new FsError(e?.message ?? 'fs error', e?.code ?? 'FS_IO_ERROR', { cause: e }) }
}
const brand = t => ({ targetKey: FsTargetKey(String(t.targetKey)), displayPath: t.displayPath })

export default class SshFileSystem extends FileSystem {
  constructor(ctx, config = {}) {
    super(ctx)
    const Core = config.platform === 'windows' ? SshFsCoreWin : SshFsCore
    this.core = new Core({ conn: config.conn, login: config.login, sshArgs: config.sshArgs, cwd: config.cwd ?? (config.platform === 'windows' ? 'C:\\' : '/') })
  }
  async resolve(path, opts) { return brand(await wrapErr(() => this.core.resolve(path, opts))) }
  processPath(target) { return this.core.processPath(target) }
  fileUrl(target) { return this.core.fileUrl(target) }
  contains(parent, child) { return this.core.contains(parent, child) }
  async stat(target, signal) { const i = await wrapErr(() => this.core.stat(target, signal)); return i && { version: FsVersion(i.version), type: i.type, size: i.size } }
  async lstat(path, opts, signal) { const i = await wrapErr(() => this.core.lstat(path, opts, signal)); return i && { version: FsVersion(i.version), type: i.type, size: i.size } }
  async readText(target, signal) { return wrapErr(() => this.core.readText(target, signal)) }
  async streamText(target, signal) { return wrapErr(() => this.core.streamText(target, signal)) }
  async readBytes(target, signal, maxBytes) { return wrapErr(() => this.core.readBytes(target, signal, maxBytes)) }
  async listDir(target, signal) { const es = await wrapErr(() => this.core.listDir(target, signal)); return es.map(e => ({ name: e.name, type: e.type, target: brand(e.target), size: e.size, version: e.version ? FsVersion(e.version) : undefined })) }
  async writeText(target, content, expected, signal) { const o = await wrapErr(() => this.core.writeText(target, content, expected, signal)); return { operation: o.operation, version: FsVersion(o.version), before: o.before, after: o.after } }
  async editText(target, edit, expected, signal) { const o = await wrapErr(() => this.core.editText(target, edit, expected, signal)); return { version: FsVersion(o.version), before: o.before, after: o.after } }
}
