/**
 * 渲染 Windows 的「申请→批准」bootstrap(PowerShell)。/join?os=win 返回它,
 * 用户在 Windows 上 `irm .../join?os=win | iex`。与 nix 版同协议:生隧道密钥 +
 * 配对码 + 注册申请 → 轮询 → 批准后写操作公钥 + 建反向隧道 + 计划任务保活 + 上线。
 *
 * Windows 专属处理:
 *  - 需 OpenSSH 服务器(sshd 服务);缺则指引安装并退出。
 *  - 管理员用户 sshd 读 C:\ProgramData\ssh\administrators_authorized_keys(且要求
 *    owner/ACL 仅 Administrators+SYSTEM);非管理员才用 ~\.ssh\authorized_keys。
 *  - 保活用计划任务(开机触发)。
 *
 * 注意(JS 模板):脚本内不得出现 PowerShell 的反引号与 ${...};用字符串拼接与 $(...) 代替。
 */

const BASEURL_RE = /^https:\/\/[A-Za-z0-9.\-:/]+$/

/**
 * @param {{baseUrl:string}} o
 * @returns {string}
 */
export function renderWinBootstrap(o) {
  if (!BASEURL_RE.test(o.baseUrl)) throw new Error('invalid baseUrl')
  const { baseUrl } = o
  return `# dsh-fleet 入网 bootstrap (Windows / PowerShell)
# 注册入网申请并等待机主在 dph 网页批准,批准后把本机 sshd 反向映射到中继、
# 登记为一台可被 dph agent 操作的主机。无需 token。
$ErrorActionPreference = 'Stop'
$BaseUrl = '${baseUrl}'
$FleetDir = Join-Path $env:USERPROFILE '.dsh-fleet'
$Key = Join-Path $FleetDir 'tunnel'
New-Item -ItemType Directory -Force -Path $FleetDir | Out-Null

# 0) 提权检查(真机踩坑):管理员组用户在未提权 PowerShell 里跑本脚本时,授权会静默写进
#    ~\\.ssh\\authorized_keys——但 sshd 对管理员组只认 administrators_authorized_keys,
#    结果 hub 连不上(publickey 拒绝)且无从排查。管理员组成员必须提权运行,当场说清楚。
$wid = [Security.Principal.WindowsIdentity]::GetCurrent()
$isElevated = (New-Object Security.Principal.WindowsPrincipal($wid)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isAdminMember = @($wid.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544'
if ($isAdminMember -and -not $isElevated) {
  Write-Host '本账号属于管理员组,但当前 PowerShell 未提权。请右键「以管理员身份运行」PowerShell 后重跑本命令。'
  return
}

foreach ($c in 'ssh','ssh-keygen') {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Write-Error ('缺 ' + $c + '(请安装 OpenSSH 客户端:Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0)'); return }
}

# 需要 OpenSSH 服务器(hub 要 ssh 进本机)
$sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  Write-Host '未检测到 OpenSSH 服务器。请以管理员运行以下命令安装并启动,然后重跑本命令:'
  Write-Host '  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0'
  Write-Host '  Start-Service sshd; Set-Service -Name sshd -StartupType Automatic'
  return
}
if ($sshd.Status -ne 'Running') { Start-Service sshd }

# 1) 隧道密钥(空口令;Windows 用 '""' 传空)
if (-not (Test-Path $Key)) { ssh-keygen -t ed25519 -N '""' -f $Key -C ('dsh-fleet:' + $env:COMPUTERNAME) | Out-Null }
$TunnelPub = (Get-Content ($Key + '.pub') -Raw).Trim()

# 2) 配对码 + 注册申请
$bytes = New-Object 'System.Byte[]' 4
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$hex = -join ($bytes | ForEach-Object { $_.ToString('X2') })
$Code = $hex.Substring(0,4) + '-' + $hex.Substring(4,4)
$Name = ($env:COMPUTERNAME -replace '[^A-Za-z0-9._-]','')
$reqBody = @{ name=$Name; os='win'; remoteUser=$env:USERNAME; tunnelPublicKey=$TunnelPub; code=$Code } | ConvertTo-Json -Compress
$reg = Invoke-RestMethod -Method Post -Uri ($BaseUrl + '/api/fleet/request') -ContentType 'application/json' -Body $reqBody
$PollId = $reg.pollId
if (-not $PollId) { Write-Error '注册申请失败'; return }
Write-Host ''
Write-Host ('  已提交入网申请,配对码: ' + $Code)
Write-Host '  请到本机 dph 网页「车队 · 待批准」核对并点通过。等待中(最多10分钟)…'

# 3) 轮询
$result = $null
for ($i = 0; $i -lt 200; $i++) {
  try { $s = Invoke-RestMethod -Uri ($BaseUrl + '/api/fleet/request-status?id=' + $PollId) } catch { $s = $null }
  if ($s -and $s.status -eq 'approved') { $result = $s.result; break }
  elseif ($s -and $s.status -eq 'rejected') { Write-Error '申请被拒绝'; return }
  elseif ($s -and ($s.status -eq 'expired' -or $s.status -eq 'unknown')) { Write-Error '申请已过期,请重跑'; return }
  Start-Sleep -Seconds 3
}
if (-not $result) { Write-Error '等待超时,请重跑'; return }
$RelayHost = $result.relayHost; $RelayPort = $result.relayPort; $RelayUser = $result.relayUser
$Port = $result.port; $Id = $result.id; $OpPub = $result.operationPublicKey
$FrpToken = $result.frpToken; $FrpPort = $result.frpServerPort; $FrpProto = $result.frpProtocol

# 4) 授权 hub 操作公钥(管理员 → administrators_authorized_keys + 修 ACL;否则 ~\.ssh)
#    步骤 0 已保证:管理员组成员到这里必然已提权(否则早退),不会写错文件。
$line = 'from="127.0.0.1,::1" ' + $OpPub
$isAdmin = $isElevated
if ($isAdmin) {
  $ak = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  if (-not (Test-Path $ak)) { New-Item -ItemType File -Force -Path $ak | Out-Null }
  if (-not (Select-String -Path $ak -SimpleMatch $OpPub -Quiet -ErrorAction SilentlyContinue)) { Add-Content -Path $ak -Value $line }
  # Windows OpenSSH 要求 administrators_authorized_keys 的 owner 必须是 Administrators/SYSTEM,
  # 否则整份文件被无视(hub 登录报 publickey 拒绝)。New-Item 建的文件 owner 是当前用户,须显式改回。
  icacls $ak /setowner 'Administrators' | Out-Null
  icacls $ak /inheritance:r /grant 'Administrators:F' 'SYSTEM:F' | Out-Null
} else {
  $sshDir = Join-Path $env:USERPROFILE '.ssh'
  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  $ak = Join-Path $sshDir 'authorized_keys'
  if (-not (Test-Path $ak)) { New-Item -ItemType File -Force -Path $ak | Out-Null }
  if (-not (Select-String -Path $ak -SimpleMatch $OpPub -Quiet -ErrorAction SilentlyContinue)) { Add-Content -Path $ak -Value $line }
}

# 5) 建到中继的通道 + 计划任务保活(开机触发)。frp(FrpToken 非空)优先,否则 legacy 反向 ssh -R。
#    frp 稳:frpc 自带心跳+断线优雅重连,不留僵尸监听口。注意:本模板禁反引号与 $大括号。
# 5.0) frps 端口预检:有的网络只放行 22(实测),443 直接超时——frp 走不通就自动回退 ssh -R。
if ($FrpToken) {
  $probe = New-Object Net.Sockets.TcpClient
  $async = $probe.BeginConnect($RelayHost, [int]$FrpPort, $null, $null)
  $frpReachable = $false
  if ($async.AsyncWaitHandle.WaitOne(5000)) { try { $probe.EndConnect($async); $frpReachable = $true } catch { } }
  $probe.Close()
  if (-not $frpReachable) {
    Write-Host ('  本机网络到中继 ' + $FrpPort + ' 端口不通,自动回退反向 ssh 隧道(22)')
    $FrpToken = $null
  }
}
if ($FrpToken) {
  Write-Host '  传输:frp —— 下载 frpc.exe 并配置反向代理…'
  $ProgressPreference = 'SilentlyContinue'   # 否则 PS5 的 Invoke-WebRequest 进度条会让下载巨慢
  $frpcExe = Join-Path $FleetDir 'frpc.exe'
  Invoke-WebRequest -Uri ($BaseUrl + '/api/fleet/frpc?os=win') -OutFile $frpcExe
  $frpcToml = Join-Path $FleetDir 'frpc.toml'
  $toml = @(
    ('serverAddr = "' + $RelayHost + '"'),
    ('serverPort = ' + $FrpPort),
    'loginFailExit = false',
    'auth.method = "token"',
    ('auth.token = "' + $FrpToken + '"'),
    ('transport.protocol = "' + $FrpProto + '"'),
    '',
    '[[proxies]]',
    ('name = "dsh-fleet-' + $Port + '"'),
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 22',
    ('remotePort = ' + $Port)
  )
  Set-Content -Path $frpcToml -Value $toml -Encoding ascii
  $TunExe = $frpcExe; $TunArgs = '-c "' + $frpcToml + '"'
} else {
  # -i 路径用引号拼接(可能含空格);端口用拼接避免 $Port: 被当驱动器
  $TunExe = 'ssh.exe'
  $TunArgs = '-N -T -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes -i "' + $Key + '" -R 127.0.0.1:' + $Port + ':localhost:22 -p ' + $RelayPort + ' ' + $RelayUser + '@' + $RelayHost
}
# 5.1) 开机自启:计划任务;有的机器策略把新任务强制 Disabled(实测,Enable 也无效)→ 回退
#      「启动」文件夹放 .cmd。当次连通不依赖任务:下面 5.2 直接拉起进程。
$action = New-ScheduledTaskAction -Execute $TunExe -Argument $TunArgs
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'dsh-fleet-tunnel' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
if ((Get-ScheduledTask -TaskName 'dsh-fleet-tunnel').State -eq 'Disabled') { schtasks /Change /TN 'dsh-fleet-tunnel' /Enable | Out-Null }
if ((Get-ScheduledTask -TaskName 'dsh-fleet-tunnel').State -eq 'Disabled') {
  Write-Host '  计划任务被本机策略禁用,改用「启动」文件夹自启'
  $cmdPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-fleet-tunnel.cmd'
  Set-Content -Path $cmdPath -Value ('start "" /min "' + $TunExe + '" ' + $TunArgs) -Encoding ascii
} else {
  try { Start-ScheduledTask -TaskName 'dsh-fleet-tunnel' } catch { }
}
# 5.2) 当次立即拉起隧道进程(不等开机;任务能跑时二者幂等——远端口被占的那个自然退出重试)
Start-Sleep -Seconds 2
$alive = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($TunExe)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.StartTime -gt (Get-Date).AddMinutes(-2)) }
if (-not $alive) { Start-Process $TunExe -ArgumentList $TunArgs -WindowStyle Hidden }

# 6) 上线回报
Start-Sleep -Seconds 2
try { Invoke-RestMethod -Method Post -Uri ($BaseUrl + '/api/fleet/heartbeat') -ContentType 'application/json' -Body (@{ id=$Id } | ConvertTo-Json -Compress) | Out-Null } catch {}
Write-Host ('dsh-fleet: 已入网(端口 ' + $Port + ')。回到 dph 网页应能看到本机在线。')
`
}
