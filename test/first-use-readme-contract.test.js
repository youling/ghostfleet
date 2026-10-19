import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkFirstUseReadmeContract } from "../scripts/first-use-doc-contract.mjs";

const original = readFileSync(new URL("../console/README.md", import.meta.url), "utf8");
const exactGeneration = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
const headings = [
  "# GhostFleet 控制面板 / Control Panel",
  "## 中文",
  "## English",
  "## 首次使用状态 / First-use status",
  "## Provider 授权核验 / Provider authority verification",
  "### 时效与跨仓发行门 / Freshness and release dependency",
];

test("one complete canonical first-use security contract passes docs validation", () => {
  assert.deepEqual(checkFirstUseReadmeContract(original), []);
  for (const heading of headings) {
    assert.equal(original.split("\n").filter(line => line.trim() === heading).length, 1, heading);
  }
  assert.ok(original.includes(exactGeneration));
  assert.ok(original.includes("PRIVATE") || original.includes("Fleet owner"));
});

test("duplicated provider section and entire second README must fail", () => {
  const repeated = original + "\n" + original;
  assert.ok(checkFirstUseReadmeContract(repeated).includes("first-use-duplicate-or-missing-heading"));
  const provider = original.replace("## Provider 授权核验 / Provider authority verification",
    "## Provider 授权核验 / Provider authority verification\n## Provider 授权核验 / Provider authority verification");
  assert.ok(checkFirstUseReadmeContract(provider).includes("first-use-duplicate-or-missing-heading"));
});

test("missing regex terminator or mismatched inline code markers must fail", () => {
  const truncated = original.replace(exactGeneration, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  assert.ok(checkFirstUseReadmeContract(truncated).includes("first-use-broken-security-contract"));
  const brokenSpan = original.replace("发布门禁顺序", "发布门禁顺序`");
  assert.ok(checkFirstUseReadmeContract(brokenSpan).includes("first-use-unclosed-code-span"));
});

test("missing release gate or unterminated fenced code must fail", () => {
  assert.ok(checkFirstUseReadmeContract(original.replace("发布门禁顺序", "普通说明"))
    .includes("first-use-broken-security-contract"));
  assert.ok(checkFirstUseReadmeContract(original + "\n```\n")
    .includes("first-use-unclosed-code-fence"));
});
