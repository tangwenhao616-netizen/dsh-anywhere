/**
 * SshFsCoreWin —— dsh FileSystem 契约的 **Windows(PowerShell)** SSH 实现核心。
 * 与 POSIX 版 ssh-fs-core.js 同契约(resolve/stat/lstat/readText/streamText/readBytes/
 * listDir/writeText/editText),但远端走 PowerShell:每个操作经 SshConn.runPowershell 送
 * 一段 `powershell -EncodedCommand`(base64 UTF-16LE)——绕引号/二次解析,输出编码自控。
 *
 * 约定(真机验证,fleet-IIRI-WIN-ZYL / PowerShell 5.1):
 *  - 路径用 base64 在脚本内解回(无引号/注入);读回内容用 base64(二进制安全、不靠文本编码)。
 *  - 写入内容经 **stdin** 传(base64),绕开 Windows 命令行长度限制。
 *  - version = `LastWriteTimeUtc.Ticks:Length`(不透明变更令牌,写入即变)。
 *  - 路径规范化在本地用 path.win32(不做远端 realpath;Windows 符号链接少见)。
 */
import { win32 } from 'node:path'
import { SshConn } from './ssh-conn.js'

/** base64 一个字符串(UTF-8)。 */
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
/** 造一个带 FS_* code 的错误。 */
const fsErr = (msg, code) => Object.assign(new Error(msg), { code })
/** PowerShell 表达式:把 base64(UTF-8) 解回文本(路径安全,base64 字符不含单引号)。 */
const dec = bstr => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bstr}'))`
/** LF 归一(去 CRLF)——写入/diff 基准。 */
const normalizeLf = s => s.replaceAll('\r\n', '\n')

export class SshFsCoreWin {
  /**
   * @param {{login?:string, sshArgs?:string[], cwd?:string, conn?:SshConn}} config
   */
  constructor(config) {
    this.cwd = config.cwd ?? 'C:\\'
    this.conn = config.conn ?? new SshConn({ login: config.login, sshArgs: config.sshArgs })
  }

  /** 在远程跑一段 PowerShell(经共享 ControlMaster);input 走 stdin。返回 {code, stdout:Buffer, stderr}。 */
  _ps(script, signal, input) { return this.conn.runPowershell(script, signal, input) }

  /** 规范成远程 canonical 路径(相对→接 cwd;win32.normalize 解析 ..、统一反斜杠)。 */
  async resolve(path, opts = {}) {
    const base = opts.cwd ?? this.cwd
    const joined = win32.isAbsolute(path) ? path : win32.join(base, path)
    const canonical = win32.normalize(joined)
    return { targetKey: canonical, displayPath: canonical }
  }

  processPath(target) { return String(target.targetKey) }
  fileUrl(target) { return 'file:///' + encodeURI(String(target.targetKey).replace(/\\/g, '/')) }
  contains(parent, child) {
    const p = String(parent.targetKey).toLowerCase(), c = String(child.targetKey).toLowerCase()
    return c === p || c.startsWith(p.endsWith('\\') ? p : p + '\\')
  }

  /** 远程探测类型/大小/版本。mode='stat' | 'lstat'(仅影响符号链接最后一段是否报 symlink)。 */
  async _probe(path, mode, signal) {
    const script =
      `$p = ${dec(b64(path))}\n` +
      `$i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue\n` +
      `if ($null -eq $i) { Write-Output '__ABSENT__'; exit 0 }\n` +
      `$rp = ([int]$i.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0\n` +
      `if ($i.PSIsContainer) { $t='directory' } elseif ($rp -and '${mode}' -eq 'lstat') { $t='symlink' } else { $t='file' }\n` +
      `$sz = if ($i.PSIsContainer) { 0 } else { [int64]$i.Length }\n` +
      `Write-Output $t; Write-Output $sz; Write-Output ("" + $i.LastWriteTimeUtc.Ticks + ":" + $sz)`
    const r = await this._ps(script, signal)
    const text = r.stdout.toString('utf8')
    if (text.includes('__ABSENT__')) return undefined
    const lines = text.split(/\r?\n/).filter(x => x !== '')
    return { type: lines[0], size: Number(lines[1]) || 0, version: lines[2] }
  }

  async stat(target, signal) {
    const p = await this._probe(String(target.targetKey), 'stat', signal)
    return p ? { version: p.version, type: p.type, size: p.size } : undefined
  }

  async lstat(path, opts = {}, signal) {
    const base = opts.cwd ?? this.cwd
    const joined = win32.isAbsolute(path) ? path : win32.join(base, path)
    const p = await this._probe(win32.normalize(joined), 'lstat', signal)
    return p ? { version: p.version, type: p.type, size: p.size } : undefined
  }

  /** 读全文;拒二进制(前 8KB 含 NUL)与非 UTF-8。 */
  async readText(target, signal) {
    const p = String(target.targetKey)
    const script =
      `$p = ${dec(b64(p))}\n` +
      `if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Write-Output '__NOFILE__'; exit 0 }\n` +
      `$b = [IO.File]::ReadAllBytes($p)\n` +
      `Write-Output ('__B64__' + [Convert]::ToBase64String($b))`
    const r = await this._ps(script, signal)
    const out = r.stdout.toString('utf8')
    if (out.includes('__NOFILE__')) throw fsErr(`cannot read "${p}": not found`, 'FS_NOT_FOUND')
    const m = out.match(/__B64__(\S*)/)
    if (!m) throw fsErr(`cannot read "${p}": ${r.stderr.trim() || 'io error'}`, 'FS_IO_ERROR')
    const bytes = Buffer.from(m[1], 'base64')
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
    const n = maxBytes + 1
    const script =
      `$p = ${dec(b64(p))}\n` +
      `if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Write-Output '__NOFILE__'; exit 0 }\n` +
      `$fs = [IO.File]::OpenRead($p)\n` +
      `try { $buf = New-Object byte[] ${n}; $read = $fs.Read($buf, 0, ${n}) } finally { $fs.Close() }\n` +
      `Write-Output ('__B64__' + [Convert]::ToBase64String($buf, 0, $read))`
    const r = await this._ps(script, signal)
    const out = r.stdout.toString('utf8')
    if (out.includes('__NOFILE__')) throw fsErr(`cannot read "${p}"`, 'FS_NOT_FOUND')
    const m = out.match(/__B64__(\S*)/)
    if (!m) throw fsErr(`cannot read "${p}"`, 'FS_IO_ERROR')
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > maxBytes) throw fsErr(`"${p}" exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    return new Uint8Array(bytes)
  }

  /** 列目录直接子项(name 走 base64,type/size/version 为 ASCII,[char]9 分隔)。 */
  async listDir(target, signal) {
    const d = String(target.targetKey)
    const script =
      `$d = ${dec(b64(d))}\n` +
      `if (-not (Test-Path -LiteralPath $d -PathType Container)) { Write-Output '__NOTDIR__'; exit 0 }\n` +
      `Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue | ForEach-Object {\n` +
      `  $rp = ([int]$_.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0\n` +
      `  $t = if ($_.PSIsContainer) {'directory'} elseif ($rp) {'symlink'} else {'file'}\n` +
      `  $sz = if ($_.PSIsContainer) {0} else {[int64]$_.Length}\n` +
      `  $nb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Name))\n` +
      `  Write-Output ($nb + [char]9 + $t + [char]9 + $sz + [char]9 + ("" + $_.LastWriteTimeUtc.Ticks + ":" + $sz))\n` +
      `}`
    const r = await this._ps(script, signal)
    const text = r.stdout.toString('utf8')
    if (text.includes('__NOTDIR__')) throw fsErr(`not a directory: "${d}"`, 'FS_NOT_DIRECTORY')
    const entries = []
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      const [nameB64, type, size, version] = line.split('\t')
      if (nameB64 === undefined || type === undefined) continue
      const name = Buffer.from(nameB64, 'base64').toString('utf8')
      const childPath = win32.join(d, name)
      entries.push({ name, type, target: { targetKey: childPath, displayPath: childPath }, size: Number(size) || 0, version })
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return entries
  }

  /** 原子写(base64 内容经 stdin → 远程 tmp → Move-Item -Force);带守卫。 */
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
      `$p = ${dec(b64(p))}\n` +
      `$b64 = [Console]::In.ReadToEnd()\n` +
      `$bytes = [Convert]::FromBase64String($b64.Trim())\n` +
      `$tmp = $p + '.dshtmp.' + $PID\n` +
      `[IO.File]::WriteAllBytes($tmp, $bytes)\n` +
      `Move-Item -LiteralPath $tmp -Destination $p -Force\n` +
      `$i = Get-Item -LiteralPath $p -Force\n` +
      `Write-Output ("" + $i.LastWriteTimeUtc.Ticks + ":" + $i.Length)`
    const r = await this._ps(script, signal, Buffer.from(content, 'utf8').toString('base64'))
    if (r.code !== 0) {
      throw fsErr(`cannot write "${p}": ${r.stderr.trim()}`, /denied|Unauthorized/i.test(r.stderr) ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR')
    }
    const version = r.stdout.toString('utf8').trim()
    return { operation: cur ? 'update' : 'create', version, before, after: normalizeLf(content) }
  }

  /** 字面编辑:读→替换→写(带版本守卫)。与 POSIX 版一致。 */
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
