import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../../src/cli/main.js";
import {
  serializeReviewPacketJson,
  type ReviewDecision,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "../unit/rounds-fixtures.js";

const SKILL_SOURCE = resolve("skills/deliver-dual-audience-report");
const EXPECTED_SKILL_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "assets/agent-context.template.md",
  "assets/review-workbench.template.html",
  "references/audience-contracts.md",
  "references/evidence-and-privacy.md",
  "references/review-document.schema.json",
  "references/review-packet.schema.json",
  "references/review-protocols.md",
  "references/review-state.schema.json",
  "scripts/review-delivery.mjs",
];
const temporaryDirectories: string[] = [];

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-installed-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function copyInstalledSkill(label: string): Promise<{ root: string; skill: string; cwd: string; home: string }> {
  const root = await temporaryDirectory(label);
  const skill = join(root, "installed", "deliver-dual-audience-report");
  const cwd = join(root, "unrelated-cwd");
  const home = join(root, "home");
  await cp(SKILL_SOURCE, skill, { recursive: true, preserveTimestamps: false });
  await Promise.all([cwd, home].map(async (path) => {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }));
  return { root, skill, cwd, home };
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

async function runInstalled(
  installed: { skill: string; cwd: string; home: string },
  arguments_: readonly string[],
  entryName = "review-delivery.mjs",
): Promise<ProcessResult> {
  const entry = join(installed.skill, "scripts", entryName);
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: installed.home };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...arguments_], {
      cwd: installed.cwd,
      env: environment,
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

function parseSingleJsonLine(result: ProcessResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function finalizedReplayCase(): {
  current: ReviewDocumentV1;
  packetText: string;
  packetId: string;
  semanticDigest: string;
} {
  const first = reviewFixture();
  const decisions: ReviewDecision[] = first.blocks.map((block) => ({ blockId: block.id, action: "PASS" }));
  const packet = makePacket(first, { decisions });
  const current = candidateBase(first, packet);
  current.document.status = "finalized";
  setContentVersion(first, current);
  const serialized = serializeReviewPacketJson(packet, first);
  if (!serialized.ok) throw new Error("installed replay packet fixture drifted");
  return {
    current,
    packetText: serialized.value,
    packetId: packet.packetId,
    semanticDigest: packet.semanticDigest,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("installed Skill distribution", () => {
  it("keeps a locatable development source map out of the installed distribution", async () => {
    const toolUrl = new URL("../../tools/build-cli.mjs", import.meta.url).href;
    const tool = await import(toolUrl) as {
      buildDevelopmentCliBundle(): Promise<{ javascript: Uint8Array; sourceMap: Uint8Array }>;
    };
    const built = await tool.buildDevelopmentCliBundle();
    const development = new TextDecoder().decode(built.javascript);
    const sourceMap = JSON.parse(new TextDecoder().decode(built.sourceMap)) as {
      version: number;
      sources: string[];
      sourcesContent?: string[];
    };
    const installed = await readFile(
      resolve("skills/deliver-dual-audience-report/scripts/review-delivery.mjs"),
      "utf8",
    );
    expect(development).toMatch(/\/\/# sourceMappingURL=review-delivery\.mjs\.map\n$/u);
    expect(sourceMap.version).toBe(3);
    expect(sourceMap.sources).toContain("../src/cli/main.ts");
    expect(sourceMap.sourcesContent?.length).toBe(sourceMap.sources.length);
    expect(installed).not.toContain("sourceMappingURL");
    await expect(lstat(resolve(
      "skills/deliver-dual-audience-report/scripts/review-delivery.mjs.map",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds identical path-free bytes from two distinct physical dependency roots", async () => {
    const dependencyPackages = [
      "@noble/hashes",
      "string-width",
      "json-canonicalize",
      "unicode-case-folding",
      "get-east-asian-width",
      "strip-ansi",
      "ansi-regex",
    ];
    const roots = await Promise.all(["physical-a", "physical-b"].map(async (label) => {
      const root = await temporaryDirectory(label);
      const dependencyRoot = join(root, "node_modules");
      await mkdir(dependencyRoot, { recursive: true, mode: 0o700 });
      for (const packageName of dependencyPackages) {
        const destination = join(dependencyRoot, packageName);
        await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
        await cp(resolve("node_modules", packageName), destination, {
          recursive: true,
          dereference: true,
          preserveTimestamps: false,
        });
        expect((await lstat(destination)).isDirectory()).toBe(true);
        expect((await lstat(destination)).isSymbolicLink()).toBe(false);
      }
      return dependencyRoot;
    }));
    const toolUrl = new URL("../../tools/build-cli.mjs", import.meta.url).href;
    const tool = await import(toolUrl) as {
      buildCliBundle(options: { dependencyRoot: string }): Promise<Uint8Array>;
    };
    const outputs = await Promise.all(roots.map(async (dependencyRoot) =>
      tool.buildCliBundle({ dependencyRoot })));
    const first = outputs[0];
    const second = outputs[1];
    if (first === undefined || second === undefined) throw new Error("physical dependency build was not produced");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const text = new TextDecoder().decode(first);
    for (const forbidden of [
      "/Users/",
      "node_modules/",
      "agent-reporting-skills",
      roots[0]!,
      roots[1]!,
    ]) expect(text).not.toContain(forbidden);
  });

  it("contains only the fixed runtime inventory and runs exact help from an unrelated cwd without node_modules", async () => {
    const installed = await copyInstalledSkill("inventory");
    expect(await listFiles(installed.skill)).toEqual(EXPECTED_SKILL_FILES);
    await expect(lstat(join(installed.skill, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const bundle = await readFile(join(installed.skill, "scripts", "review-delivery.mjs"), "utf8");
    expect(bundle).not.toMatch(/\bexport\s*\{/u);
    expect(bundle).not.toMatch(/node_modules|agent-reporting-skills|\/Users\/|sourceMappingURL/u);
    expect(bundle).not.toContain("password:!0");
    expect(bundle.match(/\["password"\]:!0/gu)).toHaveLength(2);
    expect(bundle).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|unsafe-eval|\bimport\s*\(/u);

    const result = await runInstalled(installed, ["--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("../SKILL.md");
    expect(result.stdout).toContain("../references/review-protocols.md");
    for (const name of ["init", "render", "validate", "consume", "record-usage"]) {
      expect(result.stdout.match(new RegExp(`\\b${name}\\b`, "gu"))).toHaveLength(1);
    }
    expect(result.stdout).not.toMatch(/(^|\s)(?:help|-h)(?:\s|$)/mu);

    await unlink(join(installed.skill, "assets", "review-workbench.template.html"));
    expect(await runInstalled(installed, ["--help"])).toMatchObject({ code: 0, stderr: "" });
  });

  it("returns the exact assembly argument failure without reflecting missing or unknown commands", async () => {
    const installed = await copyInstalledSkill("command-errors");
    for (const arguments_ of [[], ["secret-unsupported-command"], ["help"], ["-h"]]) {
      const result = await runInstalled(installed, arguments_);
      expect(result.code).toBe(2);
      expect(parseSingleJsonLine(result)).toEqual({
        status: "failed",
        phase: "cli",
        mutated: false,
        recoveryRequired: false,
        errors: [{
          code: "ARGUMENT_INVALID",
          path: "/arguments/command",
          blockId: null,
          message: "The CLI command is missing or unsupported.",
          hint: "Use --help and choose init, render, validate, consume, or record-usage.",
        }],
      });
      expect(result.stdout).not.toContain("secret-unsupported-command");
    }
  });

  it("maps an unexpected hostile argv failure to the sanitized generic assembly error", async () => {
    const sentinel = "private-hostile-argv-/Users/customer";
    const argv = new Proxy([] as string[], {
      get() {
        throw new Error(sentinel);
      },
    });
    const result = await executeCli(argv);
    expect(result.exitCode).toBe(70);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      status: "failed",
      phase: "cli",
      mutated: false,
      recoveryRequired: false,
      errors: [{
        code: "INTERNAL_ERROR",
        path: "",
        blockId: null,
        message: "The CLI stopped because of an unexpected internal error.",
        hint: "Retry from verified inputs; if the failure repeats, reinstall or inspect the local Skill.",
      }],
    });
    expect(result.stdout).not.toContain(sentinel);
  });

  it("loads the Approval asset only for render, delivery/batch validation, and consume apply", async () => {
    const installed = await copyInstalledSkill("asset-routing");
    await unlink(join(installed.skill, "assets", "review-workbench.template.html"));
    const output = join(installed.root, "draft");
    const initialized = await runInstalled(installed, [
      "init",
      "--output-dir", output,
      "--base-name", "asset_free_init",
      "--title", "Asset-free initialization",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ]);
    expect(initialized.code).toBe(0);
    expect(parseSingleJsonLine(initialized)).toMatchObject({ status: "ok", phase: "init" });
    const usage = await runInstalled(installed, ["record-usage", "summarize"]);
    expect(usage.code).toBe(0);
    expect(parseSingleJsonLine(usage)).toMatchObject({ status: "summarized" });
    const invalidValidate = await runInstalled(installed, ["validate", "unsupported-mode"]);
    expect(invalidValidate.code).toBe(2);
    expect(parseSingleJsonLine(invalidValidate)).toMatchObject({ status: "failed", phase: "validate" });

    const validationInput = join(installed.root, "validation-input");
    await mkdir(validationInput, { mode: 0o700 });
    const documentPath = join(validationInput, "review-document.json");
    const packetPath = join(validationInput, "packet.json");
    const statePath = join(validationInput, "state.json");
    await writePrivate(documentPath, await readFile(resolve("tests/fixtures/protocol/review-document.json")));
    await writePrivate(packetPath, await readFile(resolve("tests/fixtures/protocol/review-packet.json")));
    await writePrivate(statePath, await readFile(resolve("tests/fixtures/protocol/review-state.json")));
    for (const [mode, inputPath] of [["packet", packetPath], ["state", statePath]] as const) {
      const result = await runInstalled(installed, [
        "validate", mode, "--document", documentPath, "--input", inputPath,
      ]);
      expect(result.code).toBe(0);
      expect(parseSingleJsonLine(result)).toMatchObject({ status: "ok", phase: "validate", mode });
    }

    const replay = finalizedReplayCase();
    const replayCurrent = join(validationInput, "replay-current.review-document.json");
    const replayPacket = join(validationInput, "replay-packet.json");
    await writePrivate(replayCurrent, `${JSON.stringify(replay.current)}\n`);
    await writePrivate(replayPacket, replay.packetText);
    const transition = await runInstalled(installed, [
      "validate", "transition",
      "--current", replayCurrent,
      "--packet", replayPacket,
      "--candidate", join(validationInput, "missing-candidate.json"),
    ]);
    expect(transition.code).toBe(0);
    expect(parseSingleJsonLine(transition)).toMatchObject({
      status: "ok",
      phase: "validate",
      mode: "transition",
      summary: { status: "noop" },
    });

    for (const arguments_ of [
      ["render", "--document", join(output, "review-document.json")],
      ["validate", "delivery", "--document", join(output, "review-document.json")],
      ["validate", "batch", "--document", join(output, "review-document.json"), "--document", join(output, "review-document.json")],
    ]) {
      const result = await runInstalled(installed, arguments_);
      expect(result.code).toBe(70);
      expect(parseSingleJsonLine(result)).toMatchObject({
        status: "failed",
        phase: "cli",
        errors: [{ code: "INTERNAL_ERROR", path: "/runtime/approvalTemplateBytes" }],
      });
    }
  });

  it("runs init, render, and delivery validation through the installed-only bundle-relative template", async () => {
    const installed = await copyInstalledSkill("delivery");
    const output = join(installed.root, "delivery");
    const initialized = await runInstalled(installed, [
      "init",
      "--output-dir", output,
      "--base-name", "installed_plan",
      "--title", "Installed plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ]);
    expect(initialized.code).toBe(0);
    expect(parseSingleJsonLine(initialized)).toMatchObject({ status: "ok", phase: "init" });

    const document = reviewFixture();
    const contract = join(output, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const rendered = await runInstalled(installed, ["render", "--document", contract]);
    expect(rendered.code).toBe(0);
    expect(parseSingleJsonLine(rendered)).toMatchObject({ status: "ok", phase: "render", mode: "delivery" });
    const validated = await runInstalled(installed, ["validate", "delivery", "--document", contract]);
    expect(validated.code).toBe(0);
    expect(parseSingleJsonLine(validated)).toMatchObject({ status: "ok", phase: "validate", mode: "delivery" });
  });

  it("keeps consume replay noop independent of candidate, output root, and the installed Approval asset", async () => {
    const installed = await copyInstalledSkill("noop");
    const replay = finalizedReplayCase();
    const input = join(installed.root, "input");
    await mkdir(input, { mode: 0o700 });
    const currentPath = join(input, "current.review-document.json");
    const packetPath = join(input, "packet.json");
    await writePrivate(currentPath, `${JSON.stringify(replay.current)}\n`);
    await writePrivate(packetPath, replay.packetText);
    await unlink(join(installed.skill, "assets", "review-workbench.template.html"));
    const outputDir = join(installed.root, "must-not-exist");

    const result = await runInstalled(installed, [
      "consume",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", join(input, "missing-candidate.json"),
      "--output-dir", outputDir,
    ]);
    expect(result.code).toBe(0);
    expect(parseSingleJsonLine(result)).toEqual({
      status: "ok",
      phase: "consume",
      mode: "noop",
      mutated: false,
      summary: { packetId: replay.packetId, semanticDigest: replay.semanticDigest },
    });
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes installed and injected template loader failures while preserving invalid-byte business results", async () => {
    const installed = await copyInstalledSkill("loader-seam");
    const first = reviewFixture();
    const decisions: ReviewDecision[] = first.blocks.map((block) => ({ blockId: block.id, action: "PASS" }));
    const packet = makePacket(first, { decisions });
    const candidate = candidateBase(first, packet);
    candidate.document.status = "finalized";
    setContentVersion(first, candidate);
    const serialized = serializeReviewPacketJson(packet, first);
    if (!serialized.ok) throw new Error("loader packet fixture drifted");
    const input = join(installed.root, "loader-input");
    await mkdir(input, { mode: 0o700 });
    const currentPath = join(input, "current.review-document.json");
    const packetPath = join(input, "packet.json");
    const candidatePath = join(input, "candidate.review-document.json");
    await writePrivate(currentPath, `${JSON.stringify(first)}\n`);
    await writePrivate(packetPath, serialized.value);
    await writePrivate(candidatePath, `${JSON.stringify(candidate)}\n`);
    const arguments_ = [
      "consume",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", candidatePath,
      "--output-dir", join(installed.root, "output"),
    ];
    const approvalAsset = join(installed.skill, "assets", "review-workbench.template.html");
    await unlink(approvalAsset);
    const installedFailure = await runInstalled(installed, arguments_);
    expect(installedFailure.code).toBe(70);
    expect(JSON.parse(installedFailure.stdout)).toMatchObject({
      status: "failed",
      phase: "cli",
      errors: [{ code: "INTERNAL_ERROR", path: "/runtime/approvalTemplateBytes" }],
    });
    expect(installedFailure.stderr).toBe("");
    const toolUrl = new URL("../../tools/build-cli.mjs", import.meta.url).href;
    const tool = await import(toolUrl) as {
      buildCliLoaderHarness(): Promise<Uint8Array>;
    };
    const harnessName = "review-delivery-loader-harness.mjs";
    await writePrivate(
      join(installed.skill, "scripts", harnessName),
      await tool.buildCliLoaderHarness(),
    );
    for (const probe of ["sync", "reject"]) {
      const result = await runInstalled(installed, [probe, ...arguments_], harnessName);
      expect(result.code).toBe(70);
      expect(parseSingleJsonLine(result)).toEqual({
        status: "failed",
        phase: "cli",
        mutated: false,
        recoveryRequired: false,
        errors: [{
          code: "INTERNAL_ERROR",
          path: "/runtime/approvalTemplateBytes",
          blockId: null,
          message: "The installed approval template could not be loaded.",
          hint: "Reinstall the complete v0.2 Skill directory and retry.",
        }],
      });
      expect(result.stdout).not.toContain("private-loader-probe-sentinel");
    }

    await writePrivate(approvalAsset, new Uint8Array([0, 1, 2]));
    const invalidBytes = await runInstalled(installed, arguments_);
    const invalidResult = parseSingleJsonLine(invalidBytes);
    expect(invalidBytes.code).toBe(2);
    expect(invalidResult).toMatchObject({ status: "failed", phase: "consume" });
  });
});
