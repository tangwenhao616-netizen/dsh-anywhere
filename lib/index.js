/**
 * fs-ssh POC —— 把 SshFsCore 包成 dsh 的 `ctx.fs` provider。
 * `SshFileSystem extends FileSystem`(@deepseek-ai/dsh-fs),薄委托到 SshFsCore,
 * 并给 targetKey/version 打 brand、把核心错误转成 FsError。默认导出 Service 类
 * (service 包约定:default-export service class);loader 用 (ctx, config) 实例化,
 * 构造即注册 ctx.fs。config: { login, sshArgs, cwd }。
 *
 * 挂载:在一个 POC profile 里禁掉 base bundle 的 fs-sandbox、insert 本插件
 * (见 cordis.patch.yml),ctx.fs 即由本 provider 承接,agent 的 read/write/edit 工具
 * 透明地作用在远程机器的文件上。
 */
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { SshFsCore } from './ssh-fs-core.js'

async function wrapErr(fn) {
  try { return await fn() }
  catch (e) { if (e instanceof FsError) throw e; throw new FsError(e?.message ?? 'fs error', e?.code ?? 'FS_IO_ERROR', { cause: e }) }
}
const brandTarget = t => ({ targetKey: FsTargetKey(String(t.targetKey)), displayPath: t.displayPath })

export default class SshFileSystem extends FileSystem {
  constructor(ctx, config = {}) {
    super(ctx)
    this.core = new SshFsCore({ login: config.login, sshArgs: config.sshArgs ?? [], cwd: config.cwd ?? '/' })
  }

  async resolve(path, opts) { return brandTarget(await wrapErr(() => this.core.resolve(path, opts))) }
  processPath(target) { return this.core.processPath(target) }
  fileUrl(target) { return this.core.fileUrl(target) }
  contains(parent, child) { return this.core.contains(parent, child) }

  async stat(target, signal) {
    const i = await wrapErr(() => this.core.stat(target, signal))
    return i && { version: FsVersion(i.version), type: i.type, size: i.size }
  }
  async lstat(path, opts, signal) {
    const i = await wrapErr(() => this.core.lstat(path, opts, signal))
    return i && { version: FsVersion(i.version), type: i.type, size: i.size }
  }
  async readText(target, signal) { return wrapErr(() => this.core.readText(target, signal)) }
  async streamText(target, signal) { return wrapErr(() => this.core.streamText(target, signal)) }
  async readBytes(target, signal, maxBytes) { return wrapErr(() => this.core.readBytes(target, signal, maxBytes)) }

  async listDir(target, signal) {
    const es = await wrapErr(() => this.core.listDir(target, signal))
    return es.map(e => ({ name: e.name, type: e.type, target: brandTarget(e.target), size: e.size, version: e.version ? FsVersion(e.version) : undefined }))
  }
  async writeText(target, content, expected, signal) {
    const o = await wrapErr(() => this.core.writeText(target, content, expected, signal))
    return { operation: o.operation, version: FsVersion(o.version), before: o.before, after: o.after }
  }
  async editText(target, edit, expected, signal) {
    const o = await wrapErr(() => this.core.editText(target, edit, expected, signal))
    return { version: FsVersion(o.version), before: o.before, after: o.after }
  }
}
