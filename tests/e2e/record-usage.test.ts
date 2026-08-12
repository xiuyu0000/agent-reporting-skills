import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("src/cli/record-usage-entry.mjs");
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(resolve(".test-temporary-e2e-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(home: string, arguments_: string[]): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", entry, ...arguments_], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function metrics(sequence: number): Record<string, unknown> {
  return {
    eligible: true,
    triggered: true,
    correct: true,
    validation: "passed",
    result: "success",
    corrections: 0,
    interruptions: 0,
    caseKey: `e2e_opaque_case_${String(sequence).padStart(4, "0")}`,
    sampleSequence: sequence,
    t0T1DecidedCount: 5,
    t0T1ActiveReviewMs: 25_000,
    totalActiveReviewMs: 600_000,
    sourceRevisionRounds: 1,
    closedLoop: true,
    burdenScore: -1,
  };
}

describe("record-usage command boundary", () => {
  it("appends safely across concurrent processes and summarizes without case identity", async () => {
    const home = await makeTemporaryDirectory();
    const inputDirectory = await makeTemporaryDirectory();
    const inputs = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const path = join(inputDirectory, `metrics-${index + 1}.json`);
        await writeFile(path, JSON.stringify(metrics(index + 1)));
        return path;
      }),
    );
    const appendResults = await Promise.all(inputs.map(async (input) => run(home, ["append", "--input", input])));
    for (const result of appendResults) {
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({ status: "recorded" });
    }

    const recordPath = join(home, ".codex", "state", "deliver-dual-audience-report", "usage", "usage.jsonl");
    const lines = (await readFile(recordPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(3);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);

    const summaryResult = await run(home, ["summarize", "--min-samples", "3", "--max-samples", "5"]);
    expect(summaryResult).toMatchObject({ code: 0, stderr: "" });
    const summary = JSON.parse(summaryResult.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({ status: "summarized", conclusion: "通过", sampleCount: 3 });
    expect(summaryResult.stdout).not.toMatch(/CASE-[A-F0-9]{32}/u);
    expect(summaryResult.stdout).not.toContain("e2e_opaque_case");
  });

  it("keeps a forced write failure non-blocking and does not echo path or input content", async () => {
    const root = await makeTemporaryDirectory();
    const badHome = join(root, "customer-secret-home");
    const input = join(root, "confidential-project.json");
    const sensitiveMarker = ["private", "customer", "title"].join("-");
    await writeFile(badHome, "not a directory");
    await writeFile(input, JSON.stringify({ ...metrics(1), caseKey: `opaque_${sensitiveMarker.replaceAll("-", "_")}` }));
    const result = await run(badHome, ["append", "--input", input]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect(`${result.stdout}${result.stderr}`).not.toContain(badHome);
    expect(`${result.stdout}${result.stderr}`).not.toContain(input);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sensitiveMarker);
  });

  it("returns 尚未验证 for fewer than three compliant samples", async () => {
    const home = await makeTemporaryDirectory();
    const input = join(await makeTemporaryDirectory(), "metrics.json");
    await writeFile(input, JSON.stringify(metrics(1)));
    expect((await run(home, ["append", "--input", input])).code).toBe(0);
    const result = await run(home, ["summarize"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "summarized", conclusion: "尚未验证", sampleCount: 1 });
  });

  it("recovers across processes from a crash before canonical lock manifest publication", async () => {
    const home = await makeTemporaryDirectory();
    const input = join(await makeTemporaryDirectory(), "metrics.json");
    await writeFile(input, JSON.stringify(metrics(1)));
    const stateDirectory = join(home, ".codex", "state", "deliver-dual-audience-report", "usage");
    await mkdir(join(stateDirectory, ".usage-append.lock"), { recursive: true, mode: 0o700 });

    expect(JSON.parse((await run(home, ["append", "--input", input])).stdout)).toEqual({ status: "recorded" });
    expect(JSON.parse((await run(home, ["append", "--input", input])).stdout)).toEqual({ status: "recorded" });
    const lines = (await readFile(join(stateDirectory, "usage.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
