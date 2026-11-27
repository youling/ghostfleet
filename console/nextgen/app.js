'use strict';

const element = (id) => document.getElementById(id);
let accessToken = '';
let savedInvitation = null;
const descriptions = {
  network: 'Tailscale 网络', edge: 'Cloudflare 边缘', origin: '源站 SSH', management: '管理 SSH',
  rescue: '独立救援 SSH', compute: 'K3s 计算',
  CURRENT: '当前', READY: '就绪', UNAVAILABLE: '不可用', UNKNOWN: '未知', STALE: '已过期',
  REGISTERED: '已注册', PENDING: '待注册', REVOKED: '已撤销', CONFLICT: '冲突',
  DIFFERENT_FROM_TARGET: '与目标不同', RUNTIME_UNVERIFIED: '运行版本待核',
};

function status(message, failed = false) {
  element('message').textContent = message;
  element('message').dataset.error = String(failed);
}

function tag(name, value, style) {
  const item = document.createElement(name);
  if (value) item.textContent = value;
  if (style) item.className = style;
  return item;
}

function properties(values) {
  const list = tag('dl');
  for (const [key, value] of values) list.append(tag('dt', key), tag('dd', value || '未知'));
  return list;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error('请求未完成（' + response.status + '）');
  return result;
}

function nodeCard(node) {
  const card = tag('article', '', 'card');
  const head = tag('div', '', 'node-head');
  head.append(tag('h3', node.label), tag('span', descriptions[node.reporting], 'state'));
  card.append(head, tag('p', node.node_uid, 'meta'));
  const versions = node.versions;
  card.append(properties([
    ['目标版本', versions.desired?.version], ['已安装', versions.installed?.version],
    ['运行版本', versions.runtime?.version], ['旧版报告器', versions.legacy_reporter ??
      (versions.previous_legacy_reporter ? versions.previous_legacy_reporter.version + '（历史）' : null)],
    ['版本状态', descriptions[versions.state]],
  ]));
  const details = tag('details');
  details.append(tag('summary', '健康与来源'), properties(Object.entries(node.health).map(([dimension, health]) => {
    const value = descriptions[health.verdict] ?? health.verdict;
    const sources = health.observations.map((item) => [item.source, item.scope, item.version, item.observed_at]
      .filter(Boolean).join(' · '));
    return [descriptions[dimension], [value, ...sources].join(' / ')];
  })));
  if (versions.received_at) details.append(tag('p', '节点自报 · ' + versions.received_at, 'meta'));
  card.append(details);
  return card;
}

async function refresh() {
  const catalog = await api('/v2/nodes');
  const nodes = catalog.nodes;
  element('fleet').hidden = false;
  element('nodes').replaceChildren(...nodes.map(nodeCard));
  if (!nodes.length) element('nodes').append(tag('p', '暂无节点。'));
  element('deployment').textContent = catalog.control_plane.source_revision ?
    '源码 ' + catalog.control_plane.source_revision.slice(0, 12) : '控制面源码版本未知';
  element('enrollment').hidden = catalog.access !== 'operator';
  const select = element('target');
  const previous = select.value;
  select.replaceChildren(new Option('新节点', ''), ...nodes.map((node) => new Option(node.label, node.node_uid)));
  if ([...select.options].some((item) => item.value === previous)) select.value = previous;
}

async function action(button, run) {
  button.disabled = true;
  status('');
  try {
    await run();
  } catch (error) {
    status(error instanceof Error ? error.message : '请求失败', true);
  } finally {
    button.disabled = false;
  }
}

element('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  action(event.submitter, async () => {
    element('enrollment').hidden = true;
    element('fleet').hidden = true;
    savedInvitation = null;
    element('download').hidden = true;
    accessToken = element('access-token').value;
    element('access-token').value = '';
    await refresh();
  });
});
element('refresh').addEventListener('click', (event) => action(event.currentTarget, refresh));
element('invite').addEventListener('submit', (event) => {
  event.preventDefault();
  action(event.submitter, async () => {
    const uid = element('target').value;
    const label = element('label').value.trim();
    if (!uid && !label) throw Error('请输入新节点名称。');
    const profile = { channel: element('channel').value, platform: element('platform').value,
      config_revision: element('config-revision').value, desired: null };
    const result = await api('/v2/invitations', { profile, ...(uid ? { node_uid: uid } : { label }) });
    savedInvitation = { node_uid: result.node_uid, invitation: result.invitation };
    status('邀请已签发。到期时间 ' + result.expires_at);
    element('download').hidden = false;
  });
});
element('download').addEventListener('click', () => {
  if (!savedInvitation) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(savedInvitation)], { type: 'application/json' }));
  const link = tag('a');
  link.href = url;
  link.download = 'ghostfleet-invitation.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  savedInvitation = null;
  element('download').hidden = true;
});
