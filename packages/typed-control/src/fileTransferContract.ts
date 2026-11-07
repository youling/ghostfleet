import {createHash} from "node:crypto";
import {NODE_UID_RE} from "./routing.js";
import type {DispatchState} from "./transportContract.js";
import type {OperationOutcome} from "./operations.js";

/** Optional, pure contract. These functions neither authorize nor dispatch work. */
export const FILE_TRANSFER_CAPABILITY = "fleet.file.transfer" as const;
export const FILE_TRANSFER_PROFILE = "portable-files-v1" as const;

export interface FileTransferLocation {
  readonly node_uid: string;
  readonly root_ref: string;
  readonly relative_path: string;
}

export interface FileTransferIntent {
  readonly schema_version: 1;
  readonly capability: typeof FILE_TRANSFER_CAPABILITY;
  readonly operation_id: string;
  readonly actor_ref: string;
  readonly work_ref: string;
  readonly policy_revision: string;
  readonly source: FileTransferLocation;
  readonly destination: FileTransferLocation;
  readonly direction: "push" | "pull";
  readonly backend: "rsync-ssh" | "sftp";
  readonly profile: typeof FILE_TRANSFER_PROFILE;
  readonly source_version: string;
  readonly manifest_sha256: string;
  readonly overwrite: "deny";
  readonly delete_source: false;
  readonly delete_extraneous: false;
}

export type FileManifestEntry =
  | {readonly path: string; readonly kind: "file"; readonly size: number; readonly sha256: string}
  | {readonly path: string; readonly kind: "directory"};

export interface FileManifest {
  readonly schema_version: 1;
  readonly profile: typeof FILE_TRANSFER_PROFILE;
  readonly source_version: string;
  readonly entries: readonly FileManifestEntry[];
  readonly file_count: number;
  readonly directory_count: number;
  readonly total_bytes: number;
}

export class FileTransferError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "FileTransferError"; this.code = code; }
}

function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new FileTransferError(code);
}

/** Reject accessors/non-JSON inputs before reading them; detach and freeze all data. */
export function snapshotFileTransferValue(input: unknown): unknown {
  const ancestors = new Set<object>();
  let budget = 1_500_000;
  function copy(value: unknown, depth: number): unknown {
    requireThat(--budget >= 0 && depth <= 32, "INPUT_LIMIT");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      requireThat(value.length <= 1_048_576, "INPUT_LIMIT");
      return value;
    }
    if (typeof value === "number") {
      requireThat(Number.isFinite(value), "NON_JSON_INPUT");
      return value;
    }
    requireThat(typeof value === "object" && value !== null, "NON_JSON_INPUT");
    requireThat(!ancestors.has(value), "NON_JSON_INPUT");
    const array = Array.isArray(value);
    const proto: unknown = Object.getPrototypeOf(value);
    requireThat(array ? proto === Array.prototype : proto === Object.prototype || proto === null, "NON_JSON_INPUT");
    requireThat(Object.getOwnPropertySymbols(value).length === 0, "NON_JSON_INPUT");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireThat(Object.values(descriptors).every(d => "value" in d), "NON_JSON_INPUT");
    ancestors.add(value);
    let result: unknown;
    if (array) {
      const length = (value as unknown[]).length;
      requireThat(length <= 100_000 && Object.keys(descriptors).length === length + 1, "INPUT_LIMIT");
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) {
        requireThat(Object.hasOwn(descriptors, String(i)), "NON_JSON_INPUT");
        items.push(copy(descriptors[String(i)].value, depth + 1));
      }
      result = Object.freeze(items);
    } else {
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        requireThat(descriptor.enumerable && key !== "__proto__", "NON_JSON_INPUT");
        object[key] = copy(descriptor.value, depth + 1);
      }
      result = Object.freeze(object);
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, 0);
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  requireThat(typeof input === "object" && input !== null && !Array.isArray(input), "INVALID_OBJECT");
  const value = input as Record<string, unknown>;
  requireThat(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), "UNKNOWN_OR_MISSING_FIELD");
  return value;
}

function reference(input: unknown): asserts input is string {
  requireThat(typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9._:#/@-]{0,239}$/.test(input), "INVALID_REFERENCE");
}

function digest(input: unknown): asserts input is string {
  requireThat(typeof input === "string" && /^[0-9a-f]{64}$/.test(input), "INVALID_SHA256");
}

function count(input: unknown): asserts input is number {
  requireThat(typeof input === "number" && Number.isSafeInteger(input) && input >= 0, "INVALID_COUNT");
}

/** Portable relative names only; runtime must independently reject links/reparse points. */
export function validateFileTransferRelativePath(input: unknown, allowRoot = false): string {
  requireThat(typeof input === "string" && input.length > 0 && input.length <= 4096, "INVALID_PATH");
  if (input === "." && allowRoot) return input;
  requireThat(input === input.normalize("NFC") && !/[\u0000-\u001f\u007f<>:"\\|?*\uD800-\uDFFF]/u.test(input), "INVALID_PATH");
  for (const part of input.split("/")) {
    requireThat(part.length > 0 && part.length <= 255 && part !== "." && part !== ".." && !/[ .]$/.test(part), "INVALID_PATH");
    requireThat(!/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/iu.test(part), "WINDOWS_RESERVED_NAME");
    requireThat(!/^\.ghostfleet-(?:transfer|partial)$/i.test(part), "RESERVED_TRANSFER_PATH");
  }
  return input;
}

function location(input: unknown): void {
  const value = record(input, ["node_uid", "root_ref", "relative_path"]);
  requireThat(typeof value.node_uid === "string" && NODE_UID_RE.test(value.node_uid), "INVALID_NODE_UID");
  reference(value.root_ref);
  validateFileTransferRelativePath(value.relative_path, true);
}

export function validateFileTransferIntent(input: unknown): FileTransferIntent {
  const value = record(snapshotFileTransferValue(input), [
    "schema_version", "capability", "operation_id", "actor_ref", "work_ref", "policy_revision",
    "source", "destination", "direction", "backend", "profile", "source_version", "manifest_sha256",
    "overwrite", "delete_source", "delete_extraneous",
  ]);
  requireThat(value.schema_version === 1 && value.capability === FILE_TRANSFER_CAPABILITY && value.profile === FILE_TRANSFER_PROFILE, "UNSUPPORTED_CONTRACT");
  for (const key of ["operation_id", "actor_ref", "work_ref", "policy_revision", "source_version"]) reference(value[key]);
  digest(value.manifest_sha256);
  location(value.source); location(value.destination);
  requireThat((value.source as FileTransferLocation).node_uid !== (value.destination as FileTransferLocation).node_uid, "DISTINCT_NODES_REQUIRED");
  requireThat(value.direction === "push" || value.direction === "pull", "INVALID_DIRECTION");
  requireThat(value.backend === "rsync-ssh" || value.backend === "sftp", "UNSUPPORTED_BACKEND");
  requireThat(value.overwrite === "deny" && value.delete_source === false && value.delete_extraneous === false, "DESTRUCTIVE_POLICY_UNSUPPORTED");
  return value as unknown as FileTransferIntent;
}

export function validateFileManifest(input: unknown): FileManifest {
  const value = record(snapshotFileTransferValue(input), ["schema_version", "profile", "source_version", "entries", "file_count", "directory_count", "total_bytes"]);
  requireThat(value.schema_version === 1 && value.profile === FILE_TRANSFER_PROFILE, "UNSUPPORTED_MANIFEST");
  reference(value.source_version);
  for (const key of ["file_count", "directory_count", "total_bytes"]) count(value[key]);
  requireThat(Array.isArray(value.entries) && value.entries.length <= 100_000, "INVALID_ENTRIES");
  const names = new Map<string, FileManifestEntry>();
  const folded = new Set<string>();
  let files = 0, directories = 0, bytes = 0;
  for (const inputEntry of value.entries) {
    requireThat(typeof inputEntry === "object" && inputEntry !== null, "INVALID_ENTRY");
    const kind: unknown = (inputEntry as Record<string, unknown>).kind;
    requireThat(kind === "file" || kind === "directory", "UNSUPPORTED_FILE_KIND");
    const entry = record(inputEntry, kind === "file" ? ["path", "kind", "size", "sha256"] : ["path", "kind"]);
    const path = validateFileTransferRelativePath(entry.path);
    const foldedPath = path.toUpperCase();
    requireThat(!folded.has(foldedPath), "PATH_COLLISION");
    folded.add(foldedPath);
    names.set(path, entry as unknown as FileManifestEntry);
    if (kind === "file") {
      count(entry.size); digest(entry.sha256);
      files++; bytes += entry.size;
      requireThat(Number.isSafeInteger(bytes), "INVALID_COUNT");
    } else directories++;
  }
  for (const path of names.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length > 0) {
      requireThat(names.get(parts.join("/"))?.kind === "directory", "MISSING_OR_CONFLICTING_PARENT");
      parts.pop();
    }
  }
  requireThat(files === value.file_count && directories === value.directory_count && bytes === value.total_bytes, "MANIFEST_TOTAL_MISMATCH");
  return snapshotFileTransferValue({...value, entries: [...names.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)}) as FileManifest;
}

/** Canonical JSON SHA-256: object keys sorted, array order preserved, UTF-8 encoded. */
export function fileTransferValueSha256(input: unknown): string {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  return createHash("sha256").update(canonical(snapshotFileTransferValue(input)), "utf8").digest("hex");
}

export function fileManifestSha256(input: unknown): string {
  return fileTransferValueSha256(validateFileManifest(input));
}

export function fileTransferIntentSha256(input: unknown): string {
  return fileTransferValueSha256(validateFileTransferIntent(input));
}

/** Observations must come from an authenticated, exhaustive no-follow scanner. */
export function verifyFileTransferManifest(expectedInput: unknown, observedInput: unknown): FileManifest {
  const expected = validateFileManifest(expectedInput);
  const observed = validateFileManifest(observedInput);
  requireThat(fileManifestSha256(expected) === fileManifestSha256(observed), "MANIFEST_MISMATCH");
  return observed;
}

/** Reuse the transport dispatch state; UNKNOWN never authorizes a second dispatch. */
export function canChangeFileTransferBackend(state: DispatchState | null): boolean {
  return state === "NOT_DISPATCHED";
}

export interface FileTransferReceipt {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly intent_sha256: string;
  readonly actor_ref: string;
  readonly work_ref: string;
  readonly policy_revision: string;
  readonly source_node_uid: string;
  readonly destination_node_uid: string;
  readonly backend: "rsync-ssh" | "sftp";
  readonly outcome: OperationOutcome;
  readonly dispatch_state: DispatchState;
  readonly exit_code: number | null;
  readonly source_version_after: string | null;
  readonly observed_manifest: FileManifest | null;
  readonly destination_owner_ref: string | null;
  readonly publication: "not-published" | "no-replace";
  readonly evidence_ref: string;
}

export interface FileTransferVerification {
  readonly verified: boolean;
  readonly outcome: OperationOutcome;
  readonly retry_safe: boolean;
  readonly reconcile_required: boolean;
  readonly manifest_sha256: string | null;
}

/** Logical verification only. The existing runtime authenticates the receipt producer. */
export function verifyFileTransferReceipt(
  intentInput: unknown, manifestInput: unknown, receiptInput: unknown, expectedOwnerRef: string,
): FileTransferVerification {
  const intent = validateFileTransferIntent(intentInput);
  const manifest = validateFileManifest(manifestInput);
  reference(expectedOwnerRef);
  requireThat(intent.manifest_sha256 === fileManifestSha256(manifest) && intent.source_version === manifest.source_version, "MANIFEST_BINDING_MISMATCH");
  const value = record(snapshotFileTransferValue(receiptInput), [
    "schema_version", "operation_id", "intent_sha256", "actor_ref", "work_ref", "policy_revision", "source_node_uid",
    "destination_node_uid", "backend", "outcome", "dispatch_state", "exit_code", "source_version_after",
    "observed_manifest", "destination_owner_ref", "publication", "evidence_ref",
  ]);
  reference(value.evidence_ref);
  requireThat(value.schema_version === 1 && value.operation_id === intent.operation_id && value.intent_sha256 === fileTransferIntentSha256(intent)
    && value.actor_ref === intent.actor_ref && value.work_ref === intent.work_ref && value.policy_revision === intent.policy_revision
    && value.source_node_uid === intent.source.node_uid && value.destination_node_uid === intent.destination.node_uid
    && value.backend === intent.backend, "RECEIPT_BINDING_MISMATCH");
  requireThat(["NOT_DISPATCHED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(value.outcome)), "INVALID_OUTCOME");
  requireThat(["NOT_DISPATCHED", "MAY_HAVE_EXECUTED", "UNKNOWN"].includes(String(value.dispatch_state)), "INVALID_DISPATCH_STATE");
  requireThat(value.exit_code === null || (typeof value.exit_code === "number" && Number.isSafeInteger(value.exit_code) && value.exit_code >= 0), "INVALID_EXIT_CODE");
  requireThat(value.publication === "not-published" || value.publication === "no-replace", "INVALID_PUBLICATION");
  if (value.source_version_after !== null) reference(value.source_version_after);
  if (value.destination_owner_ref !== null) reference(value.destination_owner_ref);
  if (value.observed_manifest !== null) validateFileManifest(value.observed_manifest);
  if (value.outcome === "NOT_DISPATCHED") {
    requireThat(value.dispatch_state === "NOT_DISPATCHED" && value.exit_code === null && value.observed_manifest === null
      && value.source_version_after === null && value.destination_owner_ref === null && value.publication === "not-published", "INVALID_NOT_DISPATCHED_PROOF");
    return Object.freeze({verified: false, outcome: "NOT_DISPATCHED", retry_safe: true, reconcile_required: false, manifest_sha256: null});
  }
  requireThat(value.dispatch_state !== "NOT_DISPATCHED", "INVALID_DISPATCH_STATE");
  if (value.outcome !== "SUCCEEDED") {
    return Object.freeze({verified: false, outcome: value.outcome as "FAILED" | "UNKNOWN", retry_safe: false, reconcile_required: true, manifest_sha256: null});
  }
  requireThat(value.dispatch_state === "MAY_HAVE_EXECUTED" && value.exit_code === 0 && value.source_version_after === manifest.source_version
    && value.destination_owner_ref === expectedOwnerRef && value.publication === "no-replace" && value.observed_manifest !== null, "INCOMPLETE_SUCCESS_PROOF");
  verifyFileTransferManifest(manifest, value.observed_manifest);
  return Object.freeze({verified: true, outcome: "SUCCEEDED", retry_safe: false, reconcile_required: false, manifest_sha256: intent.manifest_sha256});
}
