// Narrow validation for the canonical GhostFleet first-use security contract.
// Do not make duplicate heading rejection global: other Markdown may repeat
// section names for legitimate bilingual/cross-topic documentation.
export function checkFirstUseReadmeContract(source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  const headings = [
    '# GhostFleet 控制面板 / Control Panel',
    '## 中文',
    '## English',
    '## 首次使用状态 / First-use status',
    '## Provider 授权核验 / Provider authority verification',
    '### 时效与跨仓发行门 / Freshness and release dependency',
  ];
  for (const heading of headings) {
    if (lines.filter(line => line.trim() === heading).length !== 1) {
      findings.push('first-use-duplicate-or-missing-heading');
    }
  }
  const pattern = '^[A-Za-z0-9][A-Za-z0-9._-]' + '{0,63}' + '$';
  const tick = String.fromCharCode(96);
  if (!source.includes(tick + pattern + tick)
    || !source.includes('Authority generation')
    || !source.includes('CONFIGURED_UNVERIFIED')
    || !source.includes('SERVICE_UNKNOWN')
    || !source.includes('PROVIDER_AUTHORITY_SETUP_UNKNOWN')
    || !source.includes('发布门禁顺序')) {
    findings.push('first-use-broken-security-contract');
  }
  let fence = false;
  for (const line of lines) {
    if (/^\s*(?:`{3}|~{3})/.test(line)) { fence = !fence; continue; }
    if (!fence && (line.match(/`/g) ?? []).length % 2 !== 0) {
      findings.push('first-use-unclosed-code-span');
      break;
    }
  }
  if (fence) findings.push('first-use-unclosed-code-fence');
  return [...new Set(findings)];
}
