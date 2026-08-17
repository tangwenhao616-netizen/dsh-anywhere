# SSH 执行世界 / 远程工作区 —— 实现计划

> 基于 [设计 spec](../specs/2026-08-18-ssh-execution-world-design.md)。POC(`~/twh/workspace/dsh-fs-ssh-poc`)已端到端验证,作为参考实现。产品化落进 dsh monorepo(`~/deepseek-harness`),遵守其约定(TS strict、每包 `./invariant`、real-composition 测试、快照、Agent Note、`test:coverage` 100%)。

**Goal:** 让一个 dsh 会话的执行世界(fs+shell+search)落在一台远程 fleet 机器上,agent 原生工具在那生效,大脑仍在 hub;并支持每会话选择目标机器。

**Architecture:** 一组共享同一条 SSH 连接的远程 provider(fs-ssh / shell-ssh / search-ssh)替换本地 provider;目标 = fleet 入网机器(ProxyJump)。

---

## M0 — 先调研两个决定成败的未知(动手前必做)

### Task 0.1: E2B 执行世界是全局还是每会话?
- 读 `packages/e2b/*` + `.agents/notes/**/2026-07-28-portable-execution-world-consumers.md`。
- 产出:dsh 里 fs/shell provider 能否**会话级作用域**;若只能 profile 级 → M5 需要引入会话级机制或"每机器一 profile"的降级方案。**这决定 M5 可行性,先答。**

### Task 0.2: shell/subprocess Service Definition 契约
- 读 `packages/shell/*`、`packages/subprocess/*`(Service Definition + local provider + Consumer)。
- 产出:shell-ssh 要实现的方法清单(exec/spawn/PTY/信号/cwd/env),对照 dsh-ssh 现有 exec 引擎能复用多少。

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

## M2 — shell-ssh(bash 远程)

### Task 2.1: `shell-ssh` provider
- Create `packages/ssh-world/shell-ssh/`:实现 `ctx.shell`(或 subprocess)Service Definition(M0.2 定的方法),经 ssh exec/PTY 在远程跑命令;复用 dsh-ssh 的 ssh2 exec 引擎或系统 ssh(与 fs-ssh 共享 ControlMaster 连接)。
- cwd/env/信号/退出码/流式 stdout-stderr。

**M2 验收**:agent 的 `bash` 工具在远程机器执行(如 `bash: uname -a` 返回远程主机信息);cwd 与 fs-ssh 的工作区一致。

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

## M5 — 每会话执行世界 + 远程目录选择器(核心 UX)

### Task 5.1: 会话级执行世界选择(依赖 M0.1 结论)
- 若会话级 provider 作用域可行:会话创建时选 target(机器 X + 目录),该会话的 fs/shell/search 挂 SSH 版,其余会话保持本地。
- 若不可行:降级为"每台机器一个 profile",UX 上用 profile 切换代替会话切换。

### Task 5.2: 远程目录选择器
- 扩展 directory-picker seam:列举/选择一台 fleet 机器上的目录(经 ssh);选定即把该会话执行世界指向 machine X 的该目录。

**M5 验收**:一个 dsh 里,新建会话可选"本地(1.44)"或"某台 fleet 机器"的工作区;两类会话并存,各自工具落在各自机器。

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
