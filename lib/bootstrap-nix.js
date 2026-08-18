/**
 * 渲染 Linux/macOS 的「申请→批准」bootstrap(bash)。/join(无 token)返回它,
 * 用户在异地机器上 `curl .../join | bash`。它:本地生隧道密钥 + 生成配对码 + 注册申请
 * → 打印配对码 → 轮询直到机主批准 → 写操作公钥 + 建反向隧道 + 装保活(Linux systemd /
 * mac launchd)+ 上线。无 token(通用命令),安全靠机主在网页批准 + 配对码肉眼核对。
 *
 * baseUrl 内联进脚本,严格校验字符防注入。
 */

const BASEURL_RE = /^https:\/\/[A-Za-z0-9.\-:/]+$/

/**
 * @param {{baseUrl:string}} o
 * @returns {string}
 */
export function renderNixBootstrap(o) {
  if (!BASEURL_RE.test(o.baseUrl)) throw new Error('invalid baseUrl')
  const { baseUrl } = o
  return `#!/usr/bin/env bash
# dsh-fleet 入网 bootstrap(Linux/macOS)。注册入网申请并等待机主在 dph 网页批准,
# 批准后自动把本机 sshd 反向映射到中继、登记为一台可被 dph agent 操作的主机。
# 需要:已运行的 sshd、openssh-client、curl。无需 token。
set -euo pipefail

BASE_URL='${baseUrl}'
FLEET_DIR="\${HOME}/.dsh-fleet"
KEY="\${FLEET_DIR}/tunnel"
mkdir -p "\${FLEET_DIR}"; chmod 700 "\${FLEET_DIR}"

for c in ssh ssh-keygen curl; do command -v "\$c" >/dev/null || { echo "缺 \$c"; exit 1; }; done
case "$(uname -s)" in Darwin) OS=mac ;; Linux) OS=linux ;; *) OS=linux ;; esac

# 1) 本地生成隧道密钥(私钥不出机器)
[ -f "\${KEY}" ] || ssh-keygen -t ed25519 -N '' -f "\${KEY}" -C "dsh-fleet:$(hostname)" >/dev/null
TUNNEL_PUB="$(cat "\${KEY}.pub")"

# 2) 生成配对码 + 注册申请
CODE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \\n' | tr a-f A-F | sed 's/^\\(....\\)\\(....\\)$/\\1-\\2/')"
NAME="$(hostname | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
REQ="$(printf '{"name":"%s","os":"%s","remoteUser":"%s","tunnelPublicKey":"%s","code":"%s"}' \\
        "\${NAME}" "\${OS}" "\${USER}" "\${TUNNEL_PUB}" "\${CODE}")"
RESP="$(curl -fsSL -X POST "\${BASE_URL}/api/fleet/request" -H 'content-type: application/json' -d "\${REQ}")"
POLL_ID="$(echo "\${RESP}" | grep -o '"pollId":"[a-f0-9]*"' | head -1 | sed 's/.*://; s/"//g')"
[ -n "\${POLL_ID}" ] || { echo "注册申请失败: \${RESP}"; exit 1; }

echo ""
echo "  ┌────────────────────────────────────────────┐"
echo "  │  已提交入网申请,配对码:  \${CODE}"
echo "  │  请到本机 dph 网页「车队 · 待批准」核对并点通过 │"
echo "  └────────────────────────────────────────────┘"
echo "  机器名:\${NAME}  等待批准中(最多 10 分钟)…"

# 3) 轮询直到批准
STATUS=""; RESULT=""
for i in $(seq 1 200); do
  S="$(curl -fsSL "\${BASE_URL}/api/fleet/request-status?id=\${POLL_ID}" 2>/dev/null || echo '{}')"
  STATUS="$(echo "\${S}" | grep -o '"status":"[a-z]*"' | head -1 | sed 's/.*://; s/"//g')"
  case "\${STATUS}" in
    approved) RESULT="\${S}"; break ;;
    rejected) echo "申请被拒绝。"; exit 1 ;;
    expired|unknown) echo "申请已过期,请重跑本命令。"; exit 1 ;;
  esac
  sleep 3
done
[ "\${STATUS}" = approved ] || { echo "等待超时,请重跑本命令。"; exit 1; }

# 4) 解析批准结果
getf(){ echo "\${RESULT}" | grep -o "\\"$1\\":[^,}]*" | head -1 | sed 's/.*://; s/^ *//; s/^"//; s/"$//'; }
RELAY_HOST="$(getf relayHost)"; RELAY_PORT="$(getf relayPort)"; RELAY_USER="$(getf relayUser)"; PORT="$(getf port)"; ID="$(getf id)"
FRP_TOKEN="$(getf frpToken)"; FRP_PORT="$(getf frpServerPort)"; FRP_PROTO="$(getf frpProtocol)"
OP_PUB="$(echo "\${RESULT}" | grep -o '"operationPublicKey":"[^"]*"' | sed 's/.*"operationPublicKey":"//; s/"$//')"
[ -n "\${PORT}" ] || { echo "批准结果异常: \${RESULT}"; exit 1; }

# 5) 授权 hub 操作公钥(仅接受经隧道从本机 loopback 来的连接)
AUTH="\${HOME}/.ssh/authorized_keys"; mkdir -p "\${HOME}/.ssh"; chmod 700 "\${HOME}/.ssh"; touch "\${AUTH}"; chmod 600 "\${AUTH}"
grep -qF "\${OP_PUB}" "\${AUTH}" || printf 'from="127.0.0.1,::1" %s\\n' "\${OP_PUB}" >> "\${AUTH}"

# 6) 建到中继的通道 + 保活服务:frp(frpToken 非空)优先,否则 legacy 反向 ssh -R。
#    frp 稳:frpc 自带心跳+断线优雅重连,不留僵尸监听口;走 TCP(控制连接默认 TLS)。
# 6.0) frps 端口预检:有的网络只放行 22(实测),443 直接超时——frp 走不通就自动回退 ssh -R。
if [ -n "\${FRP_TOKEN}" ]; then
  FRP_OK=""
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 bash -c "exec 3<>/dev/tcp/\${RELAY_HOST}/\${FRP_PORT}" 2>/dev/null && FRP_OK=1
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w 5 "\${RELAY_HOST}" "\${FRP_PORT}" 2>/dev/null && FRP_OK=1
  else
    FRP_OK=1   # 无探测工具则乐观走 frp(frpc loginFailExit=false 会持续重试)
  fi
  if [ -z "\${FRP_OK}" ]; then
    echo "  本机网络到中继 \${FRP_PORT} 端口不通,自动回退反向 ssh 隧道(22)"
    FRP_TOKEN=""
  fi
fi
if [ -n "\${FRP_TOKEN}" ]; then
  echo "  传输:frp —— 下载 frpc 并配置反向代理…"
  curl -fsSL "\${BASE_URL}/api/fleet/frpc" -o "\${FLEET_DIR}/frpc" || { echo "下载 frpc 失败"; exit 1; }
  chmod +x "\${FLEET_DIR}/frpc"
  cat > "\${FLEET_DIR}/frpc.toml" <<EOF
serverAddr = "\${RELAY_HOST}"
serverPort = \${FRP_PORT}
loginFailExit = false
auth.method = "token"
auth.token = "\${FRP_TOKEN}"
transport.protocol = "\${FRP_PROTO}"

[[proxies]]
name = "dsh-fleet-\${PORT}"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = \${PORT}
EOF
  chmod 600 "\${FLEET_DIR}/frpc.toml"
  RUN_CMD="\${FLEET_DIR}/frpc -c \${FLEET_DIR}/frpc.toml"
else
  RUN_CMD="ssh -N -T -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes -i \${KEY} -R 127.0.0.1:\${PORT}:localhost:22 -p \${RELAY_PORT} \${RELAY_USER}@\${RELAY_HOST}"
fi
if [ "\${OS}" = mac ]; then
  PLIST="\${HOME}/Library/LaunchAgents/com.dsh-fleet.tunnel.plist"; mkdir -p "$(dirname "\${PLIST}")"
  cat > "\${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dsh-fleet.tunnel</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>\${RUN_CMD}</string></array>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
</dict></plist>
EOF
  launchctl unload "\${PLIST}" 2>/dev/null || true
  launchctl load "\${PLIST}"
elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="\${HOME}/.config/systemd/user/dsh-fleet-tunnel.service"; mkdir -p "$(dirname "\${UNIT}")"
  cat > "\${UNIT}" <<EOF
[Unit]
Description=dsh-fleet reverse tunnel
After=network-online.target
[Service]
ExecStart=\${RUN_CMD}
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-fleet-tunnel.service
  loginctl enable-linger "\${USER}" >/dev/null 2>&1 || true
else
  ( \${RUN_CMD} >/dev/null 2>&1 & )
fi

# 7) 上线回报
sleep 2
curl -fsSL -X POST "\${BASE_URL}/api/fleet/heartbeat" -H 'content-type: application/json' -d "$(printf '{"id":"%s"}' "\${ID}")" >/dev/null || true
echo "dsh-fleet: 已入网(端口 \${PORT})。回到 dph 网页应能看到本机在线。"
`
}
