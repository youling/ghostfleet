import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const secretHeader = ['-----BEGIN ', '(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?', 'PRIVATE KEY-----'].join('');
const rules = [
  ['secret-material', new RegExp(secretHeader, 'g')],
  ['credential-shape', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tskey-(?:auth|client|api)-[A-Za-z0-9_-]{15,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g],
  ['jwt-shape', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['authorization-literal', /Authorization\s*[:=]\s*["'](?:Bearer|Basic)\s+[A-Za-z0-9_.+/=-]{12,}/gi],
  ['credential-literal', /\b(?:password|secret|token|private_key|api_key)\b\s*[:=]\s*["'][^"'\r\n]{12,}["']/gi],
  ['provider-key', /\b(?:nodekey|machinekey):[0-9a-f]{32,}\b/gi],
  ['node-identity', /\bnode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['tailnet-locator', /\b[A-Za-z0-9_.-]+\.(?:ts\.net|tailscale\.net)\b/gi],
  ['user-home', /(?:[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+|\/home\/[A-Za-z0-9_.-]+)/g],
  ['private-source-link', /https?:\/\/github\.com\/[^\s/]+\/(?:fleet|assets|ai-hub)(?:\b|\/)/gi],
];
const prohibitedPath = /(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env|known_hosts|id_(?:rsa|ed25519)|registry|inventory(?:\.(?:ya?ml|json|csv|ini|toml|txt))?|nodes\.(?:ya?ml|json)|runtime|receipts|private-custody|raw-logs|raw-[^/]*\.(?:zip|tar|gz|jsonl|log))(?:$|\/)/i;
const safePath = value => /(?:^|\/)(?:id_(?:rsa|ed25519)|known_hosts|\.dev\.vars|nodes\.(?:ya?ml|json))/.test(value) || /\b(?:gh[pousr]_|tskey-|node-[0-9a-f]{8}-)|(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/)/.test(value) ? '<redacted-path>' : value;
const publicHosts = new Set(['github.com', 'raw.githubusercontent.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'developers.cloudflare.com', 'docs.github.com', 'modelcontextprotocol.io', 'nodejs.org', 'docs.python.org', 'www.gnu.org', 'gnu.org', 'fsf.org', 'opensource.org', 'learn.microsoft.com', 'json-schema.org', 'www.iana.org', 'pkgs.tailscale.com']);
export function classifyUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1):$/.test(value)) return null; // Known loopback prefix with runtime-selected port.
    return 'unknown-literal-url';
  }
  if (url.username || url.password) return 'credential-url';
  for (const [key, val] of url.searchParams) if (val && /(?:token|secret|password|credential|api[_-]?key|authorization)/i.test(key)) return 'credential-url';
  const host = url.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) || /(?:^|\.)example\.(?:com|org|net|invalid)$/.test(host) || host.endsWith('.invalid') || publicHosts.has(host)) return null;
  return 'unreviewed-endpoint';
}
export function trackedFiles(root) {
  return [...new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
}
function inertIPv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.some(x => x > 255)) return true;
  return parts[0] === 127 || parts.every(x => x === 0) ||
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}
export async function scanFiles(root, files, policy = {}) {
  const findings = [], seenExceptions = new Set();
  const rootReal = await realpath(root);
  let totalBytes = 0;
  const add = (path, rule, line = 0) => findings.push({ path: safePath(path), rule, line });
  for (const path of files) {
    const full = resolve(root, path), rel = relative(root, full);
    if (isAbsolute(path) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) { add(path, 'path-escape'); continue; }
    if (prohibitedPath.test(path)) { add(path, 'private-artifact'); continue; }
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) { add(path, 'unsupported-file'); continue; }
    const real = relative(rootReal, await realpath(full));
    if (real === '..' || real.startsWith('../') || real.startsWith('..\\') || isAbsolute(real)) { add(path, 'path-escape'); continue; }
    totalBytes += stat.size;
    if (stat.size > (policy.max_file_bytes ?? 10_000_000) || totalBytes > (policy.max_total_bytes ?? 50_000_000)) { add(path, 'scan-budget'); continue; }
    const bytes = await readFile(full);
    if (bytes.includes(0) || /\.(?:png|jpg|jpeg|gif|webp|pdf|zip|gz|tar|exe|dll|whl)$/i.test(path)) {
      const review = policy.binary_reviews?.find(x => x.path === path && x.sha256 === digest(bytes) && x.purpose && x.review);
      if (!review) add(path, 'unreviewed-binary');
      continue;
    }
    const text = bytes.toString('utf8');
    if (text.includes('\ufffd')) { add(path, 'unknown-encoding'); continue; }
    const bodyPattern = new RegExp(secretHeader + '[\\s\\r\\n]*[A-Za-z0-9+/=\\s]{24,}' + ['-----END ', '(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?', 'PRIVATE KEY-----'].join(''));
    if (bodyPattern.test(text)) add(path, 'private-key-body');
    for (const candidate of text.matchAll(/[A-Za-z0-9+/]{80,}={0,2}/g)) {
      if (candidate[0].length <= 16_384 && new RegExp(secretHeader).test(Buffer.from(candidate[0], 'base64').toString('utf8'))) add(path, 'encoded-private-key');
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hits = [];
      for (const [rule, regex] of rules) {
        regex.lastIndex = 0;
        for (const match of line.matchAll(regex)) hits.push([rule, match[0]]);
      }
      for (const match of line.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) if (!inertIPv4(match[0])) hits.push(['instance-ip', match[0]]);
      for (const match of line.matchAll(/(?<![\w:])(?:[0-9a-f]{1,4}:|:)[0-9a-f:]+(?![\w:])/gi)) if (isIP(match[0]) === 6 && match[0] !== '::1' && !/^2001:db8:/i.test(match[0])) hits.push(['instance-ipv6', match[0]]);
      for (const match of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
        if (!/(?:^|\.)(?:example\.(?:com|org|net|invalid)|invalid)$/i.test(match[1]) && !(policy.public_contacts ?? []).some(x => x.path === path && x.address === match[0] && x.reason)) hits.push(['instance-email', match[0]]);
      }
      for (const match of line.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>`()[\]{}$]+/g)) {
        const value = match[0].replace(/[.,;]+$/, '');
        if (value === 'https://' || value === 'http://') continue; // Prefix composition has no literal locator.
        const issue = classifyUrl(value);
        const reviewed = policy.url_reviews?.some(x => x.path === path && x.sha256 === digest(value) && x.reason && x.review);
        if (issue && !(reviewed && issue === 'unreviewed-endpoint')) hits.push([issue, value]);
      }
      if (/^(?:src\/|console\/|packages\/|scripts\/init-local\.mjs$)/.test(path) && /(?:OPENAI_API_KEY|CHATGPT_[A-Z_]+|(?:from\s*|import\s*\(|require\s*\()\s*["'](?:openai|@openai\/)|(?:default_client|client_profile)\s*[:=]\s*["'](?:chatgpt|openai)|["'](?:openai|@openai\/[^"']+)["']\s*:)/i.test(line)) hits.push(['default-ai-provider-coupling', line]);
      if (/^(?:src\/|console\/|packages\/)/.test(path) && /(?:chatgpt\.(?:site|com)|api\.openai\.com|managed-windows-chatgpt-control)/i.test(line)) hits.push(['ai-client-specific-runtime', line]);
      for (const [rule, value] of hits) {
        const hash = digest(value);
        const exception = policy.fixture_exceptions?.find(x => x.path === path && x.rule === rule && (x.sha256 === hash || x.line_sha256 === digest(line)) && x.reason &&
          (x.kind === 'inert-fixture-or-detector' || (x.kind === 'reviewed-optional-client-compatibility' && ['ai-client-specific-runtime', 'default-ai-provider-coupling'].includes(rule) && x.optional_profile && x.review)));
        if (exception) seenExceptions.add(`${path}:${rule}:${exception.line_sha256 ?? exception.sha256}`);
        else add(path, rule, i + 1);
      }
    }
  }
  for (const item of policy.fixture_exceptions ?? []) {
    if (!seenExceptions.has(`${item.path}:${item.rule}:${item.line_sha256 ?? item.sha256}`)) add(item.path, 'stale-fixture-exception');
  }
  return { ok: findings.length === 0, files: files.length, bytes: totalBytes, findings };
}
export async function checkPublication(root = process.cwd()) {
  const policy = JSON.parse(await readFile(resolve(root, 'publication-policy.json'), 'utf8'));
  if (policy.version !== 1) throw new Error('Unsupported publication policy');
  return scanFiles(root, trackedFiles(root), policy);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await checkPublication(); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; }
  catch { console.error('Publication scan failed without exposing source or tool output.'); process.exitCode = 1; }
}
