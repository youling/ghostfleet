import { FIRST_USE, probeFirstUse } from './shared/first-use.js';
const $ = id => document.getElementById(id);
const copy = {
  zh: { subtitle:'首次纳管与心跳状态 · 远程会话仍由原生 OpenSSH 提供', login:'连接控制面', connect:'连接', disconnect:'断开', refresh:'刷新',
    credential:'这里只接受 GhostFleet Operator / Read 访问令牌，不是 Cloudflare 或 SSH 凭据。令牌仅留在页面内存。',
    missing:'控制面尚未初始化，请实例所有者通过原生部署流程设置应用访问令牌。', required:'请输入实例所有者提供的访问令牌。', unknown:'尚不能确认控制面状态，请检查部署或登录入口。',
    boundary:'“在线”仅表示最近收到本节点心跳；服务栏是本机进程观测，不代表 Cloudflare/Tailscale 入口或 SSH 登录已通过。',
    create:'注册心跳', retryTicket:'核对票据', issueUncertain:'尚未收到签发结果，可用「核对票据」查看同一请求。', ticketRecovered:'已找回原节点。短码仅显示一次，如未保存，请在该节点行重发票据。节点：', label:'节点名称', columns:['节点','心跳状态','最后收到','SSH','Cloudflare','Tailscale','操作'],
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
    boundary:'Online means a recent authenticated heartbeat. Service states are local process observations, not proof of inbound Cloudflare/Tailscale or SSH connectivity.',
    create:'Register heartbeat',retryTicket:'Check ticket',issueUncertain:'No issue receipt yet. Check ticket to recover the result of the same request.',ticketRecovered:'The original node was recovered. If you missed the one-time code, reissue the ticket from that node’s row. Node: ',label:'Node label',columns:['Node','Presence','Last received','SSH','Cloudflare','Tailscale','Actions'],
    reissue:'Reissue',revoke:'Revoke reporting',replaceConfirm:'Reissuing disables the former reporting credential, not SSH. Continue?',revokeConfirm:'Revoke heartbeat reporting only, not SSH or network access. Continue?',
    delivery:'One-time enrollment',warning:'The code is shown only now. On lost responses or interrupted installation, reconcile this same node instead of creating another.',code:'Separate terminal code',expires:'Expires',copy:'Copy installer command',hide:'Clear delivery',
    root:'Run this one-line command on the target Linux terminal with trusted CA certificates, curl or wget, and sha256sum already available. The command verifies the downloaded shim before execution. It requests sudo only when needed and installs only missing python3, without a system upgrade. An existing Python must be 3.10+. Enter the short code at the hidden terminal prompt. Reissue automatically uses --replace.',
    footer:'A panel outage does not terminate SSH. No command receiver, job queue, or resident agent is installed.',empty:'No nodes yet.',noInstaller:'Pinned installer is not published; ticket creation is disabled.',uncertain:'Outcome uncertain. Refresh and reconcile the same node before retrying.',stale:'Refresh failed. This is an old snapshot, not current online evidence.',copied:'Installer command copied; the separate code is not in it.',online:'online',total:'nodes',read:'read only',operator:'operator',readAt:'Snapshot',
    status:{ONLINE:'Online',STALE:'Stale',OFFLINE:'Heartbeat overdue',PENDING:'Awaiting heartbeat',REVOKED:'Reporting revoked',UNREGISTERED:'Not registered',UNKNOWN:'Unknown'},
    states:{active:'Active',inactive:'Inactive',failed:'Failed',activating:'Starting',deactivating:'Stopping',reloading:'Reloading',not_found:'Not found',unknown:'Unknown'} },
};
let lang = 'zh', token = '', access = null, installer = null, nodeOrigin = '', rows = [], receivedAt = null;
let epoch = 0, session = new AbortController(), timer = null, busy = false;
const ticketAttemptKey = 'ghostfleet:initial-ticket-attempt';
let ticketAttempt = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(ticketAttemptKey));
  if (typeof saved?.label === 'string' && typeof saved.attempt_id === 'string') {
    ticketAttempt = { label: saved.label, attempt_id: saved.attempt_id };
    $('label').value = saved.label;
  }
} catch { /* Use in-memory recovery when browser storage is unavailable. */ }
function saveTicketAttempt(attempt) {
  ticketAttempt = attempt;
  try {
    if (attempt) sessionStorage.setItem(ticketAttemptKey, JSON.stringify(attempt));
    else sessionStorage.removeItem(ticketAttemptKey);
  } catch { /* A normal response does not depend on browser storage. */ }
}
const t = key => copy[lang][key];
function text(id, value) { $(id).textContent = value; }
function feedback(value) { text('feedback', value); }
function date(value) { return value ? new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en') : '—'; }
function cell(value) { const td = document.createElement('td'); td.textContent = value; return td; }
function controls() {
  $('create-ticket').disabled = busy || access !== 'operator' || !installer;
  $('label').readOnly = busy || ticketAttempt !== null;
  text('create-ticket', t(ticketAttempt ? 'retryTicket' : 'create'));
  $('refresh').disabled = busy;
}
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
  if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error ?? 'REQUEST_FAILED'), { ticket: data.ticket });
  return data;
}
function clearDelivery() { $('delivery').hidden = true; for (const id of ['short-code','delivery-node','expires','command']) text(id,''); }
function disconnect() {
  epoch++; session.abort(); session = new AbortController(); clearTimeout(timer);
  token = ''; access = null; installer = null; rows = []; receivedAt = null; busy = false;
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
async function recoverTicket(ticket, requestEpoch) {
  saveTicketAttempt(null); $('label').value = '';
  await refresh();
  if (requestEpoch === epoch) feedback(t('ticketRecovered') + ticket.node_uid);
}
async function makeTicket(node) {
  if (!installer || access !== 'operator' || busy) return;
  if (node && !confirm(t('replaceConfirm'))) return;
  const e = epoch; busy = true; controls(); clearDelivery();
  try {
    if (!node && !ticketAttempt) saveTicketAttempt({ label: $('label').value.trim(), attempt_id: crypto.randomUUID() });
    const data = await api('/v0/enrollment-tickets','POST',node ? {node_uid:node.node_uid} : ticketAttempt);
    if (e !== epoch) return;
    if (!node && data.short_code === null) {
      await recoverTicket(data.ticket, e);
      return;
    }
    text('delivery-node',data.ticket.node_uid); text('short-code',data.short_code); text('expires',date(data.ticket.expires_at));
    text('command',installCommand(data.ticket.ticket_id, Boolean(node)));
    $('delivery').hidden = false;
    if (!node) { saveTicketAttempt(null); $('label').value = ''; }
    await refresh();
  } catch (error) {
    if (e === epoch) {
      if (!node && error.message === 'ENROLLMENT_ATTEMPT_CONFLICT' && error.ticket?.node_uid) {
        await recoverTicket(error.ticket, e);
        return;
      }
      // A previous Worker may reject an unknown field. Keep the original
      // attempt through rollback until the server can reconcile it.
      if (!node && ['INVALID_LABEL', 'LABEL_REQUIRED', 'INVALID_ENROLLMENT_ATTEMPT'].includes(error.message)) saveTicketAttempt(null);
      feedback(t(!node && ticketAttempt ? 'issueUncertain' : 'uncertain') + ' ' + error.message);
    }
  }
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
  try { const data=await api('/v0/access'); if(e!==epoch)return; access=data.access;installer=data.installer;nodeOrigin=data.node_origin;
    $('login-card').hidden=true;$('fleet-card').hidden=false;await refresh();if(!installer)feedback(t('noInstaller'));
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
