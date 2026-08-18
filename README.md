# dsh-anywhere

**把一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工作区落在任意一台机器上。** 一个插件、两种模式,拼起来就是"人在异地,dsh 大脑在 hub,活干在你想要的那台机器上":

- **组网(fleet)** —— 把 NAT 后的异地机器经**一次性 token + 反向隧道**拉进你的 dph:机器跑一行 `curl .../join | bash`(Windows `irm .../join?os=win | iex`)、显示配对码挂起,你在 `/fleet` 网页点「通过」它就上线,作为一条 `fleet-*` 的 **dsh-ssh 主机**出现,用现成的 `ssh_exec`/`ssh_upload`/… 操作。
- **执行世界(world)** —— 把一台**可达**的机器变成会话的 `ctx.fs` + `ctx.subprocess`:agent 的 `read / write / edit / bash / grep` **原生工具透明地作用在那台机器**,而模型、记忆、技能、agent-loop 全留在 hub。与 dsh 的 E2B 集成同构,只是远端换成任意 SSH 可达的机器。

**旗舰组合(你要的"异地电脑当工作区",缺一不可)**:先用 **fleet** 把家里/公司那台没有公网 IP 的机器拉进网,再用 **world** 把它升格为整会话工作区(`-o ProxyJump=<relay>` 经中继够到它)。目标机器本就可达(公网云主机 / 局域网)时,直接用 world、跳过 fleet。

## 两种模式一张表

| | fleet(组网层) | world(执行世界层) |
|---|---|---|
| 职责 | 让 NAT 后的异地机器**够得着** | 把可达机器变成**整会话工作区** |
| 机器呈现为 | 一条 `dsh-ssh` 主机(`fleet-*`) | 会话的 `ctx.fs` + `ctx.subprocess` |
| 操作方式 | `ssh_exec`/`ssh_upload`/`ssh_download`/`ssh_tunnel` 工具 | 原生 `read`/`write`/`edit`/`bash`/`grep`,落远程 |
| 挂载 | 装插件即常驻(`dsh.bundle` → `cordis.patch.yml`) | 每会话 `--patch workspace-on-machine.patch.yml` |
| 入口 | `dsh-anywhere` | `dsh-anywhere/world` |

- **零外部 npm 依赖**:文件/进程/隧道都走系统 `ssh` CLI(路径与内容 base64 进远程脚本,无引号/注入)。`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-subprocess` 是 **peerDependencies**,由 dsh 运行时提供。
- **快**:执行世界用 OpenSSH **ControlMaster** 复用一条连接,fs 微操作 ≈40ms(不是每次重握手)——这正是让"经隧道在异地机器上干活"流畅可用的关键。
- **可取消**:长命令用专用连接,`terminate()` 断连即由 sshd SIGHUP 远端命令。

## 安装

```sh
dsh plugin --profile <你的profile> add dsh-anywhere
```

装上即启用 **fleet**:`/fleet` 管理面板 + `/join`、`/api/fleet/*` 路由 + 一段面向 agent 的组网说明。**world** 是每会话按需挂载(见下)。

## 模式一:fleet 组网(把异地机器拉进来)

1. **配中继**(社区插件不硬编码你的 VPS):在你自己的中继 VPS 跑 `scripts/relay-init.sh`,然后 `POST /api/fleet/relay` 登记它(或在 `/fleet` 面板设)。
2. **加机器**:面板「加机器」给出一行命令 —— 目标机跑 `curl <base>/join | bash`(Windows:`irm '<base>/join?os=win' | iex`)。机器显示**配对码**并挂起。
3. **批准**:你在 `/fleet` 核对配对码后点「通过」(只有本机 `127.0.0.1`/`1.44` 能批准)。机器 sshd 经反向隧道映射到中继环回口,hub 经 ProxyJump 够到它,作为 `fleet-*` dsh-ssh 主机上线。
4. 列表/吊销:`GET /api/fleet/list`、`POST /api/fleet/approve|reject|revoke`。

**安全**:token 一次性 + 可过期 + 可单台吊销;每台机器独立隧道密钥;机器 sshd 只绑中继环回口、**不暴露公网**;审批只认本机来源。

## 模式二:world 执行世界(把机器变工作区)

用 [`examples/workspace-on-machine.patch.yml`](examples/workspace-on-machine.patch.yml) 禁本地 fs/subprocess、插 `dsh-anywhere/world`、放行 sandbox、统一 cwd。填好目标机器的 `login`/`sshArgs`/`cwd`,然后:

```sh
# 从"远程 cwd 对应的本地占位目录"启动(会话 cwd 须与远程 cwd / workspaceRoot 同指)
DSH_PERMISSION_MODE=danger-full-access \
  dsh --profile <你的profile> --patch ./workspace-on-machine.patch.yml "在这台机器上干活"
```

接 **fleet 入网机器**:把 `sshArgs` 加上跳板 `-o ProxyJump=<relay-login>`(经反向隧道够到 behind-NAT 的机器)。已验证 ProxyJump 双跳(hub→中继→机器)的 fs 读写。

### world 提供什么

| 能力 | 实现 |
|---|---|
| `ctx.fs`(FileSystem) | fs-ssh:resolve/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText;版本守卫、原子写、二进制/UTF-8 |
| `ctx.subprocess`(SubprocessRuntime) | subprocess-ssh:`resolveExecutable` / `spawn`(stdin·collect·退出码·cwd·env·terminate)/ `spawnTerminal`(基础 PTY,`ssh -tt`) |
| bash / grep / 终端 / LSP | 无需改动——它们是 `ctx.fs`+`ctx.subprocess` 的 provider-neutral consumer,自动落远程 |

## 一世界不变式(仅 world 模式)

`fs.cwd` == `subprocess.cwd`(补丁 config.cwd)== `sandbox-policy.workspaceRoot` == 会话工作区,必须**同指一个远程目录**;否则相对路径与命令 cwd 会落到远端不存在的路径而报 spawn 失败。

## 每实例 vs 每会话

dsh 的执行世界是**每实例**的(`ctx.fs`/`ctx.subprocess` 非 scope-aware):一个 dsh 实例 = 一个执行世界。要同时用本地(如 1.44)与远程工作区,就**跑两个 dsh 实例**(一个本地 profile、一个 world profile)。真·每会话混合世界需 dsh 核心把 fs/subprocess seam 改成 scope-aware(future)。fleet 模式不受此限——入网机器是 dsh-ssh 主机,可与本地工作区并存。

## 已知限制(POC 阶段)

- `spawnTerminal` 为基础 PTY;远端**前台进程组精确查询/信号**、TERM→KILL 完整静默尚未实现。
- 每次 fs 操作是一次远程命令往返(ControlMaster 已消掉握手;超大量微操作仍有 per-op ssh 进程开销)。
- 远程需有 `rg`(ripgrep)才能让 agent 的 `grep`/`glob` 满速;缺则降级 `grep`/`find`。
- world 的 `ctx.fs` 未接 dsh 沙箱围栏(用 `danger-full-access`;围栏交给远端账号本身)。

## 状态

设计/实现/测试见 `docs/superpowers/`。**67 个测试**(fleet 单测 + world hermetic 单测 + 真机集成)全绿;端到端真机验证:fleet 入网(token + 申请-批准,Win/Linux/Mac)、world 执行世界(agent 读/写/bash/grep 全落远程,含 ProxyJump 双跳)。

## License

[MIT](LICENSE)
