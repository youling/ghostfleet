import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalStringify } from "../util.js";

export function createSyntheticSigner(key = "synthetic-privilege-broker-test-key") {
  const material = Buffer.from(String(key));
  return Object.freeze({
    isProduction: false,
    signer_ref: "synthetic-signer",
    sign(payload) {
      return createHmac("sha256", material).update(canonicalStringify(payload)).digest("hex");
    },
    verify(payload, signature) {
      const expected = Buffer.from(this.sign(payload), "utf8");
      const actual = Buffer.from(String(signature ?? ""), "utf8");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  });
}
