import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const out = resolve("dist/console");
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "assets"), { recursive: true });
await mkdir(resolve(out, "third-party"), { recursive: true });
await cp(resolve("console/index.html"), resolve(out, "index.html"));
await cp(resolve("console/app.js"), resolve(out, "app.js"));
await cp(resolve("node_modules/@tabler/core/dist/css/tabler.min.css"), resolve(out, "assets/tabler.min.css"));
await cp(resolve("node_modules/@tabler/core/dist/js/tabler.min.js"), resolve(out, "assets/tabler.min.js"));
await cp(resolve("THIRD_PARTY_NOTICES.md"), resolve(out, "third-party/THIRD_PARTY_NOTICES.md"));
await cp(resolve("Tabler-LICENSE.txt"), resolve(out, "third-party/Tabler-LICENSE.txt"));
await cp(resolve("LICENSE"), resolve(out, "third-party/GhostFleet-LICENSE.txt"));
await cp(resolve("node_modules/@modelcontextprotocol/sdk/LICENSE"), resolve(out, "third-party/MCP-SDK-LICENSE.txt"));
console.log("GhostFleet Console built at dist/console");
