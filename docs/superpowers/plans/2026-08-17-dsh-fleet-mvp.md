# dsh-fleet MVP 实现计划(M1 hub 核心 + M2 中继底座 + M3 Linux 端到端)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一台异地 Linux 机器通过 dph 网页拿到一次性 token、粘一行命令即入网,入网后 hub 的 agent 用现有 `ssh_exec/ssh_upload/...` 直接操作它;token 一次性、可过期、可单台吊销,机器 sshd 不暴露公网。

**Architecture:** 新建独立本地插件 `dsh-fleet`(纯 host 侧,ESM JavaScript,零构建)。入网产物就是往 `~/.dsh/dsh-ssh.json` 写一条主机条目(`host=127.0.0.1, port=分配端口, proxyJump=[中继跳板]`),dsh-ssh 读文件即生效、无需重启。异地机器 `ssh -R` 把自己 sshd 反射到云中继 `175.24.133.218` 的**环回口**,hub 经中继 ProxyJump 够到它。

**Tech Stack:** Node.js 22 (ESM, `node:test` + `node:assert` 零依赖测试)、Cordis 插件 API(`@deepseek-ai/dsh-host-webserver` / `@deepseek-ai/dsh-system-prompt`,仅类型,运行时由 profile 提供)、系统 `ssh`/`ssh-keygen`、bash/systemd(join 端)、云中继 sshd。

---

## 与 spec 的一处细化(安全收紧,不改架构)

spec §5.2 原写"hub 生成两对密钥、隧道私钥随换证下发"。本计划收紧为:**任何私钥都不过网线**——
- **隧道密钥对**(机器→中继):由**机器**在 join 脚本里本地 `ssh-keygen` 生成,只把**公钥**随 enroll 请求上报;hub 把该公钥推到中继。
- **操作密钥对**(hub→机器):由**hub** `ssh-keygen` 生成、私钥留 hub,只把**公钥**回给机器写进 `authorized_keys`。

仍是"每台机器两把独立密钥、可单台吊销",只是把生成位置挪到各自持有私钥的一方。其余 spec 不变。

## 社区化(community-ready)要求

本插件要打包发布到 dsh 社区(`dsh-plugin` topic),因此**不得内置任何个人数据**:
- **零外部依赖**:插件只用 `node:` 内置模块,不 `import schemastery`/`yaml` 等——因为 link 插件经 symlink 解析(Node 默认走真实路径 `~/twh/workspace/dsh-fleet`),从那儿往上找不到 hoisted 的依赖,运行时会加载失败。这对社区分发也更稳(别人机器不会因缺依赖挂掉)。
- **中继地址配置化**:中继存在 `~/.dsh/dsh-fleet.json` 的 `relay` 块,`fleet-store.js` 的 `DEFAULT_RELAY.host` 为空串;用户经特权路由 `POST /api/fleet/relay`(UI/curl)或手编该文件设置自己的 VPS。源码不写死任何 IP。enroll 在中继未配置时直接拒(不消耗 token)。
- **无个人痕迹**:不带用户域名、用户名、密钥路径的硬编码;域名一律运行时从 `remote-web-ui.publicBaseUrl` 或请求 Host 取。
- **发布物**:MIT LICENSE、通用 README(装配/配置/安全说明)、`package.json` 加 `keywords: ["dsh-plugin"]` 与 `repository`,`private` 去掉;`npm pack` 可装、GitHub 仓库打 `dsh-plugin` topic。见 Task 15。

> 因此下面 Task 2 的 `DEFAULT_RELAY.host` 用空串;enroll/routes 的测试用**注入的测试中继值**断言(`relay.example`),不断言任何真实 IP。

## 数据形状(全计划共用,务必字段名一致)

`~/.dsh/dsh-fleet.json`:

```jsonc
{
  "version": 1,
  "relay": { "host": "175.24.133.218", "port": 22, "tunnelUser": "tunnel",
             "jumpAlias": "relay-jump", "portRange": [20001, 20999] },
  "tokens": [
    { "token": "<hex>", "alias": "office-pc", "os": "linux",
      "createdAt": 0, "expiresAt": 0, "consumed": false }
  ],
  "machines": [
    { "id": "<hex>", "alias": "office-pc", "os": "linux", "remoteUser": "wl",
      "port": 20001, "tunnelKeyComment": "dsh-fleet:office-pc",
      "opPrivKeyPath": "/home/wl/.dsh/fleet/keys/office-pc.op",
      "hostAlias": "fleet-office-pc",
      "status": "enrolling", "enrolledAt": 0, "lastSeen": 0 }
  ]
}
```

写进 `~/.dsh/dsh-ssh.json` 的主机条目(每台一条,须匹配 dsh-ssh 的 schema):

```jsonc
{
  "alias": "fleet-office-pc", "host": "127.0.0.1", "port": 20001,
  "user": "wl",
  "auth": { "kind": "key", "keyPath": "/home/wl/.dsh/fleet/keys/office-pc.op" },
  "proxyJump": ["relay-jump"], "tags": ["fleet"],
  "description": "公网入网机器(dsh-fleet)",
  "createdAt": 0, "updatedAt": 0
}
```

enroll 请求(机器→hub,POST JSON):`{ token, alias?, os, remoteUser, tunnelPublicKey }`
enroll 响应(hub→机器):`{ ok, relayHost, relayPort, relayUser, port, operationPublicKey, keepalive: { serverAliveInterval, serverAliveCountMax } }`

## 文件结构

```
dsh-fleet/
  package.json                # type:module, main lib/index.js, test 脚本
  .gitignore
  README.md
  cordis.patch.yml            # bundle 挂载点(insert 一行)
  lib/
    index.js                  # 插件入口:name/inject/Config/apply
    fleet-store.js            # dsh-fleet.json 原子读写
    token.js                  # token mint/consume/list/revoke(纯逻辑)
    ports.js                  # 端口分配(纯逻辑)
    ssh-host-writer.js        # 往 dsh-ssh.json upsert/remove 条目(桥到 dsh-ssh)
    loopback.js               # 从 dsh-ssh 复制的 loopback 判定
    gate.js                   # 路由栅栏:socket-loopback + 同源 + token
    provisioner.js            # Provisioner 接口 + FakeProvisioner(测试用)
    provisioner-ssh.js        # 真 Provisioner:ssh-keygen + ssh 到中继(M2)
    enroll.js                 # enroll 编排(纯函数 + 依赖注入)
    routes.js                 # /join、/api/fleet/* 路由
    join-template.js          # 生成 join.sh 文本(被 /join 返回)
  test/
    fleet-store.test.js
    token.test.js
    ports.test.js
    ssh-host-writer.test.js
    gate.test.js
    provisioner.test.js
    enroll.test.js
    routes.test.js
  scripts/
    relay-init.sh             # 中继一次性初始化(M2)
    join.sh                   # Linux join 参考脚本(M3,/join 返回的等价物)
```

---

# M1 — hub 核心

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `lib/.keep`, `test/.keep`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "dsh-fleet",
  "description": "DSH fleet enrollment: enroll an off-site machine into dph over the internet via a one-time token and a reverse tunnel to a cloud relay; the enrolled machine appears as a dsh-ssh host and is operated by the existing ssh_* agent tools.",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "test": "node --test"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: 写 .gitignore**

```gitignore
node_modules/
*.log
.DS_Store
```

- [ ] **Step 3: 写 README.md 占位**

```markdown
# dsh-fleet

dph 公网组网:异地机器经一次性 token 入网,反向隧道到云中继,被 dsh-ssh 的 agent 工具操作。

见 `docs/superpowers/specs/2026-08-17-dsh-fleet-design.md` 与 `docs/superpowers/plans/2026-08-17-dsh-fleet-mvp.md`。
```

- [ ] **Step 4: 建空目录占位**

Run: `mkdir -p lib test scripts && touch lib/.keep test/.keep`
Expected: 目录存在。

- [ ] **Step 5: 验证 node:test 可跑(空)**

Run: `cd ~/twh/workspace/dsh-fleet && node --test`
Expected: `tests 0 ... pass 0`(无测试文件,退出码 0)。

- [ ] **Step 6: Commit**

```bash
git add dsh-fleet/package.json dsh-fleet/.gitignore dsh-fleet/README.md dsh-fleet/lib/.keep dsh-fleet/test/.keep
git commit -m "feat(dsh-fleet): scaffold plugin package"
```

---

## Task 2: fleet-store.js —— dsh-fleet.json 原子读写

**Files:**
- Create: `lib/fleet-store.js`
- Test: `test/fleet-store.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/fleet-store.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore, DEFAULT_RELAY } from '../lib/fleet-store.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
  return { path: join(dir, 'dsh-fleet.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('absent file loads defaults', () => {
  const { path, cleanup } = tmpStore()
  try {
    const s = new FleetStore(path)
    const f = s.load()
    assert.equal(f.version, 1)
    assert.deepEqual(f.tokens, [])
    assert.deepEqual(f.machines, [])
    assert.equal(f.relay.host, DEFAULT_RELAY.host)
    assert.deepEqual(f.relay.portRange, [20001, 20999])
  } finally { cleanup() }
})

test('save then load round-trips and file is 0600', () => {
  const { path, cleanup } = tmpStore()
  try {
    const s = new FleetStore(path)
    const f = s.load()
    f.machines.push({ id: 'a', alias: 'x', os: 'linux', remoteUser: 'u', port: 20001,
      tunnelKeyComment: 'dsh-fleet:x', opPrivKeyPath: '/k', hostAlias: 'fleet-x',
      status: 'online', enrolledAt: 1, lastSeen: 2 })
    s.save(f)
    const again = new FleetStore(path).load()
    assert.equal(again.machines.length, 1)
    assert.equal(again.machines[0].alias, 'x')
    const { statSync } = await import('node:fs')
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { cleanup() }
})

test('corrupt file is renamed aside, load returns defaults', () => {
  const { path, cleanup } = tmpStore()
  try {
    const { writeFileSync, readdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    writeFileSync(path, 'not json{{')
    const f = new FleetStore(path).load()
    assert.deepEqual(f.machines, [])
    assert.ok(readdirSync(dirname(path)).some(n => n.includes('corrupt')))
  } finally { cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/fleet-store.test.js`
Expected: FAIL,`Cannot find module '../lib/fleet-store.js'`。

- [ ] **Step 3: 实现 fleet-store.js**

```js
// lib/fleet-store.js
/**
 * dsh-fleet 状态存储:一个 JSON 文件 ~/.dsh/dsh-fleet.json,原子写(tmp+rename),
 * 0600。存 relay 配置、pending tokens、machines。纯文件 I/O,无 cordis 依赖,可单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FORMAT_VERSION = 1

/** 中继默认结构。host 留空:社区插件不硬编码任何 IP,由插件 Config 在 apply 时 seed。 */
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
      // 补默认字段,兼容老文件。
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
```

> 注:测试里用了 `await import(...)`,把对应 `test(...)` 回调改成 `async () => {...}`。实现步骤照此调整测试签名。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/fleet-store.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/fleet-store.js dsh-fleet/test/fleet-store.test.js
git commit -m "feat(dsh-fleet): fleet-store atomic JSON persistence"
```

---

## Task 3: token.js —— 一次性 token 服务

**Files:**
- Create: `lib/token.js`
- Test: `test/token.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/token.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mintToken, findToken, consumeToken, listTokens, revokeToken } from '../lib/token.js'

/** 内存假 store:load/save 操作一个对象。 */
function fakeStore(initial = { version: 1, relay: {}, tokens: [], machines: [] }) {
  let file = structuredClone(initial)
  return { load: () => structuredClone(file), save: f => { file = structuredClone(f) },
           update(m) { const f = this.load(); const r = m(f); this.save(f); return r }, _peek: () => file }
}

test('mint creates an unconsumed token with ttl', () => {
  const store = fakeStore()
  const now = 1000
  const rec = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 600000 }, now)
  assert.match(rec.token, /^[0-9a-f]{48,}$/)
  assert.equal(rec.consumed, false)
  assert.equal(rec.expiresAt, now + 600000)
  assert.equal(store._peek().tokens.length, 1)
})

test('consume succeeds once, then rejects reuse', () => {
  const store = fakeStore()
  const now = 1000
  const { token } = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 600000 }, now)
  const first = consumeToken(store, token, now + 10)
  assert.equal(first.ok, true)
  assert.equal(first.record.alias, 'pc')
  const second = consumeToken(store, token, now + 20)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'consumed')
})

test('consume rejects unknown and expired', () => {
  const store = fakeStore()
  const now = 1000
  const { token } = mintToken(store, { alias: 'pc', os: 'linux', ttlMs: 100 }, now)
  assert.equal(consumeToken(store, 'nope', now).ok, false)
  assert.equal(consumeToken(store, 'nope', now).reason, 'unknown')
  const late = consumeToken(store, token, now + 200)
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'expired')
})

test('list hides consumed and expired; revoke removes', () => {
  const store = fakeStore()
  const now = 1000
  const a = mintToken(store, { alias: 'a', os: 'linux', ttlMs: 600000 }, now)
  mintToken(store, { alias: 'b', os: 'linux', ttlMs: 1 }, now) // expires immediately
  const live = listTokens(store, now + 100)
  assert.deepEqual(live.map(t => t.alias), ['a'])
  revokeToken(store, a.token)
  assert.equal(listTokens(store, now + 100).length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/token.test.js`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现 token.js**

```js
// lib/token.js
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
 * @returns {{token:string, alias:string, os:string, createdAt:number, expiresAt:number, consumed:false}}
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/token.test.js`
Expected: PASS(4 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/token.js dsh-fleet/test/token.test.js
git commit -m "feat(dsh-fleet): one-time enrollment token service"
```

---

## Task 4: ports.js —— 端口分配

**Files:**
- Create: `lib/ports.js`
- Test: `test/ports.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/ports.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocatePort } from '../lib/ports.js'

test('picks the lowest free port in range', () => {
  assert.equal(allocatePort([], [20001, 20999]), 20001)
  assert.equal(allocatePort([20001, 20002], [20001, 20999]), 20003)
  assert.equal(allocatePort([20003, 20001], [20001, 20999]), 20002) // 顺序无关,填空洞
})

test('throws when range exhausted', () => {
  assert.throws(() => allocatePort([20001, 20002], [20001, 20002]), /no free port/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/ports.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 ports.js**

```js
// lib/ports.js
/**
 * 在 [lo, hi] 闭区间里挑一个未被占用的最小端口。用于给每台入网机器分配中继环回端口。
 * @param {number[]} used 已占用端口
 * @param {[number,number]} range [lo, hi]
 * @returns {number}
 */
export function allocatePort(used, range) {
  const [lo, hi] = range
  const taken = new Set(used)
  for (let p = lo; p <= hi; p++) {
    if (!taken.has(p)) return p
  }
  throw new Error(`no free port in range ${lo}-${hi}`)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/ports.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/ports.js dsh-fleet/test/ports.test.js
git commit -m "feat(dsh-fleet): loopback port allocator"
```

---

## Task 5: ssh-host-writer.js —— 桥到 dsh-ssh 主机表

**Files:**
- Create: `lib/ssh-host-writer.js`
- Test: `test/ssh-host-writer.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/ssh-host-writer.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertFleetHost, removeFleetHost } from '../lib/ssh-host-writer.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'sshw-'))
  return { path: join(dir, 'dsh-ssh.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const entry = {
  alias: 'fleet-pc', host: '127.0.0.1', port: 20001, user: 'wl',
  auth: { kind: 'key', keyPath: '/home/wl/.dsh/fleet/keys/pc.op' },
  proxyJump: ['relay-jump'], tags: ['fleet'], description: '公网入网机器(dsh-fleet)',
}

test('upsert creates file and inserts a valid entry, 0600', () => {
  const { path, cleanup } = tmp()
  try {
    upsertFleetHost(path, entry, 1000)
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.version, 1)
    assert.equal(f.hosts.length, 1)
    const h = f.hosts[0]
    assert.equal(h.alias, 'fleet-pc')
    assert.equal(h.port, 20001)
    assert.deepEqual(h.proxyJump, ['relay-jump'])
    assert.equal(h.auth.kind, 'key')
    assert.equal(h.createdAt, 1000)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { cleanup() }
})

test('upsert preserves other hosts and replaces same alias', () => {
  const { path, cleanup } = tmp()
  try {
    writeFileSync(path, JSON.stringify({ version: 1, hosts: [
      { alias: 'target-22', host: '192.168.1.22', port: 22, user: 'x', auth: { kind: 'password', password: 'p' }, proxyJump: [], tags: [], createdAt: 1, updatedAt: 1 },
    ] }, null, 2))
    upsertFleetHost(path, entry, 1000)
    upsertFleetHost(path, { ...entry, port: 20002 }, 2000) // 同 alias 再写
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.hosts.length, 2) // target-22 保留 + fleet-pc 一条
    const h = f.hosts.find(x => x.alias === 'fleet-pc')
    assert.equal(h.port, 20002)        // 被替换
    assert.equal(h.createdAt, 1000)    // createdAt 保留
    assert.equal(h.updatedAt, 2000)
  } finally { cleanup() }
})

test('remove deletes only the named alias', () => {
  const { path, cleanup } = tmp()
  try {
    upsertFleetHost(path, entry, 1000)
    removeFleetHost(path, 'fleet-pc')
    const f = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(f.hosts.length, 0)
    removeFleetHost(path, 'nonexistent') // 幂等,不抛
  } finally { cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/ssh-host-writer.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 ssh-host-writer.js**

```js
// lib/ssh-host-writer.js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/ssh-host-writer.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/ssh-host-writer.js dsh-fleet/test/ssh-host-writer.test.js
git commit -m "feat(dsh-fleet): write enrolled machine into dsh-ssh host store"
```

---

## Task 6: loopback.js + gate.js —— 域名可达的路由栅栏

**Files:**
- Create: `lib/loopback.js`(从 dsh-ssh 复制), `lib/gate.js`
- Test: `test/gate.test.js`

- [ ] **Step 1: 复制 loopback.js**

把 `~/.dsh/profiles/web/node_modules/@linxin666/dsh-ssh/src/loopback.ts` 的运行体转成 JS(去掉 TS 类型注解),存 `lib/loopback.js`。完整内容:

```js
// lib/loopback.js
/** RFC5735 127/8、::1、IPv4-mapped ::ffff:127/8 的 loopback 判定(从 dsh-ssh 复制)。 */

/** IPv4 127/8。 */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** socket remoteAddress 是否 loopback。 */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const n = address.toLowerCase()
  if (n === '::1') return true
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice('::ffff:'.length))
  return isIPv4Loopback(n)
}

/** hostname 是否 loopback(localhost / [::1] / 127/8)。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}
```

- [ ] **Step 2: 写 gate 失败测试**

```js
// test/gate.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromTunnelOrLocal, sameOriginBrowser } from '../lib/gate.js'

/** 造一个假 IncomingMessage。 */
function req({ remoteAddress = '127.0.0.1', host = 'localhost', origin, secFetchSite } = {}) {
  return { socket: { remoteAddress }, headers: {
    host, ...(origin !== undefined ? { origin } : {}),
    ...(secFetchSite !== undefined ? { 'sec-fetch-site': secFetchSite } : {}) } }
}

test('fromTunnelOrLocal: cloudflared/localhost socket passes regardless of Host', () => {
  // cloudflared 转发到 127.0.0.1,Host 是公网域名
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '127.0.0.1', host: 'rip-dee.trycloudflare.com' })), true)
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '::1', host: 'localhost' })), true)
})

test('fromTunnelOrLocal: raw LAN socket is rejected', () => {
  assert.equal(fromTunnelOrLocal(req({ remoteAddress: '192.168.1.50', host: '192.168.1.44:3080' })), false)
})

test('sameOriginBrowser: cross-site marker rejected; matching origin ok; no-origin ok', () => {
  assert.equal(sameOriginBrowser(req({ host: 'd.com', secFetchSite: 'cross-site', origin: 'https://evil.com' })), false)
  assert.equal(sameOriginBrowser(req({ host: 'd.com', origin: 'https://d.com' })), true)
  assert.equal(sameOriginBrowser(req({ host: 'd.com' })), true) // 非浏览器(curl)无 Origin
  assert.equal(sameOriginBrowser(req({ host: 'd.com', origin: 'https://evil.com' })), false)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/gate.test.js`
Expected: FAIL。

- [ ] **Step 4: 实现 gate.js**

```js
// lib/gate.js
/**
 * dsh-fleet 路由栅栏。关键:经 cloudflare 域名来的请求,socket 是 127.0.0.1(cloudflared
 * 转发)但 Host 头是公网域名——所以不能用 dsh-ssh 那种"Host 必须是 loopback"的判定,
 * 否则域名流量全被拒。这里改为:
 *   - fromTunnelOrLocal:只要 socket 是 loopback(cloudflared 或本机),放行;直连 LAN IP
 *     打 0.0.0.0:3080 的 socket 非 loopback,拒。真正的鉴权由 token(enroll)或同源(UI)负责。
 *   - sameOriginBrowser:防 CSRF——浏览器跨站标记或 Origin 与 Host 不符则拒;curl 无 Origin 放行。
 */
import { isLoopbackAddress } from './loopback.js'

/** socket 是否来自隧道(cloudflared)或本机 loopback。 */
export function fromTunnelOrLocal(request) {
  const socket = request.socket
  return isLoopbackAddress(socket && socket.remoteAddress)
}

/** 浏览器同源校验(CSRF 防护);非浏览器无 Origin 时放行。 */
export function sameOriginBrowser(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === new URL('http://' + host).host
  } catch {
    return false
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/gate.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 6: Commit**

```bash
git add dsh-fleet/lib/loopback.js dsh-fleet/lib/gate.js dsh-fleet/test/gate.test.js
git commit -m "feat(dsh-fleet): domain-tolerant route gate (tunnel socket + same-origin)"
```

---

## Task 7: provisioner.js —— Provisioner 接口 + Fake

**Files:**
- Create: `lib/provisioner.js`
- Test: `test/provisioner.test.js`

Provisioner 封装两件有副作用的事(密钥生成 + 推公钥到中继),M1 只给内存 Fake 供 enroll 编排测试,真实现留 M2。

- [ ] **Step 1: 写 Fake 契约测试**

```js
// test/provisioner.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeProvisioner } from '../lib/provisioner.js'

test('FakeProvisioner records op keypair generation and relay pushes', async () => {
  const p = new FakeProvisioner()
  const kp = await p.generateOpKeypair('fleet-pc')
  assert.match(kp.operationPublicKey, /^ssh-ed25519 /)
  assert.ok(kp.opPrivKeyPath.includes('fleet-pc'))
  await p.pushTunnelKey('ssh-ed25519 AAAAtunnel comment', 20001)
  assert.deepEqual(p.pushed, [{ pubkey: 'ssh-ed25519 AAAAtunnel comment', port: 20001 }])
  await p.removeTunnelKey(20001)
  assert.deepEqual(p.removed, [20001])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/provisioner.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 provisioner.js(接口 + Fake)**

```js
// lib/provisioner.js
/**
 * Provisioner 封装 enroll 的两类副作用:
 *   generateOpKeypair(hostAlias) -> { operationPublicKey, opPrivKeyPath }
 *     在 hub 上生成"操作"密钥对(hub→机器),私钥留 hub,回传公钥文本 + 私钥路径。
 *   pushTunnelKey(tunnelPublicKey, port) -> void
 *     把机器上报的"隧道"公钥推到中继 tunnel 账号 authorized_keys,前缀锁死
 *     restrict,permitlisten="127.0.0.1:<port>"。
 *   removeTunnelKey(port) -> void  吊销时从中继删掉该端口对应的授权行。
 *
 * 真实现见 provisioner-ssh.js(M2)。这里的 Fake 供纯逻辑测试。
 */

/** 测试用内存实现,记录调用。 */
export class FakeProvisioner {
  constructor() { this.pushed = []; this.removed = [] }
  async generateOpKeypair(hostAlias) {
    return { operationPublicKey: `ssh-ed25519 AAAAop ${hostAlias}`, opPrivKeyPath: `/tmp/keys/${hostAlias}.op` }
  }
  async pushTunnelKey(pubkey, port) { this.pushed.push({ pubkey, port }) }
  async removeTunnelKey(port) { this.removed.push(port) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/provisioner.test.js`
Expected: PASS(1 test)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/provisioner.js dsh-fleet/test/provisioner.test.js
git commit -m "feat(dsh-fleet): provisioner interface + fake"
```

---

## Task 8: enroll.js —— enroll 编排

**Files:**
- Create: `lib/enroll.js`
- Test: `test/enroll.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/enroll.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from '../lib/fleet-store.js'
import { mintToken } from '../lib/token.js'
import { FakeProvisioner } from '../lib/provisioner.js'
import { enrollMachine } from '../lib/enroll.js'

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'enroll-'))
  const store = new FleetStore(join(dir, 'dsh-fleet.json'))
  // 默认 seed 一个测试中继(enroll 有"中继未配置即拒"的前置守卫)
  store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
  const sshPath = join(dir, 'dsh-ssh.json')
  return { dir, store, sshPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('happy path: consumes token, allocates port, pushes tunnel key, writes ssh host, records machine', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    // seed 一个测试中继(社区插件不硬编码 IP)
    c.store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
    const { token } = mintToken(c.store, { alias: 'office', os: 'linux', ttlMs: 600000 }, 1000)
    const res = await enrollMachine(
      { store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAAtunnel office' },
      2000,
    )
    assert.equal(res.ok, true)
    assert.equal(res.port, 20001)
    assert.equal(res.relayHost, 'relay.example')
    assert.match(res.operationPublicKey, /^ssh-ed25519 /)
    // 隧道公钥被推到中继,端口一致
    assert.deepEqual(prov.pushed, [{ pubkey: 'ssh-ed25519 AAAAtunnel office', port: 20001 }])
    // dsh-ssh.json 写了一条 fleet 主机
    const ssh = JSON.parse(readFileSync(c.sshPath, 'utf8'))
    assert.equal(ssh.hosts[0].alias, 'fleet-office')
    assert.equal(ssh.hosts[0].port, 20001)
    assert.deepEqual(ssh.hosts[0].proxyJump, ['relay-jump'])
    // machine 档案入库
    const m = c.store.load().machines[0]
    assert.equal(m.alias, 'office')
    assert.equal(m.port, 20001)
    assert.equal(m.status, 'enrolling')
  } finally { c.cleanup() }
})

test('rejects an already-consumed token', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const { token } = mintToken(c.store, { alias: 'office', os: 'linux', ttlMs: 600000 }, 1000)
    await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 2000)
    const again = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 3000)
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'consumed')
    // 未二次分配端口
    assert.equal(c.store.load().machines.length, 1)
  } finally { c.cleanup() }
})

test('second machine gets the next port', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    const a = mintToken(c.store, { alias: 'a', os: 'linux', ttlMs: 600000 }, 1000)
    const b = mintToken(c.store, { alias: 'b', os: 'linux', ttlMs: 600000 }, 1000)
    const r1 = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token: a.token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k1' }, 2000)
    const r2 = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token: b.token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k2' }, 2000)
    assert.equal(r1.port, 20001)
    assert.equal(r2.port, 20002)
  } finally { c.cleanup() }
})

test('rejects when relay not configured, without consuming the token', async () => {
  const c = ctx()
  try {
    const prov = new FakeProvisioner()
    c.store.update(f => { f.relay = { ...f.relay, host: '' } }) // 清空中继
    const { token } = mintToken(c.store, { alias: 'x', os: 'linux', ttlMs: 600000 }, 1000)
    const res = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 2000)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'relay-not-configured')
    // token 未被消耗:配置好中继后仍可用
    c.store.update(f => { f.relay = { ...f.relay, host: 'relay.example' } })
    const ok = await enrollMachine({ store: c.store, provisioner: prov, sshStorePath: c.sshPath },
      { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' }, 3000)
    assert.equal(ok.ok, true)
  } finally { c.cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/enroll.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 enroll.js**

```js
// lib/enroll.js
/**
 * enroll 编排:把 token 校验、端口分配、密钥、推中继、写 dsh-ssh、记档案串起来。
 * 纯函数 + 依赖注入(store / provisioner / sshStorePath),便于测试。
 *
 * 顺序(任一步失败即返回错误,不留半条记录):
 *   1) 一次性消耗 token(失败→reason)
 *   2) 分配环回端口(避开已在册 machines 的端口)
 *   3) 在 hub 生成操作密钥对(私钥留 hub)
 *   4) 把机器上报的隧道公钥推到中继(带 permitlisten 锁端口)
 *   5) 写 dsh-ssh 主机条目(agent 立即可用)
 *   6) 记 machine 档案(status=enrolling,待 heartbeat 置 online)
 */
import { randomBytes } from 'node:crypto'
import { consumeToken } from './token.js'
import { allocatePort } from './ports.js'
import { upsertFleetHost } from './ssh-host-writer.js'

/**
 * @param {{store, provisioner, sshStorePath:string}} deps
 * @param {{token:string, alias?:string, os:string, remoteUser:string, tunnelPublicKey:string}} req
 * @param {number} now 毫秒
 */
export async function enrollMachine(deps, req, now) {
  const { store, provisioner, sshStorePath } = deps

  // 0) 中继未配置则直接拒(在消耗 token 之前,避免误配烧掉一次性 token)
  if (!store.load().relay?.host) return { ok: false, reason: 'relay-not-configured' }

  // 1) token
  const consumed = consumeToken(store, req.token, now)
  if (!consumed.ok) return { ok: false, reason: consumed.reason }
  const alias = (req.alias && req.alias.trim()) || consumed.record.alias
  const hostAlias = `fleet-${alias}`

  // 2) 端口
  const file = store.load()
  const port = allocatePort(file.machines.map(m => m.port), file.relay.portRange)
  const relay = file.relay

  // 3) 操作密钥对(hub 生成)
  const { operationPublicKey, opPrivKeyPath } = await provisioner.generateOpKeypair(hostAlias)

  // 4) 推隧道公钥到中继
  await provisioner.pushTunnelKey(req.tunnelPublicKey, port)

  // 5) 写 dsh-ssh 主机条目
  upsertFleetHost(sshStorePath, {
    alias: hostAlias, host: '127.0.0.1', port, user: req.remoteUser,
    auth: { kind: 'key', keyPath: opPrivKeyPath },
    proxyJump: [relay.jumpAlias], tags: ['fleet'],
    description: '公网入网机器(dsh-fleet)',
  }, now)

  // 6) 记档案
  const id = randomBytes(8).toString('hex')
  store.update(f => {
    f.machines = f.machines.filter(m => m.alias !== alias) // 同名重入网覆盖
    f.machines.push({
      id, alias, os: req.os, remoteUser: req.remoteUser, port,
      tunnelKeyComment: `dsh-fleet:${alias}`, opPrivKeyPath, hostAlias,
      status: 'enrolling', enrolledAt: now, lastSeen: 0,
    })
  })

  return {
    ok: true, id,
    relayHost: relay.host, relayPort: relay.port, relayUser: relay.tunnelUser,
    port, operationPublicKey,
    keepalive: { serverAliveInterval: 30, serverAliveCountMax: 3 },
  }
}

/**
 * heartbeat:机器上线回报,置 online + lastSeen。
 * @returns {boolean} 是否命中一台在册机器
 */
export function markOnline(store, id, now) {
  return store.update(f => {
    const m = f.machines.find(x => x.id === id)
    if (!m) return false
    m.status = 'online'; m.lastSeen = now
    return true
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/enroll.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/enroll.js dsh-fleet/test/enroll.test.js
git commit -m "feat(dsh-fleet): enrollment orchestration"
```

---

## Task 9: join-template.js —— 生成 join.sh 文本

**Files:**
- Create: `lib/join-template.js`
- Test: `test/join-template.test.js`

`/join` 返回的脚本文本由此生成(注入 dph 域名、token)。M1 只做 Linux 版文本;脚本真身逻辑在 M3 的 `scripts/join.sh` 里定稿,这里内联同一份。

- [ ] **Step 1: 写失败测试**

```js
// test/join-template.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLinuxJoinScript } from '../lib/join-template.js'

test('linux join script embeds base url and token, targets enroll endpoint', () => {
  const s = renderLinuxJoinScript({ baseUrl: 'https://d.trycloudflare.com', token: 'abc123' })
  assert.match(s, /^#!\/usr\/bin\/env bash/)
  assert.ok(s.includes('https://d.trycloudflare.com/api/fleet/enroll'))
  assert.ok(s.includes('abc123'))
  assert.ok(s.includes('ssh-keygen'))     // 本地生成隧道密钥
  assert.ok(s.includes('-R 127.0.0.1:'))  // 反向隧道
  assert.ok(s.includes('systemd') || s.includes('systemctl')) // 保活
})

test('token is shell-single-quote-safe (rejects injection chars)', () => {
  assert.throws(() => renderLinuxJoinScript({ baseUrl: 'https://d', token: "a'b" }), /invalid token/)
  assert.throws(() => renderLinuxJoinScript({ baseUrl: "https://d';rm -rf", token: 'a' }), /invalid baseUrl/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/join-template.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 join-template.js**

```js
// lib/join-template.js
/**
 * 生成 Linux join 脚本文本。/join 路由把它作为 text/x-shellscript 返回,用户在异地机器
 * 上 `curl .../join?token=... | bash` 执行。token/baseUrl 直接内联进脚本,故严格校验字符,
 * 避免 shell 注入(它们会被放进单引号里,但仍禁掉引号与控制字符做双保险)。
 */

/** token:仅十六进制。 */
const TOKEN_RE = /^[0-9a-f]{16,128}$/
/** baseUrl:仅 https 常规 URL 字符。 */
const BASEURL_RE = /^https:\/\/[A-Za-z0-9.\-:/]+$/

/**
 * @param {{baseUrl:string, token:string}} o
 * @returns {string} 脚本文本
 */
export function renderLinuxJoinScript(o) {
  if (!TOKEN_RE.test(o.token)) throw new Error('invalid token')
  if (!BASEURL_RE.test(o.baseUrl)) throw new Error('invalid baseUrl')
  const { baseUrl, token } = o
  return `#!/usr/bin/env bash
# dsh-fleet Linux join 脚本(由 hub /join 生成)。把本机 sshd 反向映射到云中继,
# 并登记为一台可被 dph agent 操作的主机。需要:已运行的 sshd、openssh-client。
set -euo pipefail

BASE_URL='${baseUrl}'
TOKEN='${token}'
FLEET_DIR="\${HOME}/.dsh-fleet"
KEY="\${FLEET_DIR}/tunnel"        # 隧道私钥(机器→中继),本地生成,私钥不出网
mkdir -p "\${FLEET_DIR}"; chmod 700 "\${FLEET_DIR}"

command -v ssh >/dev/null   || { echo "缺 openssh-client"; exit 1; }
command -v ssh-keygen >/dev/null || { echo "缺 ssh-keygen"; exit 1; }
command -v curl >/dev/null   || { echo "缺 curl"; exit 1; }

# 1) 本地生成隧道密钥对(若无)
[ -f "\${KEY}" ] || ssh-keygen -t ed25519 -N '' -f "\${KEY}" -C "dsh-fleet:$(hostname)" >/dev/null
TUNNEL_PUB="$(cat "\${KEY}.pub")"

# 2) 换证
RESP="$(curl -fsSL -X POST "\${BASE_URL}/api/fleet/enroll" \\
  -H 'content-type: application/json' \\
  -d "$(printf '{"token":"%s","os":"linux","remoteUser":"%s","tunnelPublicKey":"%s"}' \\
        "\${TOKEN}" "\${USER}" "\${TUNNEL_PUB}")")"

# 极简 JSON 取值(避免依赖 jq):字段都是我们自己产的、无嵌套引号
getf() { echo "\${RESP}" | grep -o "\\"$1\\":[^,}]*" | head -1 | sed 's/.*://; s/^ *//; s/^"//; s/"$//'; }
RELAY_HOST="$(getf relayHost)"; RELAY_PORT="$(getf relayPort)"; RELAY_USER="$(getf relayUser)"
PORT="$(getf port)"; ID="$(getf id)"
OP_PUB="$(echo "\${RESP}" | grep -o '"operationPublicKey":"[^"]*"' | sed 's/.*://; s/^"//; s/"$//')"
[ -n "\${PORT}" ] || { echo "enroll 失败: \${RESP}"; exit 1; }

# 3) 授权 hub 操作公钥(仅接受经隧道从本机 loopback 来的连接)
AUTH="\${HOME}/.ssh/authorized_keys"; mkdir -p "\${HOME}/.ssh"; chmod 700 "\${HOME}/.ssh"; touch "\${AUTH}"; chmod 600 "\${AUTH}"
LINE="from=\\"127.0.0.1,::1\\" \${OP_PUB}"
grep -qF "\${OP_PUB}" "\${AUTH}" || echo "\${LINE}" >> "\${AUTH}"

# 4) 装保活反向隧道服务(systemd user 优先,回退 nohup)
TUNNEL_CMD="ssh -N -T -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -i \${KEY} -R 127.0.0.1:\${PORT}:localhost:22 -p \${RELAY_PORT} \${RELAY_USER}@\${RELAY_HOST}"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="\${HOME}/.config/systemd/user/dsh-fleet-tunnel.service"; mkdir -p "$(dirname "\${UNIT}")"
  cat > "\${UNIT}" <<EOF
[Unit]
Description=dsh-fleet reverse tunnel
After=network-online.target
[Service]
ExecStart=\${TUNNEL_CMD}
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-fleet-tunnel.service
  loginctl enable-linger "\${USER}" >/dev/null 2>&1 || true
else
  ( \${TUNNEL_CMD} >/dev/null 2>&1 & )  # 无 systemd 的回退(不保活到重启)
fi

# 5) 回报上线
sleep 2
curl -fsSL -X POST "\${BASE_URL}/api/fleet/heartbeat" -H 'content-type: application/json' -d "$(printf '{"id":"%s"}' "\${ID}")" >/dev/null || true
echo "dsh-fleet: 已入网(端口 \${PORT})。回到 dph 网页应能看到本机在线。"
`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/join-template.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/join-template.js dsh-fleet/test/join-template.test.js
git commit -m "feat(dsh-fleet): render linux join script"
```

---

## Task 10: routes.js —— /join 与 /api/fleet/*

**Files:**
- Create: `lib/routes.js`
- Test: `test/routes.test.js`

- [ ] **Step 1: 写失败测试(用假 req/res 驱动 handler)**

```js
// test/routes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FleetStore } from '../lib/fleet-store.js'
import { FakeProvisioner } from '../lib/provisioner.js'
import { makeRoutes } from '../lib/routes.js'

function res() {
  return { statusCode: 0, headers: {}, body: '',
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h) },
    end(b) { this.body = b ?? '' } }
}
function req({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1', host = 'd.trycloudflare.com', origin } = {}) {
  const r = body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([])
  r.method = method; r.url = url; r.socket = { remoteAddress }
  r.headers = { host, ...(origin !== undefined ? { origin } : {}) }
  return r
}
function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'routes-'))
  const store = new FleetStore(join(dir, 'dsh-fleet.json'))
  store.update(f => { f.relay = { host: 'relay.example', port: 22, tunnelUser: 'tunnel', jumpAlias: 'relay-jump', jumpLogin: 'ops@relay.example', portRange: [20001, 20999] } })
  const routes = makeRoutes({ store, provisioner: new FakeProvisioner(),
    sshStorePath: join(dir, 'dsh-ssh.json'), baseUrl: () => 'https://d.trycloudflare.com', now: () => 5000 })
  const byPath = Object.fromEntries(routes.map(r => [r.path, r.handler]))
  return { dir, store, byPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('POST /api/fleet/token mints; GET /api/fleet/list shows it', async () => {
  const c = ctx()
  try {
    const r1 = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'https://d.trycloudflare.com', body: { alias: 'pc', os: 'linux' } }), r1)
    assert.equal(r1.statusCode, 200)
    const minted = JSON.parse(r1.body)
    assert.match(minted.token, /^[0-9a-f]+$/)
    assert.ok(minted.command.includes('/join?token='))
    const r2 = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', origin: 'https://d.trycloudflare.com' }), r2)
    const list = JSON.parse(r2.body)
    assert.equal(list.tokens.length, 1)
  } finally { c.cleanup() }
})

test('GET /join returns a shell script for a valid token', async () => {
  const c = ctx()
  try {
    const rt = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'https://d.trycloudflare.com', body: { alias: 'pc', os: 'linux' } }), rt)
    const { token } = JSON.parse(rt.body)
    const rj = res()
    await c.byPath['/join'](req({ url: `/join?token=${token}` }), rj)
    assert.equal(rj.statusCode, 200)
    assert.match(rj.headers['content-type'], /shellscript|text\/plain/)
    assert.ok(rj.body.includes('/api/fleet/enroll'))
  } finally { c.cleanup() }
})

test('POST /api/fleet/enroll consumes token and returns relay params', async () => {
  const c = ctx()
  try {
    const rt = res()
    await c.byPath['/api/fleet/token'](req({ method: 'POST', url: '/api/fleet/token', origin: 'https://d.trycloudflare.com', body: { alias: 'pc', os: 'linux' } }), rt)
    const { token } = JSON.parse(rt.body)
    const re = res()
    await c.byPath['/api/fleet/enroll'](req({ method: 'POST', url: '/api/fleet/enroll',
      body: { token, os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'ssh-ed25519 AAAA x' } }), re)
    assert.equal(re.statusCode, 200)
    const out = JSON.parse(re.body)
    assert.equal(out.ok, true)
    assert.equal(out.port, 20001)
    assert.equal(out.relayHost, 'relay.example')
  } finally { c.cleanup() }
})

test('enroll rejects a bad token with 403', async () => {
  const c = ctx()
  try {
    const re = res()
    await c.byPath['/api/fleet/enroll'](req({ method: 'POST', url: '/api/fleet/enroll',
      body: { token: 'deadbeef', os: 'linux', remoteUser: 'wl', tunnelPublicKey: 'k' } }), re)
    assert.equal(re.statusCode, 403)
  } finally { c.cleanup() }
})

test('privileged routes reject raw-LAN socket', async () => {
  const c = ctx()
  try {
    const r = res()
    await c.byPath['/api/fleet/list'](req({ url: '/api/fleet/list', remoteAddress: '192.168.1.50', host: '192.168.1.44:3080' }), r)
    assert.equal(r.statusCode, 403)
  } finally { c.cleanup() }
})

test('POST /api/fleet/relay sets the relay config', async () => {
  const c = ctx()
  try {
    const r = res()
    await c.byPath['/api/fleet/relay'](req({ method: 'POST', url: '/api/fleet/relay', origin: 'https://d.trycloudflare.com', body: { host: '203.0.113.9', jumpLogin: 'ubuntu@203.0.113.9' } }), r)
    assert.equal(r.statusCode, 200)
    assert.equal(c.store.load().relay.host, '203.0.113.9')
    assert.equal(c.store.load().relay.jumpLogin, 'ubuntu@203.0.113.9')
  } finally { c.cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/routes.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 routes.js**

```js
// lib/routes.js
/**
 * dsh-fleet 路由族。三类:
 *   公开(经域名/隧道可达,token 鉴权):
 *     GET  /join            返回 join 脚本(?token= 必带且有效)
 *     POST /api/fleet/enroll 换证(body.token 一次性消耗)
 *     POST /api/fleet/heartbeat 上线回报(body.id)
 *   特权(浏览器 UI,fromTunnelOrLocal + 同源):
 *     POST /api/fleet/token  铸造 token,返回一行入网命令
 *     GET  /api/fleet/list   机器 + 有效 token 列表
 *     POST /api/fleet/revoke 吊销一台(body.alias)
 *     POST /api/fleet/relay  设置中继(社区插件不硬编码,用户配自己的 VPS)
 *
 * 全部 handler 形如 (req,res)=>Promise<void>,由 index.js 经 ctx.webServer.register 挂上。
 */
import { fromTunnelOrLocal, sameOriginBrowser } from './gate.js'
import { mintToken, listTokens, revokeToken, findToken } from './token.js'
import { enrollMachine, markOnline } from './enroll.js'
import { renderLinuxJoinScript } from './join-template.js'
import { removeFleetHost } from './ssh-host-writer.js'

const MAX_BODY = 64 * 1024

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}
async function readJson(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    const buf = chunk
    size += buf.length
    if (size > MAX_BODY) return undefined
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch { return undefined }
}

/**
 * @param {{store, provisioner, sshStorePath:string, baseUrl:()=>string, now?:()=>number}} deps
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function makeRoutes(deps) {
  const { store, provisioner, sshStorePath, baseUrl } = deps
  const now = deps.now ?? (() => Date.now())
  const DEFAULT_TTL = 10 * 60 * 1000

  /** 特权栅栏:隧道/本机 socket + 浏览器同源。 */
  const privileged = (req, res) => {
    if (!fromTunnelOrLocal(req) || !sameOriginBrowser(req)) { writeJson(res, 403, { error: 'forbidden' }); return false }
    return true
  }

  return [
    // ---- 特权:铸造 token
    { kind: 'exact', path: '/api/fleet/token', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(body.alias)) {
        return writeJson(res, 400, { error: 'alias required (letters/digits/._-)' })
      }
      const os = body.os === 'win' || body.os === 'mac' ? body.os : 'linux'
      const ttlMs = Number.isInteger(body.ttlMs) ? body.ttlMs : DEFAULT_TTL
      const rec = mintToken(store, { alias: body.alias, os, ttlMs }, now())
      const url = `${baseUrl()}/join?token=${rec.token}`
      const command = os === 'win'
        ? `$env:FLEET='${rec.token}'; irm ${baseUrl()}/join?token=${rec.token}\&os=win | iex`
        : `curl -fsSL '${url}' | bash`
      writeJson(res, 200, { token: rec.token, alias: rec.alias, os, expiresAt: rec.expiresAt, url, command })
    } },

    // ---- 特权:列表
    { kind: 'exact', path: '/api/fleet/list', handler: async (req, res) => {
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const f = store.load()
      writeJson(res, 200, {
        machines: f.machines.map(m => ({ alias: m.alias, os: m.os, port: m.port, status: m.status, lastSeen: m.lastSeen, enrolledAt: m.enrolledAt })),
        tokens: listTokens(store, now()).map(t => ({ alias: t.alias, os: t.os, expiresAt: t.expiresAt })),
      })
    } },

    // ---- 特权:吊销一台
    { kind: 'exact', path: '/api/fleet/revoke', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.alias !== 'string') return writeJson(res, 400, { error: 'alias required' })
      const m = store.load().machines.find(x => x.alias === body.alias)
      if (m) {
        try { await provisioner.removeTunnelKey(m.port) } catch { /* 中继不可达也要继续本地清理 */ }
        removeFleetHost(sshStorePath, m.hostAlias)
        store.update(f => { f.machines = f.machines.filter(x => x.alias !== body.alias) })
      }
      writeJson(res, 200, { ok: true })
    } },

    // ---- 特权:设置中继(社区插件不硬编码中继,用户在此配置自己的 VPS)
    { kind: 'exact', path: '/api/fleet/relay', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!privileged(req, res)) return
      const body = await readJson(req)
      if (!body || typeof body.host !== 'string' || body.host.trim() === '') return writeJson(res, 400, { error: 'host required' })
      store.update(f => {
        f.relay = {
          host: body.host.trim(),
          port: Number.isInteger(body.port) ? body.port : 22,
          tunnelUser: typeof body.tunnelUser === 'string' && body.tunnelUser ? body.tunnelUser : 'tunnel',
          jumpAlias: 'relay-jump',
          jumpLogin: typeof body.jumpLogin === 'string' ? body.jumpLogin : '',
          portRange: Array.isArray(body.portRange) && body.portRange.length === 2 ? body.portRange : (f.relay?.portRange ?? [20001, 20999]),
        }
      })
      writeJson(res, 200, { ok: true, relay: store.load().relay })
    } },

    // ---- 公开:join 脚本
    { kind: 'exact', path: '/join', handler: async (req, res) => {
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const token = url.searchParams.get('token') ?? ''
      const rec = findToken(store, token)
      if (!rec || rec.consumed || now() > rec.expiresAt) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('# 无效或过期的 token\n')
      }
      // MVP:仅 Linux;win/mac 见 M5。
      const script = renderLinuxJoinScript({ baseUrl: baseUrl(), token })
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8' })
      res.end(script)
    } },

    // ---- 公开:换证
    { kind: 'exact', path: '/api/fleet/enroll', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const body = await readJson(req)
      if (!body || typeof body.token !== 'string' || typeof body.tunnelPublicKey !== 'string' || typeof body.remoteUser !== 'string') {
        return writeJson(res, 400, { error: 'token, remoteUser, tunnelPublicKey required' })
      }
      const os = typeof body.os === 'string' ? body.os : 'linux'
      const result = await enrollMachine({ store, provisioner, sshStorePath },
        { token: body.token, alias: body.alias, os, remoteUser: body.remoteUser, tunnelPublicKey: body.tunnelPublicKey }, now())
      if (!result.ok) return writeJson(res, 403, { error: `enroll rejected: ${result.reason}` })
      writeJson(res, 200, result)
    } },

    // ---- 公开:上线回报
    { kind: 'exact', path: '/api/fleet/heartbeat', handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
      if (!fromTunnelOrLocal(req)) return writeJson(res, 403, { error: 'forbidden' })
      const body = await readJson(req)
      if (!body || typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' })
      const hit = markOnline(store, body.id, now())
      writeJson(res, hit ? 200 : 404, { ok: hit })
    } },
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/routes.test.js`
Expected: PASS(5 tests)。

- [ ] **Step 5: 跑全量测试**

Run: `cd ~/twh/workspace/dsh-fleet && node --test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add dsh-fleet/lib/routes.js dsh-fleet/test/routes.test.js
git commit -m "feat(dsh-fleet): join + fleet API routes"
```

---

## Task 11: index.js —— 插件入口

**Files:**
- Create: `lib/index.js`, `cordis.patch.yml`

无独立单测(集成在 M3 端到端)。照 dsh-ssh 的 `apply` 骨架:装路由 + systemPrompt section,用真 Provisioner。

- [ ] **Step 1: 写 cordis.patch.yml**

```yaml
# dsh-fleet bundle patch:把 host 侧插件行插入 web profile。
- insert:
    - id: fleet
      name: dsh-fleet
      inject:
        - webServer
        - systemPrompt
```

- [ ] **Step 2: 实现 lib/index.js**

```js
// lib/index.js
/**
 * dsh-fleet host 入口。挂 /join + /api/fleet/* 路由,注册一段面向 agent 的 systemPrompt
 * 说明。入网机器最终是一条 dsh-ssh 主机,故本插件不注册任何 agent 工具——操作能力复用
 * dsh-ssh 的 ssh_exec/ssh_upload/... 现成工具。
 *
 * baseUrl:agent 生成"添加机器"命令需要 dph 的公网域名。优先读 remote-web-ui 的
 * publicBaseUrl 设置(settings.yaml: remote-web-ui.publicBaseUrl),回退请求 Host。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.js'
import { SshProvisioner } from './provisioner-ssh.js'
import { makeRoutes } from './routes.js'
import { sshStorePath } from './ssh-host-writer.js'

export const name = 'fleet'
export const inject = ['webServer', 'systemPrompt']

// 零外部依赖:不用 schemastery Config(link 插件解析不到)。中继配置存 dsh-fleet.json,
// 经 POST /api/fleet/relay 设置。

const SECTION_ORDER = 151
const GUIDANCE = '本机已安装 dsh-fleet 插件(dph 公网组网)。作用:把异地机器(behind NAT)经一次性 token 拉进车队——用户在 dph 网页(或调 POST /api/fleet/token)铸造 token,得到一行 `curl .../join | bash` 命令,在新机器执行后,机器 sshd 经反向隧道映射到云中继环回口,hub 经 ProxyJump 够到它。入网机器会作为一条别名 fleet-* 的 dsh-ssh 主机出现,因此直接用 ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster 操作它,与局域网机器无异。列表/吊销:GET /api/fleet/list、POST /api/fleet/revoke(按 alias)。安全:token 一次性+可过期+可单台吊销;每台机器独立隧道密钥;机器 sshd 只绑中继环回、不暴露公网。用户提到「异地电脑 / 公网组网 / 加一台机器 / 入网 / 远程纳管」时即指本插件。'

export function apply(ctx) {
  const store = new FleetStore()
  const provisioner = new SshProvisioner(() => store.load().relay)

  // dph 公网域名:优先 settings 的 remote-web-ui.publicBaseUrl。
  const baseUrl = () => {
    try {
      const settings = ctx.settings?.get?.('remote-web-ui')
      if (settings?.publicBaseUrl) return String(settings.publicBaseUrl).replace(/\/+$/, '')
    } catch { /* fall through */ }
    return 'http://127.0.0.1:3080'
  }

  const routes = makeRoutes({ store, provisioner, sshStorePath: sshStorePath(), baseUrl })

  ctx.effect(() => {
    const disposers = routes.map(r => ctx.webServer.register(r))
    return () => { for (const d of disposers) d() }
  }, 'dsh-fleet: routes')

  const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-fleet', order: SECTION_ORDER, text: GUIDANCE })
  ctx.effect(() => () => disposeSection(), 'dsh-fleet: prompt section')
}
```

> `ctx.settings?.get?.(...)` 是保守取法(settings 服务存在时读取,否则回退)。若 profile 的 settings API 名称不同,在集成时按 `~/.dsh/settings.yaml` 已有的 `remote-web-ui.publicBaseUrl` 键对齐读取方式;端到端测试会暴露取值是否成功。

- [ ] **Step 3: 语法自检**

Run: `cd ~/twh/workspace/dsh-fleet && node --check lib/index.js && node --check lib/routes.js`
Expected: 无输出(语法 OK)。

- [ ] **Step 4: Commit**

```bash
git add dsh-fleet/lib/index.js dsh-fleet/cordis.patch.yml
git commit -m "feat(dsh-fleet): plugin entry + bundle mount"
```

---

# M2 — 中继底座

## Task 12: scripts/relay-init.sh —— 中继一次性初始化

**Files:**
- Create: `scripts/relay-init.sh`

在中继 `175.24.133.218` 上以 sudo 跑一次:建受限 `tunnel` 账号 + sshd Match 限制。

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# 在云中继上跑一次(需 sudo)。建受限 tunnel 账号:只能做反向端口转发(-R)、开不了
# shell/pty、开不了本地转发;端口强制绑环回(GatewayPorts no)。hub 侧不新建账号,
# 用现有账号(ubuntu)做 ProxyJump 跳板。
set -euo pipefail
TUNNEL_USER="${1:-tunnel}"

id -u "${TUNNEL_USER}" >/dev/null 2>&1 || sudo useradd -m -s /usr/sbin/nologin "${TUNNEL_USER}"
sudo mkdir -p "/home/${TUNNEL_USER}/.ssh"
sudo touch "/home/${TUNNEL_USER}/.ssh/authorized_keys"
sudo chown -R "${TUNNEL_USER}:${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh"
sudo chmod 700 "/home/${TUNNEL_USER}/.ssh"
sudo chmod 600 "/home/${TUNNEL_USER}/.ssh/authorized_keys"

DROPIN="/etc/ssh/sshd_config.d/dsh-fleet.conf"
sudo tee "${DROPIN}" >/dev/null <<EOF
# dsh-fleet:tunnel 账号只准反向转发,绑环回,禁 shell/pty/本地转发。
Match User ${TUNNEL_USER}
    AllowTcpForwarding remote
    PermitOpen none
    PermitListen 127.0.0.1:20001 127.0.0.1:20999
    GatewayPorts no
    X11Forwarding no
    PermitTTY no
    AllowAgentForwarding no
    ForceCommand /usr/sbin/nologin
EOF
# 注:PermitListen 的端口段需与 dsh-fleet.json relay.portRange 一致;OpenSSH 支持
# 空格分隔的多个 host:port,但不支持区间通配,故这里列首尾——生产可用逗号枚举或
# 简化为 `PermitListen 127.0.0.1:*` 并靠每台 authorized_keys 的 permitlisten 锁死单端口。
sudo sed -i 's|^ *PermitListen 127.0.0.1:20001 127.0.0.1:20999|    PermitListen 127.0.0.1:*|' "${DROPIN}"

sudo sshd -t
sudo systemctl reload ssh || sudo systemctl reload sshd
echo "relay-init: tunnel 账号就绪。authorized_keys=/home/${TUNNEL_USER}/.ssh/authorized_keys"
```

- [ ] **Step 2: 静态检查(shellcheck 或 bash -n)**

Run: `bash -n scripts/relay-init.sh && command -v shellcheck >/dev/null && shellcheck scripts/relay-init.sh || echo "shellcheck 未装,跳过"`
Expected: 无语法错误。

- [ ] **Step 3: 在中继上执行(手动,一次)**

Run(在 hub,经现有中继访问):
```bash
scp ~/twh/workspace/dsh-fleet/scripts/relay-init.sh ubuntu@175.24.133.218:/tmp/
ssh ubuntu@175.24.133.218 'bash /tmp/relay-init.sh tunnel'
```
Expected: 打印 `relay-init: tunnel 账号就绪`;`sudo sshd -t` 无报错。

- [ ] **Step 4: Commit**

```bash
git add dsh-fleet/scripts/relay-init.sh
git commit -m "feat(dsh-fleet): relay bootstrap for locked tunnel account"
```

---

## Task 13: provisioner-ssh.js —— 真 Provisioner

**Files:**
- Create: `lib/provisioner-ssh.js`
- Test: `test/provisioner-ssh.test.js`(仅测密钥生成落盘;推中继为手动集成)

- [ ] **Step 1: 写测试(只测本地 keygen)**

```js
// test/provisioner-ssh.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshProvisioner } from '../lib/provisioner-ssh.js'

test('generateOpKeypair produces an ed25519 keypair on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'))
  try {
    const prov = new SshProvisioner(() => ({ host: 'h', port: 22, tunnelUser: 't', jumpAlias: 'j', portRange: [20001, 20999] }), dir)
    const { operationPublicKey, opPrivKeyPath } = await prov.generateOpKeypair('fleet-pc')
    assert.ok(existsSync(opPrivKeyPath))
    assert.ok(existsSync(opPrivKeyPath + '.pub'))
    assert.match(operationPublicKey, /^ssh-ed25519 /)
    assert.match(readFileSync(opPrivKeyPath, 'utf8'), /OPENSSH PRIVATE KEY/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/provisioner-ssh.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 provisioner-ssh.js**

```js
// lib/provisioner-ssh.js
/**
 * 真 Provisioner:
 *   generateOpKeypair —— 在 hub 本地 ssh-keygen 生成操作密钥对,私钥存
 *     ~/.dsh/fleet/keys/<alias>.op,回传公钥文本 + 私钥路径。
 *   pushTunnelKey —— ssh 到中继,用 hub 现有账号(ProxyJump 同一账号),把机器隧道公钥
 *     以 restrict,permitlisten="127.0.0.1:<port>" 前缀追加进 tunnel 账号 authorized_keys。
 *   removeTunnelKey —— 删掉带该端口 permitlisten 标记的行。
 *
 * 说明:pushTunnelKey/removeTunnelKey 依赖 hub 能免密 ssh 到中继(现状已具备:hub 已
 * 有中继访问)。中继登录目标由 relay() 提供;这里用 relay.jumpLogin(如 'ubuntu@175.24.133.218')。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class SshProvisioner {
  /**
   * @param {()=>object} relay 返回 relay 配置(host/port/tunnelUser/portRange,及可选 jumpLogin)
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

  /** 中继登录串:relay.jumpLogin 优先,否则 ubuntu@<host>。 */
  _jump() {
    const r = this.relay()
    return { login: r.jumpLogin ?? `ubuntu@${r.host}`, port: r.port ?? 22, tunnelUser: r.tunnelUser ?? 'tunnel' }
  }

  async pushTunnelKey(pubkey, port) {
    const { login, port: p, tunnelUser } = this._jump()
    // permitlisten 锁死本机环回单端口;restrict 关掉一切多余能力。
    const line = `restrict,permitlisten="127.0.0.1:${port}" ${pubkey}`
    const authPath = `/home/${tunnelUser}/.ssh/authorized_keys`
    // 幂等:先删旧的同端口行,再追加。
    const remote = `sudo sh -c 'touch ${authPath}; grep -v "permitlisten=\\"127.0.0.1:${port}\\"" ${authPath} > ${authPath}.tmp || true; mv ${authPath}.tmp ${authPath}; printf "%s\\n" ${shq(line)} >> ${authPath}; chown ${tunnelUser}:${tunnelUser} ${authPath}; chmod 600 ${authPath}'`
    await run('ssh', ['-p', String(p), '-o', 'StrictHostKeyChecking=accept-new', login, remote])
  }

  async removeTunnelKey(port) {
    const { login, port: p, tunnelUser } = this._jump()
    const authPath = `/home/${tunnelUser}/.ssh/authorized_keys`
    const remote = `sudo sh -c 'test -f ${authPath} && grep -v "permitlisten=\\"127.0.0.1:${port}\\"" ${authPath} > ${authPath}.tmp && mv ${authPath}.tmp ${authPath} && chown ${tunnelUser}:${tunnelUser} ${authPath} && chmod 600 ${authPath} || true'`
    await run('ssh', ['-p', String(p), '-o', 'StrictHostKeyChecking=accept-new', login, remote])
  }
}

/** 单引号安全包裹(shell)。 */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/twh/workspace/dsh-fleet && node --test test/provisioner-ssh.test.js`
Expected: PASS(1 test,需系统有 ssh-keygen)。

- [ ] **Step 5: Commit**

```bash
git add dsh-fleet/lib/provisioner-ssh.js dsh-fleet/test/provisioner-ssh.test.js
git commit -m "feat(dsh-fleet): real ssh provisioner (keygen + relay push)"
```

---

# M3 — Linux 端到端

## Task 14: relay-jump 主机条目 + 挂载 + 端到端联调

**Files:**
- Modify: `~/.dsh/profiles/web/package.json`(加 link 依赖 + bundles 列表)
- Modify: `~/.dsh/cordis.patch.yml`(或 profile 层)确认 fleet 行被 insert
- Create: `~/.dsh/dsh-ssh.json` 里新增 `relay-jump` 跳板条目(经 dsh-ssh 网页或手写)

- [ ] **Step 1: 写 relay-jump 跳板条目**

在 `~/.dsh/dsh-ssh.json` 的 `hosts` 里加(用 hub 现有中继私钥;若你现在用密码/其它 key,按实际填):

```jsonc
{
  "alias": "relay-jump", "host": "175.24.133.218", "port": 22, "user": "ubuntu",
  "auth": { "kind": "key", "keyPath": "~/.ssh/id_ed25519" },
  "proxyJump": [], "tags": ["fleet","jump"],
  "description": "dsh-fleet 中继跳板(hub→机器 ProxyJump)",
  "createdAt": 0, "updatedAt": 0
}
```

验证 hub 能经它连中继:
Run: `ssh -i ~/.ssh/id_ed25519 ubuntu@175.24.133.218 'echo relay-ok'`
Expected: `relay-ok`。

- [ ] **Step 2: 用 link 把 dsh-fleet 挂进 profile**

编辑 `~/.dsh/profiles/web/package.json`:`dependencies` 加
`"dsh-fleet": "link:/home/wl/twh/workspace/dsh-fleet"`,`dsh.profile.bundles` 数组末尾加 `"dsh-fleet"`。然后:

Run:
```bash
cd ~/.dsh/profiles/web && pnpm install
```
Expected: 建立 `node_modules/dsh-fleet` 软链,无报错。

- [ ] **Step 3: 重启 dsh web,确认插件加载**

Run: `bash ~/twh/workspace/restart-dsh-web.sh && sleep 3 && grep -i fleet ~/.dsh/dsh-web.log | head`
Expected: 日志无 fleet 相关报错;`dsh --profile web --dump-config | grep fleet` 能看到 `id: fleet` 行。

- [ ] **Step 4: 铸造 token(经本机 loopback,验证路由通)**

Run:
```bash
curl -fsS -X POST http://127.0.0.1:3080/api/fleet/token \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3080' \
  -d '{"alias":"testpc","os":"linux"}'
```
Expected: 返回 JSON,含 `token`、`command`(形如 `curl -fsSL 'https://<你的域名>/join?token=...' | bash`)。

- [ ] **Step 5: 在一台真 Linux 机器(异地或另一台)入网**

在目标机器执行上一步返回的 `command`。
Expected:脚本打印 `dsh-fleet: 已入网(端口 200xx)`;`systemctl --user status dsh-fleet-tunnel` 为 active。

- [ ] **Step 6: 验证 agent 能操作它**

Run(在 hub,经 dsh-ssh 工具或直接命令行验证 ProxyJump 通):
```bash
ssh -J ubuntu@175.24.133.218 -i ~/.dsh/fleet/keys/fleet-testpc.op -p 200XX wl@127.0.0.1 'uname -a'
```
(200XX 为分配端口;命令等价于 dsh-ssh 用该主机条目做的事。)
Expected: 打印目标机器的 `uname -a`。随后在 dph 网页对话里让 agent `ssh_exec` 该主机也应成功。

- [ ] **Step 7: 验证断线自恢复**

在目标机器:`systemctl --user restart dsh-fleet-tunnel`;等 10 秒。
Expected: 隧道重新建立,Step 6 的命令仍通。

- [ ] **Step 8: 验证吊销**

Run:
```bash
curl -fsS -X POST http://127.0.0.1:3080/api/fleet/revoke \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3080' \
  -d '{"alias":"testpc"}'
```
Expected: `{"ok":true}`;之后 Step 6 的命令**连不上**(中继授权行已删、dsh-ssh 条目已删);旧 token 复用 enroll 返回 403 consumed。

- [ ] **Step 9: 收尾提交(记录联调结论)**

```bash
git add dsh-fleet/docs
git commit -m "docs(dsh-fleet): M3 linux end-to-end verified" --allow-empty
```

---

# 发布 — 社区插件

## Task 15: 社区发布准备(去个人化 + 元数据 + 打包)

**Files:**
- Modify: `package.json`(元数据)、`README.md`(通用文档)
- Create: `LICENSE`(MIT)

- [ ] **Step 1: 去个人化自检(硬门禁)**

Run:
```bash
cd ~/twh/workspace/dsh-fleet
grep -rInE '175\.24\.133\.218|trycloudflare\.com|/home/wl|IrmaGillomy|dongjuan' lib scripts \
  && echo "❌ 发现个人数据,必须清除" || echo "✅ lib/scripts 无个人数据"
```
Expected: `✅ lib/scripts 无个人数据`。若命中(除 README/docs 举例外),改成配置项/占位符。

- [ ] **Step 2: 写 LICENSE(MIT)**

```
MIT License

Copyright (c) 2026 dsh-fleet contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: 补齐 package.json 发布元数据**

把 Task 1 的 `package.json` 改为(去掉 `private`,加 keywords/repository/author/files):

```json
{
  "name": "dsh-fleet",
  "description": "DSH fleet enrollment over the internet: enroll an off-site machine (behind NAT) into your dph via a one-time token and a reverse tunnel to your own relay VPS; the machine appears as a dsh-ssh host and is driven by the existing ssh_* agent tools. Bring-your-own relay, one-time revocable tokens, per-machine keys, sshd never exposed publicly.",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "keywords": ["dsh-plugin", "deepseek-harness", "reverse-tunnel", "fleet", "remote", "ssh"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["lib/**/*.js", "scripts/**/*.sh", "cordis.patch.yml", "README.md", "LICENSE"],
  "scripts": { "test": "node --test" },
  "repository": { "type": "git", "url": "git+https://github.com/<你的用户名>/dsh-fleet.git" },
  "author": "",
  "license": "MIT"
}
```

- [ ] **Step 4: 扩写 README(通用装配/配置/安全)**

README 覆盖:一句话简介;架构图(hub+中继+机器星型);**先决条件**(一台公网中继 VPS、hub 能 ssh 到它);**装配**(profile `link:`/`npm` + cordis.patch insert);**配置**(settings.yaml 里 `dsh-fleet.relayHost/relayPort/relayTunnelUser/relayJumpLogin`);**中继初始化**(`scripts/relay-init.sh`);**用法**(网页/curl 铸 token→机器一行命令入网→agent ssh_exec);**安全模型**(环回绑定、每台密钥、token 一次性、吊销);**限制**(MVP 仅 Linux;需机器运行 sshd)。不含任何真实 IP/域名/用户名。

- [ ] **Step 5: 打包 dry-run**

Run: `cd ~/twh/workspace/dsh-fleet && npm pack --dry-run`
Expected: 列出将发布的文件仅含 `lib/*.js`、`scripts/*.sh`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`——**无 test/**、**无 docs/**、**无个人文件**。

- [ ] **Step 6: 独立仓库 + 打 topic(需你的 GitHub)**

> 需要你的 GitHub 账号(`gh auth status` 已登录)。这一步会把插件推成一个独立公开仓库并打 `dsh-plugin` topic(社区据此发现)。

Run(占位用户名替换为实际):
```bash
cd ~/twh/workspace/dsh-fleet
gh repo create dsh-fleet --public --source=. --remote=origin \
  --description "DSH fleet enrollment over the internet (bring-your-own relay)"
git push -u origin HEAD
gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness
```
Expected: 仓库创建、推送成功、topic 生效。(可选 `npm publish` 发到 npm。)

- [ ] **Step 7: Commit**

```bash
git add dsh-fleet/package.json dsh-fleet/LICENSE dsh-fleet/README.md
git commit -m "chore(dsh-fleet): community-ready metadata, LICENSE, README"
```

---

## 自审(计划 vs spec)

- **spec §5 入网协议** → Task 3/7/8/9/10(token→enroll→路由→join 脚本),含一次性消耗与 heartbeat。✅
- **spec §6.1 hub 插件(token/路由/面板/prompt)** → Task 10(路由:token/list/revoke/join/enroll/heartbeat)+ Task 11(prompt section)。**Web 面板(§6.1 UI)未在本 MVP**——列为 M4 独立计划,MVP 用 `/api/fleet/token` 路由 + curl 触发。已在计划标题与范围声明。✅(有意分期)
- **spec §6.2 join 客户端** → Task 9(Linux 版文本)+ Task 14(真机联调);mac/Win 为 M5。✅(有意分期)
- **spec §6.3 中继初始化** → Task 12。✅
- **spec §7 数据模型** → Task 2(dsh-fleet.json)+ Task 5(dsh-ssh 条目)。字段名与本计划"数据形状"节一致。✅
- **spec §8 安全**:环回绑定(join 脚本 `-R 127.0.0.1:PORT`,中继 `GatewayPorts no`/`permitlisten`)、每台独立密钥(隧道机器生成、操作 hub 生成)、token 一次性+TTL+吊销、`from="127.0.0.1,::1"`、全 key 无明文——分别落在 Task 9/12/3/8/13。✅
- **spec §10 测试**:token/端口/enroll 单测 + Linux 端到端(Task 14 Step 5-8)。✅

**类型/命名一致性检查**:`FleetStore`、`mintToken/consumeToken/listTokens/revokeToken`、`allocatePort`、`upsertFleetHost/removeFleetHost`、`fromTunnelOrLocal/sameOriginBrowser`、`FakeProvisioner/SshProvisioner`(`generateOpKeypair/pushTunnelKey/removeTunnelKey`)、`enrollMachine/markOnline`、`makeRoutes`、`renderLinuxJoinScript` —— 各任务引用一致。✅

**社区化检查**:零外部依赖(只用 `node:` 内置,不 import schemastery);中继无硬编码(Task 2 `DEFAULT_RELAY.host=''`,经 `POST /api/fleet/relay` 设置);测试用 `relay.example`/`203.0.113.9` 文档示例段,不含真实 IP;Task 15 去个人化门禁 + MIT + `dsh-plugin` topic + `npm pack` 白名单。✅

## 后续计划(非本 MVP)

- **M4 Web 面板**:dsh-fleet 客户端半(React),"添加机器"对话框(调 `/api/fleet/token`、展示一行命令 + 复制)、机器列表/在线状态/吊销按钮。挂在 dsh-ssh 面板旁。
- **M5 mac/Windows join**:`renderMacJoinScript`(launchd)、`renderWinJoinScript`(PowerShell + 计划任务);`/join?os=mac|win` 分发。
- **可选**:用 frp 替代 `ssh -R` 做隧道传输(参考社区 `dsh-webgate`),更强的断线重连与多路复用。
