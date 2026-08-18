/**
 * dsh 车队管理页(host 直接托管的自包含 HTML+原生 JS,零构建)。GET /fleet 返回它。
 * 机主在 dph 域名下打开,管理:待批准(通过/拒绝)、已入网(吊销)、设中继、加机器命令。
 * 页面里所有请求都是同源 fetch,过 host 侧 privileged 栅栏(fromTunnelOrLocal + 同源)。
 * name/sourceIp 等来自机器申请(不可信),渲染时转义防 XSS。
 */

/**
 * @param {string} baseUrl dph 公网域名(用于展示加机器命令)
 * @returns {string} 完整 HTML
 */
export function renderFleetPanel(baseUrl) {
  const B = JSON.stringify(baseUrl)
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh 车队</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--line:#262b36;--fg:#e6e8ec;--mut:#8b93a1;--acc:#4f7cff;--ok:#31c48d;--warn:#f0883e;--danger:#f05252}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
.wrap{max-width:820px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.badge{font-size:12px;padding:1px 8px;border-radius:999px;background:#232833;color:var(--mut)}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.row:first-of-type{border-top:0}
.grow{flex:1;min-width:140px}.name{font-weight:600}.meta{color:var(--mut);font-size:12px}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:1px;background:#0c1830;color:#a9c2ff;border:1px solid #22345e;border-radius:8px;padding:4px 10px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}.on{background:var(--ok)}.off{background:#4b5563}
button{font:inherit;border:1px solid var(--line);background:#222833;color:var(--fg);border-radius:8px;padding:6px 12px;cursor:pointer}
button:hover{border-color:#3a4150}button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.danger{background:transparent;border-color:#5a2b2f;color:var(--danger)}
input{font:inherit;background:#0e1117;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 10px}
pre{background:#0c0f14;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12px;margin:6px 0}
.empty{color:var(--mut);font-size:13px;padding:6px 0}
.pill{font-size:11px;padding:1px 7px;border-radius:6px;background:#232833;color:var(--mut);text-transform:uppercase}
a{color:var(--acc)}
</style></head><body><div class="wrap">
<h1>dsh 车队</h1><div class="sub">异地机器申请入网 → 你核对配对码后批准 → 机器自动上线,agent 即可操作。</div>

<div class="card" id="relayCard"></div>
<div class="card">
  <h2>➕ 加一台机器</h2>
  <div class="meta">在目标机器上运行(它会显示配对码并挂起等待批准):</div>
  <div class="pill">Linux / macOS</div><pre id="cmdNix"></pre>
  <div class="pill">Windows (PowerShell 管理员)</div><pre id="cmdWin"></pre>
</div>
<div class="card"><h2>⏳ 待批准 <span class="badge" id="reqCount">0</span></h2><div id="requests"></div></div>
<div class="card"><h2>🖥 已入网 <span class="badge" id="mcount">0</span></h2><div id="machines"></div></div>
</div>
<script>
const BASE = ${B};
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, opts){ const r = await fetch(path, Object.assign({headers:{'content-type':'application/json'}}, opts||{})); try{return await r.json()}catch(e){return {}} }
function ago(t){ if(!t)return''; const s=Math.max(0,Math.floor((Date.now()-t)/1000)); if(s<60)return s+'秒前'; if(s<3600)return Math.floor(s/60)+'分钟前'; return Math.floor(s/3600)+'小时前'; }

$('#cmdNix').textContent = "curl -fsSL '"+BASE+"/join' | bash";
$('#cmdWin').textContent = "irm '"+BASE+"/join?os=win' | iex";

function renderRelay(relay){
  const el = $('#relayCard');
  if(relay && relay.configured){
    el.innerHTML = '<h2>🛰 中继 <span class="badge">已配置</span></h2><div class="meta">'+esc(relay.host)+'</div>';
  } else {
    el.innerHTML = '<h2>🛰 中继 <span class="badge" style="color:#f0883e">未配置</span></h2>'+
      '<div class="meta">先配置你的公网中继 VPS(已用 relay-init.sh 初始化过的那台):</div>'+
      '<div class="row"><input id="rh" placeholder="中继地址 如 1.2.3.4" class="grow"><input id="rj" placeholder="跳板登录 如 ubuntu@1.2.3.4" class="grow"><button class="primary" data-act="setRelay">保存</button></div>';
  }
}
async function setRelay(){
  const host=$('#rh').value.trim(), jumpLogin=$('#rj').value.trim();
  if(!host){alert('请填中继地址');return}
  await api('/api/fleet/relay',{method:'POST',body:JSON.stringify({host,jumpLogin})}); refresh();
}
function renderRequests(reqs){
  reqs = reqs||[]; $('#reqCount').textContent = reqs.length;
  $('#requests').innerHTML = reqs.length ? reqs.map(r =>
    '<div class="row"><div class="grow"><span class="name">'+esc(r.name)+'</span> <span class="pill">'+esc(r.os)+'</span>'+
    '<div class="meta">来自 '+esc(r.sourceIp)+' · '+ago(r.createdAt)+'</div></div>'+
    '<span class="code">'+esc(r.code)+'</span>'+
    '<button class="primary" data-act="approve" data-req="'+esc(r.reqId)+'" data-name="'+esc(r.name)+'">通过</button>'+
    '<button data-act="reject" data-req="'+esc(r.reqId)+'">拒绝</button></div>'
  ).join('') : '<div class="empty">暂无待批准的机器。在目标机器上跑上面的命令即可申请。</div>';
}
function renderMachines(ms){
  ms = ms||[]; $('#mcount').textContent = ms.length;
  $('#machines').innerHTML = ms.length ? ms.map(m => {
    const on = m.status==='online';
    return '<div class="row"><div class="grow"><span class="dot '+(on?'on':'off')+'"></span><span class="name">'+esc(m.alias)+'</span> <span class="pill">'+esc(m.os)+'</span>'+
    '<div class="meta">端口 '+esc(m.port)+' · '+(on?'在线':(m.status==='enrolling'?'连接中':'离线'))+(m.lastSeen?' · '+ago(m.lastSeen):'')+'</div></div>'+
    '<button class="danger" data-act="revoke" data-alias="'+esc(m.alias)+'">吊销</button></div>';
  }).join('') : '<div class="empty">还没有已入网的机器。</div>';
}
async function approve(reqId, name){
  const alias = prompt('给这台机器起个别名(留空用 "'+name+'"):', name);
  if(alias===null) return;
  const res = await api('/api/fleet/approve',{method:'POST',body:JSON.stringify({reqId,alias:(alias.trim()||name)})});
  if(res && res.error) alert('批准失败:'+res.error);
  refresh();
}
async function reject(reqId){ await api('/api/fleet/reject',{method:'POST',body:JSON.stringify({reqId})}); refresh(); }
async function revoke(alias){ if(!confirm('吊销「'+alias+'」?该机器将不可达。')) return; await api('/api/fleet/revoke',{method:'POST',body:JSON.stringify({alias})}); refresh(); }
async function refresh(){ try{ const d = await api('/api/fleet/list'); renderRelay(d.relay); renderRequests(d.requests); renderMachines(d.machines); }catch(e){ console.error(e); } }
// 事件委托:按钮用 data-* 携带参数,避免 inline onclick 的引号冲突
document.addEventListener('click', function(e){
  const b = e.target.closest('button[data-act]'); if(!b) return;
  const act = b.getAttribute('data-act');
  if(act==='approve') approve(b.getAttribute('data-req'), b.getAttribute('data-name'));
  else if(act==='reject') reject(b.getAttribute('data-req'));
  else if(act==='revoke') revoke(b.getAttribute('data-alias'));
  else if(act==='setRelay') setRelay();
});
refresh(); setInterval(refresh, 3000);
</script></body></html>`
}
