# SSH 执行世界 / 远程工作区 —— 实现计划

> 基于 [设计 spec](../specs/2026-08-18-ssh-execution-world-design.md)。POC(`~/twh/workspace/dsh-fs-ssh-poc`)已端到端验证,作为参考实现。产品化落进 dsh monorepo(`~/deepseek-harness`),遵守其约定(TS strict、每包 `./invariant`、real-composition 测试、快照、Agent Note、`test:coverage` 100%)。

**Goal:** 让一个 dsh 会话的执行世界(fs+shell+search)落在一台远程 fleet 机器上,agent 原生工具在那生效,大脑仍在 hub;并支持每会话选择目标机器。

**Architecture:** 一组共享同一条 SSH 连接的远程 provider(fs-ssh / shell-ssh / search-ssh)替换本地 provider;目标 = fleet 入网机器(ProxyJump)。

---

## M0 — 调研结论(2026-08-18,已完成)✅

### 0.1 执行世界是**每实例**,不是每会话
- `ctx.fs` + `ctx.subprocess` **合起来定义一个执行世界**;bash/终端/LSP/grep 是只消费这两个接口的 **provider-neutral consumer**(见 note `2026-07-28-portable-execution-world-consumers.md`)。
- E2B 挂法(`examples/headless-agent/e2b.cordis.yml`)= **全局**禁 `fs-local`+`subprocess-local`、插 `e2b`(sandbox owner)+`fs-e2b`+`subprocess-e2b`,整个实例执行世界搬远程。**"一世界不变式"**:`fs.cwd == subprocess.cwd == sandbox.workspaceRoot` 必须同指一个远程目录。
- **结论**:fs/subprocess 是实例级服务,**每会话混合世界(有的本地有的远程)当前不支持**,要支持须把这两个 seam 改成 scope-aware(`dsh-scope` 有 per-agent 作用域,但 fs/subprocess 未 scope-aware)——那是 dsh 核心大改。
- **对计划的影响**:**M5 改为「每实例执行世界」作为出货形态**(E2B 同款,已证);"每会话切换 / 1.44 与远程并存"= **跑两个 dsh 实例**(或切实例的世界),per-session 混合列为**未来核心增强**(scope-aware fs/subprocess),单独立项。

### 0.2 要建的是 **subprocess-ssh**(不是 shell-ssh)
- `ctx.subprocess` = `SubprocessRuntime extends Service`,三抽象方法:`resolveExecutable(...)`、`spawn(spec): SubprocessHandle`、`spawnTerminal(spec): Promise<SubprocessTerminalHandle>`(PTY:文本 I/O + 前台进程组 + 信号 + TERM→KILL 静默)。
- 做好 fs-ssh + subprocess-ssh 两个 provider,**bash/grep/终端/LSP 自动落远程**(它们 provider-neutral)。`spawnTerminal` 走 `ssh -tt` 的 PTY;可复用 dsh-ssh 的 ssh2 shell/PTY 引擎。
- **SSH 世界 = 三包**(同 E2B 结构):`ssh-world`(SSH 连接 owner + ControlMaster 复用)+ `fs-ssh`(ctx.fs)+ `subprocess-ssh`(ctx.subprocess)。

---

## M1 — fs-ssh 硬化 + 连接复用

### Task 1.1: 把 POC 的 SshFsCore 移植成 monorepo 包 `fs-ssh`
- Create `packages/ssh-world/fs-ssh/`(TS):`class SshFileSystem extends FileSystem`(@deepseek-ai/dsh-fs)。
- 12 方法照 POC 语义(resolve/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText/processPath/fileUrl/contains);FsError/FsTarget/FsVersion 用真类型。
- `./invariant`、README(Model Experience 格式)、Agent Note。

### Task 1.2: 连接复用(消掉 per-op ssh 开销 —— 用户已感知的"卡")
- 选型:**SSH ControlMaster**(`-o ControlMaster=auto -o ControlPath=~/.dsh/ssh-world/cm-%C -o ControlPersist=300`)最省事、零依赖,首连建 master、后续复用;或 **ssh2 持久连接 + SFTP**(更快但引入 ssh2 依赖 + 自管重连)。**先做 ControlMaster 版**(改动最小),benchmark 后再评估 ssh2。
- Test:同一 target 连续 N 次 fs 操作,ControlMaster 下延迟显著低于逐次新连。

### Task 1.3: 精确 CRLF 还原 + 真流式 streamText + sandbox 语义决策
- writeText/editText 的 CRLF 还原(照 fs-e2b);streamText 走 SFTP 分块(大文件)。
- 决定 fs-ssh 的 `sandboxMode`:是否自带 workspace-write 围栏,还是把策略层留给 `fs-observation-policy`(POC 直接禁了 fs-sandbox)。

**M1 验收**:对一台远程机跑 fs 契约单测全绿;ControlMaster 下 fs 操作延迟达标;boot 一个挂 fs-ssh 的 profile,agent read/write/edit 在远程生效(复刻 POC demo,但用连接复用)。

---

## M2 — subprocess-ssh(`ctx.subprocess` 远程;bash/终端/LSP 自动落远程)

### Task 2.1: `subprocess-ssh` provider(实现 `ctx.subprocess` = SubprocessRuntime 三方法)
- Create `packages/ssh-world/subprocess-ssh/`:`class extends SubprocessRuntime`:
  - `resolveExecutable`:远程 `command -v` / PATH 查找。
  - `spawn(spec): SubprocessHandle`:远程进程(raw/collected),经共享 SSH 连接跑;stdout/stderr 流、退出码、信号、cwd、env。
  - `spawnTerminal(spec): Promise<SubprocessTerminalHandle>`:PTY —— `ssh -tt` 控制终端;文本 I/O、前台进程组查询/信号、TERM→KILL 静默。复用 dsh-ssh 的 ssh2 shell/PTY 引擎。
- 与 fs-ssh 共享同一条 SSH 连接 + 同一远程 cwd(遵守"一世界不变式")。

**M2 验收**:agent 的 `bash` 在远程执行(`uname -a` 返回远程主机);持久终端(tool-terminal)在远程可用;cwd 与 fs-ssh 工作区一致。bash/grep/终端/LSP provider-neutral,自动落远程。

---

## M3 — search-ssh(glob/grep 远程)

### Task 3.1: 远程 ripgrep
- `tool-fs-search` 经 `ctx.subprocess` 跑 rg。M2 后 subprocess 已远程 → 确认 `glob`/`grep` 自动落远程;远程缺 rg 时:推送打包的 `@vscode/ripgrep` 二进制到远程临时目录,或降级 `grep -r`/`find`。

**M3 验收**:agent 的 `grep`/`glob` 在远程机器的文件树上搜索,结果与远程 `read` 同根、可跟读。

---

## M4 — execution-world 合成 bundle

### Task 4.1: 一个 bundle 面向一台目标机器合成挂载
- Create `packages/bundle/ssh-world/`(或 patch 层):对一个 target 同时挂 fs-ssh + shell-ssh + search-ssh,禁掉对应本地 provider。config:target 的 sshArgs/login/cwd。
- 复刻 POC 的稳态(全局/每 profile 一个 target),作为 M5 之前的可用形态。

**M4 验收**:`dsh --profile <ssh-world-profile>` 整个执行世界在远程,agent read/write/bash/grep 全落远程。

---

## M5 — 每实例执行世界 + 机器/目录选择(出货形态;per-session 为未来核心增强)

> M0.1 结论:fs/subprocess 是实例级、非 scope-aware,**每会话混合世界当前不支持**。出货先做每实例。

### Task 5.1: 每实例执行世界(E2B 同款)
- 一个 dsh 实例的执行世界 = 一台选定机器:profile 模板/开关选 target(机器 X + 远程 cwd),整实例 fs/subprocess → 该机器,遵守一世界不变式。
- **"1.44 与远程并存"** = 跑两个 dsh 实例(1.44 本地 profile + 远程世界 profile),或切实例 target。

### Task 5.2: 机器/目录选择器
- 启动/切换时选 target 机器(fleet 已入网列表)+ 远程目录(经 ssh 列),写进该实例执行世界配置。

### Task 5.3(未来核心增强,单独立项):scope-aware fs/subprocess → 真·每会话混合世界
- 把 fs/subprocess seam 改成 scope-aware(基于 `dsh-scope` per-agent 作用域),让不同会话用不同执行世界。dsh 核心大改,风险/工作量大,不在本计划范围。

**M5 验收**:选一台机器 → 该 dsh 实例整个工作区落在它上面,agent 用 hub 模型在它文件/进程上干活;并存靠多实例。

---

## M6 — fleet 集成

### Task 6.1: target = fleet 入网机器
- 从 dsh-ssh 主机表读该 fleet 机器条目(`host=127.0.0.1, port, proxyJump=[relay-jump], key`),推导 fs-ssh/shell-ssh 的 sshArgs(带 ProxyJump)。POC 用中继直连验证过机制,此处仅换连接参数。
- 远程目录选择器的机器列表 = fleet 已入网机器(`/api/fleet/list` 或 dsh-ssh `fleet-*` 主机)。

**M6 验收**:在面板/选择器里选一台真实 fleet 入网机器,新建会话工作区落在它上面,agent 用 hub 模型在它的文件上干活——即完整 vision。

---

## 自审(计划 vs spec)
- fs-ssh(§4.1)→ M1;shell-ssh(§4.2)→ M2;search-ssh(§4.3)→ M3;合成(§4.4)→ M4;每会话+目录选择器(§4.5/4.6)→ M5;fleet 集成(§4.7)→ M6;连接复用(§5 性能)→ M1.2;每会话作用域难点(§5)→ M0.1 先调研。✅
- 风险前置:M0 先答"会话级作用域可行否"与"shell 契约",避免 M5 才发现不可行。
