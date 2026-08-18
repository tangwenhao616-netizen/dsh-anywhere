# dsh-fleet 申请/批准入网 + 跨平台 设计文档

- 日期:2026-08-17
- 状态:设计已确认,待写实现计划
- 前置:本文件建立在 [2026-08-17-dsh-fleet-design.md](2026-08-17-dsh-fleet-design.md)(MVP,已实现并端到端验证通过)之上。

## 1. 背景与目标

MVP 的入网方式是:hub 铸一次性 token → 把一行命令**复制**到目标机执行。痛点:复制 token 到异地机器麻烦;且只做了 Linux 脚本。

**目标**:改成**「申请 → 批准」**的人性化流程,并**同时支持 Linux / macOS / Windows**:
- 异地机器上跑一条**通用命令**(无需 token、人人一样、可记忆),它注册一条「入网申请」并挂起等待。
- 机主在**本机 dph 网页的车队面板**看到申请,核对**配对码**,点「通过」即批准;机器随后自动建隧道上线。
- 机主也能在面板看已入网机器的在线状态、一键**吊销**。

**关键约束(设计前提)**:浏览器里点按钮**无法**让机器真正入网——入网 = 在机器上生成密钥 + 建反向隧道 + 装保活服务,只有跑在机器上的程序能做。所以机器端**至少跑一次命令**这步省不掉;我们能省掉的是**「复制 token」**(命令变通用),并把安全从 token 换成**机主显式批准 + 配对码**。

## 2. 架构:申请/批准是 enroll 的前置层

**复用已验证的 `enrollMachine`**(MVP 的核心:分配端口 / 生操作密钥 / 经中继 NOPASSWD 助手写授权键 / 写 dsh-ssh 主机条目 / 记档案)。申请/批准只是在它前面加一层:

```
机器端 bootstrap(通用命令,无 token)
  1. 本地 ssh-keygen 生隧道密钥对(私钥不出机器)
  2. 生成短配对码(如 7F3A-91),POST /api/fleet/request
        body: { name(=hostname), os, remoteUser, tunnelPublicKey, code }
        resp: { id(高熵秘密,仅本机持有,用于轮询) }
  3. 机器打印配对码,轮询 GET /api/fleet/request-status?id=<秘密>
        → pending / rejected / approved(approved 时含 relay 参数+端口+操作公钥)
        │
本机 dph 车队面板
  4. 「待批准」列出申请(name/os/来源IP/配对码/时间)
  5. 机主核对配对码一致 → 点[通过] → POST /api/fleet/approve {reqId, alias?}
        → 调用 enrollMachine(...) → 结果回填进该 request 记录(status=approved)
        │
机器端(下一次轮询拿到 approved + 结果)
  6. 写操作公钥进 authorized_keys(带 from 限制)
  7. ssh -R 建反向隧道(IdentitiesOnly+BatchMode)
  8. 装保活服务(systemd/launchd/计划任务)
  9. POST /api/fleet/heartbeat 上线;删除已消费的 request
```

## 3. 数据模型

在 `~/.dsh/dsh-fleet.json` 增加 `requests[]`(machines/tokens/relay 不变):

```jsonc
{
  "requests": [
    { "id": "<高熵秘密>",           // 机器轮询凭证(仅注册机持有)
      "code": "7F3A-91",             // 短配对码(人肉核对,防冒名)
      "name": "office-pc",           // = hostname,批准时机主可改别名
      "os": "win",                   // linux | mac | win
      "remoteUser": "Administrator",
      "tunnelPublicKey": "ssh-ed25519 AAAA...",
      "sourceIp": "1.2.3.4",         // 来源(仅展示,X-Forwarded-For 不可信,取 socket)
      "status": "pending",           // pending | approved | rejected
      "createdAt": 0, "expiresAt": 0,
      "result": null                 // 批准后填 enroll 结果(relay参数/端口/操作公钥)
    }
  ]
}
```

- **`id` 与 `code` 是两样东西**:`id` 是高熵秘密(轮询 + 取操作公钥的凭证,只有注册机有);`code` 是人可读短码(机主肉眼核对)。攻击者猜不到 `id` 就拿不到批准结果。
- 申请 TTL 默认 10 分钟;过期自动清。

## 4. 路由(在 MVP 路由基础上新增)

**公开(经域名/隧道可达)**:
- `POST /api/fleet/request` —— 注册申请,回 `{id, code(回显), pollIntervalMs}`。限流(按 sourceIp)+ TTL。
- `GET /api/fleet/request-status?id=<秘密>` —— 轮询;approved 时回 relay 参数 + 端口 + 操作公钥。
- `GET /join`(扩展) —— 按 `?os=` 返回 Linux/Mac(bash)或 Windows(PowerShell)bootstrap;bootstrap 走「申请→轮询」而非 token。浏览器打开时返回一个**极简说明页**(展示要跑的命令,不是 dph 主界面)。
- `POST /api/fleet/heartbeat` —— 保留。

**特权(fromTunnelOrLocal + 同源)**:
- `GET /api/fleet/list` —— 扩展:同时返回 `requests`(待批准)、`machines`(已入网)、`relay`。
- `POST /api/fleet/approve` —— `{reqId, alias?}`:调用 `enrollMachine`,把结果回填 request。
- `POST /api/fleet/reject` —— `{reqId}`:删申请。
- `POST /api/fleet/revoke` —— 保留(按 alias 吊销已入网机器)。
- `POST /api/fleet/relay` —— 保留(设中继)。
- `POST /api/fleet/token` —— **保留**(agent/脚本化的 token 流程不删)。

## 5. 配对码与安全

- **申请公开但无害**:任何人 POST /request 只是排进「待批准」队列;真正的门是机主**批准**。
- **配对码防冒名**:机器本地生成短码并打印,机主在面板核对一致才通过——防止攻击者的申请被误批(机主会看到不认识的码)。
- **轮询凭证保密**:`id` 高熵,approved 的 relay 参数/操作公钥只发给持 `id` 的注册机。
- **限流 + TTL**:按 sourceIp 限流防刷;申请 10 分钟过期。
- 其余沿用 MVP:反向端口只绑中继环回、每台独立隧道密钥、操作公钥带 `from="127.0.0.1,::1"`、中继 `tunnel` 账号 `permitlisten` 锁端口 + Match 块禁 shell/pty/agent/x11/-L。

## 6. 跨平台 bootstrap(三平台同协议,只换封装)

同一「生密钥 → 注册申请 → 轮询 → 建隧道 → 装保活」协议:

- **Linux**:bash;OpenSSH 客户端 + 本机 sshd;保活 systemd user service(`enable-linger`)。
- **macOS**:bash/zsh;OpenSSH 自带;保活 launchd plist。
- **Windows**:PowerShell(`irm .../join?os=win | iex`);Win10+ 自带 OpenSSH 客户端;**需 OpenSSH 服务器**(可选功能,bootstrap 检测缺失则指引安装 + 启服务);保活**计划任务(开机触发)**运行 `ssh -R`。
  - **★ Windows sshd 坑**:管理员用户 sshd **不读** `~/.ssh/authorized_keys`,而读 `C:\ProgramData\ssh\administrators_authorized_keys`(且该文件属主/ACL 有要求)。操作公钥必须按此写入并修 ACL,否则 hub 连不进去。普通(非管理员)用户才用 `~/.ssh/authorized_keys`。bootstrap 按当前用户是否管理员分别处理。

所有平台隧道命令统一带 `-o IdentitiesOnly=yes -o BatchMode=yes -i <隧道私钥>`(避免 agent 多 key 撞 MaxAuthTries——MVP 实测教训)。

## 7. UI:dph 网页车队面板(React 客户端半)

照 dsh-ssh 的 client 写法(`dsh.client` 声明 + 侧边栏入口 + `/plugins/<id>/client.js`)做一个「车队」面板:

```
┌─ 待批准 (N) ────────────────────────────────┐
│  <name>  <OS>   来自 <sourceIp>              │
│  配对码 <code>   <相对时间>   [ 通过 ][ 拒绝 ]│
│  …                                           │
├─ 已入网 (M) ─────────────────────────────────┤
│  ● <alias>  <OS>  端口<port>  <在线/离线>  [吊销] │
└──────────────────────────────────────────────┘
```

- 「通过」弹一个可选「别名」输入(默认用申请的 name),确认后 `POST /approve`。
- 轮询 `/api/fleet/list`(如 3s)刷新待批准与在线状态。
- 顶部小字提示中继是否已配置(未配置引导去设 relay)。

## 8. 复用 / 不做

**复用**:`enrollMachine` / `FleetStore` / `token`(端口分配、密钥、推中继、写 dsh-ssh 全不动)、`gate`、`provisioner-ssh`、中继 helper。dsh-ssh 的连接池/agent 工具照旧承接已入网机器。

**不做(YAGNI)**:WebSocket(轮询够用);机器端常驻 agent(bootstrap 一次性跑完即交给保活服务);扫码(配对码肉眼核对即可)。

## 9. 测试

- 单测:request 注册(id 高熵、code 生成、TTL、限流)、request-status 状态机(pending→approved 回填结果 / rejected / 过期)、approve 调用 enrollMachine 并回填、reject 删除。
- 跨平台 bootstrap 文本渲染:三平台各自含正确的注册/轮询/隧道命令 + `IdentitiesOnly`;Windows 含 `administrators_authorized_keys` 分支。
- 端到端(hub 冒充机器):三平台 bootstrap 各跑一遍「申请→(面板)批准→建隧道→hub ssh 进机器执行」;Windows 用一台真 Windows 冒烟(sshd + 计划任务 + admin authorized_keys)。
- 面板:待批准渲染、通过/拒绝/吊销调用正确端点。

## 10. 里程碑

- **R1 后端申请/批准**:`requests[]` 存储 + `request/request-status/approve/reject` 路由 + `list` 扩展;approve 复用 enrollMachine;单测全绿(hub 冒充机器跑通「注册→批准→拿到结果」)。
- **R2 Linux/Mac bootstrap**:bash bootstrap(申请→轮询→隧道→保活)+ 端到端。
- **R3 车队面板**:React 客户端半(待批准/已入网/通过/拒绝/吊销)。
- **R4 Windows bootstrap**:PowerShell bootstrap + OpenSSH 服务器检测/指引 + `administrators_authorized_keys` 处理 + 计划任务保活 + 真机冒烟。
