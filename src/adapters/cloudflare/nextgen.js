import { authorizeNextgenPanel, authorizeObserver, checkObservationGrant } from './auth.js';
import { admitNodeRequest } from './node-ingress.js';
import { cancelBody, prepare, json } from '../../control-plane/http.js';

const denied = (error, status) => json({ ok: false, error }, status);
const fixed = new Map([
  ['GET /v2/nodes', ['panel', 'list']],
  ['POST /v2/invitations', ['panel', 'issue']],
  ['POST /v2/claim', ['node', 'claim']],
]);
const nodeOperations = new Map([
  ['evidence', ['node', 'report']], ['observation', ['observer', 'observe']],
  ['revoke', ['panel', 'revoke']], ['desired', ['panel', 'desired']],
  ['adopt', ['panel', 'adopt']],
]);
const SHA = /^[a-f0-9]{40}$/;

function route(method, path) {
  const match = fixed.get(method + ' ' + path);
  if (match) return match;
  const entry = /^\/v2\/nodes\/([^/]+)\/([^/]+)$/.exec(path);
  if (entry && method === 'POST' && nodeOperations.has(entry[2])) {
    return [...nodeOperations.get(entry[2]), entry[1]];
  }
  return [];
}

function validOrigin(value, local) {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === 'https:' ||
      (local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch {
    return false;
  }
}

async function identify(request, env) {
  const url = new URL(request.url);
  const [surface, operation, uid] = route(request.method, url.pathname);
  const { GHOSTFLEET_PANEL_ORIGIN: panel, GHOSTFLEET_NODE_ORIGIN: node } = env;
  const local = env.NEXTGEN_LOCAL_TEST === '1';
  if (!validOrigin(panel, local) || !validOrigin(node, local) ||
      (panel === node && !(local && panel.startsWith('http:')))) {
    return { response: denied('ORIGINS_NOT_CONFIGURED', 503) };
  }
  if (!surface || url.search || url.origin !== (surface === 'node' ? node : panel)) {
    return { response: denied('NOT_FOUND', 404) };
  }
  if (surface === 'node') {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') && auth.length <= 512 ? auth.slice(7) : '';
    return { operation, uid, token };
  }
  const from = request.headers.get('origin');
  if (from && request.method === 'POST' && from !== panel) return { response: denied('ORIGIN_DENIED', 403) };
  if (surface === 'observer') {
    const { response, grant } = authorizeObserver(request, env);
    return response ? { response } : { operation, uid, role: 'observer', grant };
  }
  const authorization = await authorizeNextgenPanel(request, env);
  return authorization instanceof Response ? { response: authorization } : { operation, uid, role: authorization.access };
}

export async function prepareNextgen(request, env, edge = false) {
  const identity = await identify(request, env);
  let response = identity.response;
  if (!response && edge && (identity.operation === 'claim' || identity.operation === 'report')) {
    const limiter = identity.operation === 'claim' ? env.NEXTGEN_CLAIM_LIMIT : env.GHOSTFLEET_REPORT_LIMIT;
    response = await admitNodeRequest(request, limiter, identity.operation, env.NEXTGEN_LOCAL_TEST);
  }
  if (response) {
    await cancelBody(request);
    return { response };
  }
  const parsed = await prepare(request, env);
  if (parsed.response) {
    await cancelBody(request);
    return parsed;
  }
  const body = parsed.input.body;
  const deniedGrant = identity.grant && checkObservationGrant(identity.grant, identity.uid, body);
  return deniedGrant ? { response: deniedGrant } : { identity, body };
}

export async function serveNextgen(request, env) {
  const prepared = await prepareNextgen(request, env, true);
  if (prepared.response) return prepared.response;
  try {
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const forwarded = new Request(request.url, {
      method: request.method, headers,
      ...(request.method === 'POST' ? { body: JSON.stringify(prepared.body) } : {}),
    });
    const state = env.GHOSTFLEET_STATE.get(env.GHOSTFLEET_STATE.idFromName('global'));
    const response = await state.fetch(forwarded);
    if (prepared.identity.operation !== 'list' || !response.ok) return response;
    const projection = await response.json();
    return json({ ...projection, control_plane: {
      deployment_id: env.NEXTGEN_VERSION?.id ?? null,
      source_revision: SHA.test(env.NEXTGEN_SOURCE_REVISION ?? '') ? env.NEXTGEN_SOURCE_REVISION : null,
      protocols: ['ghostfleet-heartbeat/v1', 'ghostfleet-evidence/v2'],
    } });
  } catch {
    return denied('STATE_UNAVAILABLE', 503);
  }
}
