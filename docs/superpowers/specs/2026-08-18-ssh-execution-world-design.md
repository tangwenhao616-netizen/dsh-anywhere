# SSH 执行世界 / 远程工作区 —— 设计文档

- 日期:2026-08-18
- 状态:POC 已端到端验证;本文为产品化设计
- 前置:POC(`~/twh/workspace/dsh-fs-ssh-poc`)已证 Level-1(fs-ssh 对真实远程机读写改列 + 版本守卫)与 Level-2(挂进真实 dsh boot,agent 的 read/write 工具作用在远程机器,中继实地核实)。

## 1. 目标

让**一套 dsh 大脑**(模型/配置/记忆/技能都在 hub)的**一个会话的"执行世界"落在一台远程机器上**——agent 的原生工具(`read/write/edit/ls/bash/glob/grep`)透明地在那台机器的文件与进程上运行,而推理仍用 hub 的模型。配合**每会话选择**,同一个 dsh 可以:在异地电脑本地建工作区干活,同时能切到 1.44 本地工作区。把"hub 操作异地机器"与"异地用 hub 的模型"两个方向,在**执行世界(execution world)**这一层统一。

远程目标 = 一台 **fleet 入网机器**(经 [[dsh-fleet]] 的反向隧道 + ProxyJump 可达),或任意 SSH 主机。

## 2. 为什么架构上成立(已查证)

dsh 的文件系统 `ctx.fs`、shell/subprocess、搜索都是**可替换 capability seam**(Service Definition / Provider / Consumer)。`packages/e2b/fs-e2b` 就是"远程 FileSystem"先例(远程后端可替换 fs-local 而不动工具 schema)。POC 已把这条路走通:`SshFsCore`(fs over ssh)→ `SshFileSystem extends @deepseek-ai/dsh-fs` 注册 `ctx.fs` → agent 工具据此落在远程。

## 3. 架构:一套"远程 provider"合成执行世界

**执行世界** = 面向同一台远程机器的一组 provider,共享一条 SSH 连接:
- **fs-ssh** —— `ctx.fs`(FileSystem)经 SFTP/ssh 在远程读写。
- **shell-ssh** —— `ctx.shell` / `ctx.subprocess` 经 ssh exec/PTY 在远程执行命令。
- **search-ssh** —— `glob`/`grep` 经远程 ripgrep(或 find/grep)。

```
hub dsh(大脑:模型/记忆/技能/agent-loop)
   │  会话 A 的执行世界 = 本地(fs-local/shell-local) → 1.44 工作区
   │  会话 B 的执行世界 = SSH(fs-ssh/shell-ssh/search-ssh)→ 异地机器工作区
   ▼                         │ 一条复用的 SSH 连接(ControlMaster / ssh2 持久连接)
[fleet 入网机器] ◄── ProxyJump 经中继 ── 同 fleet 的 hub→机器 连法
   agent 的 read/write/edit/bash/grep 在这台机器的文件/进程上生效
```

## 4. 组件

1. **fs-ssh(FileSystem provider)** —— 由 POC `SshFsCore` 硬化:
   - 全部 12 方法(resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText),已在 POC 实现并验证。
   - **连接复用**:POC 每个 fs 操作起一次 `ssh`(慢,即用户说的"卡")。产品化用 **SSH ControlMaster**(`-o ControlMaster=auto -o ControlPath=… -o ControlPersist=…`)或 **ssh2 持久连接 + SFTP**,让每次 fs 操作复用同一条连接,消掉 per-op 握手开销。
   - 真流式 streamText、精确 CRLF 还原、原子写(tmp+rename,已有)、版本身份(mtime:size:inode,已有)。
   - 可选 sandbox 语义(见 §6)。
2. **shell-ssh(shell/subprocess provider)** —— `bash` 等在远程跑:复用 dsh-ssh 的 ssh2 exec/PTY 引擎(或系统 ssh)。实现 `ctx.shell` 的 Service Definition。
3. **search-ssh(glob/grep)** —— 远程 ripgrep(推送 `rg` 二进制或用远程已有 `rg`/`grep`/`find`)。`tool-fs-search` 走 `ctx.subprocess`,所以 shell-ssh 到位后 search 大体自动落远程,仅需保证远程有 rg。
4. **execution-world 合成** —— 一个 bundle/插件,面向一个目标机器同时挂 fs-ssh + shell-ssh + search-ssh,并禁掉对应的本地 provider(POC 用 `- id: fs-sandbox\n disabled: true` + insert fs-ssh 证过)。
5. **每会话执行世界选择** —— 会话级 provider 作用域:有的会话本地、有的指向机器 X。**这是最硬的一环**(POC 是整 profile 全局换)。须研究 dsh 如何做会话级 provider 作用域(E2B 是全局还是每会话?见"portable execution world consumers" note)。
6. **远程目录选择器** —— 在 directory-picker seam 里增加"选一台 fleet 机器上的目录"(经 ssh 列远程目录)。
7. **fleet 集成** —— 目标从"中继直连"换成"fleet 入网机器":`sshArgs` 由该机器的 dsh-ssh 主机条目(`host=127.0.0.1, port, proxyJump=[relay-jump], key`)推导。POC 已用中继直连验证机制,换成 ProxyJump 仅是参数变化。

## 5. 关键挑战(诚实标注)

- **★ 每会话 provider 作用域**:让不同会话用不同执行世界,是产品化的核心难点。若 dsh 的 fs/shell 只能 profile 级挂载,则需要引入会话级作用域机制(或每台机器一个 profile)。必须先调研 E2B 集成怎么处理。
- **性能/连接复用**:POC per-op ssh 慢(用户已感知)。ControlMaster / ssh2 持久连接是必须项。
- **sandbox/policy 交互**:`fs-observation-policy`(read-before-edit / 版本守卫)、`fs-sandbox`(workspace-write 围栏)与远程后端的组合。POC 直接禁了 fs-sandbox;产品化要决定远程后端是否自带围栏或复用策略层。
- **搜索**:远程需有 ripgrep;缺则推送二进制或降级 grep/find。
- **断线/重连**:执行世界的 SSH 连接掉线时的会话行为(fleet 的保活隧道已缓解,但仍需处理连接层重连)。

## 6. 安全

- 复用 fleet 的安全底座:反向端口只绑中继环回、每台独立密钥、hub 经 ProxyJump 够到机器。
- 远程 fs/shell 在**远程机器上以入网时的用户身份**运行——即用户自己的账号,权限即该账号权限。
- 不放大信任面:执行世界只作用在用户已批准入网的 fleet 机器。

## 7. 测试

- 单测:`SshFsCore` 各方法(对测试主机);连接复用逻辑。
- 集成:boot 一个挂了 SSH 执行世界的 profile,agent 在远程 read/write/edit/bash/grep,核实远程副作用(POC 的手法)。
- 快照:带远程工作区的 agent transcript(dsh 要求 model/user-visible 变更配快照)。
- 性能:对比 per-op ssh vs ControlMaster 的 fs 操作延迟。

## 8. 落点与里程碑

正式做进 dsh monorepo(`~/deepseek-harness`),按 dsh 约定建包(`packages/ssh-world/fs-ssh`、`shell-ssh`、`search-ssh` + 一个 execution-world bundle),带测试/invariant/Agent Note/快照。POC 代码(`~/twh/workspace/dsh-fs-ssh-poc`)作为参考实现移植过去。

- **M1 fs-ssh 硬化 + 连接复用**:ssh2 SFTP 或 ControlMaster 持久连接;12 方法产品级;单测。
- **M2 shell-ssh**:`bash` 远程(复用 dsh-ssh exec 引擎);`ctx.shell` provider。
- **M3 search-ssh**:远程 ripgrep;`glob`/`grep` 落远程。
- **M4 execution-world bundle**:面向一个目标机器合成挂载(全局/每 profile,先复刻 POC 的稳态)。
- **M5 每会话执行世界 + 远程目录选择器**:会话级选择目标机器+目录(核心 UX)。
- **M6 fleet 集成**:目标 = fleet 入网机器(经 ProxyJump),`sshArgs` 由 dsh-ssh 条目推导。
