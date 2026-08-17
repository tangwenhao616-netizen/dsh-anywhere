/**
 * SshFsCore —— dsh FileSystem 契约的 SSH 实现核心(无 cordis 依赖,可独立测)。
 * 每个 fs 操作 = 一次系统 `ssh` 命令往返;路径与写入内容全部 base64 进远程脚本,
 * 避免任何 shell 引号/注入问题。POC 目标:证明"通过 SSH 在一台远程机器上读/写/改文件"。
 *
 * 返回值遵循 @deepseek-ai/dsh-fs 的词汇(FsTarget/FsInfo/FsDirEntry/FsWriteOutcome/
 * FsEditOutcome);targetKey/version 在这里是普通字符串,Service 包装层再打 brand。
 * 错误用 `Object.assign(new Error(msg), { code: 'FS_*' })`,包装层转成 FsError。
 */
import { spawn } from 'node:child_process'
import { posix } from 'node:path'

/** base64 一个字符串(路径/内容注入远程脚本用)。 */
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
/** 造一个带 FS_* code 的错误。 */
const fsErr = (msg, code) => Object.assign(new Error(msg), { code })

export class SshFsCore {
  /**
   * @param {{login:string, sshArgs:string[], cwd?:string}} config
   *   login: 'user@host';sshArgs: 传给 ssh 的参数(-i key / ProxyJump / -o…);cwd: 相对路径基准。
   */
  constructor(config) {
    this.login = config.login
    this.sshArgs = config.sshArgs ?? []
    this.cwd = config.cwd ?? '/'
  }

  /** 在远程跑一段 bash 脚本;返回 {code, stdout:Buffer, stderr:string}。脚本作为单个 arg 传给 ssh。 */
  _ssh(script, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.sshArgs, this.login, script], { stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []; let err = ''
      child.stdout.on('data', d => out.push(d))
      child.stderr.on('data', d => { err += d.toString('utf8') })
      const onAbort = () => { child.kill('SIGKILL'); reject(fsErr('aborted', 'FS_ABORTED')) }
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }) }
      child.on('error', e => reject(fsErr(`ssh spawn failed: ${e.message}`, 'FS_IO_ERROR')))
      child.on('close', code => { if (signal) signal.removeEventListener('abort', onAbort); resolve({ code, stdout: Buffer.concat(out), stderr: err }) })
    })
  }

  /** 把 model/plugin 传的 path 规范成远程 canonical 路径(相对→接 cwd;远程 realpath -m 解析符号链接/..)。 */
  async resolve(path, opts = {}) {
    const base = opts.cwd ?? this.cwd
    const joined = path.startsWith('/') ? path : posix.join(base, path)
    const script = `p=$(printf %s '${b64(joined)}' | base64 -d); realpath -m -- "$p" 2>/dev/null || printf %s "$p"`
    const r = await this._ssh(script, opts.signal)
    const canonical = r.stdout.toString('utf8').trim() || joined
    return { targetKey: canonical, displayPath: canonical }
  }

  processPath(target) { return String(target.targetKey) }
  fileUrl(target) { return 'file://' + encodeURI(String(target.targetKey)) }
  contains(parent, child) {
    const p = String(parent.targetKey), c = String(child.targetKey)
    return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
  }

  /** 远程探测一个路径的类型/大小/版本。mode='stat'(跟随符号链接) | 'lstat'(不跟随最后一段)。 */
  async _probe(path, mode, signal) {
    const script =
      `p=$(printf %s '${b64(path)}' | base64 -d); ` +
      `if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo __ABSENT__; exit 0; fi; ` +
      (mode === 'lstat'
        ? `if [ -L "$p" ]; then t=symlink; elif [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi; `
        : `if [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi; `) +
      `sz=$(stat -c %s -- "$p" 2>/dev/null || echo 0); ver=$(stat -c '%Y:%s:%i' -- "$p" 2>/dev/null || echo '0:0:0'); ` +
      `printf '%s\\n%s\\n%s\\n' "$t" "$sz" "$ver"`
    const r = await this._ssh(script, signal)
    const text = r.stdout.toString('utf8')
    if (text.trim() === '__ABSENT__') return undefined
    const [type, size, version] = text.split('\n')
    return { type, size: Number(size) || 0, version }
  }

  async stat(target, signal) {
    const p = await this._probe(String(target.targetKey), 'stat', signal)
    if (!p) return undefined
    return { version: p.version, type: p.type, size: p.size }
  }

  async lstat(path, opts = {}, signal) {
    const base = opts.cwd ?? this.cwd
    const joined = path.startsWith('/') ? path : posix.join(base, path)
    const p = await this._probe(joined, 'lstat', signal)
    if (!p) return undefined
    return { version: p.version, type: p.type, size: p.size }
  }

  /** 读全文;拒二进制(前 8KB 含 NUL)与非 UTF-8。 */
  async readText(target, signal) {
    const p = String(target.targetKey)
    const r = await this._ssh(`p=$(printf %s '${b64(p)}' | base64 -d); cat -- "$p"`, signal)
    if (r.code !== 0) throw fsErr(`cannot read "${p}": ${r.stderr.trim() || 'not found'}`, /No such file/.test(r.stderr) ? 'FS_NOT_FOUND' : 'FS_IO_ERROR')
    const bytes = r.stdout
    if (bytes.subarray(0, 8192).includes(0)) throw fsErr(`cannot read "${p}": binary file`, 'FS_NOT_TEXT')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw fsErr(`cannot read "${p}": invalid UTF-8`, 'FS_NOT_TEXT') }
  }

  async streamText(target, signal) {
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  async readBytes(target, signal, maxBytes) {
    const p = String(target.targetKey)
    const r = await this._ssh(`p=$(printf %s '${b64(p)}' | base64 -d); head -c ${maxBytes + 1} -- "$p" | base64`, signal)
    if (r.code !== 0) throw fsErr(`cannot read "${p}"`, 'FS_NOT_FOUND')
    const bytes = Buffer.from(r.stdout.toString('utf8'), 'base64')
    if (bytes.length > maxBytes) throw fsErr(`"${p}" exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    return new Uint8Array(bytes)
  }

  /** 列目录直接子项(一个远程命令输出 name<TAB>type<TAB>size<TAB>version)。 */
  async listDir(target, signal) {
    const d = String(target.targetKey)
    const script =
      `d=$(printf %s '${b64(d)}' | base64 -d); cd -- "$d" 2>/dev/null || { echo __NOTDIR__; exit 0; }; ` +
      `for n in * .*; do [ "$n" = . ] && continue; [ "$n" = .. ] && continue; [ -e "$n" ] || [ -L "$n" ] || continue; ` +
      `if [ -d "$n" ]; then t=directory; elif [ -f "$n" ]; then t=file; else t=other; fi; ` +
      `sz=$(stat -c %s -- "$n" 2>/dev/null || echo 0); ver=$(stat -c '%Y:%s:%i' -- "$n" 2>/dev/null || echo '0:0:0'); ` +
      `printf '%s\\t%s\\t%s\\t%s\\n' "$n" "$t" "$sz" "$ver"; done`
    const r = await this._ssh(script, signal)
    const text = r.stdout.toString('utf8')
    if (text.trim() === '__NOTDIR__') throw fsErr(`not a directory: "${d}"`, 'FS_NOT_DIRECTORY')
    const entries = []
    for (const line of text.split('\n')) {
      if (!line) continue
      const [name, type, size, version] = line.split('\t')
      if (name === undefined) continue
      const childPath = posix.join(d, name)
      entries.push({ name, type, target: { targetKey: childPath, displayPath: childPath }, size: Number(size) || 0, version })
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return entries
  }

  /** 原子写(base64 内容 → 远程 tmp → mv);带 createIfAbsent / replaceIfVersion 守卫。 */
  async writeText(target, content, expected, signal) {
    const p = String(target.targetKey)
    const cur = await this._probe(p, 'stat', signal)
    if (expected?.kind === 'createIfAbsent' && cur) throw fsErr(`"${p}" already exists`, 'FS_NOT_OBSERVED')
    if (expected?.kind === 'replaceIfVersion' && (!cur || cur.version !== expected.version)) {
      throw fsErr(`"${p}" changed since read`, 'FS_STALE_VERSION')
    }
    let before = null
    if (cur && cur.type === 'file') { try { before = normalizeLf(await this.readText(target, signal)) } catch { before = null } }
    const script =
      `p=$(printf %s '${b64(p)}' | base64 -d); tmp="$p.dshtmp.$$"; ` +
      `printf %s '${b64(content)}' | base64 -d > "$tmp" && mv -f -- "$tmp" "$p" && stat -c '%Y:%s:%i' -- "$p"`
    const r = await this._ssh(script, signal)
    if (r.code !== 0) throw fsErr(`cannot write "${p}": ${r.stderr.trim()}`, /Permission/.test(r.stderr) ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR')
    const version = r.stdout.toString('utf8').trim()
    return { operation: cur ? 'update' : 'create', version, before, after: normalizeLf(content) }
  }

  /** 字面编辑:读→替换→写(带版本守卫)。 */
  async editText(target, edit, expected, signal) {
    const cur = await this._probe(String(target.targetKey), 'stat', signal)
    if (!cur) throw fsErr(`"${target.displayPath}" not found`, 'FS_NOT_FOUND')
    if (expected && cur.version !== expected.version) throw fsErr(`"${target.displayPath}" changed since read`, 'FS_STALE_VERSION')
    const original = normalizeLf(await this.readText(target, signal))
    const oldS = normalizeLf(edit.oldString), newS = normalizeLf(edit.newString)
    const count = oldS ? original.split(oldS).length - 1 : 0
    if (count === 0) throw fsErr(`old_string not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
    if (count > 1 && !edit.replaceAll) throw fsErr(`old_string matched ${count} times; make it unique or set replace_all`, 'FS_AMBIGUOUS_EDIT')
    const edited = edit.replaceAll ? original.split(oldS).join(newS) : original.replace(oldS, newS)
    const outcome = await this.writeText(target, edited, undefined, signal)
    return { version: outcome.version, before: original, after: edited }
  }
}

/** LF 归一(去 CRLF)——写入/diff 基准。 */
function normalizeLf(s) { return s.replaceAll('\r\n', '\n') }
