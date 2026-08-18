# dsh-ssh-world

把一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话的**执行世界搬到一台远程机器**上:一个插件同时注册 `ctx.fs`(fs-ssh)与 `ctx.subprocess`(subprocess-ssh),二者共享一条 SSH 连接。挂上它并禁掉本地 fs/subprocess provider 后,agent 的 `read / write / edit / bash / grep` **原生工具透明地作用在那台机器的文件与进程上**,而模型、记忆、技能、agent-loop 全留在 hub。

和 dsh 的 E2B 集成同构(`ctx.fs` + `ctx.subprocess` 合为一个执行世界),只是远端换成任意 **SSH 可达**的机器——包括经反向隧道入网的 fleet 机器(`-o ProxyJump=<relay>`)。

- **零 npm 依赖**:文件/进程都走系统 `ssh` CLI(路径与内容 base64 进远程脚本,无引号/注入)。`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-subprocess` 是 **peerDependencies**,由 dsh 运行时提供。
- **快**:OpenSSH **ControlMaster** 复用一条连接,fs 微操作 ≈40ms(不是每次重握手)。
- **可取消**:长命令用专用连接,`terminate()` 断连即由 sshd SIGHUP 远端命令。

## 它提供什么

| 能力 | 实现 |
|---|---|
| `ctx.fs`(FileSystem) | fs-ssh:resolve/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText;版本守卫、原子写、二进制/UTF-8 处理 |
| `ctx.subprocess`(SubprocessRuntime) | subprocess-ssh:`resolveExecutable` / `spawn`(stdin·collect·退出码·cwd·env·terminate)/ `spawnTerminal`(基础 PTY,`ssh -tt`) |
| bash / grep / 终端 / LSP | 无需本插件改动——它们是 `ctx.fs`+`ctx.subprocess` 的 provider-neutral consumer,自动落远程 |

## 用法

1. 装插件到某个 profile(peerDeps 由 dsh 提供):

   ```sh
   dsh plugin --profile <你的profile> add dsh-ssh-world
   ```

2. 用一份合成补丁(见 [`examples/ssh-world.patch.yml`](examples/ssh-world.patch.yml))禁本地 fs/subprocess、插 `ssh-world`、放行 sandbox。填好你的目标机器 `login`/`sshArgs`/`cwd`,然后:

   ```sh
   # 从"远程 cwd 对应的本地占位目录"启动(会话 cwd 须与远程 cwd / workspaceRoot 同指:一世界不变式)
   DSH_PERMISSION_MODE=danger-full-access \
     dsh --profile <你的profile> --patch ./ssh-world.patch.yml "在这台远程机器上干活"
   ```

## 一世界不变式

`fs.cwd` == `subprocess.cwd`(本插件 config.cwd)== `sandbox-policy.workspaceRoot` == 会话工作区,必须**同指一个远程目录**;否则相对路径与命令 cwd 会落到远端不存在的路径而报 spawn 失败。

## 接 fleet 入网机器

目标从直连机器换成 fleet 入网机器,只需把 `sshArgs` 加上跳板:`-o ProxyJump=<relay-login>`(经反向隧道中继够到 behind-NAT 的机器)。已验证 ProxyJump 双跳(hub→中继→机器)的 fs 读写。

## 每实例 vs 每会话

dsh 的执行世界是**每实例**的(`ctx.fs`/`ctx.subprocess` 非 scope-aware):一个 dsh 实例 = 一个执行世界。要同时用本地(如 1.44)与远程工作区,就**跑两个 dsh 实例**(一个本地 profile、一个 ssh-world profile)。真·每会话混合世界需 dsh 核心把 fs/subprocess seam 改成 scope-aware(future)。

## 安全

远程 fs/shell 以入网时的用户身份在远程机器上运行,权限即该账号权限。本插件不放大信任面:只连你显式配置(或经 fleet 批准入网)的机器。sandbox 放行(`danger-full-access`)是把围栏交给远端账号本身;需要更严可换 sandbox 模式并配套远端策略。

## 已知限制(POC 阶段)

- `spawnTerminal` 为基础 PTY;远端**前台进程组精确查询/信号**、TERM→KILL 完整静默尚未实现(持久终端工具够用,精细控制待补)。
- 每次 fs 操作是一次远程命令往返(ControlMaster 已消掉握手;超大量微操作仍有 per-op ssh 进程开销)。
- 远程需有 `rg`(ripgrep)才能让 agent 的 `grep`/`glob` 工具满速;缺则降级 `grep`/`find`。
- `ctx.fs` 未接 dsh 的沙箱围栏(用 `danger-full-access`)。

## 状态

设计/实现/测试见 `docs/superpowers/`。21 个测试(hermetic 单测 + 真机集成)+ 端到端(agent 读/写/bash 全落远程,真机验证)。

## License

[MIT](LICENSE)
