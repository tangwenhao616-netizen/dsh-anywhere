# dsh-fleet 申请/批准 + 跨平台 实现计划

> **For agentic workers:** 用 superpowers:subagent-driven-development 或 executing-plans 逐任务实现。基于 [设计 spec](../specs/2026-08-17-dsh-fleet-request-approve-design.md)。沿用 MVP 的模式:零外部依赖 ESM + `node:test`,`git add lib/... test/...` 逐任务提交。

**Goal:** 机器跑通用命令注册「入网申请」→ 机主网页核对配对码批准 → 机器自动建隧道上线;Linux/Mac/Windows 全支持。全部并入 dsh-fleet,后续统一发社区。

**Architecture:** 申请/批准是 `enrollMachine` 的前置层——把 enroll 核心(端口/密钥/推中继/写 dsh-ssh)从 token 消耗里抽出为 `enrollCore`,token 流程与 approve 流程共用它。

---

## R1 — 后端 申请/批准(全部可单测)

### Task 1: 抽出 `enrollCore`(不含 token),`enrollMachine` 改为消耗 token 后调它
- Modify `lib/enroll.js`;Test `test/enroll.test.js`(现有用例保持绿)
- `enrollCore(deps, {alias, os, remoteUser, tunnelPublicKey}, now)` = 现 enrollMachine 第 2–6 步(端口/操作密钥/推中继/写 dsh-ssh/记档案 + 返回 relay 参数+端口+操作公钥)。
- `enrollMachine` = 中继守卫 + `consumeToken` + `enrollCore`。新增 `enrollCore` 直测(无 token 也能 enroll)。

### Task 2: `lib/requests.js` —— 申请状态机(纯逻辑,注入 store + enrollCore)
- Create `lib/requests.js`;Test `test/requests.test.js`
- `registerRequest(store, {name, os, remoteUser, tunnelPublicKey, code, sourceIp}, now, ttlMs)` → `{id, code}`(id=32B hex 秘密;去重同名 pending)。
- `getRequestStatus(store, id, now)` → `{status:'pending'|'approved'|'rejected'|'unknown'|'expired', result?}`。
- `approveRequest(deps, reqId, aliasOverride, now)` → 校验 pending+未过期 → `enrollCore` → 回填 `result` + status=approved → 返回 result;未找到/过期返回 reason。
- `rejectRequest(store, reqId)`;`listRequests(store, now)`(仅 pending 未过期);`sweepRequests(store, now)`(清过期/已消费)。
- 限流:`registerRequest` 按 sourceIp 统计,超阈值(如 10/分钟)拒。

### Task 3: 路由接入 `request/request-status/approve/reject` + 扩展 `list`
- Modify `lib/routes.js`;Test `test/routes.test.js`
- 公开:`POST /api/fleet/request`、`GET /api/fleet/request-status`。
- 特权:`POST /api/fleet/approve`、`POST /api/fleet/reject`;`GET /api/fleet/list` 加 `requests`。
- request 的 sourceIp 取 `req.socket.remoteAddress`(cloudflared 下都是回环,退化为限流用途;X-Forwarded-For 不取)。

**R1 验收(hub 冒充机器,无真机)**:注册申请 → list 见待批准 → approve → request-status 拿到 relay 参数+操作公钥 → 用它建反向隧道 → 中继端口 BOUND → hub ProxyJump ssh 进机器执行命令 → 吊销清理。(复用 MVP 已验证的干跑手法。)

---

## R2 — Linux/Mac bootstrap(申请→轮询→建隧道→保活)

### Task 4: `lib/bootstrap-nix.js` —— 渲染 bash bootstrap(Linux+Mac)
- Create `lib/bootstrap-nix.js`;Test `test/bootstrap-nix.test.js`
- 渲染 bash:检查 ssh/ssh-keygen/curl;本地生隧道密钥;生成配对码;`POST /request` 拿 id;打印配对码;轮询 `/request-status` 直到 approved/rejected/超时;approved 后写操作公钥进 `~/.ssh/authorized_keys`(`from="127.0.0.1,::1"`);建 `ssh -R`(`IdentitiesOnly+BatchMode`);装保活(Linux systemd user / mac launchd,按 `uname` 分支);heartbeat。
- 严格校验注入的 baseUrl(仅 https 白名单字符)。
- Test:含 `/api/fleet/request`、`/request-status`、`IdentitiesOnly=yes`、`from=`、systemd 与 launchd 分支;`bash -n` 渲染结果。

### Task 5: `/join` 改走 bootstrap;按 `?os=` 分发
- Modify `lib/routes.js`、`lib/index.js`;Test `test/routes.test.js`
- `GET /join`(无 token):`?os=mac|linux` → bash bootstrap;`?os=win` → PowerShell(R4);浏览器 Accept: text/html → 极简说明页(展示命令)。
- 保留 token 版 `renderLinuxJoinScript`(`/join?token=` 仍走 token 流程,兼容)。

**R2 验收**:Linux 机(或 hub 冒充)跑 `curl .../join|bash` → 面板批准 → 自动上线 → agent ssh_exec 通;断网隧道自恢复。

---

## R3 — 车队面板(React 客户端半)

### Task 6: 客户端脚手架(照 dsh-ssh 的 `dsh.client`)
- 研读 `@linxin666/dsh-ssh` 的 client 结构(`src/client/`:mount.tsx / sidebar-entry / api),照搬最小骨架:`package.json` 加 `dsh.client`(inject + platform:web)、`lib/client.js` 入口、侧边栏「车队」入口。
- Create `src/client/*`(TSX)或直接 `lib/client.js`(若走无构建 JS 需确认 dsh 是否接受未编译 client;大概率要 tsdown 构建 client bundle)。**构建策略在本任务先定**:若 client 必须编译,则本插件引入最小 tsdown 仅编译 client(host 侧仍零构建)。

### Task 7: 面板组件 —— 待批准 / 已入网 / 通过·拒绝·吊销
- 拉 `/api/fleet/list`(3s 轮询);待批准列表(name/os/sourceIp/配对码/时间 + 通过[可改别名]/拒绝);已入网列表(alias/os/port/在线 + 吊销);中继未配置提示。
- 通过 → `POST /approve {reqId, alias}`;拒绝 → `/reject`;吊销 → `/revoke`。

**R3 验收**:网页开面板,造一个申请 → 面板显示 → 点通过 → 机器上线 → 面板转「已入网」。

---

## R4 — Windows bootstrap

### Task 8: `lib/bootstrap-win.js` —— 渲染 PowerShell bootstrap
- Create `lib/bootstrap-win.js`;Test `test/bootstrap-win.test.js`
- PowerShell:检测 OpenSSH 客户端(自带)与**服务器**(缺则指引 `Add-WindowsCapability` + 启 `sshd` 服务);`ssh-keygen` 生隧道密钥;生成配对码;`Invoke-RestMethod` 注册申请 + 轮询;approved 后写操作公钥——**按当前用户是否管理员**:管理员 → `C:\ProgramData\ssh\administrators_authorized_keys`(并修 owner=Administrators + 去继承 ACL,否则 sshd 忽略);普通用户 → `$env:USERPROFILE\.ssh\authorized_keys`;建 `ssh -R`(IdentitiesOnly+BatchMode);保活**计划任务**(开机触发,`schtasks`/`Register-ScheduledTask`);heartbeat。
- Test:含 request/status URL、`administrators_authorized_keys` 分支、`Register-ScheduledTask`、`IdentitiesOnly`。

### Task 9: `/join?os=win` 返回 PowerShell;真机冒烟
- Modify `lib/routes.js`(os=win 分发到 bootstrap-win)。
- 真 Windows 机:`irm .../join?os=win | iex` → 面板批准 → 上线 → hub ssh_exec 通。**需用户一台真 Windows**。

---

## 发布(全部做完后,一次性)
- 更新 README(申请/批准流程 + 三平台 + 中继先决条件 + 安全)。
- 去个人化门禁 + `npm pack` 白名单 + `gh repo create`(dsh-plugin topic)。**需用户 gh 账号**。

## 自审(计划 vs spec)
- 申请/批准状态机(spec §2-3)→ Task 2;路由(§4)→ Task 3/5;配对码+id 两分与限流(§5)→ Task 2;三平台 bootstrap(§6)→ Task 4/8;UI(§7)→ Task 6/7;复用 enrollCore(§2、§8)→ Task 1。✅
- 命名一致:`enrollCore/enrollMachine`、`registerRequest/getRequestStatus/approveRequest/rejectRequest/listRequests/sweepRequests`、`renderNixBootstrap/renderWinBootstrap`。
