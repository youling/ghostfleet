import { Buffer } from "buffer";
import {
  CommandRequestMessage,
  ChannelRequestMessage,
  SshAlgorithms,
  SshClientSession,
  SshDisconnectReason,
  SshSessionConfiguration,
  type KeyPair,
  type PublicKeyAlgorithm,
} from "@microsoft/dev-tunnels-ssh";
import { importKey } from "@microsoft/dev-tunnels-ssh-keys";
import type { SshHostKeyAlgorithm } from "./targets.js";
import { WorkersSocketStream, type WorkersDuplexSocket } from "./workersSocketStream.js";
import { createDeadlineAt, DeadlineExceededError, settleCleanup, withDeadline } from "./deadline.js";

export type SshDispatchState = "NOT_DISPATCHED" | "MAY_HAVE_EXECUTED";

/** A local transport outcome, never a claim that remote work was killed. */
export class SshExecutionError extends Error {
  public constructor(public readonly code: string, public readonly dispatch_state: SshDispatchState) {
    super(code);
    this.name = "SshExecutionError";
  }
}

function invalid(code: string): never {
  throw new SshExecutionError(code, "NOT_DISPATCHED");
}

export interface SshTargetIdentity {
  username: string;
  hostKeyAlgorithm: SshHostKeyAlgorithm;
  /** OpenSSH SHA256 fingerprint, e.g. SHA256:abc... (no base64 padding). */
  hostKeySha256: string;
}

export interface SshExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const DEFAULT_OUTPUT_LIMIT = 128 * 1024;

export async function sshKeyFingerprintSha256(key: KeyPair): Promise<string> {
  const bytes = await key.getPublicKeyBytes();
  if (!bytes) throw new Error("SSH_HOST_KEY_BYTES_MISSING");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return `SHA256:${Buffer.from(digest).toString("base64").replace(/=+$/, "")}`;
}

function requiredAlgorithm(value: PublicKeyAlgorithm | null): PublicKeyAlgorithm {
  if (!value) invalid("PINNED_HOST_KEY_ALGORITHM_UNAVAILABLE");
  return value;
}

function hostKeyAlgorithms(algorithm: SshHostKeyAlgorithm): PublicKeyAlgorithm[] {
  switch (algorithm) {
    case "ssh-rsa":
      return [
        requiredAlgorithm(SshAlgorithms.publicKey.rsaWithSha512),
        requiredAlgorithm(SshAlgorithms.publicKey.rsaWithSha256),
      ];
    case "ecdsa-sha2-nistp256":
      return [requiredAlgorithm(SshAlgorithms.publicKey.ecdsaSha2Nistp256)];
    case "ecdsa-sha2-nistp384":
      return [requiredAlgorithm(SshAlgorithms.publicKey.ecdsaSha2Nistp384)];
    case "ecdsa-sha2-nistp521":
      return [requiredAlgorithm(SshAlgorithms.publicKey.ecdsaSha2Nistp521)];
    default:
      invalid("INVALID_PINNED_HOST_KEY_ALGORITHM");
  }
}

function validateControllerPrivateKey(value: string): void {
  if (!value || value.length > 64 * 1024) invalid("INVALID_CONTROLLER_PRIVATE_KEY");
  if (value.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    invalid("CONTROLLER_PRIVATE_KEY_OPENSSH_UNSUPPORTED");
  }
  if (!/^-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/m.test(value)) {
    invalid("INVALID_CONTROLLER_PRIVATE_KEY_FORMAT");
  }
}

function appendBounded(
  chunks: Buffer[],
  data: Buffer,
  currentBytes: number,
  limit: number,
): { bytes: number; truncated: boolean } {
  if (currentBytes >= limit) return { bytes: currentBytes, truncated: data.length > 0 };
  const remaining = limit - currentBytes;
  const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
  if (accepted.length > 0) chunks.push(Buffer.from(accepted));
  return { bytes: currentBytes + accepted.length, truncated: accepted.length !== data.length };
}

/**
 * Takes ownership of an already-targeted socket, including on validation failure.
 * The caller must create deadlineAt BEFORE connecting to include transport time.
 * Timeout closes local resources only; it cannot prove remote command termination.
 */
export async function executeSshCommand(
  socket: WorkersDuplexSocket,
  target: SshTargetIdentity,
  controllerPrivateKeyPem: string,
  command: string | null,
  options: { timeoutMs?: number; outputLimitBytes?: number; deadlineAt?: number; stdin?: string; forcedCommandPrincipal?:string } = {},
): Promise<SshExecResult> {
  let deadlineAt = Date.now();
  let dispatchState: SshDispatchState = "NOT_DISPATCHED";
  let failureCode = "INVALID_SSH_TIMEOUT";
  let session: SshClientSession | undefined;
  let stream: WorkersSocketStream | undefined;
  let importedKey: KeyPair | undefined;
  void socket.closed?.catch(() => undefined);
  try {
    const defaultDeadline = createDeadlineAt(options.timeoutMs);
    deadlineAt = Math.min(options.deadlineAt ?? defaultDeadline, defaultDeadline);
    if (!Number.isFinite(deadlineAt)) invalid("INVALID_DEADLINE");
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(target.hostKeySha256)) invalid("INVALID_PINNED_HOST_KEY_FINGERPRINT");
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(target.username)) invalid("INVALID_SSH_USERNAME");
    // null requests the server's forced command without SSH_ORIGINAL_COMMAND.
    // Trusted privileged backend selects its installed dedicated principal.
    const forcedPrincipal=options.forcedCommandPrincipal ?? "ghostfleet-ops";
    if (command === null ? !/^[a-z_][a-z0-9_-]{0,31}$/i.test(forcedPrincipal) || target.username !== forcedPrincipal :
      (!command || command.length > 32_768 || command.includes("\0"))) invalid("INVALID_SSH_COMMAND");
    validateControllerPrivateKey(controllerPrivateKeyPem);
    const outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
    if (!Number.isFinite(outputLimit) || outputLimit < 1_024 || outputLimit > 1024 * 1024) invalid("INVALID_OUTPUT_LIMIT");
    const stdin = options.stdin === undefined ? null : Buffer.from(options.stdin,"utf8");
    if (stdin && stdin.length > 32*1024) invalid("SSH_STDIN_TOO_LARGE");

    failureCode = "SSH_KEY_IMPORT_FAILED";
    const controllerKey = importedKey = await withDeadline(() => importKey(controllerPrivateKeyPem), deadlineAt, "SSH_KEY_IMPORT_TIMEOUT", (lateKey) => lateKey.dispose());
    const config = new SshSessionConfiguration();
    const pinnedAlgorithms = hostKeyAlgorithms(target.hostKeyAlgorithm);
    config.publicKeyAlgorithms.splice(0, config.publicKeyAlgorithms.length, ...pinnedAlgorithms);
    const sshSession = session = new SshClientSession(config);
    const socketStream = stream = new WorkersSocketStream(socket, deadlineAt);
    let observedHostFingerprint: string | null = null;
    sshSession.onAuthenticating((event) => {
      if (!event.publicKey) return;
      event.authenticationPromise = (async () => {
        observedHostFingerprint = await sshKeyFingerprintSha256(event.publicKey!);
        return observedHostFingerprint === target.hostKeySha256 ? {} : null;
      })();
    });

    failureCode = "SSH_CONNECT_FAILED";
    await withDeadline(() => sshSession.connect(socketStream), deadlineAt, "SSH_CONNECT_TIMEOUT");
    failureCode = "SSH_HOST_AUTH_FAILED";
    const serverAuthenticated = await withDeadline(
      () => sshSession.authenticateServer(),
      deadlineAt,
      "SSH_HOST_AUTH_TIMEOUT",
    );
    if (!serverAuthenticated) {
      if (observedHostFingerprint && observedHostFingerprint !== target.hostKeySha256) {
        invalid("SSH_HOST_KEY_MISMATCH");
      }
      invalid("SSH_HOST_AUTH_FAILED");
    }

    failureCode = "SSH_CLIENT_AUTH_FAILED";
    const clientAuthenticated = await withDeadline(
      () => sshSession.authenticateClient({ username: target.username, publicKeys: [controllerKey] }),
      deadlineAt,
      "SSH_CLIENT_AUTH_TIMEOUT",
    );
    if (!clientAuthenticated) invalid("SSH_CLIENT_AUTH_FAILED");

    failureCode = "SSH_CHANNEL_OPEN_FAILED";
    const channel = await withDeadline(() => sshSession.openChannel(), deadlineAt, "SSH_CHANNEL_OPEN_TIMEOUT", (lateChannel) => lateChannel.dispose());
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    channel.onDataReceived((data) => {
      const result = appendBounded(stdoutChunks, data, stdoutBytes, outputLimit);
      stdoutBytes = result.bytes;
      truncated ||= result.truncated;
      channel.adjustWindow(data.length);
    });
    channel.onExtendedDataReceived((event) => {
      const result = appendBounded(stderrChunks, event.data, stderrBytes, outputLimit);
      stderrBytes = result.bytes;
      truncated ||= result.truncated;
      channel.adjustWindow(event.data.length);
    });

    const closed = new Promise<{ exitStatus?: number; error?: Error; exitSignal?: string }>((resolve) => {
      channel.onClosed((event) => resolve(event));
    });

    const request = command === null ? new ChannelRequestMessage() : new CommandRequestMessage();
    if (request instanceof CommandRequestMessage) request.command = command!;
    else request.requestType = "shell";
    request.wantReply = true;
    failureCode = "SSH_EXEC_REQUEST_FAILED";
    const accepted = await withDeadline(() => {
      // Set BEFORE calling request: even a send failure may follow a partial send.
      dispatchState = "MAY_HAVE_EXECUTED";
      return channel.request(request);
    }, deadlineAt, "SSH_EXEC_REQUEST_TIMEOUT");
    if (!accepted) invalid("SSH_EXEC_REQUEST_REJECTED");

    if (stdin !== null) {
      failureCode="SSH_STDIN_SEND_FAILED";
      if (stdin.length) await withDeadline(()=>channel.send(stdin),deadlineAt,"SSH_STDIN_SEND_TIMEOUT");
      failureCode="SSH_STDIN_EOF_FAILED";
      // dev-tunnels-ssh uses an empty send for channel EOF.
      await withDeadline(()=>channel.send(Buffer.alloc(0)),deadlineAt,"SSH_STDIN_EOF_TIMEOUT");
    }

    failureCode = "SSH_EXEC_CHANNEL_ERROR";
    const closeResult = await withDeadline(() => closed, deadlineAt, "SSH_EXEC_TIMEOUT");
    if (closeResult.error) throw new SshExecutionError("SSH_EXEC_CHANNEL_ERROR", dispatchState);
    if (closeResult.exitSignal) throw new SshExecutionError("SSH_REMOTE_SIGNAL", dispatchState);

    return {
      exit_code: closeResult.exitStatus ?? null,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      truncated,
    };
  } catch (error) {
    if (error instanceof SshExecutionError) throw error;
    throw new SshExecutionError(error instanceof DeadlineExceededError ? error.code : failureCode, dispatchState);
  } finally {
    // Start socket closure regardless of whether graceful SSH close settles.
    await settleCleanup([
      () => session?.close(SshDisconnectReason.byApplication),
      () => stream ? stream.close() : socket.close(),
      () => session?.dispose(),
      () => importedKey?.dispose(),
    ], deadlineAt);
  }
}
