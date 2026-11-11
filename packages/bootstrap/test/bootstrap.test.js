import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,mkdir,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {BOOTSTRAP_SH,renderBootstrap} from "../src/index.js";

test("Phase 0 pins a readable SSH host identity before any host effects",()=>{
  const keyCheck=BOOTSTRAP_SH.indexOf("no readable SSH host public key");
  const fingerprintCheck=BOOTSTRAP_SH.indexOf("SSH host public key fingerprint could not be verified");
  // Check executed calls, not the earlier function declarations.
  const preflightCall=BOOTSTRAP_SH.indexOf("\nbootstrap_phase0_preflight\n");
  const baselineCall=BOOTSTRAP_SH.indexOf("\nbootstrap_transport_baseline\n");
  const claimCall=BOOTSTRAP_SH.indexOf("\nCLAIM_URL=");
  assert.ok(keyCheck>0 && fingerprintCheck>keyCheck);
  assert.ok(preflightCall>fingerprintCheck && baselineCall>preflightCall && claimCall>baselineCall);
  assert.match(BOOTSTRAP_SH,/ssh_host_ed25519_key\.pub/);
  assert.match(BOOTSTRAP_SH,/ssh_host_ecdsa_key\.pub/);
  assert.match(BOOTSTRAP_SH,/ssh_host_rsa_key\.pub/);

  // A post-claim empty assignment used to erase the verified fingerprint.
  const assignments=[...BOOTSTRAP_SH.matchAll(/^\s*SSH_HOST_KEY_SHA=.*$/gm)];
  assert.equal(assignments.length,1,"Phase 0 fingerprint must never be reassigned after verification");
  assert.match(assignments[0][0],/ssh-keygen -lf "\$SSH_HOST_KEY_PATH"/);
  const reportStart=BOOTSTRAP_SH.indexOf('REPORT_FILE="$REPORT_DIR/enrollment-report.json"');
  assert.ok(reportStart>claimCall);
  const reportPath=BOOTSTRAP_SH.slice(reportStart);
  assert.ok(reportPath.includes('"ssh_host_key_sha256": "$SSH_HOST_KEY_SHA"'),"local report must carry pinned fingerprint");
  assert.ok(reportPath.includes('"$OS_VERSION_ID" "$SSH_HOST_KEY_SHA" "$BOOTSTRAP_VERSION"'),"completion request must carry pinned fingerprint");
});

test("Linux Phase 0 host-key preflight exercises real fingerprints before continuation",{skip:process.platform!=="linux"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"ghostfleet-phase0-hostkey-"));
  try {
    const ssh=join(root,"ssh"),marker=join(root,"after-preflight"),script=join(root,"phase0.sh");
    await mkdir(ssh);await mkdir(join(root,"systemd"));

    // Execute the production Phase 0 function in a disposable, unprivileged
    // fixture. Only absolute host observation paths are redirected to temp.
    // Never execute the full bootstrap (which may install packages/services).
    const start=BOOTSTRAP_SH.indexOf("bootstrap_phase0_preflight() {");
    const end=BOOTSTRAP_SH.indexOf("\nbootstrap_phase0_preflight\n",start);
    assert.ok(start>=0 && end>start,"expected executable Phase 0 function");
    let phase0=BOOTSTRAP_SH.slice(start,end);
    for(const [original,fixture] of [
      ["/run/systemd/system",join(root,"systemd")],
      ["/etc/ssh/",ssh+"/"],
      ["/etc/openmediavault",join(root,"omv")],
      ["/var/run/docker.sock",join(root,"docker.sock")],
      ["/etc/sudoers.d",join(root,"sudoers.d")],
      ["/etc/sudoers",join(root,"sudoers")],
    ]){
      assert.ok(phase0.includes(original),"expected preflight observation path: "+original);
      phase0=phase0.replaceAll(original,fixture);
    }
    await writeFile(script,[
      "#!/bin/sh",
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      "OS_FAMILY=debian-family",
      "OS_ID=debian",
      "OS_VERSION_ID=13",
      phase0,
      "bootstrap_phase0_preflight",
      'printf "%s" "$SSH_HOST_KEY_SHA" > "'+marker+'"',
    ].join("\n")+"\n");

    const run=()=>spawnSync("/bin/sh",[script],{encoding:"utf8",timeout:10000});
    const expectDenied=async reason=>{
      const result=run();
      assert.notEqual(result.status,0,result.stderr);
      assert.match(result.stderr,reason);
      await assert.rejects(stat(marker),{code:"ENOENT"});
    };
    await expectDenied(/no readable SSH host public key/);

    const edPub=join(ssh,"ssh_host_ed25519_key.pub");
    const ecdsaPub=join(ssh,"ssh_host_ecdsa_key.pub");
    await writeFile(edPub,"ssh-ed25519 MALFORMED host\n");
    await expectDenied(/fingerprint could not be verified/);
    await rm(edPub);

    const makeKey=async(type,basename,args=[])=>{
      const key=join(root,basename);
      const result=spawnSync("ssh-keygen",["-q","-t",type,...args,"-N","","-f",key],{encoding:"utf8",timeout:10000});
      assert.equal(result.status,0,result.stderr||String(result.error));
      return readFile(key+".pub","utf8");
    };
    const fingerprint=pub=>{
      const result=spawnSync("ssh-keygen",["-lf",pub],{encoding:"utf8",timeout:10000});
      assert.equal(result.status,0,result.stderr||String(result.error));
      return result.stdout.trim().split(/\s+/)[1];
    };
    await writeFile(ecdsaPub,await makeKey("ecdsa","ecdsa",["-b","256"]));
    let result=run();
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(marker,"utf8"),fingerprint(ecdsaPub),"ECDSA fallback must be pinned");
    await rm(marker);

    await writeFile(edPub,await makeKey("ed25519","ed25519"));
    result=run();
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(marker,"utf8"),fingerprint(edPub),"Ed25519 must take precedence");
    assert.match(fingerprint(edPub),/^SHA256:/);

    // RSA is the final supported fallback when Ed25519/ECDSA are absent.
    // Exercise the actual production Phase 0 function, not its source strings.
    await rm(marker);
    await rm(edPub);
    await rm(ecdsaPub);
    const rsaPub=join(ssh,"ssh_host_rsa_key.pub");
    await writeFile(rsaPub,await makeKey("rsa","rsa",["-b","2048"]));
    result=run();
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(marker,"utf8"),fingerprint(rsaPub),"RSA-only host identity must be pinned");
  } finally {await rm(root,{recursive:true,force:true});}
});

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
    // The production script pins a trusted admin PATH. Synthetic commands
    // live in this fixture directory; inject only into this disposable source.
    const fixture=BOOTSTRAP_SH.replace('PATH="/usr/sbin:/usr/bin:/sbin:/bin"',
      'PATH="'+bin+':/usr/sbin:/usr/bin:/sbin:/bin"');
    assert.notEqual(fixture,BOOTSTRAP_SH);
    const script=join(root,"bootstrap.sh");await writeFile(script,fixture);
    async function snapshot(){return Promise.all(["enrollment-checkpoint.json","enrollment-report.json"].map(async name=>{const path=join(state,name);const info=await stat(path);return {name,body:await readFile(path,"utf8"),mtime:info.mtimeMs,mode:info.mode};}));}
    const before=await snapshot();
    for(let repeat=0;repeat<2;repeat++){
      const result=spawnSync("/bin/sh",[script],{env:{PATH:bin+":/usr/bin:/bin",GHOSTFLEET_CHECKPOINT_DIR:state},encoding:"utf8",timeout:10000});
      assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/already converged/);
    }
    assert.deepEqual(await snapshot(),before);
  } finally {await rm(root,{recursive:true,force:true});}
});
