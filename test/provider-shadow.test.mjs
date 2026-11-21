import test from "node:test";
import assert from "node:assert/strict";
import { projectProviderShadow as project, ProviderShadowError } from "../src/control-plane/provider-shadow.js";

const UID = ["node","11111111","1111","4111","8111","111111111111"].join("-");
const OTHER = ["node","22222222","2222","4222","8222","222222222222"].join("-");
const NOW=1_800_000_000_000;
const ts=(changes={})=>({node_uid:UID,source_kind:"TAILSCALE_DEVICES",
  source_state:"CONTROL_CONNECTED",collected_at_ms:NOW-2000,valid_until_ms:NOW+60000,...changes});
const cf=(changes={})=>({node_uid:UID,source_kind:"CLOUDFLARE_TUNNEL",
  source_state:"EDGE_HEALTHY",collected_at_ms:NOW-4000,valid_until_ms:NOW+60000,...changes});
const hb=(changes={})=>({node_uid:UID,source_kind:"GHOSTFLEET_HEARTBEAT",
  source_state:"ONLINE",collected_at_ms:NOW-1000,valid_until_ms:NOW+60000,...changes});
const p=(rows,uid=UID,now=NOW)=>project(uid,rows,now);
const deny=fn=>assert.throws(fn,err=>err instanceof ProviderShadowError&&err.message==="PROVIDER_SHADOW_INVALID");
const noPower=o=>{
  assert.equal(o.authorization,"NOT_EVALUATED");
  assert.equal(o.ssh_authentication,"NOT_EVALUATED");
  assert.equal(o.job_admission,"NOT_EVALUATED");
  assert.equal(o.network_connectivity_effect,"NONE");
  assert.equal(o.execution_effect,"NONE");
  assert.equal(o.heartbeat_configuration_effect,"NONE");
  assert.equal(o.canonical_node_uid_mapping,"OWNER_REVIEWED_INPUT_REQUIRED");
};

test("provider-only facts show independent states without asserting host/SSH/Job",()=>{
  const out=p([ts(),cf()]);
  assert.deepEqual(out.tailscale,{state:"CURRENT",source_state:"CONTROL_CONNECTED",age_ms:2000});
  assert.deepEqual(out.cloudflare,{state:"CURRENT",source_state:"EDGE_HEALTHY",age_ms:4000});
  assert.deepEqual(out.ghostfleet,{state:"UNKNOWN",source_state:null,age_ms:null});
  noPower(out);
});

test("host-only heartbeat cannot prove TS/CF connection or privileges",()=>{
  const out=p([hb()]);
  assert.equal(out.ghostfleet.source_state,"ONLINE");
  assert.equal(out.tailscale.state,"UNKNOWN");
  assert.equal(out.cloudflare.state,"UNKNOWN");
  noPower(out);
});

test("connected Tailscale and healthy Cloudflare coexist with stale host heartbeat",()=>{
  const out=p([ts(),cf(),hb({collected_at_ms:NOW-600000,valid_until_ms:NOW-500000})]);
  assert.equal(out.ghostfleet.state,"STALE");
  assert.equal(out.tailscale.source_state,"CONTROL_CONNECTED");
  assert.equal(out.cloudflare.source_state,"EDGE_HEALTHY");
  noPower(out);
});

test("disconnected Tailscale does NOT imply whole host offline if heartbeat still fresh",()=>{
  const out=p([ts({source_state:"CONTROL_DISCONNECTED"}),hb()]);
  assert.equal(out.tailscale.source_state,"CONTROL_DISCONNECTED");
  assert.equal(out.ghostfleet.source_state,"ONLINE");
  noPower(out);
});

test("Cloudflare EDGE_DOWN does not silently downgrade independent host presence",()=>{
  const out=p([cf({source_state:"EDGE_DOWN"}),hb()]);
  assert.equal(out.cloudflare.source_state,"EDGE_DOWN");
  assert.equal(out.ghostfleet.source_state,"ONLINE");
  noPower(out);
});

test("no observation and wrong immutable UID remain UNKNOWN rather than inferred by label",()=>{
  const out=p([ts({node_uid:OTHER}),cf({node_uid:OTHER})]);
  assert.equal(out.tailscale.state,"UNKNOWN");
  assert.equal(out.cloudflare.state,"UNKNOWN");
  noPower(out);
});

test("latest fresh reading supersedes older different state without conflict",()=>{
  const out=p([ts({source_state:"CONTROL_DISCONNECTED",collected_at_ms:NOW-6000}),ts()]);
  assert.equal(out.tailscale.state,"CURRENT");
  assert.equal(out.tailscale.source_state,"CONTROL_CONNECTED");
});

test("same-time contradictory fresh source reports become CONFLICT, not a green signal",()=>{
  const out=p([cf(),cf({source_state:"EDGE_DOWN"})]);
  assert.deepEqual(out.cloudflare,{state:"CONFLICT",source_state:null,age_ms:null});
  noPower(out);
});

test("identical repeated fresh reports are harmless",()=>{
  const out=p([ts(),ts()]);
  assert.equal(out.tailscale.source_state,"CONTROL_CONNECTED");
  assert.equal(out.tailscale.state,"CURRENT");
});

test("expired evidence does not imply DISCONNECTED, DOWN or OFFLINE",()=>{
  const out=p([ts({source_state:"CONTROL_DISCONNECTED",collected_at_ms:NOW-6000,valid_until_ms:NOW-4000}),
    cf({source_state:"EDGE_DOWN",collected_at_ms:NOW-9000,valid_until_ms:NOW-2000})]);
  assert.equal(out.tailscale.state,"STALE");
  assert.equal(out.cloudflare.state,"STALE");
  assert.equal(out.tailscale.source_state,null);
});

test("future-dated provider evidence remains STALE, not current",()=>{
  const out=p([ts({collected_at_ms:NOW+5000,valid_until_ms:NOW+30000})]);
  assert.equal(out.tailscale.state,"STALE");
  assert.equal(out.tailscale.source_state,null);
});

test("unknown provider source, mistyped fields and raw identifiers fail closed",()=>{
  for(const bad of [
    ts({source_kind:"TAILSCALE_WEBHOOK_ONLINE"}),
    ts({source_state:"CONNECTED"}),
    cf({source_state:"SSH_AUTHENTICATED"}),
    hb({source_state:"CONTROL_CONNECTED"}),
    {...ts(),tailnet_ip:"100.1.2.3"},
    {...cf(),tunnel_uuid:"secret"},
    {...hb(),node_label:"JG"},
    ts({node_uid:"jg"}),
    ts({node_uid:100}),
  ]) deny(()=>p([bad]));
});

test("oversized TTL, wrong timestamps, NaN or excess records fail closed",()=>{
  for(const bad of [
    ts({valid_until_ms:NOW+20*60000}),ts({collected_at_ms:"today"}),
    ts({valid_until_ms:NOW-8000}),ts({collected_at_ms:Number.NaN}),
  ]) deny(()=>p([bad]));
  deny(()=>p(Array.from({length:33},()=>ts())));
  deny(()=>p([ts()],UID,Number.NaN));
  deny(()=>p([ts()],UID,-1));
  deny(()=>p("not-array"));
});

test("missing required key, wrong UID or unsupported source envelope rejected",()=>{
  const r=ts();delete r.source_state;
  deny(()=>p([r]));
  deny(()=>p([ts()],"node-fake"));
  deny(()=>p([null]));
});

test("no raw provider IDs, token, URL, IP, SSH auth or execution emitted",()=>{
  const rows=Object.freeze([Object.freeze(ts()),Object.freeze(cf()),Object.freeze(hb())]);
  const before=JSON.stringify(rows);
  const out=p(rows);
  assert.equal(JSON.stringify(rows),before);
  assert.deepEqual(Object.keys(out).sort(),[
    "schema","node_uid","tailscale","cloudflare","ghostfleet",
    "canonical_node_uid_mapping","authorization","ssh_authentication","job_admission",
    "network_connectivity_effect","execution_effect","heartbeat_configuration_effect"
  ].sort());
  const json=JSON.stringify(out);
  assert.doesNotMatch(json,/ssh-rsa|ecdsa|access-token|https?:\/\/|10\.0\.|device_id|tunnel_id|private_key/);
  noPower(out);
});

test("source projection preserves distinct provider states on one Fleet identity",()=>{
  const out=p([
    ts({source_state:"CONTROL_DISCONNECTED"}),
    cf({source_state:"EDGE_DEGRADED"}),
    hb({source_state:"ONLINE"})
  ]);
  assert.equal(out.tailscale.source_state,"CONTROL_DISCONNECTED");
  assert.equal(out.cloudflare.source_state,"EDGE_DEGRADED");
  assert.equal(out.ghostfleet.source_state,"ONLINE");
  noPower(out);
});
