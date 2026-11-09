/** Optional V4 command-effect/status seam; no signer, tools or default backend. */
import { Buffer } from "buffer";
import { z } from "zod";
import { actorAllows, controlActorRef, PRIVILEGED_SCOPE, type ControlActor } from "./controlPolicy.js";
import { assertDistinctKeyIdentities, resolvePrivilegedTarget, type PrivilegedDependencies, type PrivilegedRuntimeEnv } from "./privilegedOperations.js";
import { createDeadlineAt, withDeadline } from "./deadline.js";
import { isSshExecutionError } from "./sshClient.js";

export const APPROVED_ADMIN_SCHEMA = "youling-fleet-privileged-operations/v4";
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const uid = z.string().regex(/^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** Opaque protocol reference, not a free-form URL. Human-readable links belong in work_ref/purpose. */
export const approvedAdminReferenceSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$/);
const ref = approvedAdminReferenceSchema;
const profile = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
const command = z.object({
  argv: z.array(text).min(1).max(64),
  cwd: text,
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), text),
  executable_sha256: hex,
  output: z.enum(["discard", "bounded"]).default("discard"),
  output_limit_bytes: z.number().int().min(1024).max(32768).optional(),
}).strict();
export const approvedAdminLeaseSchema = z.object({
  schema: z.literal("ghostfleet-approved-admin-lease/v1"),
  lease_id: ref, request_id: ref, operation_id: ref, operation: z.literal("admin.command"),
  issuer_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  node_uid: uid, subject_ref: hex, audience_ref: z.literal("ghostfleet-approved-admin-command/v1"),
  generation: hex, profile_generation: profile,
  work_ref: text, purpose: text, approval_ref: ref, rollback_ref: text,
  issued_at: z.number().int().safe(), not_before: z.number().int().safe(),
  expires_at: z.number().int().safe(), max_uses: z.literal(1),
  max_runtime_seconds: z.number().int().min(1).max(900),
  command,
}).strict();
export const approvedAdminInputSchema = z.object({
  node_uid: uid,
  action: z.enum(["execute", "status", "cancel"]),
  lease_b64: z.string().min(1).max(21848),
  signature_b64: z.string().min(1).max(88),
}).strict();
export type ApprovedAdminInput = z.infer<typeof approvedAdminInputSchema>;
export interface ApprovedAdminEnvironment extends PrivilegedRuntimeEnv {
  /** Deployment-owned projection matching the node's root-owned V4 binding. */
  CONTROL_APPROVED_ADMIN_POLICY_JSON?: string;
}
const policySchema = z.object({
  generation: hex, profile_generation: profile, subject_ref: hex,
  issuer_ids: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)).min(1).max(16),
}).strict();
const receiptSchema = z.object({
  schema: z.literal("ghostfleet-approved-admin-receipt/v1"),
  lease_id: ref, request_id: ref, operation_id: ref, node_uid: uid, actor_ref: hex,
  lease_digest: hex, command_digest: hex,
  state: z.enum(["NOT_FOUND", "RESERVED", "STARTED", "UNKNOWN", "SUCCEEDED", "FAILED", "EXPIRED", "REVOKED"]),
  duplicate: z.boolean(), retry_safe: z.literal(false), reconcile_required: z.boolean(),
  exit_code: z.number().int().min(-255).max(255).nullable(),
  execution_privilege: z.literal("root").nullable(),
  output: z.enum(["discarded", "bounded"]), persistent_effects_rolled_back: z.literal(false),
  stdout_bytes: z.number().int().nonnegative().optional(),
  stderr_bytes: z.number().int().nonnegative().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  output_sha256: hex.optional(),
  code: z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable(),
}).strict();
export const approvedAdminReceiptSchema = receiptSchema;
export const approvedAdminOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
}).strict();
export type ApprovedAdminOutput = z.infer<typeof approvedAdminOutputSchema>;
export type ApprovedAdminReceipt = z.infer<typeof receiptSchema>;

/** Stable, explicit result contract for the optional approved-admin command seam. */
export type ApprovedAdminCommandResult =
  | {
      outcome: "NOT_DISPATCHED";
      error: string;
      validation_fields?: string[];
      retry_safe: false;
      reconcile_required: false;
    }
  | {
      outcome: "UNKNOWN";
      error: string;
      helper_error?: true;
      validation_fields?: string[];
      retry_safe: false;
      reconcile_required: true;
    }
  | {
      outcome: "UNKNOWN";
      receipt: ApprovedAdminReceipt;
      output?: ApprovedAdminOutput;
      retry_safe: false;
      reconcile_required: true;
    }
  | {
      outcome: "RUNNING";
      receipt: ApprovedAdminReceipt;
      output?: ApprovedAdminOutput;
      retry_safe: false;
      reconcile_required: true;
    }
  | {
      outcome: "SUCCEEDED" | "FAILED" | "STOPPED";
      receipt: ApprovedAdminReceipt;
      output?: ApprovedAdminOutput;
      retry_safe: false;
      reconcile_required: false;
    };

const helperSuccessResponseSchema = z.object({
  ok: z.literal(true),
  receipt: receiptSchema,
  output: approvedAdminOutputSchema.optional(),
}).strict();

/**
 * The node helper can return a structured validation/preflight error without a
 * receipt. This is diagnostic evidence, not a terminal execution receipt:
 * once the SSH forced-command request was sent, keep the operation UNKNOWN
 * until the exact lease is reconciled through the node ledger.
 */
const helperErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().regex(/^[A-Z0-9_]{1,100}$/),
}).strict();

const helperResponseSchema = z.discriminatedUnion("ok", [
  helperSuccessResponseSchema,
  helperErrorResponseSchema,
]);

class AdminValidationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly fields: string[],
  ) {
    super(code);
    this.name = "AdminValidationError";
  }
}

function validationFields(error: z.ZodError): string[] {
  const paths = error.issues.map((issue) => {
    const path = issue.path.map((part) => typeof part === "number"
      ? `[${part}]`
      : String(part).replace(/[^A-Za-z0-9_-]/g, "_")).join(".");
    return path || "$";
  });
  return [...new Set(paths)].slice(0, 8);
}

function parseInput(raw: unknown): ApprovedAdminInput {
  const parsed = approvedAdminInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdminValidationError("ADMIN_INPUT_SCHEMA_INVALID", validationFields(parsed.error));
  }
  return parsed.data;
}

function parseLease(raw: unknown): z.infer<typeof approvedAdminLeaseSchema> {
  const parsed = approvedAdminLeaseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdminValidationError("ADMIN_LEASE_SCHEMA_INVALID", validationFields(parsed.error));
  }
  return parsed.data;
}

function parseHelperResponse(raw: unknown): z.infer<typeof helperResponseSchema> {
  const parsed = helperResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdminValidationError("ADMIN_HELPER_RESPONSE_INVALID", validationFields(parsed.error));
  }
  return parsed.data;
}

function parseJsonText(value: string, code: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AdminValidationError(code, [field]);
  }
}

const defaults: PrivilegedDependencies = {
  connect: async () => { throw new Error("CONTROL_BACKEND_NOT_CONFIGURED"); },
  execute: async () => { throw new Error("CONTROL_BACKEND_NOT_CONFIGURED"); },
};

function decode(value: string, limit: number, exact?: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("ADMIN_BASE64_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > limit || (exact !== undefined && bytes.length !== exact)) {
    throw new Error("ADMIN_BASE64_INVALID");
  }
  return bytes;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, "0")).join("");
}

/** Root verifies the Ed25519 signature over DOMAIN + exact decoded lease bytes.
 * The controller binds the authenticated actor before any SSH connection; a
 * successful call/start never means the command completed.
 */
export async function runApprovedAdminCommand(
  env: ApprovedAdminEnvironment, actor: ControlActor | undefined, raw: ApprovedAdminInput,
  dependencies: PrivilegedDependencies = defaults,
): Promise<ApprovedAdminCommandResult> {
  let dispatched = false;
  try {
    if (!actor || !actorAllows(actor, PRIVILEGED_SCOPE)) throw new Error("PRIVILEGED_SCOPE_REQUIRED");
    const input = parseInput(raw);
    const bytes = decode(input.lease_b64, 16384);
    decode(input.signature_b64, 64, 64);
    const leaseJson = parseJsonText(
      new TextDecoder("utf-8", {fatal:true}).decode(bytes),
      "ADMIN_LEASE_JSON_INVALID",
      "lease_b64",
    );
    const lease = parseLease(leaseJson);
    const subject = await controlActorRef(actor);
    const policy = z.record(uid, policySchema).parse(JSON.parse(env.CONTROL_APPROVED_ADMIN_POLICY_JSON ?? "{}"))[input.node_uid];
    if (!policy || policy.subject_ref !== subject || lease.subject_ref !== subject
        || lease.node_uid !== input.node_uid || !policy.issuer_ids.includes(lease.issuer_id)) {
      throw new Error("ADMIN_AUTHENTICATED_BINDING_MISMATCH");
    }
    if (input.action === "execute" && (lease.generation !== policy.generation
        || lease.profile_generation !== policy.profile_generation
        || !(lease.issued_at <= lease.not_before && lease.not_before <= Date.now()/1000
             && Date.now()/1000 < lease.expires_at))) {
      throw new Error("ADMIN_APPROVAL_STALE");
    }
    const resolved = resolvePrivilegedTarget(env, input.node_uid);
    const deadlineAt = createDeadlineAt(30000);
    await assertDistinctKeyIdentities(env, resolved.controllerPrivateKey, deadlineAt);
    const socket = await withDeadline(
      () => dependencies.connect(env, input.node_uid, resolved.target),
      deadlineAt, "PRIVILEGED_CONNECT_TIMEOUT",
      late => { void late.closed?.catch(() => undefined); void Promise.resolve().then(() => late.close()).catch(() => undefined); },
    );
    const wire = {schema: APPROVED_ADMIN_SCHEMA, ...input, actor_ref: subject};
    dispatched = true;
    const result = await dependencies.execute(
      socket,
      {username: resolved.target.username, hostKeyAlgorithm: resolved.target.ssh_host_key_algorithm,
        hostKeySha256: resolved.target.ssh_host_key_sha256},
      resolved.controllerPrivateKey, null,
      {deadlineAt, timeoutMs: 30000, outputLimitBytes: 131072,
        forcedCommandPrincipal: env.CONTROL_PRIVILEGED_USERNAME, stdin: JSON.stringify(wire)},
    );
    if (result.exit_code !== 0 || result.truncated) throw new Error("ADMIN_RESPONSE_UNAVAILABLE");
    const responseJson = parseJsonText(result.stdout, "ADMIN_HELPER_RESPONSE_INVALID", "stdout_json");
    const response = parseHelperResponse(responseJson);
    if (!response.ok) {
      // A negative helper response preserves the precise node-side error code,
      // but it has no request-bound receipt. Do not infer NOT_EXECUTED or allow
      // a retry after the SSH request has crossed the dispatch boundary.
      return {
        outcome: "UNKNOWN",
        error: response.error,
        helper_error: true,
        reconcile_required: true,
        retry_safe: false,
      };
    }
    const receipt = response.receipt;
    if (receipt.lease_id !== lease.lease_id || receipt.request_id !== lease.request_id
        || receipt.operation_id !== lease.operation_id || receipt.node_uid !== input.node_uid
        || receipt.actor_ref !== subject || receipt.lease_digest !== await sha256(bytes)) {
      throw new Error("ADMIN_RECEIPT_BINDING_MISMATCH");
    }
    if (lease.command.output === "discard") {
      if (receipt.output !== "discarded" || response.output !== undefined) {
        throw new Error("ADMIN_RECEIPT_OUTPUT_MODE_MISMATCH");
      }
    } else if (lease.command.output === "bounded") {
      if (receipt.output !== "bounded") {
        throw new Error("ADMIN_RECEIPT_OUTPUT_MODE_MISMATCH");
      }
      if (["SUCCEEDED", "FAILED"].includes(receipt.state)) {
        if (!response.output) {
          throw new Error("ADMIN_OUTPUT_DATA_MISSING");
        }
        if (receipt.stdout_bytes === undefined || receipt.stderr_bytes === undefined
            || receipt.output_bytes === undefined || receipt.truncated === undefined
            || receipt.output_sha256 === undefined) {
          throw new Error("ADMIN_OUTPUT_METADATA_MISSING");
        }
        const stdoutBytes = Buffer.byteLength(response.output.stdout, "utf-8");
        const stderrBytes = Buffer.byteLength(response.output.stderr, "utf-8");
        if (stdoutBytes !== receipt.stdout_bytes || stderrBytes !== receipt.stderr_bytes) {
          throw new Error("ADMIN_OUTPUT_BYTE_LENGTH_MISMATCH");
        }
        if (receipt.stdout_bytes + receipt.stderr_bytes !== receipt.output_bytes) {
          throw new Error("ADMIN_OUTPUT_SUM_MISMATCH");
        }
        const limit = lease.command.output_limit_bytes ?? 32768;
        if (receipt.output_bytes > limit) {
          throw new Error("ADMIN_OUTPUT_LIMIT_EXCEEDED");
        }
        const outputConcat = new TextEncoder().encode(response.output.stdout + response.output.stderr);
        const computedHash = await sha256(outputConcat);
        if (receipt.output_sha256 !== computedHash) {
          throw new Error("ADMIN_OUTPUT_DIGEST_MISMATCH");
        }
      }
    }
    if (["NOT_FOUND", "RESERVED", "UNKNOWN"].includes(receipt.state)) {
      return {outcome:"UNKNOWN", receipt, output:response.output,
        retry_safe:false, reconcile_required:true};
    }
    if (receipt.state === "STARTED") {
      return {outcome:"RUNNING", receipt, output:response.output,
        retry_safe:false, reconcile_required:true};
    }
    if (receipt.state === "SUCCEEDED" || receipt.state === "FAILED") {
      return {outcome:receipt.state, receipt, output:response.output,
        retry_safe:false, reconcile_required:false};
    }
    return {outcome:"STOPPED", receipt, output:response.output,
      retry_safe:false, reconcile_required:false};
  } catch (error) {
    if (isSshExecutionError(error)) dispatched = error.dispatch_state === "MAY_HAVE_EXECUTED";
    const validation = error instanceof AdminValidationError ? error : undefined;
    const code = validation?.code
      ?? (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message : "ADMIN_REQUEST_OR_RESPONSE_INVALID");
    // Lost responses and all malformed post-dispatch replies remain uncertain
    // until exact-lease status reconciliation. Never silently mint a new ID.
    return {
      outcome:dispatched ? "UNKNOWN" : "NOT_DISPATCHED",
      error:code,
      ...(validation ? {validation_fields: validation.fields} : {}),
      reconcile_required:dispatched,
      retry_safe:false,
    };
  }
}
