import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewPacketV1 } from "../../src/protocol/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-legacy-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function run(entry: string, cwd: string, arguments_: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(process.execPath, [entry, ...arguments_], {
      cwd,
      env,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("legacy interface hard cut", () => {
  it("removes every old runtime resource while preserving the dedicated legacy-contract diagnostic", async () => {
    const root = await temporaryDirectory("static-contract");
    const skill = join(root, "skill");
    const cwd = join(root, "cwd");
    const { mkdir } = await import("node:fs/promises");
    await cp(resolve("skills/deliver-dual-audience-report"), skill, { recursive: true });
    await mkdir(cwd, { mode: 0o700 });
    for (const relativePath of [
      "scripts/init_delivery.py",
      "scripts/validate_delivery.py",
      "scripts/record_usage.py",
      "assets/agent-report.template.md",
      "assets/human-report.template.html",
      "references/report-contract.schema.json",
    ]) {
      await expect(readFile(join(skill, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const contract = join(root, "legacy-report-contract.json");
    await writePrivate(contract, `${JSON.stringify({ schema_version: "dual-audience-report-contract-v1" })}\n`);
    const result = await run(join(skill, "scripts", "review-delivery.mjs"), cwd, [
      "validate", "delivery", "--document", contract,
    ]);
    expect(result).toMatchObject({ code: 3, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      phase: "validate",
      mutated: false,
      errors: [{ code: "LEGACY_CONTRACT_INCOMPATIBLE", path: "/format" }],
    });
  });

  it("gives render the same exact legacy diagnostic as every other document reader", async () => {
    // Spec §10.5: an old static contract must be reported as incompatible, not
    // answered with generic schema errors that read like an ordinary bad file.
    const root = await temporaryDirectory("static-contract-render");
    const skill = join(root, "skill");
    const cwd = join(root, "cwd");
    const { mkdir } = await import("node:fs/promises");
    await cp(resolve("skills/deliver-dual-audience-report"), skill, { recursive: true });
    await mkdir(cwd, { mode: 0o700 });
    const entry = join(skill, "scripts", "review-delivery.mjs");

    for (const legacy of [
      { schema_version: "dual-audience-report-contract-v1", title: "Old report", sections: [] },
      { format: "dual-audience-report-contract-v1" },
    ]) {
      const contract = join(root, `legacy-${Object.keys(legacy)[0]}.json`);
      await writePrivate(contract, `${JSON.stringify(legacy)}\n`);
      const rendered = await run(entry, cwd, ["render", "--document", contract]);

      expect(rendered, JSON.stringify(legacy)).toMatchObject({ code: 3, stderr: "" });
      const parsed = JSON.parse(rendered.stdout);
      expect(parsed, JSON.stringify(legacy)).toMatchObject({
        status: "failed",
        mutated: false,
        errors: [{ code: "LEGACY_CONTRACT_INCOMPATIBLE", path: "/format" }],
      });
      // Exactly one error: the generic schema pile must not leak alongside it.
      expect(parsed.errors, JSON.stringify(legacy)).toHaveLength(1);
    }
  });

  it("normalizes explicit prototype actions without requiring the Approval asset", async () => {
    const root = await temporaryDirectory("prototype-actions");
    const skill = join(root, "skill");
    const cwd = join(root, "cwd");
    const input = join(root, "input");
    const { mkdir } = await import("node:fs/promises");
    await cp(resolve("skills/deliver-dual-audience-report"), skill, { recursive: true });
    await Promise.all([cwd, input].map(async (path) => mkdir(path, { mode: 0o700 })));
    await unlink(join(skill, "assets", "review-workbench.template.html"));
    const documentPath = join(input, "review-document.json");
    const packetPath = join(input, "legacy-packet.json");
    const documentText = await readFile(resolve("tests/fixtures/protocol/review-document.json"), "utf8");
    const packet = JSON.parse(await readFile(
      resolve("tests/fixtures/protocol/review-packet.json"),
      "utf8",
    )) as ReviewPacketV1;
    const legacy = structuredClone(packet) as unknown as Record<string, unknown>;
    const decisions = legacy.decisions as Array<Record<string, unknown>>;
    decisions[0]!.action = "TRIM";
    decisions[0]!.note = "Remove redundant detail.";
    decisions[1]!.action = "EXPAND";
    decisions[1]!.note = "Add one example.";
    legacy.stats = { TRIM: 1, EXPAND: 1 };
    await writePrivate(documentPath, documentText);
    await writePrivate(packetPath, `${JSON.stringify(legacy)}\n`);

    const result = await run(join(skill, "scripts", "review-delivery.mjs"), cwd, [
      "validate", "packet",
      "--document", documentPath,
      "--input", packetPath,
      "--legacy-profile", "prototype-v1",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      phase: "validate",
      mode: "packet",
      normalized: {
        format: "review-packet/1",
        decisions: expect.arrayContaining([
          expect.objectContaining({ action: "EDIT", note: "【精简】Remove redundant detail." }),
          expect.objectContaining({ action: "EDIT", note: "【扩展】Add one example." }),
        ]),
      },
    });
  });
});
