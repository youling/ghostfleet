import { FIRST_USE, probeFirstUse } from './shared/first-use.js';
const $ = id => document.getElementById(id);
const copy = {
  zh: { subtitle:'首次纳管与心跳状态 · 远程会话仍由原生 OpenSSH 提供', login:'连接控制面', connect:'连接', disconnect:'断开', refresh:'刷新',
    credential:'这里只接受 GhostFleet Operator / Read 访问令牌，不是 Cloudflare 或 SSH 凭据。令牌仅留在页面内存。',
    missing:'控制面尚未初始化，请实例所有者通过原生部署流程设置应用访问令牌。', required:'请输入实例所有者提供的访问令牌。', unknown:'尚不能确认控制面状态，请检查部署或登录入口。',
    boundary:'“在线”仅表示最近收到本节点心跳；服务栏是本机进程观测，不代表 Cloudflare/Tailscale 入口或 SSH 登录已通过。',
    create:'首次纳管', label:'节点名称', columns:['节点','心跳状态','最后收到','SSH','Cloudflare','Tailscale','操作'],
    reissue:'重发票据', revoke:'撤销上报', replaceConfirm:'重发将使该节点旧心跳凭据失效，但不改变 SSH。继续？', revokeConfirm:'只撤销心跳上报，不撤销 SSH 或网络权限。继续？',
    delivery:'一次性纳管材料', warning:'短码只在本次显示。响应丢失或安装中断时，先检查同一节点，不要重复创建节点。',
    code:'终端中输入的独立短码', expires:'过期时间', copy:'复制安装命令', hide:'清除此材料', root:'复制整条命令到目标 Linux 终端。命令会先校验固定版本的 Shell 引导器，再以 root 运行；若缺少 Python 3，会按系统发行版只补装 python3，不执行系统升级。短码由安装器隐藏提示，绝不放进命令。已有节点重发票据时会保留原 node_uid。',
    footer:'面板中断不会切断现有 SSH。节点端没有命令接收器、任务队列或常驻 Agent。',
    empty:'尚无节点。', noInstaller:'安装材料未发布，暂不能生成纳管票据。', uncertain:'操作结果不确定：先刷新列表并核对同一节点，不要盲目重试。',
    stale:'刷新失败，当前显示是旧快照，不代表实时在线状态。', copied:'安装命令已复制；独立短码不在命令中。', online:'在线', total:'节点', read:'仅查看', operator:'操作员', readAt:'快照时间',
    status:{ONLINE:'在线',STALE:'心跳延迟',OFFLINE:'心跳超时',PENDING:'待首次心跳',REVOKED:'已撤销上报',UNREGISTERED:'未绑定上报',UNKNOWN:'未知'},
    states:{active:'活动',inactive:'未运行',failed:'失败',activating:'启动中',deactivating:'停止中',reloading:'重载中',not_found:'未安装/未找到',unknown:'未知'} },
  en: { subtitle:'Enrollment and presence · native OpenSSH remains the session transport', login:'Connect to control plane', connect:'Connect', disconnect:'Disconnect', refresh:'Refresh',
    credential:'Use a GhostFleet Operator / Read token, not a Cloudflare or SSH credential. It stays only in page memory.',
    missing:'Application authentication is not initialized. The deployment owner must configure it through the native deployment flow.', required:'Enter the access token supplied by the instance owner.', unknown:'Backend status is unknown. Check the deployment or login entry.',
    boundary:'Online means a recent authenticated heartbeat. Service states are local process observations, not proof of inbound Cloudflare/Tailscale or SSH connectivity.',
    create:'Enroll node',label:'Node label',columns:['Node','Presence','Last received','SSH','Cloudflare','Tailscale','Actions'],
    reissue:'Reissue',revoke:'Revoke reporting',replaceConfirm:'Reissuing disables the former reporting credential, not SSH. Continue?',revokeConfirm:'Revoke heartbeat reporting only, not SSH or network access. Continue?',
    delivery:'One-time enrollment',warning:'The code is shown only now. On lost responses or interrupted installation, reconcile this same node instead of creating another.',code:'Separate terminal code',expires:'Expires',copy:'Copy installer command',hide:'Clear delivery',
    root:'Copy the complete command to the target Linux terminal. It verifies the pinned shell bootstrap before running as root. If Python 3 is missing, it installs only python3 using the supported distro package manager; it never runs a system upgrade. The short code is requested with hidden input and is never placed in the command. Reissues preserve the existing node_uid.',
    footer:'A panel outage does not terminate SSH. No command receiver, job queue, or resident agent is installed.',empty:'No nodes yet.',noInstaller:'Pinned installer is not published; ticket creation is disabled.',uncertain:'Outcome uncertain. Refresh and reconcile the same node before retrying.',stale:'Refresh failed. This is an old snapshot, not current online evidence.',copied:'Installer command copied; the separate code is not in it.',online:'online',total:'nodes',read:'read only',operator:'operator',readAt:'Snapshot',
    status:{ONLINE:'Online',STALE:'Stale',OFFLINE:'Heartbeat overdue',PENDING:'Awaiting heartbeat',REVOKED:'Reporting revoked',UNREGISTERED:'Not registered',UNKNOWN:'Unknown'},
    states:{active:'Active',inactive:'Inactive',failed:'Failed',activating:'Starting',deactivating:'Stopping',reloading:'Reloading',not_found:'Not found',unknown:'Unknown'} },
};
let lang = 'zh', token = '', access = null, installer = null, bootstrap = null, nodeOrigin = '', rows = [], receivedAt = null;
let epoch = 0, session = new AbortController(), timer = null, busy = false;
const t = key => copy[lang][key];
function text(id, value) { $(id).textContent = value; }
function feedback(value) { text('feedback', value); }
function date(value) { return value ? new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en') : '—'; }
function cell(value) { const td = document.createElement('td'); td.textContent = value; return td; }
function controls() { $('create-ticket').disabled = busy || access !== 'operator' || !installer || !bootstrap; $('refresh').disabled = busy; }
function translate() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const [id, key] of Object.entries({subtitle:'subtitle','login-title':'login',connect:'connect',disconnect:'disconnect',refresh:'refresh','credential-help':'credential',boundary:'boundary','create-ticket':'create','delivery-title':'delivery','delivery-warning':'warning','code-label':'code','expires-label':'expires','copy-command':'copy','hide-delivery':'hide','root-help':'root','footer-note':'footer'})) text(id, t(key));
  $('label').placeholder = t('label');
  $('columns').replaceChildren(...t('columns').map(v => { const th = document.createElement('th'); th.textContent = v; return th; }));
  render();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, redirect:'error', cache:'no-store', credentials:'same-origin',
    headers:{authorization:'Bearer ' + token, ...(body !== undefined ? {'content-type':'application/json'} : {})},
    ...(body !== undefined ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.any([session.signal, AbortSignal.timeout(10000)]) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('UNEXPECTED_RESPONSE');
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error(data.error ?? 'REQUEST_FAILED');
  return data;
}
function clearDelivery() { $('delivery').hidden = true; for (const id of ['short-code','delivery-node','expires','command']) text(id,''); }
function disconnect() {
  epoch++; session.abort(); session = new AbortController(); clearTimeout(timer);
  token = ''; access = null; installer = null; bootstrap = null; rows = []; receivedAt = null; busy = false;
  $('token').value = ''; $('fleet-card').hidden = true; $('login-card').hidden = false;
  clearDelivery(); feedback(''); render();
}
async function refresh() {
  const e = epoch;
  try {
    const data = await api('/v0/nodes'); if (e !== epoch) return;
    rows = data.nodes; receivedAt = data.received_at; render(); feedback('');
  } catch (error) { if (e === epoch) feedback(t('stale') + ' ' + error.message); }
  finally { if (e === epoch && token) { clearTimeout(timer); timer = setTimeout(refresh, 30000); } }
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function installCommand(ticket, replace = false) {
  const inner = [
    'set -eu',
    'umask 077',
    'tmp=$(mktemp /tmp/ghostfleet-join.XXXXXX)',
    \`trap 'rm -f "$tmp"' 0\`,
    \`curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 --output "$tmp" \${quote(bootstrap.url)}\`,
    \`printf '%s  %s\\n' \${quote(bootstrap.sha256)} "$tmp" | sha256sum -c - >/dev/null\`,
    \`/bin/sh "$tmp" --origin \${quote(nodeOrigin)} --ticket \${quote(ticket)}\${replace ? ' --replace' : ''}\`,
  ].join('; ');
  return 'if [ "$(id -u)" -eq 0 ]; then /bin/sh -c ' + quote(inner) + '; else sudo /bin/sh -c ' + quote(inner) + '; fi';
}
async function makeTicket(node) {
  if (!installer || !bootstrap || access !== 'operator' || busy) return;
  if (node && !confirm(t('replaceConfirm'))) return;
  const e = epoch; busy = true; controls(); clearDelivery();
  try {
    const data = await api('/v0/enrollment-tickets','POST',node ? {node_uid:node.node_uid} : {label:$('label').value.trim()});
    if (e !== epoch) return;
    text('delivery-node',data.ticket.node_uid); text('short-code',data.short_code); text('expires',date(data.ticket.expires_at));
    text('command',installCommand(data.ticket.ticket_id, Boolean(node))); $('delivery').hidden = false; $('label').value = ''; await refresh();
  } catch (error) { if (e === epoch) feedback(t('uncertain') + ' ' + error.message); }
  finally { if (e === epoch) { busy = false; controls(); render(); } }
}
async function revoke(node) {
  if (busy || !confirm(t('revokeConfirm'))) return;
  const e = epoch; busy = true; controls(); clearDelivery();
  try { await api('/v0/nodes/' + node.node_uid + '/revoke','POST',{}); if (e === epoch) await refresh(); }
  catch (error) { if (e === epoch) feedback(t('uncertain') + ' ' + error.message); }
  finally { if (e === epoch) { busy = false; controls(); render(); } }
}
function render() {
  text('summary',rows.filter(n=>n.presence==='ONLINE').length+' '+t('online')+' / '+rows.length+' '+t('total')+' · '+(access==='operator'?t('operator'):t('read')));
  text('read-time',t('readAt')+': '+date(receivedAt));
  const body = $('nodes'); body.replaceChildren();
  for (const n of rows) {
    const tr = document.createElement('tr'), label = cell(n.label), small = document.createElement('small'); small.textContent = n.node_uid; label.append(small); tr.append(label);
    const state = cell(''), badge = document.createElement('span'); badge.className = 'status status-' + String(n.presence).toLowerCase(); badge.textContent = t('status')[n.presence] ?? t('status').UNKNOWN; state.append(badge); tr.append(state,cell(date(n.last_seen_at)));
    for (const role of ['ssh','cloudflared','tailscaled']) tr.append(cell(t('states')[n.report?.services?.[role]] ?? '—'));
    const actions = cell('');
    if (access === 'operator') for (const [labelKey, handler] of [['reissue',makeTicket],['revoke',revoke]]) {
      const b = document.createElement('button'); b.type='button'; b.textContent=t(labelKey); b.disabled=busy || (labelKey==='reissue'&&!installer); b.addEventListener('click',()=>handler(n)); actions.append(b);
    }
    tr.append(actions); body.append(tr);
  }
  if (!rows.length) { const tr=document.createElement('tr'),td=cell(t('empty')); td.colSpan=7;tr.append(td);body.append(tr); }
  controls();
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault(); const entered=$('token').value; disconnect(); token=entered; const e=epoch;
  try { const data=await api('/v0/access'); if(e!==epoch)return; access=data.access;installer=data.installer;bootstrap=data.bootstrap;nodeOrigin=data.node_origin;
    $('login-card').hidden=true;$('fleet-card').hidden=false;await refresh();if(!installer || !bootstrap)feedback(t('noInstaller'));
  } catch(error) { if(e===epoch){disconnect();feedback(error.message);} }
});
$('disconnect').addEventListener('click',disconnect);$('refresh').addEventListener('click',refresh);
$('enroll-form').addEventListener('submit',e=>{e.preventDefault();makeTicket(null);});
$('hide-delivery').addEventListener('click',clearDelivery);
$('copy-command').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('command').textContent);feedback(t('copied'));}catch{feedback('CLIPBOARD_UNAVAILABLE');}});
$('language').addEventListener('change',()=>{lang=$('language').value;translate();});
$('theme').addEventListener('click',()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';});
window.addEventListener('pagehide',disconnect);
translate();
probeFirstUse().then(state=>text('first-use',state===FIRST_USE.NOT_INITIALIZED?t('missing'):state===FIRST_USE.TOKEN_REQUIRED?t('required'):t('unknown')));
