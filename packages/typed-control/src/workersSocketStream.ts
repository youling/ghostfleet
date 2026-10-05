import { BaseStream, type CancellationToken } from "@microsoft/dev-tunnels-ssh";
import { Buffer } from "buffer";
import { settleCleanup } from "./deadline.js";

export interface WorkersDuplexSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
  /** Workers sockets may reject this independently of read/write operations. */
  closed?: Promise<void>;
}

/**
 * Adapts a Cloudflare Workers TCP/VPC socket to dev-tunnels-ssh's Stream.
 * The adapter contains no target selection or SSH policy.
 */
export class WorkersSocketStream extends BaseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private closeStarted = false;
  private closePromise?: Promise<void>;
  private closeNotified = false;

  public constructor(private readonly socket: WorkersDuplexSocket, private readonly deadlineAt = Date.now() + 100) {
    super();
    this.reader = socket.readable.getReader();
    try { this.writer = socket.writable.getWriter(); }
    catch (error) { this.reader.releaseLock(); throw error; }
    void socket.closed?.catch(() => undefined);
    void this.reader.closed.catch(() => undefined);
    void this.writer.closed.catch(() => undefined);
    void this.pump().catch(() => undefined);
  }

  private notifyClosed(error?: Error): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.fireOnClose(error);
  }

  private async pump(): Promise<void> {
    try {
      while (!this.disposed) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.onEnd();
          this.notifyClosed();
          return;
        }
        if (value && value.byteLength > 0) this.onData(Buffer.from(value));
      }
    } catch (error) {
      if (this.closeStarted) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.onError(normalized);
      this.notifyClosed(normalized);
    }
  }

  public async write(data: Buffer, cancellation?: CancellationToken): Promise<void> {
    if (this.disposed) throw new Error("WORKERS_SOCKET_STREAM_CLOSED");
    if (cancellation?.isCancellationRequested) throw new Error("SSH_OPERATION_CANCELLED");
    await this.writer.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  public close(error?: Error, _cancellation?: CancellationToken): Promise<void> {
    if (this.closeStarted) return this.closePromise ?? Promise.resolve();
    this.closeStarted = true;
    this.disposed = true;
    // Unblock BaseStream reads immediately. Cancellation must not skip cleanup.
    this.onEnd();
    this.closePromise = settleCleanup([
      () => this.socket.close(),
      () => this.reader.cancel(),
      () => this.writer.abort(error),
    ], this.deadlineAt).then(() => {
      try { this.reader.releaseLock(); } catch { /* A runtime read may still be pending. */ }
      try { this.writer.releaseLock(); } catch { /* A runtime write may still be pending. */ }
      this.notifyClosed(error);
    }).catch(() => undefined);
    return this.closePromise;
  }

  public override dispose(): void {
    if (!this.closeStarted) void this.close().catch(() => undefined);
  }
}
