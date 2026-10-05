import { readFile, lstat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { trackedFiles } from './publication-guard.mjs';

function headings(text) {
  const result = new Set(), repeats = new Map(); let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const anchor = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = repeats.get(anchor) ?? 0; repeats.set(anchor, count + 1); result.add(count ? `${anchor}-${count}` : anchor);
  }
  return result;
}
export async function checkDocuments(root, catalog, files) {
  const findings = [];
  for (const item of catalog.documents) {
    let text;
    try { text = await readFile(resolve(root, item.path), 'utf8'); } catch { findings.push({ path: item.path, rule: 'missing-document' }); continue; }
    const zh = text.indexOf('## 中文'), en = text.indexOf('## English');
    if (zh < 0 || en < 0 || en <= zh) { findings.push({ path: item.path, rule: 'missing-bilingual-sections' }); continue; }
    const parts = [text.slice(zh, en), text.slice(en)];
    for (const topic of item.topics ?? []) for (let lang = 0; lang < 2; lang++) {
      if (!parts[lang].includes(`<!-- topic:${topic} -->`)) findings.push({ path: item.path, rule: 'missing-topic', language: lang ? 'en' : 'zh', topic });
    }
  }
  for (const path of files.filter(x => x.endsWith('.md'))) {
    const text = (await readFile(resolve(root, path), 'utf8')).replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '');
    const targets = [...text.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*)?\)/g)].map(x => x[1] ?? x[2]);
    targets.push(...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map(x => x[1]));
    for (const target of targets) {
      if (/^(?:https?:|mailto:|data:)/i.test(target)) continue;
      if (/^[A-Za-z]+:/.test(target)) { findings.push({ path, rule: 'unsupported-link' }); continue; }
      const [location, fragment] = target.split('#');
      let full;
      try { full = location ? resolve(dirname(resolve(root, path)), decodeURIComponent(location)) : resolve(root, path); } catch { findings.push({ path, rule: 'invalid-link' }); continue; }
      const rel = relative(root, full);
      if (rel.startsWith('..')) { findings.push({ path, rule: 'link-escape' }); continue; }
      try {
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) { findings.push({ path, rule: 'link-symlink' }); continue; }
        if (fragment && full.endsWith('.md') && !headings(await readFile(full, 'utf8')).has(decodeURIComponent(fragment))) findings.push({ path, rule: 'missing-anchor', target_sha256: createHash('sha256').update(target).digest('hex') });
      } catch { findings.push({ path, rule: 'missing-link-target', target_sha256: createHash('sha256').update(target).digest('hex') }); }
    }
  }
  return { ok: findings.length === 0, documents: catalog.documents.length, findings, parity: 'Structure/topics checked; semantic equivalence requires review.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const root = process.cwd(), catalog = JSON.parse(await readFile(resolve(root, 'docs-catalog.json'), 'utf8')); const result = await checkDocuments(root, catalog, trackedFiles(root)); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; }
  catch { console.error('Documentation check failed.'); process.exitCode = 1; }
}
