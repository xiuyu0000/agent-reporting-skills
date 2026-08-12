#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_IDS = Array.from({ length: 22 }, (_, index) =>
  `A${String(index + 1).padStart(2, "0")}`,
);

export class CoverageMapError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageMapError";
  }
}

async function collectTestFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function parseCoverageMap(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CoverageMapError(`${source}: invalid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoverageMapError(`${source}: root must be an object`);
  }
  if (parsed.format !== "acceptance-coverage/1") {
    throw new CoverageMapError(`${source}: format must be acceptance-coverage/1`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new CoverageMapError(`${source}: cases must be an array`);
  }
  return parsed;
}

export async function validateAcceptanceCoverage({ mapPath, testsRoot }) {
  const coverageMap = parseCoverageMap(await readFile(mapPath, "utf8"), mapPath);
  const ids = new Set();
  const testIds = new Set();

  for (const [index, item] of coverageMap.cases.entries()) {
    const location = `${mapPath}#/cases/${index}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CoverageMapError(`${location}: case must be an object`);
    }
    if (typeof item.id !== "string" || !/^A(?:0[1-9]|1[0-9]|2[0-2])$/.test(item.id)) {
      throw new CoverageMapError(`${location}/id: expected A01 through A22`);
    }
    if (ids.has(item.id)) {
      throw new CoverageMapError(`${location}/id: duplicate ${item.id}`);
    }
    ids.add(item.id);

    if (typeof item.primaryTask !== "string" || item.primaryTask.trim() === "") {
      throw new CoverageMapError(`${location}/primaryTask: exactly one non-empty task is required`);
    }
    if (typeof item.testId !== "string" || item.testId.trim() === "") {
      throw new CoverageMapError(`${location}/testId: exactly one non-empty test ID is required`);
    }
    if (!item.testId.startsWith(`${item.id}_`)) {
      throw new CoverageMapError(`${location}/testId: must begin with ${item.id}_`);
    }
    if (testIds.has(item.testId)) {
      throw new CoverageMapError(`${location}/testId: duplicate ${item.testId}`);
    }
    testIds.add(item.testId);
  }

  const missing = EXPECTED_IDS.filter((id) => !ids.has(id));
  if (missing.length > 0 || ids.size !== EXPECTED_IDS.length) {
    throw new CoverageMapError(
      `${mapPath}: expected A01-A22 exactly once; missing=${missing.join(",") || "none"}`,
    );
  }

  const testFiles = await collectTestFiles(testsRoot);
  const searchable = (
    await Promise.all(testFiles.map(async (path) => ({ path, text: await readFile(path, "utf8") })))
  );
  for (const testId of testIds) {
    if (!searchable.some(({ text }) => text.includes(testId))) {
      throw new CoverageMapError(`${mapPath}: testId ${testId} is not discoverable under ${testsRoot}`);
    }
  }

  return { acceptanceIds: ids.size, testIds: testIds.size, testFiles: testFiles.length };
}

function buildCases() {
  return EXPECTED_IDS.map((id) => ({
    id,
    primaryTask: id === "A01" ? "GEN-001" : "INT-001",
    testId: `${id}_self_test_proof`,
  }));
}

async function expectFailure(options, expectedFragment) {
  try {
    await validateAcceptanceCoverage(options);
  } catch (error) {
    if (error instanceof CoverageMapError && error.message.includes(expectedFragment)) return;
    throw error;
  }
  throw new Error(`self-test expected failure containing: ${expectedFragment}`);
}

async function runSelfTest() {
  const root = await mkdtemp(join(tmpdir(), "acceptance-coverage-"));
  const mapPath = join(root, "coverage-map.json");
  const testsRoot = join(root, "tests");
  const testPath = join(testsRoot, "proof.test.ts");
  try {
    await mkdir(testsRoot, { recursive: true });
    const cases = buildCases();
    await writeFile(mapPath, `${JSON.stringify({ format: "acceptance-coverage/1", cases })}\n`);
    await writeFile(testPath, `${cases.map(({ testId }) => testId).join("\n")}\n`);
    const result = await validateAcceptanceCoverage({ mapPath, testsRoot });
    if (result.acceptanceIds !== 22 || result.testIds !== 22) {
      throw new Error("self-test valid case returned the wrong counts");
    }

    await writeFile(
      mapPath,
      `${JSON.stringify({ format: "acceptance-coverage/1", cases: cases.slice(1) })}\n`,
    );
    await expectFailure({ mapPath, testsRoot }, "missing=A01");

    const duplicateId = cases.map((item) => ({ ...item }));
    duplicateId[1].id = "A01";
    await writeFile(mapPath, `${JSON.stringify({ format: "acceptance-coverage/1", cases: duplicateId })}\n`);
    await expectFailure({ mapPath, testsRoot }, "duplicate A01");

    const mismatchedTestId = cases.map((item) => ({ ...item }));
    mismatchedTestId[1].testId = "A03_wrong_acceptance_case";
    await writeFile(
      mapPath,
      `${JSON.stringify({ format: "acceptance-coverage/1", cases: mismatchedTestId })}\n`,
    );
    await expectFailure({ mapPath, testsRoot }, "must begin with A02_");

    await writeFile(mapPath, `${JSON.stringify({ format: "acceptance-coverage/1", cases })}\n`);
    await writeFile(testPath, "A01_self_test_proof\n");
    await expectFailure({ mapPath, testsRoot }, "A02_self_test_proof is not discoverable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const config = (await import(pathToFileURL(resolve("vitest.config.ts")).href)).default;
  const thresholds = config?.test?.coverage?.thresholds;
  const expectedThresholds = { branches: 85, functions: 90, lines: 90, statements: 90 };
  if (JSON.stringify(thresholds) !== JSON.stringify(expectedThresholds)) {
    throw new Error(
      `coverage thresholds drifted: expected ${JSON.stringify(expectedThresholds)}, got ${JSON.stringify(thresholds)}`,
    );
  }

  const coverageRoot = await mkdtemp(join(tmpdir(), "coverage-threshold-"));
  try {
    const sourcePath = join(coverageRoot, "branch.ts");
    const testPath = join(coverageRoot, "branch.test.ts");
    const configPath = join(coverageRoot, "vitest.config.mjs");
    await writeFile(
      sourcePath,
      "export function branch(value: boolean): string { return value ? 'yes' : 'no'; }\n",
    );
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        root: coverageRoot,
        test: {
          coverage: {
            enabled: true,
            include: [sourcePath],
            provider: "v8",
            reporter: ["text-summary"],
            reportsDirectory: join(coverageRoot, "coverage"),
            thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
          },
          include: [testPath],
        },
      })};\n`,
    );

    const runCoverage = () =>
      spawnSync(
        process.execPath,
        [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", configPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );

    await writeFile(
      testPath,
      "import { expect, test } from 'vitest';\nimport { branch } from './branch.ts';\n"
        + "test('covers both branches', () => { expect(branch(true)).toBe('yes'); expect(branch(false)).toBe('no'); });\n",
    );
    const positive = runCoverage();
    if (positive.status !== 0) {
      throw new Error(`coverage positive self-test failed (rc=${positive.status})`);
    }

    await writeFile(
      testPath,
      "import { expect, test } from 'vitest';\nimport { branch } from './branch.ts';\n"
        + "test('leaves one branch uncovered', () => { expect(branch(true)).toBe('yes'); });\n",
    );
    const negative = runCoverage();
    if (negative.status === 0 || !`${negative.stdout}\n${negative.stderr}`.includes("Coverage for branches")) {
      throw new Error("coverage negative self-test did not fail the branch threshold");
    }
  } finally {
    await rm(coverageRoot, { recursive: true, force: true });
  }
  console.log("acceptance coverage checker self-test: passed");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const mapPath = resolve("tests/acceptance/coverage-map.json");
  const testsRoot = resolve("tests");
  try {
    const result = await validateAcceptanceCoverage({ mapPath, testsRoot });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      console.error(`component not implemented: ${relative(process.cwd(), mapPath)}`);
      process.exitCode = 3;
      return;
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CoverageMapError ? 1 : 70;
  });
}
