import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "src/protocol/types.generated.ts");

const schemaEntries = [
  {
    namespace: "ReviewDocumentSchema",
    path: "skills/deliver-dual-audience-report/references/review-document.schema.json",
    rootType: "ReviewDocumentV1",
  },
  {
    namespace: "ReviewPacketSchema",
    path: "skills/deliver-dual-audience-report/references/review-packet.schema.json",
    rootType: "ReviewPacketV1",
  },
  {
    namespace: "ReviewStateSchema",
    path: "skills/deliver-dual-audience-report/references/review-state.schema.json",
    rootType: "ReviewStateV1",
  },
];

function indent(source) {
  return source
    .trim()
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");
}

export async function generateSchemaTypes() {
  const sections = [];

  for (const entry of schemaEntries) {
    const generated = await compileFromFile(resolve(repoRoot, entry.path), {
      additionalProperties: false,
      bannerComment: "",
      cwd: repoRoot,
      declareExternallyReferenced: true,
      enableConstEnums: false,
      format: true,
      ignoreMinAndMaxItems: true,
      strictIndexSignatures: true,
      style: {
        bracketSpacing: true,
        printWidth: 100,
        semi: true,
        singleQuote: false,
        tabWidth: 2,
        trailingComma: "all",
        useTabs: false,
      },
      unknownAny: true,
      unreachableDefinitions: false,
    });
    sections.push(`export namespace ${entry.namespace} {\n${indent(generated)}\n}`);
  }

  const aliases = schemaEntries
    .map(
      (entry) =>
        `export type ${entry.rootType} = ${entry.namespace}.${entry.rootType};`,
    )
    .join("\n");

  return [
    "/* eslint-disable */",
    "/**",
    " * Generated from the public review JSON Schemas.",
    " * Do not edit by hand; run `npm run schema:types`.",
    " */",
    "",
    sections.join("\n\n"),
    "",
    aliases,
    "",
  ].join("\n");
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const generated = await generateSchemaTypes();

  if (checkOnly) {
    let existing;
    try {
      existing = await readFile(outputPath, "utf8");
    } catch {
      console.error("generated schema types are missing");
      process.exit(3);
    }
    if (existing !== generated) {
      console.error("generated schema types are stale");
      process.exit(3);
    }
    console.log("generated schema types are current");
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log("generated src/protocol/types.generated.ts");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
