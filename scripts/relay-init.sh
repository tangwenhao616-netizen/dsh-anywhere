#!/usr/bin/env bash
# 在云中继上跑一次(需 root:用 `sudo bash relay-init.sh`)。建立:
#   1) 受限 tunnel 账号(nologin,只准反向端口转发、绑环回)
#   2) sshd Match 限制(AllowTcpForwarding remote / PermitOpen none / GatewayPorts no / ...)
#   3) root-owned 助手 /usr/local/sbin/dsh-fleet-authkeys:安全增删 tunnel 的授权键行,
#      每行强制锁 permitlisten="127.0.0.1:<port>"(不用 restrict——实测 OpenSSH 9.6 上
#      restrict 会连 permitlisten 放行的 -R 也一并禁掉;pty/agent/x11/shell/本地转发的
#      限制改由下面 Match 块兜底);校验端口区间与 key 字符,调用方注入不了别的选项。
#   4) 窄 NOPASSWD sudoers:jump 用户仅可免密调用上面这个助手(其它一律不免密),
#      这样 hub 在 enroll/吊销时能非交互地增删 tunnel 授权键。
#
# 用法:  sudo bash relay-init.sh [tunnel_user] [jump_user]
#        默认 tunnel_user=tunnel, jump_user=ubuntu
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行(sudo bash relay-init.sh)"; exit 1; }
TUNNEL_USER="${1:-tunnel}"
JUMP_USER="${2:-ubuntu}"
PORT_LO=20001; PORT_HI=20999

# 1) tunnel 账号(nologin)
id -u "${TUNNEL_USER}" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "${TUNNEL_USER}"
install -d -m 700 -o "${TUNNEL_USER}" -g "${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh"
touch "/home/${TUNNEL_USER}/.ssh/authorized_keys"
chown "${TUNNEL_USER}:${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh/authorized_keys"
chmod 600 "/home/${TUNNEL_USER}/.ssh/authorized_keys"

# 2) sshd 受限 Match
cat > /etc/ssh/sshd_config.d/dsh-fleet.conf <<EOF
# dsh-fleet:tunnel 账号只准反向转发、绑环回、禁 shell/pty/本地转发。
# 端口锁定完全交给每台机器授权键行里的 permitlisten="127.0.0.1:<port>"(精确匹配)
# + GatewayPorts no(强制环回)。不在这里写 PermitListen:其端口通配星号与请求取交集
# 会把合法 listen 也拒掉(实测 OpenSSH 9.6 remote forward failure 根因)。
Match User ${TUNNEL_USER}
    AllowTcpForwarding remote
    PermitOpen none
    GatewayPorts no
    X11Forwarding no
    PermitTTY no
    AllowAgentForwarding no
    ForceCommand /usr/sbin/nologin
    # 快速回收死掉的反向隧道客户端(15x2=30s,而非默认 90s):隧道断线时中继尽快
    # 释放转发口,机器重连才不会撞"端口占用"→ExitOnForwardFailure→循环抖动(治 flapping)。
    ClientAliveInterval 15
    ClientAliveCountMax 2
EOF

# 3) root-owned 助手
cat > /usr/local/sbin/dsh-fleet-authkeys <<'HELPER'
#!/usr/bin/env bash
# dsh-fleet:安全增删 tunnel 账号的反向隧道授权键。仅由 root(经窄 NOPASSWD sudo)调用。
#   add <port> <keytype> <keybody> [comment]
#   remove <port>
set -euo pipefail
TUNNEL_USER="__TUNNEL_USER__"; PORT_LO=__PORT_LO__; PORT_HI=__PORT_HI__
AK="/home/${TUNNEL_USER}/.ssh/authorized_keys"
op="${1:-}"; port="${2:-}"
[[ "${port}" =~ ^[0-9]+$ ]] || { echo "bad port"; exit 2; }
(( port >= PORT_LO && port <= PORT_HI )) || { echo "port out of range"; exit 2; }
install -d -m 700 -o "${TUNNEL_USER}" -g "${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh"
touch "${AK}"
grep -v "permitlisten=\"127.0.0.1:${port}\"" "${AK}" > "${AK}.tmp" 2>/dev/null || true
mv "${AK}.tmp" "${AK}"
if [[ "${op}" == "add" ]]; then
  keytype="${3:-}"; keybody="${4:-}"; comment="${5:-dsh-fleet}"
  [[ "${keytype}" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)$ ]] || { echo "bad keytype"; exit 2; }
  [[ "${keybody}" =~ ^[A-Za-z0-9+/=]+$ ]] || { echo "bad keybody"; exit 2; }
  [[ "${comment}" =~ ^[A-Za-z0-9._@:-]*$ ]] || comment="dsh-fleet"
  # 不用 restrict:OpenSSH 9.6 上 restrict 会禁掉 permitlisten 本应放行的 -R。
  # 其它能力(pty/agent/x11/shell/-L)由 sshd Match 块统一禁。
  printf 'permitlisten="127.0.0.1:%s" %s %s %s\n' "${port}" "${keytype}" "${keybody}" "${comment}" >> "${AK}"
elif [[ "${op}" != "remove" ]]; then
  echo "usage: dsh-fleet-authkeys add <port> <keytype> <keybody> [comment] | remove <port>"; exit 2
fi
chown "${TUNNEL_USER}:${TUNNEL_USER}" "${AK}"; chmod 600 "${AK}"
echo "ok"
HELPER
sed -i "s/__TUNNEL_USER__/${TUNNEL_USER}/g; s/__PORT_LO__/${PORT_LO}/g; s/__PORT_HI__/${PORT_HI}/g" /usr/local/sbin/dsh-fleet-authkeys
chown root:root /usr/local/sbin/dsh-fleet-authkeys
chmod 0755 /usr/local/sbin/dsh-fleet-authkeys

# 4) 窄 NOPASSWD sudoers(只允许免密调这一个助手)
echo "${JUMP_USER} ALL=(root) NOPASSWD: /usr/local/sbin/dsh-fleet-authkeys" > /etc/sudoers.d/dsh-fleet
chmod 440 /etc/sudoers.d/dsh-fleet
visudo -cf /etc/sudoers.d/dsh-fleet

sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "relay-init: tunnel=${TUNNEL_USER}, jump=${JUMP_USER};助手+窄 NOPASSWD 就绪。"
