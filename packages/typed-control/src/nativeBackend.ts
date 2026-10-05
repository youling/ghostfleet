import type { OperationDependencies } from "./operations.js";

/** Explicit authenticated native adapter injection; this factory performs no I/O. */
export function createNativeBackend(backend: OperationDependencies): OperationDependencies {
  if (!backend || typeof backend.connect !== "function" || typeof backend.execute !== "function") {
    throw new Error("CONTROL_BACKEND_NOT_CONFIGURED");
  }
  return Object.freeze({ connect: backend.connect.bind(backend), execute: backend.execute.bind(backend) });
}
