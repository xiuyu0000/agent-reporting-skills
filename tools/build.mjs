import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { assertSupportedNode } from "../tests/helpers/runtime.ts";
import { writeCliArtifacts } from "./build-cli.mjs";
import {
  writeWorkbenchArtifacts,
} from "./build-workbench.mjs";

assertSupportedNode();

const args = new Set(process.argv.slice(2));
if (args.has("--infrastructure-only")) {
  console.log("infrastructure build passed");
  process.exit(0);
}

const cliEntry = resolve("src/cli/main.ts");
const workbenchEntry = resolve("src/workbench/main.ts");

try {
  await Promise.all([access(cliEntry), access(workbenchEntry)]);
} catch {
  console.error("component not implemented: src/cli/main.ts and src/workbench/main.ts are required");
  process.exit(3);
}

await mkdir("build", { recursive: true });
await Promise.all([writeCliArtifacts(), writeWorkbenchArtifacts()]);
