# dsh-fleet 设计文档 —— dph 公网组网

- 日期:2026-08-17
- 状态:设计已确认,待落实现计划
- 落点:`~/twh/workspace/dsh-fleet/`(独立插件)

## 1. 背景与目标

现在 dph(本机 `dsh web`)通过 `dsh-ssh` 插件能操作"两台电脑",但它是**本机主动 SSH 拨出去连目标机**,只在局域网能直连(主机表 `~/.dsh/dsh-ssh.json` 现只有一台 `192.168.1.22`)。异地机器 behind NAT,家里 dph 直连不到。

**目标**:让异地一台新机器(behind NAT,Linux/Windows/macOS)通过 dph 网页"添加机器"拿到一次性 token,在新机器上粘一行命令即"入网";入网后它和现有局域网机器**完全一样**,被 agent 用现有 `ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster` 直接操作。

**一句话本质**:把"dph 能操作 N 台机器"从局域网扩到公网,新机器**主动拨回来 + 一次认证入网**,认证过了就变成 dph 车队里的一台。

### 成功标准

1. 在异地打开 dph 域名 → 点"添加机器" → 得到一行命令。
2. 在一台异地 Linux 机器粘贴执行 → 数秒内 dph 主机列表出现这台、状态"在线"。
3. agent 对这台跑 `ssh_exec`(如 `uname -a`)能拿到正确输出,`ssh_upload/download` 能传文件。
4. 断网后隧道自动重连恢复;在 dph 网页"吊销"这台后,它立即不可达且不能重新入网(token 已一次性消耗)。
5. token 一次性、可设过期、可按单台吊销;机器 sshd 全程不暴露公网。

## 2. 术语

- **hub**:家里本机,跑 `dsh web` + cloudflared,是唯一的"大脑"和控制端。
- **中继(relay)**:云 VPS `175.24.133.218`(腾讯云,ubuntu 有 sudo,已跑熟反向隧道),公网可达,做会合点。
- **机器 / 节点(node)**:入网的异地电脑。
- **入网 / enroll**:新机器用一次性 token 换取隧道凭证并建立反向隧道、被 hub 登记的过程。

## 3. 现状(复用面盘点)

- hub 跑 `dsh web` 绑 `0.0.0.0:3080`,一个常驻 `cloudflared` 隧道 → 域名 `https://rip-dee-carlos-detector.trycloudflare.com`(由 `~/twh/workspace/ensure-dsh-tunnel.sh` 托管,域名变了自动同步到 `connection.trustedHosts` 白名单)。
- `dsh-ssh` 插件(`@linxin666/dsh-ssh`)已提供:主机表 `~/.dsh/dsh-ssh.json`、持久 ssh2 连接池(支持 **ProxyJump 跳板**)、agent 工具 `ssh_list/ssh_exec/ssh_upload/ssh_download/ssh_tunnel/ssh_cluster`、Web 终端。
- `dsh-remote-web-ui` 插件已有 token 原语:一次性 token、TTL、设备会话、吊销(现用于手机远控扫码配对)——入网 token 沿用其思路。
- 中继侧已有 hub 的 SSH 访问(记忆:2026-08-07 在 127 重建了 reverse-tunnel;ubuntu 账号 sudo 可用)。

**关键复用点**:入网最终产物就是**往 `dsh-ssh` 主机表写一条新主机**,因此入网后所有 agent 工具零改动即可用。

## 4. 拓扑与总体架构

星型:hub + 中继 + N 台机器。机器之间不互联,只 hub↔机器。

```
                  ①换证 (HTTPS, 带一次性 token)
   [异地新机器] ───────────────────────────► [家里 dph hub]
   OpenSSH 客户端                             (异地打开的 cloudflare 域名入口)
        │                                            │
        │②ssh -R 保活(systemd/launchd/计划任务)      │③hub→机器 操作
        ▼                                            │  dsh-ssh 经中继 ProxyJump
   [云中继 175.24.133.218] ◄──── hub 已有 SSH 跳板 ───┘
   受限 tunnel 账号(只准转发,开不了 shell)
   机器 sshd 反射到中继【环回】:PORT(不对公网开放)
```

三条链路:

- **① 换证(HTTPS)**:新机器带 token 向 hub(经 cloudflare 域名)`POST /api/fleet/enroll`,换回:中继地址 + 分配端口 PORT + 连中继的**隧道私钥** + hub 的**操作公钥**(新机器把它写进自己的 `authorized_keys`)。
- **② 反向隧道(机器→中继)**:新机器用隧道私钥执行
  `ssh -R 127.0.0.1:PORT:localhost:22 tunnel@175.24.133.218`,
  把自己的 sshd 反射到**中继环回口** `127.0.0.1:PORT`;用系统服务保活、开机自启。
- **③ hub 操作(hub→机器)**:hub 把这台登记成一条 dsh-ssh 主机 `host=127.0.0.1, port=PORT, proxyJump=[中继]`。dsh-ssh 经中继 ProxyJump 后,在**中继视角**连 `127.0.0.1:PORT` 即打到机器 sshd。agent 现有工具原样即用。

### 为什么必须要中继(而不是机器直接反射到 hub)

hub 在家里 NAT 后,cloudflare quick tunnel **只转发 HTTP(S) 3080,不转发任意 TCP/SSH**,家里没有公网 SSH 入口。所以需要一台公网可达的 VPS 当 SSH 会合点。中继 `175.24.133.218` 现成、已跑熟,直接复用。

### 为什么反向端口绑"环回"而不是公网

若绑公网(`GatewayPorts yes`),每台机器的 sshd 端口就暴露到整个互联网,任人爆破——不可接受。绑中继**环回**后,只有能登进中继的人(hub)才够得到;hub 用自己已有的中继账号做 **ProxyJump 跳板**,从中继视角本地转发到 `127.0.0.1:PORT`。这是整个方案的安全主线。

## 5. 入网协议(详细步骤)

### 5.1 网页发起

用户在 dph 网页点"添加机器"(可选填机器别名、token TTL)。hub `dsh-fleet` mint 一个一次性 token(随机高熵串),记入 `~/.dsh/dsh-fleet.json` 的 `pendingTokens`,附 TTL(默认 10 分钟)。网页弹出一行入网命令(按目标 OS 给 bash / PowerShell 版):

```
# Linux / macOS
curl -fsSL https://<dph域名>/join | bash -s -- <TOKEN>
# Windows (PowerShell)
irm https://<dph域名>/join?os=win | iex   # 脚本内引用 $env:FLEET_TOKEN 或参数传入 <TOKEN>
```

`GET /join` 由 hub 经 cloudflare 域名提供,按 `User-Agent`/`?os=` 返回对应平台脚本。

### 5.2 新机器换证

join 脚本(顺序:先换证拿到凭证,再落盘授权):

1. 检查/提示安装 OpenSSH 客户端(`ssh`)与 sshd(本机需运行 sshd 供反射;缺则给出安装指引)。
2. `POST https://<dph域名>/api/fleet/enroll`,body 带 `token` + 机器指纹(hostname、OS、本机登录用户名)。
3. hub 校验 token(存在、未过期、未用过)→ 原子标记已消耗 → 分配一个未占用的 PORT(环回端口段,如 `20001-20999`)→ 生成**隧道密钥对**(机器→中继)与**操作密钥对**(hub→机器)→ **回发**:
   - 中继地址、`tunnel` 账号、隧道**私钥**、分配的 PORT;
   - hub 操作**公钥**(机器下一步写入自己的 authorized_keys);
   - 建议的隧道保活参数(`ServerAliveInterval` 等)。
   并**同时**在 hub 侧:把隧道**公钥**推到中继 `tunnel` 账号的 `authorized_keys`(带 `restrict,permitlisten="127.0.0.1:PORT"` 前缀);在 `dsh-ssh.json` 写入这台的主机条目;在 `dsh-fleet.json` 记录机器档案(状态 `enrolling`)。
4. 机器收到响应后落盘:隧道**私钥**写入(权限 0600);把 hub 操作**公钥**追加到本机 `~/.ssh/authorized_keys`。授权行带来源限制 `from="127.0.0.1,::1"` —— 因为反向隧道是 `-R ...:localhost:22`,hub 经隧道到达时,机器 sshd 看到的来源是**本机 loopback**,而非中继 IP。

> 密钥生成放在 **hub 侧**:hub 生成两对密钥,隧道私钥随换证下发给机器、操作私钥留 hub;机器只需接收、落盘、写 authorized_keys。这样吊销时 hub 掌握全部公钥位置,便于清理。

### 5.3 建反向隧道 + 保活

join 脚本用隧道私钥安装一个**保活服务**(见 §6.2),命令核心:

```
ssh -N -T \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
  -i <隧道私钥> \
  -R 127.0.0.1:<PORT>:localhost:22 \
  tunnel@175.24.133.218
```

隧道起来后脚本回 `POST /api/fleet/heartbeat`(带 token 派生的机器 id)告知上线;hub 把机器档案置 `online`。

### 5.4 hub 验活与操作

hub 定期(或按需)经 ProxyJump 探活 `127.0.0.1:PORT`;agent 调 `ssh_exec` 等工具时,dsh-ssh 连接池用该主机条目(含 proxyJump)建连、复用长连接。

### 5.5 吊销

网页"吊销"某台 → hub:从中继 `tunnel` authorized_keys 删该机隧道公钥 → 删 `dsh-ssh.json` 该条目 → `dsh-fleet.json` 档案置 `revoked` → 若隧道尚在,杀掉(中继侧 kill 对应转发/连接)。机器再想复用旧 token 无效(已消耗)。

## 6. 组件详细设计

### 6.1 `dsh-fleet` hub 插件(复用 dsh-ssh 主机表 & 连接池)

Cordis 插件,`inject: ['webServer', 'tools', 'systemPrompt']`,并依赖 dsh-ssh 的主机存储 API(直接写 `dsh-ssh.json` 或调 dsh-ssh 暴露的 store)。

职责:

- **token 服务**:mint / 校验 / 一次性消耗 / TTL / 列表 / 吊销。落 `~/.dsh/dsh-fleet.json`。
- **路由**:
  - `GET /join`:返回 OS 自适配入网脚本(bash 版 + PowerShell 版,内联或按 `?os=` 分发)。
  - `POST /api/fleet/enroll`:token 校验 → 分配端口 → 生成两对密钥 → 推隧道公钥到中继 → 写 dsh-ssh 主机表 → 回发凭证。
  - `POST /api/fleet/heartbeat`:机器上线/保活回报,更新状态与 `lastSeen`。
  - `POST /api/fleet/revoke`:吊销单台(网页调用)。
  - `GET /api/fleet/list`:机器列表 + 在线状态(供网页面板)。
- **Web 面板**(dsh-ssh 面板旁新增入口,或并入其侧边栏):
  - "添加机器":填别名/TTL → 出一行命令(带复制按钮,按 OS 切换)。
  - 机器列表:别名、OS、PORT、状态(online/offline/enrolling/revoked)、lastSeen、吊销按钮。
- **system-prompt section**:向 agent 声明本插件与"车队机器"的存在(类似 dsh-ssh 的 `SSH_GUIDANCE`),让 agent 知道这些主机是公网入网机器。

### 6.2 join 客户端脚本(三平台,同一协议)

同一 enroll 协议,只换"装 OpenSSH + 保活封装":

- **Linux**:参考实现。装 `openssh-client`/`openssh-server`;保活用 **systemd user/system service**(或 `autossh`)`Restart=always`,开机自启。
- **macOS**:`ssh` 自带;保活用 **launchd**(`KeepAlive=true`)plist。
- **Windows**:OpenSSH 客户端(Win10+ 自带或按需装),sshd 用可选功能安装;保活用**计划任务(开机触发)**或 `nssm` 包一个服务。PowerShell 版脚本。

脚本共同动作:换证 → 落隧道私钥(权限 0600)→ 写 authorized_keys(hub 操作公钥,带 `from=` 限制)→ 安装保活服务 → 首次拉起隧道 → 回报上线。脚本需**幂等**(重复跑不产生重复服务/重复授权行)。

### 6.3 中继一次性初始化脚本

在中继 `175.24.133.218` 上跑一次(hub ubuntu 账号 sudo):

- 建受限系统账号 `tunnel`(无登录 shell:`/usr/sbin/nologin` 或 forced-command;home 仅放 `.ssh/authorized_keys`)。
- sshd 配置(`Match User tunnel`):`AllowTcpForwarding remote`、`PermitOpen none`(禁本地转发)、`X11Forwarding no`、`PermitTTY no`、`GatewayPorts no`(强制环回)、`ForceCommand /usr/sbin/nologin` 或 `internal-sftp` 拒绝。
- 每台机器的隧道公钥入 `tunnel` 的 authorized_keys 时带前缀:
  `restrict,permitlisten="127.0.0.1:<PORT>" ssh-ed25519 AAAA... machine-<id>`
  —— 即使某机隧道私钥泄露,也只能监听自己那个环回端口、开不了 shell、开不了别的转发。
- hub 侧**不新建账号**:hub 用**现有中继账号**(ubuntu 或已有的 hub 账号)做 ProxyJump 跳板,该账号本就能开 `direct-tcpip` 到 `127.0.0.1:PORT`。

## 7. 数据模型

### 7.1 `~/.dsh/dsh-fleet.json`

```jsonc
{
  "version": 1,
  "relay": { "host": "175.24.133.218", "port": 22, "tunnelUser": "tunnel",
             "jumpAlias": "relay-jump", "portRange": [20001, 20999] },
  "pendingTokens": [
    { "token": "<高熵串>", "alias": "office-pc", "createdAt": 0, "expiresAt": 0,
      "ttlMs": 600000, "consumed": false }
  ],
  "machines": [
    { "id": "<机器id>", "alias": "office-pc", "os": "linux",
      "remoteUser": "wl", "port": 20001,
      "tunnelPubKeyPath": "...", "opPrivKeyPath": "...",
      "status": "online", "enrolledAt": 0, "lastSeen": 0 }
  ]
}
```

### 7.2 写入 `~/.dsh/dsh-ssh.json` 的主机条目(每台机器一条)

```jsonc
{
  "alias": "fleet-office-pc",
  "host": "127.0.0.1",           // 中继视角的环回
  "port": 20001,                  // 分配端口
  "user": "<远程机器登录名>",
  "auth": { "kind": "key", "keyPath": "<hub 操作私钥路径>" },
  "proxyJump": ["relay-jump"],    // hub→中继 跳板(现有账号)
  "tags": ["fleet"],
  "description": "公网入网机器(dsh-fleet)"
}
```

> `relay-jump` 是 dsh-ssh 主机表里一条指向中继、用 hub 现有账号的普通主机条目(初始化时写入一次),作为 ProxyJump 目标。

## 8. 安全设计(公网关键)

- **端口不公网**:反向端口只绑中继环回;hub 经 ProxyJump 才够到 → 机器 sshd 全程不上公网。
- **最小权限中继账号**:`tunnel` 账号 `restrict` + `permitlisten` 限死单端口 + 禁 shell/pty/本地转发;隧道 key 泄露影响面被封死在"一个环回端口的转发"。
- **每台两把独立密钥**:隧道 key(机器→中继)、操作 key(hub→机器)互不复用;**吊销 = 删两处公钥 + 删 dsh-ssh 条目 + 杀隧道**,单台即时失效,不牵连他机。
- **token**:高熵、一次性、TTL、按台;mint 是 dph **已登录会话内**的特权动作(网页已过 `connection` 浏览器信任栅栏与 dph 自身会话)。
- **换证走 HTTPS**:`/join` 与 `/enroll` 均经 cloudflare 域名(TLS)。
- **hub 操作公钥带 `from=`**:写入机器 authorized_keys 时带 `from="127.0.0.1,::1"`(反向隧道使 hub 连接从机器本机 loopback 进入),仅接受经隧道来的连接,降低该 key 被他处滥用的风险。
- **零明文密码**:全程 key 认证(区别于现有 `dsh-ssh.json` 里那条 `192.168.1.22` 的明文密码)。
- **审计**:入网/吊销/上线事件写入 `dsh-fleet.json` 与日志,便于回溯。

## 9. 复用与不做

**复用**:云中继 `175.24.133.218`、`dsh-ssh`(主机表/连接池/ProxyJump/全套 agent 工具)、`remote-web-ui` 的 token 思路、`ssh -R` 反向隧道、`ensure-dsh-tunnel.sh`/`restart-dsh-web.sh` 运维习惯。

**不做(YAGNI)**:机器之间互联(只 hub↔机器星型);多中继 HA/故障转移;动态 DNS;机器上跑完整 dph 本体(机器只当被操作的瘦节点)。

## 10. 测试策略

- **单测**:token mint/一次性消耗/过期/吊销;端口分配不撞车;enroll 后 dsh-ssh 条目字段正确、dsh-fleet 档案正确。
- **组件测**:中继 authorized_keys 前缀(`restrict,permitlisten`)拼装正确;join 脚本幂等(重复跑不重复授权/不重复装服务)。
- **端到端(Linux 参考)**:一台 Linux 机器 join → dph 列表出现且在线 → agent `ssh_exec uname -a` 通、`ssh_upload/download` 传文件通 → 断网(杀隧道进程)后保活自恢复 → 网页吊销后即不可达、旧 token 复用被拒。
- **平台冒烟**:mac(launchd)、Windows(计划任务)各跑一遍 join→在线→ssh_exec。

## 11. 默认决策(已确认)

1. 代码落点:独立插件 `~/twh/workspace/dsh-fleet/`(本 spec 在此仓库)。
2. 平台节奏:三平台同协议设计,**Linux 参考实现先打通**,Win/mac 紧随(只换保活封装)。
3. 保活:反向隧道默认**装成系统服务、开机自启**。

## 12. 里程碑(供实现计划展开)

- **M1 — hub 核心**:`dsh-fleet` 插件骨架 + token 服务 + `dsh-fleet.json` 存储 + `enroll/heartbeat/list/revoke` 路由 + 写 dsh-ssh 主机表(先用 mock 隧道跑通单测)。
- **M2 — 中继底座**:中继初始化脚本(`tunnel` 账号 + sshd 受限配置)+ hub 推隧道公钥 + `relay-jump` 主机条目。
- **M3 — Linux join 端到端**:Linux join 脚本(换证 + 隧道 + systemd 保活)→ 真机 join → agent `ssh_exec` 打通 → 断网自恢复 → 吊销失效。
- **M4 — Web 面板**:"添加机器"(出命令)+ 机器列表/状态/吊销 UI。
- **M5 — mac / Windows**:launchd 与计划任务两版 join 脚本 + 冒烟。
