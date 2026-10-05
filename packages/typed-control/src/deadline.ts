/** A deadline bounds local waiting; it does not cancel or undo remote work. */
export class DeadlineExceededError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "DeadlineExceededError";
  }
}

export function createDeadlineAt(timeoutMs = 30_000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("INVALID_SSH_TIMEOUT");
  }
  return Date.now() + timeoutMs;
}

/**
 * The factory is never invoked after the deadline. The caller owns disposal of
 * late resources (for example a VPC connect resolving after a timeout).
 * All late rejections, including disposal failures, remain observed.
 */
export function withDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  code: string,
  onLateValue?: (value: T) => Promise<unknown> | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!Number.isFinite(deadlineAt)) {
      reject(new Error("INVALID_DEADLINE"));
      return;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new DeadlineExceededError(code));
      return;
    }
    let settled = false;
    const expire = () => {
      settled = true;
      reject(new DeadlineExceededError(code));
    };
    const timer = setTimeout(expire, remaining);
    const discard = (value: T) => {
      if (onLateValue) void Promise.resolve().then(() => onLateValue(value)).catch(() => undefined);
    };
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    void Promise.resolve(pending).then(
      (value) => {
        if (settled) { discard(value); return; }
        clearTimeout(timer);
        // A busy event loop must not allow a late phase to start the next one.
        if (Date.now() >= deadlineAt) { expire(); discard(value); return; }
        settled = true;
        resolve(value);
      },
      (error) => {
        if (settled) return;
        clearTimeout(timer);
        if (Date.now() >= deadlineAt) { expire(); return; }
        settled = true;
        reject(error);
      },
    );
  });
}

/** Start every cleanup even if expired, but never wait beyond the original deadline. */
export async function settleCleanup(
  operations: Array<() => unknown>,
  deadlineAt: number,
): Promise<void> {
  const pending = operations.map((operation) => {
    try { return Promise.resolve(operation()).catch(() => undefined); }
    catch { return Promise.resolve(); }
  });
  // Cleanup cannot consume another full operation timeout, even on early errors.
  const cleanupDeadline = Math.min(Number.isFinite(deadlineAt) ? deadlineAt : Date.now(), Date.now() + 100);
  await withDeadline(() => Promise.all(pending), cleanupDeadline, "CLEANUP_TIMEOUT").catch(() => undefined);
}
