import { FIRST_USE, classifyFirstUseResponse } from './shared/first-use.js';
const $ = id => document.getElementById(id);
const copy = {
  zh: { subtitle:'首次纳管与心跳状态 · 远程会话仍由原生 OpenSSH 提供', login:'连接控制面', connect:'连接', disconnect:'断开', refresh:'刷新',
    credential:'这里只接受 GhostFleet Operator / Read 访问令牌，不是 Cloudflare 或 SSH 凭据。令牌仅留在页面内存。',
    missing:'控制面尚未初始化，请实例所有者通过原生部署流程设置应用访问令牌。', required:'请输入实例所有者提供的访问令牌。', unknown:'尚不能确认控制面状态，请检查部署或登录入口。',
    panelAccess:'面板访问', checkingAccess:'正在检查面板访问权限…', reconnect:'重新打开面板',
    accessRequired:'当前 Cloudflare Access 会话不可用。重新打开面板以继续。',
    accessDenied:'当前 Cloudflare Access 身份没有面板权限。请联系实例所有者。',
    accessMissing:'面板的 Cloudflare Access 验证尚未配置完成。请联系实例所有者。',
    accessDisconnected:'已断开面板。重新打开面板可复用当前 Cloudflare Access 会话。',
    boundary:'“在线”仅表示最近收到本节点心跳；服务栏是本机进程观测，不代表 Cloudflare/Tailscale 入口或 SSH 登录已通过。',
    create:'首次纳管', label:'节点名称', columns:['节点','心跳状态','最后收到','SSH','Cloudflare','Tailscale','操作'],
    reissue:'重发票据', revoke:'撤销上报', replaceConfirm:'重发将使该节点旧心跳凭据失效，但不改变 SSH。继续？', revokeConfirm:'只撤销心跳上报，不撤销 SSH 或网络权限。继续？',
    delivery:'一次性纳管材料', warning:'短码只在本次显示。响应丢失或安装中断时，先检查同一节点，不要重复创建节点。',
    code:'终端中输入的独立短码', expires:'过期时间', copy:'复制安装命令', hide:'清除此材料', root:'在目标 Linux 终端运行这一行命令。须已有可信 CA、curl 或 wget 和 sha256sum；命令先校验下载脚本，非 root 时请求 sudo，仅在缺少 Python 时安装 python3，不做系统升级。已有 Python 需为 3.10+。短码仍在终端隐藏提示中输入。已有节点重发自动使用 --replace。',
    footer:'面板中断不会切断现有 SSH。节点端没有命令接收器、任务队列或常驻 Agent。',
    empty:'尚无节点。', noInstaller:'安装材料未发布，暂不能生成纳管票据。', uncertain:'操作结果不确定：先刷新列表并核对同一节点，不要盲目重试。',
    stale:'刷新失败，当前显示是旧快照，不代表实时在线状态。', copied:'安装命令已复制；独立短码不在命令中。', online:'在线', total:'节点', read:'仅查看', operator:'操作员', readAt:'快照时间',
    status:{ONLINE:'在线',STALE:'心跳延迟',OFFLINE:'心跳超时',PENDING:'待首次心跳',REVOKED:'已撤销上报',UNREGISTERED:'未绑定上报',UNKNOWN:'未知'},
    states:{active:'活动',inactive:'未运行',failed:'失败',activating:'启动中',deactivating:'停止中',reloading:'重载中',not_found:'未安装/未找到',unknown:'未知'} },
  en: { subtitle:'Enrollment and presence · native OpenSSH remains the session transport', login:'Connect to control plane', connect:'Connect', disconnect:'Disconnect', refresh:'Refresh',
    credential:'Use a GhostFleet Operator / Read token, not a Cloudflare or SSH credential. It stays only in page memory.',
    missing:'Application authentication is not initialized. The deployment owner must configure it through the native deployment flow.', required:'Enter the access token supplied by the instance owner.', unknown:'Backend status is unknown. Check the deployment or login entry.',
    panelAccess:'Panel access', checkingAccess:'Checking panel access…', reconnect:'Reopen panel',
    accessRequired:'Your Cloudflare Access session is unavailable. Reopen the panel to continue.',
    accessDenied:'Your Cloudflare Access identity lacks panel permissions. Contact the instance owner.',
    accessMissing:'Cloudflare Access verification is not configured for the panel. Contact the instance owner.',
    accessDisconnected:'The panel is disconnected. Reopen it to use your current Cloudflare Access session.',
    boundary:'Online means a recent authenticated heartbeat. Service states are local process observations, not proof of inbound Cloudflare/Tailscale or SSH connectivity.',
    create:'Enroll node',label:'Node label',columns:['Node','Presence','Last received','SSH','Cloudflare','Tailscale','Actions'],
    reissue:'Reissue',revoke:'Revoke reporting',replaceConfirm:'Reissuing disables the former reporting credential, not SSH. Continue?',revokeConfirm:'Revoke heartbeat reporting only, not SSH or network access. Continue?',
    delivery:'One-time enrollment',warning:'The code is shown only now. On lost responses or interrupted installation, reconcile this same node instead of creating another.',code:'Separate terminal code',expires:'Expires',copy:'Copy installer command',hide:'Clear delivery',
    root:'Run this one-line command on the target Linux terminal with trusted CA certificates, curl or wget, and sha256sum already available. The command verifies the downloaded shim before execution. It requests sudo only when needed and installs only missing python3, without a system upgrade. An existing Python must be 3.10+. Enter the short code at the hidden terminal prompt. Reissue automatically uses --replace.',
    footer:'A panel outage does not terminate SSH. No command receiver, job queue, or resident agent is installed.',empty:'No nodes yet.',noInstaller:'Pinned installer is not published; ticket creation is disabled.',uncertain:'Outcome uncertain. Refresh and reconcile the same node before retrying.',stale:'Refresh failed. This is an old snapshot, not current online evidence.',copied:'Installer command copied; the separate code is not in it.',online:'online',total:'nodes',read:'read only',operator:'operator',readAt:'Snapshot',
    status:{ONLINE:'Online',STALE:'Stale',OFFLINE:'Heartbeat overdue',PENDING:'Awaiting heartbeat',REVOKED:'Reporting revoked',UNREGISTERED:'Not registered',UNKNOWN:'Unknown'},
    states:{active:'Active',inactive:'Inactive',failed:'Failed',activating:'Starting',deactivating:'Stopping',reloading:'Reloading',not_found:'Not found',unknown:'Unknown'} },
};
let lang = 'zh', token = '', access = null, installer = null, nodeOrigin = '', rows = [], receivedAt = null;
let authMode = null, loginStatus = FIRST_USE.CHECKING;
let epoch = 0, session = new AbortController(), timer = null, busy = false;
const t = key => copy[lang][key];
function text(id, value) { $(id).textContent = value; }
function feedback(value) { text('feedback', value); }
function date(value) { return value ? new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en') : '—'; }
function cell(value) { const td = document.createElement('td'); td.textContent = value; return td; }
function controls() { $('create-ticket').disabled = busy || access !== 'operator' || !installer; $('refresh').disabled = busy; }
function renderLogin() {
  const tokenMode = [FIRST_USE.TOKEN_REQUIRED, FIRST_USE.NOT_INITIALIZED].includes(loginStatus);
  $('login-card').hidden = Boolean(access);
  $('fleet-card').hidden = !access;
  $('login-form').hidden = !tokenMode;
  $('credential-help').hidden = !tokenMode;
  $('reconnect').hidden = ![FIRST_USE.SESSION_REQUIRED, FIRST_USE.DISCONNECTED, FIRST_USE.UNKNOWN].includes(loginStatus);
  text('login-title', t(tokenMode ? 'login' : 'panelAccess'));
  text('first-use', t(loginStatus));
}
function translate() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const [id, key] of Object.entries({subtitle:'subtitle',connect:'connect',disconnect:'disconnect',reconnect:'reconnect',refresh:'refresh','credential-help':'credential',boundary:'boundary','create-ticket':'create','delivery-title':'delivery','delivery-warning':'warning','code-label':'code','expires-label':'expires','copy-command':'copy','hide-delivery':'hide','root-help':'root','footer-note':'footer'})) text(id, t(key));
  $('label').placeholder = t('label');
  $('columns').replaceChildren(...t('columns').map(v => { const th = document.createElement('th'); th.textContent = v; return th; }));
  renderLogin(); render();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, redirect:'manual', cache:'no-store', credentials:'same-origin',
    headers:{accept:'application/json', 'x-requested-with':'XMLHttpRequest', ...(token ? {authorization:'Bearer ' + token} : {}),
      ...(body !== undefined ? {'content-type':'application/json'} : {})},
    ...(body !== undefined ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.any([session.signal, AbortSignal.timeout(10000)]) });
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    let state = classifyFirstUseResponse(response);
    if (response.status === 401) state = FIRST_USE.SESSION_REQUIRED;
    if (response.status === 403) state = FIRST_USE.IDENTITY_DENIED;
    throw Object.assign(new Error('UNEXPECTED_RESPONSE'), { loginStatus:state });
  }
  const data = await response.json();
  if (!response.ok || data?.ok !== true || response.redirected) {
    throw Object.assign(new Error(data?.error ?? 'REQUEST_FAILED'), { loginStatus:classifyFirstUseResponse(response, data) });
  }
  return data;
}
function clearDelivery() { $('delivery').hidden = true; for (const id of ['short-code','delivery-node','expires','command']) text(id,''); }
function disconnect(status = authMode === 'cloudflare_access' ? FIRST_USE.DISCONNECTED : FIRST_USE.TOKEN_REQUIRED) {
  epoch++; session.abort(); session = new AbortController(); clearTimeout(timer);
  token = ''; access = null; authMode = null; installer = null; nodeOrigin = ''; rows = []; receivedAt = null; busy = false;
  $('token').value = ''; loginStatus = status;
  clearDelivery(); feedback(''); renderLogin(); render();
}
function handleSessionFailure(error) {
  const status = error.loginStatus;
  const accessFailure = [FIRST_USE.SESSION_REQUIRED, FIRST_USE.IDENTITY_DENIED, FIRST_USE.ACCESS_NOT_CONFIGURED].includes(status);
  const accessDisabled = authMode === 'cloudflare_access' && [FIRST_USE.TOKEN_REQUIRED, FIRST_USE.NOT_INITIALIZED].includes(status);
  if (!accessFailure && !accessDisabled) return false;
  disconnect(status);
  return true;
}
async function refresh() {
  if (!access) return;
  const e = epoch;
  try {
    const data = await api('/v0/nodes'); if (e !== epoch) return;
    rows = data.nodes; receivedAt = data.received_at; render(); feedback('');
    return true;
  } catch (error) { if (e === epoch && !handleSessionFailure(error)) feedback(t('stale') + ' ' + error.message); }
  finally { if (e === epoch && access) { clearTimeout(timer); timer = setTimeout(refresh, 30000); } }
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function installCommand(ticket, replace = false) {
  const bootstrap = installer.bootstrap;
  const url = quote(bootstrap.url), sha = quote(bootstrap.sha256);
  const replaceArg = replace ? ' --replace' : '';
  return [
    '(set -eu; umask 077;',
    "command -v sha256sum >/dev/null 2>&1 || { echo 'GF_BOOTSTRAP_ERROR SHA256SUM_REQUIRED' >&2; exit 1; };",
    "ca=''; for p in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do if [ -r \"$p\" ] && [ -s \"$p\" ]; then ca=$p; break; fi; done;",
    "[ -n \"$ca\" ] || { echo 'GF_BOOTSTRAP_ERROR CA_BUNDLE_REQUIRED' >&2; exit 1; };",
    'd=$(mktemp -d) || exit 1; trap \'rm -rf "$d"\' 0; trap \'exit 130\' HUP INT TERM;',
    `if command -v curl >/dev/null 2>&1; then status=$(curl -q -fsS --proto '=https' --tlsv1.2 --max-redirs 0 --connect-timeout 10 --max-time 60 --max-filesize 262144 -H 'User-Agent: GhostFleet-Bootstrap/1' --cacert "$ca" -w '%{http_code}' ${url} -o "$d/join.sh") || exit 1; [ "$status" = 200 ] || { echo 'GF_BOOTSTRAP_ERROR BOOTSTRAP_HTTP_STATUS' >&2; exit 1; }; elif command -v wget >/dev/null 2>&1; then wget --no-config -q --https-only --max-redirect=0 --timeout=30 --tries=1 --user-agent='GhostFleet-Bootstrap/1' --ca-certificate="$ca" -O "$d/join.sh" ${url}; else echo 'GF_BOOTSTRAP_ERROR CURL_OR_WGET_REQUIRED' >&2; exit 1; fi;`,
    `printf '%s  %s\\n' ${sha} "$d/join.sh" | sha256sum -c -;`,
    `/bin/sh "$d/join.sh" --origin ${quote(nodeOrigin)} --ticket ${quote(ticket)}${replaceArg})`,
  ].join(' ');
}
async function makeTicket(node) {
  if (!installer || access !== 'operator' || busy) return;
  if (node && !confirm(t('replaceConfirm'))) return;
  const e = epoch; busy = true; controls(); clearDelivery();
  try {
    const data = await api('/v0/enrollment-tickets','POST',node ? {node_uid:node.node_uid} : {label:$('label').value.trim()});
    if (e !== epoch) return;
    text('delivery-node',data.ticket.node_uid); text('short-code',data.short_code); text('expires',date(data.ticket.expires_at));
    text('command',installCommand(data.ticket.ticket_id, Boolean(node))); $('delivery').hidden = false; $('label').value = ''; await refresh();
  } catch (error) {
    if (e === epoch) feedback(t('uncertain') + (handleSessionFailure(error) ? '' : ' ' + error.message));
  }
  finally { if (e === epoch) { busy = false; controls(); render(); } }
}
async function revoke(node) {
  if (busy || !confirm(t('revokeConfirm'))) return;
  const e = epoch; busy = true; controls(); clearDelivery();
  try { await api('/v0/nodes/' + node.node_uid + '/revoke','POST',{}); if (e === epoch) await refresh(); }
  catch (error) {
    if (e === epoch) feedback(t('uncertain') + (handleSessionFailure(error) ? '' : ' ' + error.message));
  }
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
async function connect(entered = '') {
  disconnect(FIRST_USE.CHECKING);
  token = entered;
  const e = epoch;
  try {
    const data = await api('/v0/access');
    if (e !== epoch) return;
    const cloudflareAccess = data.auth_mode === 'cloudflare_access';
    if ((!entered && !cloudflareAccess) || !['operator', 'read_only'].includes(data.access)) throw new Error('UNEXPECTED_RESPONSE');
    authMode = cloudflareAccess ? 'cloudflare_access' : 'bearer';
    if (cloudflareAccess) token = '';
    access = data.access; installer = data.installer; nodeOrigin = data.node_origin;
    renderLogin(); render();
    if (await refresh() && e === epoch && !installer) feedback(t('noInstaller'));
  } catch (error) {
    if (e !== epoch) return;
    const status = error.loginStatus ?? FIRST_USE.UNKNOWN;
    const retryBearer = entered && [FIRST_USE.UNKNOWN, FIRST_USE.TOKEN_REQUIRED].includes(status);
    disconnect(retryBearer ? FIRST_USE.TOKEN_REQUIRED : status);
    if (retryBearer) feedback(error.message);
  }
}
$('login-form').addEventListener('submit', event=>{
  event.preventDefault();
  const entered = $('token').value;
  if (!$('login-form').hidden && entered) return connect(entered);
});
$('disconnect').addEventListener('click',()=>disconnect());$('refresh').addEventListener('click',refresh);
$('reconnect').addEventListener('click',()=>window.location.reload());
$('enroll-form').addEventListener('submit',e=>{e.preventDefault();makeTicket(null);});
$('hide-delivery').addEventListener('click',clearDelivery);
$('copy-command').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('command').textContent);feedback(t('copied'));}catch{feedback('CLIPBOARD_UNAVAILABLE');}});
$('language').addEventListener('change',()=>{lang=$('language').value;translate();});
$('theme').addEventListener('click',()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';});
window.addEventListener('pagehide',()=>disconnect(FIRST_USE.CHECKING));
window.addEventListener('pageshow',event=>{ if (event.persisted) void connect(); });
translate();
void connect();
