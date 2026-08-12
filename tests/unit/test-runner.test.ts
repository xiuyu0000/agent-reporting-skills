import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

interface RunnerModule {
  buildVitestArguments(files: string[], vitestOptions: string[]): string[];
  parseSuiteArguments(arguments_: string[]): {
    suite: string | undefined;
    selectors: string[];
    vitestOptions: string[];
  };
  selectTestFiles(suite: string, selectors?: string[]): Promise<string[]>;
}

// The executable tool remains plain ESM; this local contract keeps the product
// TypeScript graph independent from build-tool implementation details.
// @ts-expect-error The runtime .mjs tool intentionally has no published TS declarations.
const { buildVitestArguments, parseSuiteArguments, selectTestFiles } = (await import("../../tools/run-test-suite.mjs")) as RunnerModule;

const temporaryDirectories: string[] = [];

async function fixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "test-runner-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "nested"));
  await Promise.all([
    writeFile(join(root, "usage.test.ts"), ""),
    writeFile(join(root, "unrelated.test.ts"), ""),
    writeFile(join(root, "nested", "usage-e2e.test.ts"), ""),
    writeFile(join(root, "nested", "browser.spec.ts"), ""),
    writeFile(join(root, "notes.ts"), ""),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});
describe("test suite runner selection", () => {
  it("keeps every selected file inside the requested suite", async () => {
    const root = await fixtureTree();
    const files = await selectTestFiles(root, ["usage"]);
    expect(files.map((path) => relative(root, path).split(sep).join("/"))).toEqual([
      "nested/usage-e2e.test.ts",
      "usage.test.ts",
    ]);
    expect(files.every((path) => {
      const localPath = relative(root, path);
      return localPath !== "" && !localPath.startsWith(`..${sep}`) && localPath !== "..";
    })).toBe(true);
    expect(await selectTestFiles(root, ["nested\\usage"])).toEqual([files[0]]);
  });

  it("runs all supported test suffixes without selectors and ignores ordinary source files", async () => {
    const root = await fixtureTree();
    const files = await selectTestFiles(root);
    expect(files.map((path) => relative(root, path).split(sep).join("/"))).toEqual([
      "nested/browser.spec.ts",
      "nested/usage-e2e.test.ts",
      "unrelated.test.ts",
      "usage.test.ts",
    ]);
  });

  it("returns an empty selection when the suite or requested component does not exist", async () => {
    const root = await fixtureTree();
    expect(await selectTestFiles(join(root, "missing"))).toEqual([]);
    expect(await selectTestFiles(root, ["contracts"])).toEqual([]);
  });

  it("separates leading selectors and forwards every Vitest option verbatim", () => {
    expect(parseSuiteArguments([
      "tests",
      "record-usage",
      "--coverage",
      "--reporter",
      "verbose",
      "-t",
      "privacy",
    ])).toEqual({
      suite: "tests",
      selectors: ["record-usage"],
      vitestOptions: ["--coverage", "--reporter", "verbose", "-t", "privacy"],
    });
    expect(parseSuiteArguments(["tests", "nested\\usage", "--reporter=verbose"])).toEqual({
      suite: "tests",
      selectors: ["nested/usage"],
      vitestOptions: ["--reporter=verbose"],
    });
    expect(parseSuiteArguments([
      "tests",
      "--no-isolate",
      "--fileParallelism",
      "-u",
      "--update",
      "all",
      "--detectAsyncLeaks",
    ])).toEqual({
      suite: "tests",
      selectors: [],
      vitestOptions: [
        "--no-isolate",
        "--fileParallelism",
        "-u",
        "--update",
        "all",
        "--detectAsyncLeaks",
      ],
    });
    expect(parseSuiteArguments(["tests", "public-tree", "--reporter"])).toEqual({
      suite: "tests",
      selectors: ["public-tree"],
      vitestOptions: ["--reporter"],
    });
    const arguments_ = buildVitestArguments(
      ["/suite/one.test.ts", "/suite/two.test.ts"],
      ["-u"],
    );
    expect(arguments_.slice(-3)).toEqual([
      "/suite/one.test.ts",
      "/suite/two.test.ts",
      "-u",
    ]);
  });
});
