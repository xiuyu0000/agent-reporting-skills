import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [suite, ...filters] = process.argv.slice(2);
if (!suite) {
  console.error("usage: run-test-suite.mjs <suite-directory> [...filters]");
  process.exit(2);
}

const suitePath = resolve(suite);
let entries;
try {
  entries = await readdir(suitePath, { recursive: true });
} catch {
  console.error(`component not implemented: ${suite}`);
  process.exit(3);
}

if (!entries.some((entry) => /\.test\.[cm]?[jt]sx?$/.test(entry))) {
  console.error(`component not implemented: ${suite}`);
  process.exit(3);
}

const result = spawnSync(
  process.execPath,
  [resolve("node_modules/vitest/vitest.mjs"), "run", suite, ...filters],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(70);
}

process.exit(result.status ?? 70);
