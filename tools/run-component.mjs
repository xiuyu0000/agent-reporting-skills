import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [componentPath, ...componentArgs] = process.argv.slice(2);

if (!componentPath) {
  console.error("usage: run-component.mjs <module> [...args]");
  process.exit(2);
}

const resolved = resolve(componentPath);
try {
  await access(resolved);
} catch {
  console.error(`component not implemented: ${componentPath}`);
  process.exit(3);
}

process.argv = [process.argv[0], resolved, ...componentArgs];
await import(pathToFileURL(resolved).href);
