import { isIP } from 'node:net';
import { json } from '../../control-plane/http.js';

export async function admitNodeRequest(request, limiter, kind) {
  const url = new URL(request.url);
  if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) return null;

  const family = kind === 'claim' ? 'CLAIM' : 'REPORT';
  const unavailable = () => json({ ok: false, error: family + '_INGRESS_UNAVAILABLE' }, 503);
  const source = request.headers.get('cf-connecting-ip');
  if (!source || !isIP(source) || !limiter) return unavailable();
  try {
    const result = await limiter.limit({ key: source });
    if (result.success === true) return null;
    if (result.success === false) return json({ ok: false, error: family + '_RATE_LIMITED' }, 429);
  } catch {
    return unavailable();
  }
  return unavailable();
}
