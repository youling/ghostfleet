import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

try {
  await writeFile(".dev.vars", [
    `GHOSTFLEET_OPERATOR_TOKEN=${randomBytes(32).toString("hex")}`,
    `GHOSTFLEET_READ_TOKEN=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  console.log("Created ignored local credentials in .dev.vars; no values printed.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing .dev.vars preserved.");
}
