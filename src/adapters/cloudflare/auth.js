import { createHash, timingSafeEqual } from 'node:crypto';
import { parseObserverGrants } from '../../control-plane/observations.js';

function denied(error, status) {
  return Response.json({ ok: false, error }, { status, headers: {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  } });
}

const hash = (value) => createHash('sha256').update(value).digest();
const valid = (value) => typeof value === 'string' && value.length >= 32 && value.length <= 4089;

function bearer(request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && authorization.length <= 4096 ? authorization.slice(7) : '';
}

function roleCredentials(env) {
  const operator = env.GHOSTFLEET_OPERATOR_TOKEN;
  const reader = env.GHOSTFLEET_READ_TOKEN;
  const oldObserver = env.GHOSTFLEET_OBSERVER_TOKEN;
  const grants = parseObserverGrants(env);
  const tokens = [operator, reader, oldObserver].filter(valid);
  const digests = new Set(tokens.map((token) => hash(token).toString('hex')));
  const conflict = digests.size !== tokens.length || grants?.some((grant) => digests.has(grant.token_sha256));
  return { operators: [['operator', operator], ['read_only', reader]].filter(([, token]) => valid(token)),
    grants, conflict };
}

export function authorizeApi(request, env) {
  const { operators, conflict } = roleCredentials(env);
  if (conflict) return { response: denied('AUTH_CONFIG_CONFLICT', 503) };
  if (!operators.length) return { response: denied('AUTH_NOT_CONFIGURED', 503) };
  const token = bearer(request);
  if (valid(token)) {
    const digest = hash(token);
    for (const [access, expected] of operators) {
      if (!timingSafeEqual(digest, hash(expected))) continue;
      if (request.method !== 'GET' && access === 'read_only') return { response: denied('READ_ONLY_CREDENTIAL', 403) };
      return { access };
    }
  }
  return { response: denied('UNAUTHORIZED', 401) };
}

export function authorizeObserver(request, env) {
  const { grants, conflict } = roleCredentials(env);
  if (conflict) return { response: denied('AUTH_CONFIG_CONFLICT', 503) };
  if (!grants?.length) return { response: denied('OBSERVER_GRANTS_NOT_CONFIGURED', 503) };
  const token = bearer(request);
  if (!/^gf_obs_[A-Za-z0-9_-]{43}$/.test(token)) return { response: denied('UNAUTHORIZED', 401) };
  const digest = hash(token);
  const grant = grants.find(({ token_sha256 }) => timingSafeEqual(digest, Buffer.from(token_sha256, 'hex')));
  return grant ? { grant } : { response: denied('UNAUTHORIZED', 401) };
}

export function checkObservationGrant(grant, uid, body) {
  const { source, dimension } = body ?? {};
  const scope = body && Object.hasOwn(body, 'scope') ? body.scope : 'primary';
  if (uid !== grant.node_uid || scope !== grant.scope || typeof source !== 'string' || typeof dimension !== 'string' ||
    !grant.streams.includes(`${source}/${dimension}`)) {
    return denied('OBSERVATION_SCOPE_DENIED', 403);
  }
  return null;
}
