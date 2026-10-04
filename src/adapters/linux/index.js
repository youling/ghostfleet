import { LinuxReceiptError, LINUX_EVIDENCE_TYPES, validateLinuxBinding, validateLinuxReceipt } from "./receipt.js";

const METHODS = Object.freeze({
  "transport.ready": "readTransportReceipt",
  "bootstrap.report": "readBootstrapReceipt",
  "control.canary": "readControlReceipt",
  "convergence.zero_delta": "readConvergenceReceipt",
  "reboot.recovered": "readRebootReceipt",
});

/**
 * Receipt observation only: the private backend consumes accepted Fleet control,
 * converger and reboot receipts. This adapter has no exec/mint/join/reboot method.
 * It neither resolves Human Gates nor admits nodes or changes Assets facts.
 */
export class LinuxReceiptAdapter {
  #binding;
  #backend;
  #verifyReceipt;
  #clock;
  #deadlineMs;

  constructor({ binding, backend, verifyReceipt, clock = Date, observation_timeout_ms = 30000 }) {
    if (typeof clock?.now !== "function" || !Number.isFinite(clock.now())) throw new LinuxReceiptError("LINUX_CLOCK_INVALID");
    if (!Number.isInteger(observation_timeout_ms) || observation_timeout_ms < 1 || observation_timeout_ms > 30000) throw new LinuxReceiptError("LINUX_DEADLINE_INVALID");
    this.#binding = validateLinuxBinding(binding, clock.now());
    if (!backend || typeof verifyReceipt !== "function" || Object.values(METHODS).some((method) => typeof backend[method] !== "function")) throw new LinuxReceiptError("LINUX_BACKEND_INVALID");
    this.#backend = Object.fromEntries(Object.values(METHODS).map((method) => [method, backend[method].bind(backend)]));
    this.#verifyReceipt = verifyReceipt;
    this.#clock = clock;
    this.#deadlineMs = observation_timeout_ms;
  }

  async collect(type) {
    if (!LINUX_EVIDENCE_TYPES.includes(type)) throw new LinuxReceiptError("LINUX_EVIDENCE_TYPE_INVALID");
    // Expiry is checked before any private I/O, including observations.
    validateLinuxBinding(this.#binding, this.#clock.now());
    const abort = new AbortController();
    let timer;
    try {
      // One absolute budget covers both observation and authentication. Late
      // read-only results cannot produce evidence after timeout returns UNKNOWN.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new LinuxReceiptError("LINUX_OBSERVATION_TIMEOUT"));
        }, this.#deadlineMs);
      });
      const observation = (async () => {
        const receipt = await this.#backend[METHODS[type]](structuredClone(this.#binding), { signal: abort.signal });
        if (abort.signal.aborted) throw new LinuxReceiptError("LINUX_OBSERVATION_TIMEOUT");
        if (receipt?.type !== type) throw new LinuxReceiptError("LINUX_EVIDENCE_TYPE_MISMATCH");
        return validateLinuxReceipt(receipt, this.#binding, { verifyReceipt: this.#verifyReceipt, clock: this.#clock, signal: abort.signal });
      })();
      const evidence = await Promise.race([observation, deadline]);
      const ok = evidence.data.status === "PASS";
      return { ok, state: ok ? "OBSERVED" : "RECONCILE_REQUIRED", evidence };
    } catch (error) {
      // Never surface private transport errors, raw receipts or backend output.
      // Latest UNKNOWN must invalidate a previous PASS at the consumer seam.
      const reason = error instanceof LinuxReceiptError ? error.code : "LINUX_OBSERVATION_UNKNOWN";
      return {
        ok: false, state: "RECONCILE_REQUIRED", reason,
        evidence: {
          type, source: "ghostfleet-linux-adapter", at: new Date(this.#clock.now()).toISOString(),
          data: { status: "UNKNOWN", attempt_id: this.#binding.attempt_id, node_uid: this.#binding.node_uid, reason },
        },
      };
    } finally { clearTimeout(timer); }
  }
}
