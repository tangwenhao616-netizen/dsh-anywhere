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
TUNNEL_CMD="ssh -N -T -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes -i \${KEY} -R 127.0.0.1:\${PORT}:localhost:22 -p \${RELAY_PORT} \${RELAY_USER}@\${RELAY_HOST}"
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
  ( \${TUNNEL_CMD} >/dev/null 2>&1 & )
fi

# 5) 回报上线
sleep 2
curl -fsSL -X POST "\${BASE_URL}/api/fleet/heartbeat" -H 'content-type: application/json' -d "$(printf '{"id":"%s"}' "\${ID}")" >/dev/null || true
echo "dsh-fleet: 已入网(端口 \${PORT})。回到 dph 网页应能看到本机在线。"
`
}
