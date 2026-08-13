import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { generateSchemaTypes } from "./generate-schema-types.mjs";
import {
  generateBrowserSchemaValidators,
  generateSchemaValidators,
} from "./generate-schema-validators.mjs";

const generatedEntries = [
  {
    description: "schema types",
    path: resolve("src/protocol/types.generated.ts"),
    expected: await generateSchemaTypes(),
  },
  {
    description: "standalone schema validators",
    path: resolve("src/protocol/schema.generated.ts"),
    expected: await generateSchemaValidators(),
  },
  {
    description: "browser companion schema validators",
    path: resolve("src/protocol/schema.browser.generated.ts"),
    expected: await generateBrowserSchemaValidators(),
  },
];

for (const entry of generatedEntries) {
  let actual;
  try {
    actual = await readFile(entry.path, "utf8");
  } catch {
    console.error(`generated ${entry.description} are missing`);
    process.exit(3);
  }
  if (actual !== entry.expected) {
    console.error(`generated ${entry.description} are stale`);
    process.exit(3);
  }
}

const defaultProbe = await build({
  bundle: true,
  format: "iife",
  metafile: true,
  minify: true,
  platform: "browser",
  sourcemap: false,
  stdin: {
    contents: [
      'import { computeReviewDigest, validateReviewDocument } from "./src/protocol/index.ts";',
      "globalThis.__DAR_PROTOCOL_PROBE__ = [validateReviewDocument, computeReviewDigest];",
    ].join("\n"),
    loader: "ts",
    resolveDir: process.cwd(),
    sourcefile: "protocol-browser-size-probe.ts",
  },
  target: "es2023",
  treeShaking: true,
  write: false,
});
const defaultProbeOutput = defaultProbe.outputFiles[0];
if (!defaultProbeOutput) {
  console.error("protocol browser size probe produced no output");
  process.exit(3);
}
const PROBE_LIMIT_BYTES = 235_520;
if (defaultProbeOutput.contents.byteLength > PROBE_LIMIT_BYTES) {
  console.error(
    `protocol browser size probe is ${defaultProbeOutput.contents.byteLength} bytes; limit is ${PROBE_LIMIT_BYTES}`,
  );
  process.exit(3);
}
const forbiddenProbeContributions = Object.values(defaultProbe.metafile.outputs).flatMap((output) =>
  Object.entries(output.inputs)
    .filter(
      ([path, contribution]) =>
        (path.includes("portable-path") || path.includes("unicode-case-folding"))
        && contribution.bytesInOutput > 0,
    )
    .map(([path, contribution]) => `${path}:${contribution.bytesInOutput}`),
);
const probeText = defaultProbeOutput.text;
if (
  forbiddenProbeContributions.length > 0
  || probeText.includes("new Map([[65,[97]],[66,[98]],[67,[99]]")
) {
  console.error(
    `protocol browser size probe includes portable Unicode path logic: ${forbiddenProbeContributions.join(", ")}`,
  );
  process.exit(3);
}

const {
  checkTrackedWorkbenchTemplate,
  createBrowserSchemaValidatorPlugin,
} = await import("./build-workbench.mjs");
const combinedProbe = await build({
  bundle: true,
  format: "iife",
  metafile: true,
  minify: true,
  platform: "browser",
  plugins: [createBrowserSchemaValidatorPlugin()],
  sourcemap: false,
  stdin: {
    contents: [
      "import {",
      "  validateReviewDocumentSchema,",
      "  validateReviewPacketSchema,",
      "  validateReviewStateSchema,",
      '} from "./src/protocol/index.ts";',
      "globalThis.__DAR_COMBINED_SCHEMA_PROBE__ = [",
      "  validateReviewDocumentSchema,",
      "  validateReviewPacketSchema,",
      "  validateReviewStateSchema,",
      "];",
    ].join("\n"),
    loader: "ts",
    resolveDir: process.cwd(),
    sourcefile: "protocol-combined-browser-size-probe.ts",
  },
  target: "es2023",
  treeShaking: true,
  write: false,
});
const combinedProbeOutput = combinedProbe.outputFiles[0];
if (!combinedProbeOutput) {
  console.error("combined protocol browser size probe produced no output");
  process.exit(3);
}
if (combinedProbeOutput.contents.byteLength > PROBE_LIMIT_BYTES) {
  console.error(
    `combined protocol browser size probe is ${combinedProbeOutput.contents.byteLength} bytes; limit is ${PROBE_LIMIT_BYTES}`,
  );
  process.exit(3);
}
const forbiddenCombinedRuntime = [
  ["runtime Ajv", /node_modules\/ajv\//u],
  ["runtime eval", /\beval\s*\(/u],
  ["runtime new Function", /\bnew\s+Function\b/u],
  ["runtime import", /\bimport\s*\(/u],
  ["network fetch", /\bfetch\s*\(/u],
  ["network XMLHttpRequest", /\bXMLHttpRequest\b/u],
  ["network WebSocket", /\bWebSocket\b/u],
  ["network sendBeacon", /\bsendBeacon\s*\(/u],
  ["network EventSource", /\bEventSource\b/u],
];
const combinedInputs = Object.values(combinedProbe.metafile.outputs).flatMap((output) =>
  Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([path]) => path),
).join("\n");
for (const [description, pattern] of forbiddenCombinedRuntime) {
  const inspected = `${combinedInputs}\n${combinedProbeOutput.text}`;
  if (pattern.test(inspected)) {
    console.error(`combined protocol browser probe contains ${description}`);
    process.exit(3);
  }
}

console.log(
  "generated schema types and standalone validators are current; "
    + `default browser probe ${defaultProbeOutput.contents.byteLength}/${PROBE_LIMIT_BYTES} bytes; `
    + `combined browser probe ${combinedProbeOutput.contents.byteLength}/${PROBE_LIMIT_BYTES} bytes`,
);

const workbenchBytes = await checkTrackedWorkbenchTemplate();
console.log(`generated review workbench template is current; shell ${workbenchBytes}/358400 bytes`);

const { checkTrackedCliBundle } = await import("./build-cli.mjs");
const cliBytes = await checkTrackedCliBundle();
console.log(`generated installed CLI bundle is current; bundle ${cliBytes} bytes`);
