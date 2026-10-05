import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,mkdir,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {BOOTSTRAP_SH,renderBootstrap} from "../src/index.js";

test("bootstrap has no deployment endpoint and requires a supplied HTTPS origin",()=>{
  assert.ok(BOOTSTRAP_SH.includes('GHOSTFLEET_BROKER_ORIGIN'));
  assert.throws(()=>renderBootstrap({brokerOrigin:"http://fixture.example.invalid"}),/ORIGIN_INVALID/);
  assert.throws(()=>renderBootstrap({brokerOrigin:"https://fixture.example.invalid/path"}),/ORIGIN_INVALID/);
  assert.throws(()=>renderBootstrap({brokerOrigin:"https://fixture.example.invalid",checkpointDir:"/tmp/../etc"}),/PATH_INVALID/);
  assert.ok(renderBootstrap({brokerOrigin:"https://fixture.example.invalid",checkpointDir:"/tmp/synthetic-fixture"}).includes("BROKER_ORIGIN='https://fixture.example.invalid'"));
});

test("actual shell provisional compliant repeat is zero delta and never claims",{skip:process.platform!=="linux"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"ghostfleet-bootstrap-synthetic-"));
  try {
    const state=join(root,"state"),bin=join(root,"bin");await mkdir(state);await mkdir(bin);
    const enrollment="enroll-00000000-0000-4000-8000-000000000001",node="fleet-bootstrap-000000000001";
    const checkpoint={schema:"fleet-enroll-checkpoint/v1",status:"COMPLIANT",node_id:node,node_uid:"",identity_kind:"provisional",enrollment_id:enrollment};
    await writeFile(join(state,"enrollment-checkpoint.json"),JSON.stringify(checkpoint));await writeFile(join(state,"enrollment-report.json"),JSON.stringify(checkpoint));
    async function command(name,body){await writeFile(join(bin,name),"#!/bin/sh\n"+body+"\n",{mode:0o755});}
    await command("id","printf 0");await command("uname","printf Linux");await command("dpkg-query","printf 'install ok installed'");
    await command("tailscale",`[ "$*" = "status --self --peers=false --json" ] || exit 90\nprintf '%s' '{"BackendState":"Running","Self":{"HostName":"${node}"}}'`);
    await command("curl","exit 91");await command("apt-get","exit 92");await command("systemctl","exit 93");
    const script=join(root,"bootstrap.sh");await writeFile(script,BOOTSTRAP_SH);
    async function snapshot(){return Promise.all(["enrollment-checkpoint.json","enrollment-report.json"].map(async name=>{const path=join(state,name);const info=await stat(path);return {name,body:await readFile(path,"utf8"),mtime:info.mtimeMs,mode:info.mode};}));}
    const before=await snapshot();
    for(let repeat=0;repeat<2;repeat++){
      const result=spawnSync("/bin/sh",[script],{env:{PATH:bin+":/usr/bin:/bin",GHOSTFLEET_CHECKPOINT_DIR:state},encoding:"utf8",timeout:10000});
      assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/already converged/);
    }
    assert.deepEqual(await snapshot(),before);
  } finally {await rm(root,{recursive:true,force:true});}
});
