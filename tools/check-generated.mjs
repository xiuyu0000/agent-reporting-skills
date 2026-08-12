import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { generateSchemaTypes } from "./generate-schema-types.mjs";
import { generateSchemaValidators } from "./generate-schema-validators.mjs";

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

const probe = await build({
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
const probeOutput = probe.outputFiles[0];
if (!probeOutput) {
  console.error("protocol browser size probe produced no output");
  process.exit(3);
}
const PROBE_LIMIT_BYTES = 235_520;
if (probeOutput.contents.byteLength > PROBE_LIMIT_BYTES) {
  console.error(
    `protocol browser size probe is ${probeOutput.contents.byteLength} bytes; limit is ${PROBE_LIMIT_BYTES}`,
  );
  process.exit(3);
}
const forbiddenProbeContributions = Object.values(probe.metafile.outputs).flatMap((output) =>
  Object.entries(output.inputs)
    .filter(
      ([path, contribution]) =>
        (path.includes("portable-path") || path.includes("unicode-case-folding"))
        && contribution.bytesInOutput > 0,
    )
    .map(([path, contribution]) => `${path}:${contribution.bytesInOutput}`),
);
const probeText = probeOutput.text;
if (
  forbiddenProbeContributions.length > 0
  || probeText.includes("new Map([[65,[97]],[66,[98]],[67,[99]]")
) {
  console.error(
    `protocol browser size probe includes portable Unicode path logic: ${forbiddenProbeContributions.join(", ")}`,
  );
  process.exit(3);
}

console.log(
  `generated schema types and standalone validators are current; browser probe ${probeOutput.contents.byteLength}/${PROBE_LIMIT_BYTES} bytes`,
);
