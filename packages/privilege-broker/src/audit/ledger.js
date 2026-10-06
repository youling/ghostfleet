import { sha256, deepFreeze } from "../util.js";

export function createAuditLedger() {
  const entries = [];
  return Object.freeze({
    append(record) {
      const previous_hash = entries.at(-1)?.entry_hash ?? null;
      const entry = deepFreeze({
        sequence: entries.length + 1,
        previous_hash,
        record,
        entry_hash: sha256({ sequence:entries.length + 1, previous_hash, record }),
      });
      entries.push(entry);
      return entry;
    },
    list() { return entries.slice(); },
  });
}
