import {createHash, generateKeyPairSync} from "node:crypto";
import {Buffer} from "node:buffer";
import {describe, expect, it, vi} from "vitest";
import {runApprovedAdminCommand, type ApprovedAdminEnvironment} from "../src/approvedAdminCommand.js";
import {controlActorRef, type ControlActor} from "../src/controlPolicy.js";
import {SSH_EXECUTION_ERROR_BRAND, SshExecutionError} from "../src/sshClient.js";

const uid = "node-00000000-0000-4000-8000-000000000001";
const actor: ControlActor = {userId:"synthetic-admin", scopes:["fleet.privileged"], authKind:"oauth"};
// Generated for these in-memory tests only. No live host, fixture secret or
// production signer is used; node signature verification has Python tests.
function key() {
  return generateKeyPairSync("ec", {namedCurve:"prime256v1",
    publicKeyEncoding:{type:"spki",format:"pem"},
    privateKeyEncoding:{type:"pkcs8",format:"pem"}}).privateKey;
}
async function fixture(state = "STARTED") {
  const subject = await controlActorRef(actor);
  const generation = "b".repeat(64), profile = "sha256:" + "c".repeat(64);
  const now = Math.floor(Date.now()/1000);
  const lease = {schema:"ghostfleet-approved-admin-lease/v1", lease_id:"lease-fixture-01",
    request_id:"request-fixture-01", operation_id:"operation-fixture-01", operation:"admin.command",
    issuer_id:"synthetic-issuer", node_uid:uid, subject_ref:subject,
    audience_ref:"ghostfleet-approved-admin-command/v1", generation, profile_generation:profile,
    work_ref:"synthetic/work", purpose:"Synthetic command-effect test", approval_ref:"approval-fixture-01",
    rollback_ref:"synthetic/rollback", issued_at:now, not_before:now, expires_at:now+60,
    max_uses:1, max_runtime_seconds:30,
    command:{argv:["/usr/bin/true"],cwd:"/",env:{},executable_sha256:"d".repeat(64),output:"discard"}};
  const input = {node_uid:uid,action:"execute" as const,
    lease_b64:Buffer.from(JSON.stringify(lease)).toString("base64"),
    signature_b64:Buffer.alloc(64).toString("base64")};
  const target = (username:string) => ({username,transport_mode:"local_ssh",
    ssh_host_key_algorithm:"ecdsa-sha2-nistp256",ssh_host_key_sha256:"SHA256:AAAA"});
  const env:ApprovedAdminEnvironment = {
    CONTROL_APPROVED_ADMIN_POLICY_JSON:JSON.stringify({[uid]:{generation,profile_generation:profile,
      subject_ref:subject,issuer_ids:["synthetic-issuer"]}}),
    CONTROL_PRIVILEGED_USERNAME:"ghostfleet-ops",CONTROL_PRIVILEGED_SSH_PRIVATE_KEY:key(),
    CONTROL_SSH_PRIVATE_KEY:key(),
    CONTROL_PRIVILEGED_TARGETS_JSON:JSON.stringify({[uid]:target("ghostfleet-ops")}),
    CONTROL_TARGETS_JSON:JSON.stringify({[uid]:target("ghostfleet")}),
  };
  const receipt = {schema:"ghostfleet-approved-admin-receipt/v1",lease_id:lease.lease_id,
    request_id:lease.request_id,operation_id:lease.operation_id,node_uid:uid,actor_ref:subject,
    lease_digest:createHash("sha256").update(Buffer.from(input.lease_b64,"base64")).digest("hex"),
    command_digest:"e".repeat(64),state,duplicate:false,retry_safe:false,
    reconcile_required:["STARTED","RESERVED","UNKNOWN"].includes(state),
    exit_code:state === "SUCCEEDED" ? 0 : null,execution_privilege:state === "NOT_FOUND" ? null : "root",
    output:"discarded",persistent_effects_rolled_back:false,code:null};
  const connect = vi.fn(async()=>({close:async()=>{},closed:Promise.resolve()}) as never);
  const execute = vi.fn(async()=>({exit_code:0,stdout:JSON.stringify({ok:true,receipt}),stderr:"",truncated:false}));
  return {env,input,lease,receipt,dependencies:{connect,execute}};
}

describe("approved administrator command seam",()=>{
  it("denies ordinary scope before any connection",async()=>{
    const f=await fixture();
    const result=await runApprovedAdminCommand(f.env,{...actor,scopes:["fleet.exec"]},f.input,f.dependencies);
    expect(result.outcome).toBe("NOT_DISPATCHED");expect(result.error).toBe("PRIVILEGED_SCOPE_REQUIRED");
    expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it.each(["subject_ref","node_uid","generation"])("rejects wrong signed %s before connection",async(field)=>{
    const f=await fixture();
    const bad={...f.lease,[field]:field === "node_uid" ? "node-00000000-0000-4000-8000-000000000002" : "f".repeat(64)};
    const result=await runApprovedAdminCommand(f.env,actor,{...f.input,lease_b64:Buffer.from(JSON.stringify(bad)).toString("base64")},f.dependencies);
    expect(result.outcome).toBe("NOT_DISPATCHED");expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it("rejects noncanonical base64 and caller-supplied actor",async()=>{
    const f=await fixture();
    for(const bad of [{...f.input,lease_b64:f.input.lease_b64+"\n"},{...f.input,actor_ref:"f".repeat(64)}]) {
      const result=await runApprovedAdminCommand(f.env,actor,bad,f.dependencies);
      expect(result.outcome).toBe("NOT_DISPATCHED");
    }
    expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it("reports opaque lease-reference schema failures before connecting without echoing values",async()=>{
    const f=await fixture();
    const invalidLease={...f.lease,approval_ref:"https://github.com/org/repo/issues/1#issuecomment-123"};
    const result=await runApprovedAdminCommand(
      f.env,actor,{...f.input,lease_b64:Buffer.from(JSON.stringify(invalidLease)).toString("base64")},f.dependencies
    );
    expect(result.outcome).toBe("NOT_DISPATCHED");
    expect(result.error).toBe("ADMIN_LEASE_SCHEMA_INVALID");
    expect((result as {validation_fields?:string[]}).validation_fields).toContain("approval_ref");
    expect(JSON.stringify(result)).not.toContain("https://github.com");
    expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it("preserves a structured host-helper error code without claiming a terminal outcome",async()=>{
    const f=await fixture();
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code:0,
      stdout:JSON.stringify({ok:false,error:"ADMIN_LEASE_BOUNDS"}),
      stderr:"",
      truncated:false,
    });
    const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_LEASE_BOUNDS");
    expect((result as {helper_error?:boolean}).helper_error).toBe(true);
    expect(result.reconcile_required).toBe(true);
    expect(result.retry_safe).toBe(false);
    expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed helper error envelopes without echoing raw helper output",async()=>{
    const f=await fixture();
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code:0,
      stdout:JSON.stringify({ok:false,error:"lease rejected",detail:"private detail"}),
      stderr:"",
      truncated:false,
    });
    const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_HELPER_RESPONSE_INVALID");
    expect((result as {validation_fields?:string[]}).validation_fields).toContain("error");
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(result.reconcile_required).toBe(true);
    expect(result.retry_safe).toBe(false);
  });
  it("reports malformed helper JSON as an explicit post-dispatch response error",async()=>{
    const f=await fixture();
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code:0,stdout:"not-json",stderr:"",truncated:false,
    });
    const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_HELPER_RESPONSE_INVALID");
    expect((result as {validation_fields?:string[]}).validation_fields).toEqual(["stdout_json"]);
    expect(result.reconcile_required).toBe(true);
    expect(result.retry_safe).toBe(false);
  });
  it("reports started as RUNNING with same-lease reconciliation",async()=>{
    const f=await fixture();const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("RUNNING");expect(result.reconcile_required).toBe(true);
    expect(result.retry_safe).toBe(false);expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
    const args=f.dependencies.execute.mock.calls[0] as unknown as unknown[];
    expect(args[3]).toBe(null);
    const wire=JSON.parse((args[4] as {stdin:string}).stdin);
    expect(wire.actor_ref).toBe(await controlActorRef(actor));expect(wire.lease_b64).toBe(f.input.lease_b64);
  });
  it("reports success only from the bound terminal receipt",async()=>{
    const f=await fixture("SUCCEEDED");const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("SUCCEEDED");expect(result.receipt?.persistent_effects_rolled_back).toBe(false);
  });
  it("classifies an unavailable or mismatched receipt as UNKNOWN without retry",async()=>{
    const f=await fixture();f.receipt.lease_digest="f".repeat(64);
    const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");expect(result.retry_safe).toBe(false);
    expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  });
  it("does not convert transport acceptance or a missing receipt into success",async()=>{
    const f=await fixture("NOT_FOUND");
    const result=await runApprovedAdminCommand(f.env,actor,{...f.input,action:"status"},f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");expect(result.reconcile_required).toBe(true);
  });
  it("preserves dispatch state across duplicate typed-control module instances",async()=>{
    for(const state of ["NOT_DISPATCHED","MAY_HAVE_EXECUTED"] as const) {
      const f=await fixture();
      const foreignCopy = Object.assign(new Error("SYNTHETIC_CROSS_BUNDLE_FAILURE"), {
        name:"SshExecutionError",
        code:"SYNTHETIC_CROSS_BUNDLE_FAILURE",
        dispatch_state:state,
        [SSH_EXECUTION_ERROR_BRAND]:true,
      });
      f.dependencies.execute.mockImplementationOnce(async()=>{throw foreignCopy;});
      const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
      expect(result.outcome).toBe(state === "NOT_DISPATCHED" ? "NOT_DISPATCHED" : "UNKNOWN");
      expect(result.error).toBe("SYNTHETIC_CROSS_BUNDLE_FAILURE");
      expect(result.reconcile_required).toBe(state === "MAY_HAVE_EXECUTED");
      expect(result.retry_safe).toBe(false);
    }
  });
  it("preserves pre-dispatch versus post-dispatch transport uncertainty",async()=>{
    for(const state of ["NOT_DISPATCHED","MAY_HAVE_EXECUTED"] as const) {
      const f=await fixture();f.dependencies.execute.mockImplementation(async()=>{throw new SshExecutionError("SYNTHETIC_TRANSPORT_FAILURE",state);});
      const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
      expect(result.outcome).toBe(state === "NOT_DISPATCHED" ? "NOT_DISPATCHED" : "UNKNOWN");
      expect(result.retry_safe).toBe(false);
    }
  });

  it("supports bounded output mode and returns private stdout/stderr", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = {
      ...f.lease,
      command: { ...f.lease.command, output: "bounded" as const, output_limit_bytes: 4096 },
    };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const stdoutText = "NVME SMART HEALTH PASSED\n";
    const stderrText = "TEMP 35C\n";
    const outputSha = createHash("sha256").update(Buffer.from(stdoutText + stderrText)).digest("hex");
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: Buffer.byteLength(stdoutText),
      stderr_bytes: Buffer.byteLength(stderrText),
      output_bytes: Buffer.byteLength(stdoutText) + Buffer.byteLength(stderrText),
      truncated: false,
      output_sha256: outputSha,
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({
        ok: true,
        receipt: boundedReceipt,
        output: { stdout: stdoutText, stderr: stderrText },
      }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(
      f.env,
      actor,
      { ...f.input, lease_b64: leaseB64 },
      f.dependencies,
    );
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.receipt?.output).toBe("bounded");
    expect(result.receipt?.output_sha256).toBe(outputSha);
    expect(result.output).toEqual({ stdout: stdoutText, stderr: stderrText });
  });

  it("fails closed when returned bounded output digest mismatches receipt", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = {
      ...f.lease,
      command: { ...f.lease.command, output: "bounded" as const },
    };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const stdoutText = "SOME OUTPUT";
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: Buffer.byteLength(stdoutText),
      stderr_bytes: 0,
      output_bytes: Buffer.byteLength(stdoutText),
      truncated: false,
      output_sha256: "0".repeat(64),
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({
        ok: true,
        receipt: boundedReceipt,
        output: { stdout: stdoutText, stderr: "" },
      }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(
      f.env,
      actor,
      { ...f.input, lease_b64: leaseB64 },
      f.dependencies,
    );
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_DIGEST_MISMATCH");
  });

  it("fails closed when terminal bounded receipt is missing response.output", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = { ...f.lease, command: { ...f.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: 10,
      stderr_bytes: 0,
      output_bytes: 10,
      truncated: false,
      output_sha256: "0".repeat(64),
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_DATA_MISSING");
  });

  it("fails closed when terminal bounded receipt is missing metadata or hash", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = { ...f.lease, command: { ...f.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt, output: { stdout: "HI", stderr: "" } }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_METADATA_MISSING");
  });

  it("fails closed when response.output byte lengths mismatch receipt metadata", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = { ...f.lease, command: { ...f.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const stdoutText = "HELLO";
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: 999,
      stderr_bytes: 0,
      output_bytes: 999,
      truncated: false,
      output_sha256: createHash("sha256").update(stdoutText).digest("hex"),
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt, output: { stdout: stdoutText, stderr: "" } }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_BYTE_LENGTH_MISMATCH");
  });

  it("fails closed when receipt stdout_bytes + stderr_bytes !== output_bytes", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = { ...f.lease, command: { ...f.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const stdoutText = "HELLO";
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: Buffer.byteLength(stdoutText),
      stderr_bytes: 0,
      output_bytes: 50,
      truncated: false,
      output_sha256: createHash("sha256").update(stdoutText).digest("hex"),
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt, output: { stdout: stdoutText, stderr: "" } }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_SUM_MISMATCH");
  });

  it("fails closed when receipt output_bytes exceeds lease limit", async () => {
    const f = await fixture("SUCCEEDED");
    const boundedLease = {
      ...f.lease,
      command: { ...f.lease.command, output: "bounded" as const, output_limit_bytes: 1024 },
    };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const stdoutText = "A".repeat(2048);
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      stdout_bytes: 2048,
      stderr_bytes: 0,
      output_bytes: 2048,
      truncated: true,
      output_sha256: createHash("sha256").update(stdoutText).digest("hex"),
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt, output: { stdout: stdoutText, stderr: "" } }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.error).toBe("ADMIN_OUTPUT_LIMIT_EXCEEDED");
  });

  it("succeeds with non-terminal STARTED receipt without output data", async () => {
    const f = await fixture("STARTED");
    const boundedLease = { ...f.lease, command: { ...f.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const boundedReceipt = {
      ...f.receipt,
      lease_digest: leaseDigest,
      output: "bounded" as const,
      state: "STARTED" as const,
    };
    f.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt }),
      stderr: "",
      truncated: false,
    });
    const result = await runApprovedAdminCommand(f.env, actor, { ...f.input, lease_b64: leaseB64 }, f.dependencies);
    expect(result.outcome).toBe("RUNNING");
    expect(result.receipt?.output).toBe("bounded");
    expect(result.output).toBeUndefined();
  });

  it("fails closed on lease vs receipt output mode mismatch", async () => {
    const f1 = await fixture("SUCCEEDED");
    const boundedReceipt = {
      ...f1.receipt,
      output: "bounded" as const,
    };
    f1.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: boundedReceipt }),
      stderr: "",
      truncated: false,
    });
    const res1 = await runApprovedAdminCommand(f1.env, actor, f1.input, f1.dependencies);
    expect(res1.outcome).toBe("UNKNOWN");
    expect(res1.error).toBe("ADMIN_RECEIPT_OUTPUT_MODE_MISMATCH");

    const f2 = await fixture("SUCCEEDED");
    f2.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: f2.receipt, output: { stdout: "LEAK", stderr: "" } }),
      stderr: "",
      truncated: false,
    });
    const res2 = await runApprovedAdminCommand(f2.env, actor, f2.input, f2.dependencies);
    expect(res2.outcome).toBe("UNKNOWN");
    expect(res2.error).toBe("ADMIN_RECEIPT_OUTPUT_MODE_MISMATCH");

    const f3 = await fixture("SUCCEEDED");
    const boundedLease = { ...f3.lease, command: { ...f3.lease.command, output: "bounded" as const } };
    const leaseB64 = Buffer.from(JSON.stringify(boundedLease)).toString("base64");
    const leaseDigest = createHash("sha256").update(Buffer.from(leaseB64, "base64")).digest("hex");
    const discardedReceipt = {
      ...f3.receipt,
      lease_digest: leaseDigest,
      output: "discarded" as const,
    };
    f3.dependencies.execute.mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, receipt: discardedReceipt }),
      stderr: "",
      truncated: false,
    });
    const res3 = await runApprovedAdminCommand(f3.env, actor, { ...f3.input, lease_b64: leaseB64 }, f3.dependencies);
    expect(res3.outcome).toBe("UNKNOWN");
    expect(res3.error).toBe("ADMIN_RECEIPT_OUTPUT_MODE_MISMATCH");
  });

  it("rejects invalid output_limit_bytes in command schema", async () => {
    const f = await fixture();
    const badSmall = {
      ...f.lease,
      command: { ...f.lease.command, output: "bounded" as const, output_limit_bytes: 512 },
    };
    const resSmall = await runApprovedAdminCommand(
      f.env,
      actor,
      { ...f.input, lease_b64: Buffer.from(JSON.stringify(badSmall)).toString("base64") },
      f.dependencies,
    );
    expect(resSmall.outcome).toBe("NOT_DISPATCHED");

    const badLarge = {
      ...f.lease,
      command: { ...f.lease.command, output: "bounded" as const, output_limit_bytes: 65536 },
    };
    const resLarge = await runApprovedAdminCommand(
      f.env,
      actor,
      { ...f.input, lease_b64: Buffer.from(JSON.stringify(badLarge)).toString("base64") },
      f.dependencies,
    );
    expect(resLarge.outcome).toBe("NOT_DISPATCHED");
  });
});
