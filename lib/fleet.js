/**
 * dsh-fleet host 入口。挂 /join + /api/fleet/* 路由,注册一段面向 agent 的 systemPrompt
 * 说明。入网机器最终是一条 dsh-ssh 主机,故本插件不注册任何 agent 工具——操作能力复用
 * dsh-ssh 的 ssh_exec/ssh_upload/... 现成工具。
 *
 * 零外部依赖:不用 schemastery Config(link 插件解析不到)。中继配置存 dsh-fleet.json,
 * 经 POST /api/fleet/relay 设置。baseUrl 直接读 ~/.dsh/settings.yaml 的
 * remote-web-ui.publicBaseUrl(行级正则,不引 YAML 库)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.js'
import { SshProvisioner } from './provisioner-ssh.js'
import { makeRoutes } from './routes.js'
import { sshStorePath } from './ssh-host-writer.js'
import { WorkspaceLauncher } from './launcher.js'

export const name = 'fleet'
export const inject = ['webServer', 'systemPrompt']

// 零外部依赖:不用 schemastery Config(link 插件解析不到)。中继配置存 dsh-fleet.json,
// 经 POST /api/fleet/relay 设置。

const SECTION_ORDER = 151
const GUIDANCE = '本机已安装 dsh-fleet 插件(dph 公网组网)。作用:把异地机器(behind NAT)经一次性 token 拉进车队——用户在 dph 网页(或调 POST /api/fleet/token)铸造 token,得到一行 `curl .../join | bash` 命令,在新机器执行后,机器 sshd 经反向隧道映射到云中继环回口,hub 经 ProxyJump 够到它。入网机器会作为一条别名 fleet-* 的 dsh-ssh 主机出现,因此直接用 ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster 操作它,与局域网机器无异。网页管理面板在 /fleet(待批准/已入网/通过·拒绝·吊销、设中继、加机器命令)。新增机器:在目标机跑 `curl .../join | bash`(Windows: `irm .../join?os=win | iex`),机器显示配对码并挂起,用户在 /fleet 核对配对码后点「通过」即上线。列表/吊销:GET /api/fleet/list、POST /api/fleet/approve/reject/revoke。前置:先经 POST /api/fleet/relay 配置好中继 VPS(社区插件不硬编码)。安全:token 一次性+可过期+可单台吊销;每台机器独立隧道密钥;机器 sshd 只绑中继环回、不暴露公网。用户提到「异地电脑 / 公网组网 / 加一台机器 / 入网 / 远程纳管」时即指本插件。'

/** 从 ~/.dsh/settings.yaml 读 remote-web-ui.publicBaseUrl(零依赖,行级正则)。 */
function readPublicBaseUrl() {
  try {
    const p = join(homedir(), '.dsh', 'settings.yaml')
    if (!existsSync(p)) return ''
    const m = readFileSync(p, 'utf8').match(/publicBaseUrl:\s*(\S+)/)
    return m ? m[1].replace(/^['"]|['"]$/g, '').replace(/\/+$/, '') : ''
  } catch { return '' }
}

export function apply(ctx) {
  const store = new FleetStore()
  const provisioner = new SshProvisioner(() => store.load().relay)
  const baseUrl = () => readPublicBaseUrl() || 'http://127.0.0.1:3080'

  // ① 工作区启动器:为一台 fleet 机器起独立 world web 实例 + cloudflared 隧道(异地"打开工作区")。
  const cfBin = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'cloudflared', 'bin', 'cloudflared')
  const launcher = new WorkspaceLauncher({
    cloudflaredBin: existsSync(cfBin) ? cfBin : 'cloudflared',
    dshArgv: [process.execPath, process.argv[1]],
  })
  ctx.effect(() => () => launcher.stopAll(), 'dsh-anywhere: workspace launcher cleanup')

  const routes = makeRoutes({ store, provisioner, sshStorePath: sshStorePath(), baseUrl, launcher })

  ctx.effect(() => {
    const disposers = routes.map(r => ctx.webServer.register(r))
    return () => { for (const d of disposers) d() }
  }, 'dsh-fleet: routes')

  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({ name: 'plugin:dsh-fleet', order: SECTION_ORDER, text: GUIDANCE })
    return () => dispose()
  }, 'dsh-fleet: prompt section')
}
