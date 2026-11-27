import { isIP } from 'node:net';
import { json } from '../../control-plane/http.js';

function sourceKey(source) {
  const family = isIP(source);
  if (family === 4) return source;
  if (family !== 6 || source.includes('%')) return null;

  let address = source.toLowerCase();
  if (address.includes('.')) {
    const start = address.lastIndexOf(':') + 1;
    const [a, b, c, d] = address.slice(start).split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    address = address.slice(0, start) + high + ':' + low;
  }
  const [left, right] = address.split('::');
  const groups = left ? left.split(':') : [];
  if (right !== undefined) {
    const tail = right ? right.split(':') : [];
    groups.push(...Array(8 - groups.length - tail.length).fill('0'), ...tail);
  }
  const words = groups.map((group) => Number.parseInt(group, 16));
  if (words[5] === 0xffff && words.slice(0, 5).every((word) => word === 0)) {
    return words.slice(6).flatMap((word) => [word >>> 8, word & 0xff]).join('.');
  }
  const prefix = words.slice(0, 4);
  while (prefix.at(-1) === 0) prefix.pop();
  return prefix.map((word) => word.toString(16)).join(':') + '::/64';
}

export async function admitNodeRequest(request, limiter, kind, localTest) {
  const url = new URL(request.url);
  if (localTest === '1' && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) return null;

  const family = kind === 'claim' ? 'CLAIM' : 'REPORT';
  const unavailable = () => json({ ok: false, error: family + '_INGRESS_UNAVAILABLE' }, 503);
  const key = sourceKey(request.headers.get('cf-connecting-ip') ?? '');
  if (!key || !limiter) return unavailable();
  try {
    const result = await limiter.limit({ key });
    if (result.success === true) return null;
    if (result.success === false) return json({ ok: false, error: family + '_RATE_LIMITED' }, 429);
  } catch {
    return unavailable();
  }
  return unavailable();
}
