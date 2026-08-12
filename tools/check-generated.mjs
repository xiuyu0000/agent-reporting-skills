import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateSchemaTypes } from "./generate-schema-types.mjs";

const generatedPath = resolve("src/protocol/types.generated.ts");
const expected = await generateSchemaTypes();

let actual;
try {
  actual = await readFile(generatedPath, "utf8");
} catch {
  console.error("generated schema types are missing; run npm run schema:types");
  process.exit(3);
}

if (actual !== expected) {
  console.error("generated schema types are stale; run npm run schema:types");
  process.exit(3);
}

console.log("generated schema types are current");
