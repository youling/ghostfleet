import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const out = resolve("dist/console");
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "assets"), { recursive: true });
await cp(resolve("console/index.html"), resolve(out, "index.html"));
await cp(resolve("console/app.js"), resolve(out, "app.js"));
await cp(resolve("node_modules/@tabler/core/dist/css/tabler.min.css"), resolve(out, "assets/tabler.min.css"));
await cp(resolve("node_modules/@tabler/core/dist/js/tabler.min.js"), resolve(out, "assets/tabler.min.js"));
console.log("GhostFleet Console built at dist/console");
