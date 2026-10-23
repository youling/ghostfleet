import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const helper=resolve(root,"packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged/managed-linux-privileged-operations.sh");
const content=readFileSync(helper,"utf8");

test("privileged installer uses administrative PATH, Ed25519 and exact key guard",()=>{
  assert.match(content,/PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/);
  assert.match(content,/ssh-ed25519\|ssh-rsa/);
  assert.match(content,/authorized_key_file_ok\(\)/);
  assert.match(content,/if authorized_key_file_ok; then/);
  assert.match(content,/stat\.S_IMODE\(info\.st_mode\) != 0o600/);
  assert.match(content,/expected = 'restrict,command="/);
  assert.match(content,/len\(rows\) != 1/);
  assert.doesNotMatch(content,/grep -Fq "restrict,command=/);
});

test("privileged installer parses as Bash without executing root effects",()=>{
  if(process.platform!=="linux")return;
  const check=spawnSync("/bin/bash",["-n",helper],{encoding:"utf8",timeout:5000});
  assert.equal(check.status,0,check.stderr);
});
