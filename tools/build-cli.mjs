import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { build } from "esbuild";

export const CLI_ENTRY = resolve("src/cli/main.ts");
export const CLI_BUILD_PATH = resolve("build/review-delivery.mjs");
export const CLI_BUILD_MAP_PATH = resolve("build/review-delivery.mjs.map");
export const CLI_DISTRIBUTION_PATH = resolve(
  "skills/deliver-dual-audience-report/scripts/review-delivery.mjs",
);

const CLI_ESBUILD_OPTIONS = Object.freeze({
  bundle: true,
  charset: "utf8",
  format: "esm",
  legalComments: "none",
  minify: true,
  platform: "node",
  preserveSymlinks: true,
  sourcemap: false,
  target: ["node24"],
  treeShaking: true,
  write: false,
});
const CLI_ENTRY_STDIN = Object.freeze({
  contents: 'import { main } from "./src/cli/main.ts";\nawait main();\n',
  loader: "ts",
  resolveDir: process.cwd(),
  sourcefile: "installed-cli-entry.ts",
});
const CLI_LOADER_HARNESS_STDIN = Object.freeze({
  contents: [
    'import { executeCli } from "./src/cli/main.ts";',
    'const [probe, ...argv] = process.argv.slice(2);',
    'const sentinel = "private-loader-probe-sentinel";',
    'const loadApprovalTemplateBytes = probe === "sync"',
    '  ? () => { throw new Error(sentinel); }',
    '  : () => Promise.reject(new Error(sentinel));',
    'const execution = await executeCli(argv, { loadApprovalTemplateBytes });',
    'process.stdout.write(execution.stdout);',
    'process.stderr.write(execution.stderr);',
    'process.exitCode = execution.exitCode;',
    '',
  ].join("\n"),
  loader: "ts",
  resolveDir: process.cwd(),
  sourcefile: "installed-cli-loader-harness.ts",
});

const BUNDLED_DEPENDENCY_PATTERN = /^(@noble\/hashes|string-width|json-canonicalize|unicode-case-folding|get-east-asian-width|strip-ansi|ansi-regex)(\/|$)/;
const DISTRIBUTION_CREDENTIAL_FALSE_POSITIVE = "password:!0";
const DISTRIBUTION_CREDENTIAL_REPLACEMENT = '["password"]:!0';
const EXPECTED_DISTRIBUTION_CREDENTIAL_REPLACEMENTS = 2;

function dependencyRootPlugin(dependencyRoot) {
  const resolver = createRequire(resolve(dependencyRoot, "..", "dar-cli-dependency-resolver.cjs"));
  return {
    name: "cli-physical-dependency-root",
    setup(buildContext) {
      buildContext.onResolve({ filter: BUNDLED_DEPENDENCY_PATTERN }, (args) => ({
        path: resolver.resolve(args.path),
      }));
    },
  };
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sanitizeDistributionBundle(contents) {
  const source = new TextDecoder().decode(contents);
  const matches = source.split(DISTRIBUTION_CREDENTIAL_FALSE_POSITIVE).length - 1;
  if (matches !== EXPECTED_DISTRIBUTION_CREDENTIAL_REPLACEMENTS) {
    throw new Error(
      `installed CLI credential-token drift: expected ${EXPECTED_DISTRIBUTION_CREDENTIAL_REPLACEMENTS}, found ${matches}`,
    );
  }
  return new TextEncoder().encode(source.replaceAll(
    DISTRIBUTION_CREDENTIAL_FALSE_POSITIVE,
    DISTRIBUTION_CREDENTIAL_REPLACEMENT,
  ));
}

export async function buildCliBundle(options = {}) {
  const dependencyRoot = options.dependencyRoot;
  const result = await build({
    ...CLI_ESBUILD_OPTIONS,
    ...(dependencyRoot === undefined ? {} : { plugins: [dependencyRootPlugin(dependencyRoot)] }),
    stdin: CLI_ENTRY_STDIN,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("CLI bundle was not produced");
  return sanitizeDistributionBundle(output.contents);
}

// Test-only: exercises the installed bundle boundary with a controllable loader failure.
export async function buildCliLoaderHarness() {
  const result = await build({
    ...CLI_ESBUILD_OPTIONS,
    stdin: CLI_LOADER_HARNESS_STDIN,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("CLI loader harness was not produced");
  return output.contents;
}

export async function buildDevelopmentCliBundle() {
  const result = await build({
    ...CLI_ESBUILD_OPTIONS,
    minify: false,
    outfile: CLI_BUILD_PATH,
    sourcemap: "linked",
    stdin: CLI_ENTRY_STDIN,
  });
  const javascript = result.outputFiles.find((file) => !file.path.endsWith(".map"));
  const sourceMap = result.outputFiles.find((file) => file.path.endsWith(".map"));
  if (!javascript || !sourceMap) throw new Error("development CLI bundle or source map was not produced");
  return {
    javascript: javascript.contents,
    sourceMap: sourceMap.contents,
  };
}

export async function writeCliArtifacts() {
  const [contents, development] = await Promise.all([
    buildCliBundle(),
    buildDevelopmentCliBundle(),
  ]);
  await Promise.all([
    atomicWrite(CLI_BUILD_PATH, development.javascript),
    atomicWrite(CLI_BUILD_MAP_PATH, development.sourceMap),
    atomicWrite(CLI_DISTRIBUTION_PATH, contents),
  ]);
  return contents.byteLength;
}

export async function checkTrackedCliBundle() {
  const expected = await buildCliBundle();
  let actual;
  try {
    actual = await readFile(CLI_DISTRIBUTION_PATH);
  } catch {
    throw new Error("generated installed CLI bundle is missing");
  }
  if (!actual.equals(expected)) throw new Error("generated installed CLI bundle is stale");
  return expected.byteLength;
}
