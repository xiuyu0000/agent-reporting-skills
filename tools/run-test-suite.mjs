import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
function portableSelector(value) {
  return value.replaceAll("\\", "/");
}

export async function selectTestFiles(suite, selectors = []) {
  const suitePath = resolve(suite);
  let entries;
  try {
    entries = await readdir(suitePath, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && TEST_FILE_PATTERN.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (selectors.length === 0) return candidates;
  const portableSelectors = selectors.map(portableSelector);
  return candidates.filter((path) => {
    const localPath = relative(suitePath, path).split(sep).join("/");
    return portableSelectors.some((selector) => localPath.includes(selector));
  });
}

export function parseSuiteArguments(arguments_) {
  const [suite, ...rest] = arguments_;
  const optionBoundary = rest.findIndex((value) => value.startsWith("-"));
  const selectorArguments = optionBoundary === -1 ? rest : rest.slice(0, optionBoundary);
  const selectors = selectorArguments.map(portableSelector);
  const vitestOptions = optionBoundary === -1 ? [] : rest.slice(optionBoundary);
  return { suite, selectors, vitestOptions };
}

export function buildVitestArguments(files, vitestOptions) {
  return [resolve("node_modules/vitest/vitest.mjs"), "run", ...files, ...vitestOptions];
}

async function main() {
  let parsed;
  try {
    parsed = parseSuiteArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const { suite, selectors, vitestOptions } = parsed;
  if (!suite) {
    console.error("usage: run-test-suite.mjs <suite-directory> [...file-selectors] [...vitest-options]");
    process.exitCode = 2;
    return;
  }

  const files = await selectTestFiles(suite, selectors);
  if (files.length === 0) {
    const suffix = selectors.length === 0 ? "" : ` (${selectors.join(",")})`;
    console.error(`component not implemented: ${suite}${suffix}`);
    process.exitCode = 3;
    return;
  }

  const result = spawnSync(
    process.execPath,
    // Keep concrete files before forwarded options. Some Vitest flags accept an
    // optional value (for example `-u` / `--update`); putting an explicit file
    // after such a flag lets the option parser consume that file as its value.
    buildVitestArguments(files, vitestOptions),
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 70;
    return;
  }

  process.exitCode = result.status ?? 70;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
