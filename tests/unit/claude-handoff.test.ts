import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const claudePath = resolve(ROOT, "CLAUDE.md");
const agentsPath = resolve(ROOT, "AGENTS.md");
const handoffPath = resolve(ROOT, "docs/claude-code-handoff.md");
const packagePath = resolve(ROOT, "package.json");
const usagePath = resolve(ROOT, "src/cli/record-usage.ts");
const zipPath = resolve(ROOT, "dist/deliver-dual-audience-report-v0.2.0.zip");
const manifestPath = resolve(ROOT, "dist/deliver-dual-audience-report-v0.2.0.manifest.json");

const EXPECTED_ZIP_SHA256 = "e33d05ba296e5b4436c49179c9bac34ea2dd9fc3a9a04090d464176d1eb49e1c";
const EXPECTED_MANIFEST_SHA256 = "3d20833ce1398d23e5793851869d2b57c366d61a2779dffe7a4ce2794a922fa6";
const execFileAsync = promisify(execFile);
const PILOT_INPUT_KEYS = [
  "eligible",
  "triggered",
  "correct",
  "validation",
  "result",
  "corrections",
  "interruptions",
  "caseKey",
  "sampleSequence",
  "t0T1DecidedCount",
  "t0T1ActiveReviewMs",
  "totalActiveReviewMs",
  "sourceRevisionRounds",
  "closedLoop",
  "burdenScore",
] as const;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expectCanonicalInTreePath(path: string): Promise<void> {
  const pathRelative = relative(ROOT, path);
  expect(isAbsolute(pathRelative) || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)).toBe(false);
  let current = ROOT;
  for (const segment of pathRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const status = await lstat(current);
    expect(status.isSymbolicLink()).toBe(false);
  }
}

async function expectLocalMarkdownLinksToResolve(path: string, text: string): Promise<void> {
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]);
  for (const rawTarget of links) {
    if (rawTarget === undefined || /^(?:https?:|mailto:|#)/u.test(rawTarget)) continue;
    const target = rawTarget.split("#", 1)[0];
    if (target === undefined || target === "") continue;
    const absoluteTarget = resolve(dirname(path), target);
    const lexicalRelative = relative(ROOT, absoluteTarget);
    expect(isAbsolute(lexicalRelative) || lexicalRelative === ".." || lexicalRelative.startsWith("../")).toBe(false);
    await expectCanonicalInTreePath(absoluteTarget);
    const status = await lstat(absoluteTarget);
    expect(status.isSymbolicLink()).toBe(false);
    const canonicalTarget = await realpath(absoluteTarget);
    const canonicalRelative = relative(ROOT, canonicalTarget);
    expect(isAbsolute(canonicalRelative) || canonicalRelative === ".." || canonicalRelative.startsWith("../")).toBe(false);
  }
}

async function readHandoffFiles(): Promise<{
  readonly claude: string;
  readonly agents: string;
  readonly handoff: string;
  readonly usage: string;
  readonly zip: Uint8Array;
  readonly manifest: Uint8Array;
  readonly packageJson: {
    readonly engines: { readonly node: string };
    readonly scripts: Readonly<Record<string, string>>;
  };
}> {
  const [claude, agents, handoff, packageText, usage, zip, manifest] = await Promise.all([
    readFile(claudePath, "utf8"),
    readFile(agentsPath, "utf8"),
    readFile(handoffPath, "utf8"),
    readFile(packagePath, "utf8"),
    readFile(usagePath, "utf8"),
    readFile(zipPath),
    readFile(manifestPath),
  ]);

  return {
    claude,
    agents,
    handoff,
    usage,
    zip,
    manifest,
    packageJson: JSON.parse(packageText) as {
      readonly engines: { readonly node: string };
      readonly scripts: Readonly<Record<string, string>>;
    },
  };
}

describe("Claude Code handoff documentation", () => {
  it("provides portable project-local entry points", async () => {
    const { claude, agents, handoff } = await readHandoffFiles();

    await Promise.all([
      expectCanonicalInTreePath(claudePath),
      expectCanonicalInTreePath(agentsPath),
      expectCanonicalInTreePath(handoffPath),
      expectLocalMarkdownLinksToResolve(claudePath, claude),
      expectLocalMarkdownLinksToResolve(agentsPath, agents),
      expectLocalMarkdownLinksToResolve(handoffPath, handoff),
    ]);

    expect(claude).toContain("[AGENTS.md](AGENTS.md)");
    expect(claude).toContain("[Claude Code handoff](docs/claude-code-handoff.md)");
    expect(claude).toContain("not a filesystem symlink");
    expect(agents).toContain("[the Claude Code handoff](docs/claude-code-handoff.md)");
    expect(agents).toContain("parent directory belongs to another project");
    expect(handoff).toContain("[AGENTS.md](../AGENTS.md)");
    expect(handoff).toContain("[CLAUDE.md](../CLAUDE.md)");
    expect(handoff).toMatch(/repository\s+clone\/worktree/i);
    expect(handoff).toMatch(/not(?:\*\*)?\s+part of the v0\.2 ZIP/i);
  });

  it("preserves the candidate, release, and W7 continuation boundary", async () => {
    const { handoff, zip, manifest, packageJson } = await readHandoffFiles();

    expect(handoff).toContain("dae53e5b76e6507592b37c1a241e7ad6c6e22905");
    expect(handoff).toContain("e33d05ba296e5b4436c49179c9bac34ea2dd9fc3a9a04090d464176d1eb49e1c");
    expect(handoff).toContain("3d20833ce1398d23e5793851869d2b57c366d61a2779dffe7a4ce2794a922fa6");
    expect(handoff).toContain("PIL-001");
    expect(handoff).toContain("MET-001");
    expect(handoff).toContain("#61");
    expect(handoff).toContain("#62");
    expect(handoff).toMatch(/not created; requires separate user authorization/i);
    expect(handoff).toMatch(/at least\s+four\s+naturally\s+independent/i);
    expect(handoff).toMatch(/one primary approver/i);
    expect(handoff).toMatch(/named private output root/i);
    expect(packageJson.engines.node).toBe(">=24 <25");
    expect(sha256(zip)).toBe(EXPECTED_ZIP_SHA256);
    expect(sha256(manifest)).toBe(EXPECTED_MANIFEST_SHA256);
    expect(handoff).toContain(EXPECTED_ZIP_SHA256);
    expect(handoff).toContain(EXPECTED_MANIFEST_SHA256);
    expect(handoff).toContain("git merge-base --is-ancestor dae53e5b76e6507592b37c1a241e7ad6c6e22905 HEAD");
    expect(handoff).toContain("major !== 24");
    expect(handoff).toContain("set -euo pipefail");
    expect(handoff).toContain("shasum -a 256 -c -");
    expect(handoff).toContain('test -z "$(git status --porcelain)"');
    expect(handoff.indexOf('test -z "$(git status --porcelain)"')).toBeLessThan(handoff.indexOf("git fetch origin --prune"));

    const releaseManifest = JSON.parse(Buffer.from(manifest).toString("utf8")) as {
      readonly archive: { readonly entryCount: number; readonly root: string };
      readonly files: readonly { readonly path: string }[];
    };
    expect(releaseManifest.archive).toMatchObject({ entryCount: 11, root: "deliver-dual-audience-report" });
    expect(releaseManifest.files).toHaveLength(11);
    expect(releaseManifest.files.map((file) => file.path)).toContain(
      "deliver-dual-audience-report/scripts/review-delivery.mjs",
    );
    for (const nonRuntimeDocument of ["AGENTS.md", "CLAUDE.md", "docs/claude-code-handoff.md"]) {
      expect(releaseManifest.files.map((file) => file.path)).not.toContain(nonRuntimeDocument);
    }
  });

  it("keeps public command and validation references aligned with package scripts", async () => {
    const { handoff, packageJson, usage } = await readHandoffFiles();

    const zipCli = "node '<private-runtime-root>/deliver-dual-audience-report/scripts/review-delivery.mjs' ";
    for (const command of ["init", "render", "validate", "consume", "record-usage"]) {
      expect(handoff).toContain(zipCli + command);
    }

    for (const script of [
      "build",
      "check:generated",
      "typecheck",
      "lint",
      "test:unit",
      "test:browser",
      "test:e2e",
      "validate:skill",
      "verify:dist",
    ]) {
      expect(packageJson.scripts[script], script).toBeDefined();
      expect(handoff).toContain("npm run " + script);
    }

    expect(handoff).toContain("unzip -q dist/deliver-dual-audience-report-v0.2.0.zip");
    expect(handoff).toContain("extracted release ZIP is the only pilot runtime");
    expect(handoff).toContain("no shell variable persists between steps");
    expect(handoff).not.toContain('node "$CLI"');
    expect(handoff).not.toContain("node skills/deliver-dual-audience-report/scripts/review-delivery.mjs");
    expect(handoff).toContain("~/.codex/state/deliver-dual-audience-report/usage");
    expect(handoff).toMatch(/separate(?:ly)? authorization/i);
    expect(handoff).toMatch(/private channel/i);
    expect(handoff).toMatch(/public-safe\s+status template/i);
    expect(handoff).toMatch(/authorization for public disclosure/i);
    expect(handoff).toMatch(/new and empty/i);
    expect(handoff).toMatch(/no existing node_modules/i);
    expect(handoff).toContain("Runtime parent must be canonical and root must be new.");
    expect(handoff).toContain("path.isAbsolute(raw)");
    expect(handoff).toContain("raw !== root");
    expect(handoff).toContain("rootStatus = fs.lstatSync(root)");
    expect(handoff).toContain("-d '<private-runtime-root>'");
    expect(handoff).toMatch(/previously\s+nonexistent, empty destination/i);
    expect(handoff).toMatch(/absolute,\s+canonical, non-symlink path/i);
    expect(handoff).toMatch(/any permitted dynamic value/i);
    expect(handoff).toContain("git add -N -- AGENTS.md CLAUDE.md docs/claude-code-handoff.md");
    expect(handoff).toContain("tests/unit/claude-handoff.test.ts");
    expect(handoff).toMatch(/git add -N -- AGENTS\.md CLAUDE\.md docs\/claude-code-handoff\.md \\\n+\s+tests\/unit\/claude-handoff\.test\.ts/u);

    for (const field of PILOT_INPUT_KEYS) expect(usage).toContain('"' + field + '"');
    const match = handoff.match(/<!-- record-usage-pilot-input:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- record-usage-pilot-input:end -->/u);
    expect(match?.[1]).toBeDefined();
    const metrics = JSON.parse(match?.[1] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(metrics).sort()).toEqual([...PILOT_INPUT_KEYS].sort());
    expect(metrics).toMatchObject({
      eligible: true,
      triggered: true,
      correct: true,
      validation: "passed",
      result: "success",
      closedLoop: true,
    });
    expect(metrics.caseKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(metrics.sampleSequence).toBeGreaterThanOrEqual(1);
    expect(metrics.t0T1DecidedCount).toBeGreaterThanOrEqual(0);
    expect(metrics.t0T1DecidedCount).toBeLessThanOrEqual(15);
    expect(metrics.t0T1ActiveReviewMs).toBeLessThanOrEqual(metrics.totalActiveReviewMs as number);
    expect(metrics.burdenScore).toBeGreaterThanOrEqual(-2);
    expect(metrics.burdenScore).toBeLessThanOrEqual(2);
    expect(handoff).toContain("record-usage append --input '<private-output-root>/content-free-metrics.json'");
    expect(handoff).toContain('record-usage summarize --min-samples 3 --max-samples 5');
    expect(handoff).toMatch(/within the preceding 60 seconds/i);
    expect(handoff).toMatch(/unique among the\s+latest complete records/i);
    expect(handoff).toMatch(/fresh, never-before-used opaque `caseKey`/i);
    expect(handoff).toMatch(/same opaque `caseKey` and\s+use a higher sequence/i);
    expect(handoff).toMatch(/not invoke any `record-usage` operation/i);
    expect(handoff).toMatch(/exit 0 with `not-recorded`/i);

    const nodeGate = handoff.indexOf("major !== 24");
    const npmInstall = handoff.indexOf("\nnpm ci", nodeGate);
    const firstZipCommand = handoff.indexOf(zipCli);
    const stateAuthorization = handoff.indexOf("separately authorized the state directory");
    const append = handoff.indexOf("record-usage append");
    const summarize = handoff.indexOf("record-usage summarize");
    expect(nodeGate).toBeGreaterThanOrEqual(0);
    expect(npmInstall).toBeGreaterThan(nodeGate);
    expect(firstZipCommand).toBeGreaterThan(nodeGate);
    expect(stateAuthorization).toBeGreaterThanOrEqual(0);
    expect(append).toBeGreaterThan(stateAuthorization);
    expect(summarize).toBeGreaterThan(stateAuthorization);
    for (const unquotedArgument of ["--output-dir <", "--document <", "--current <", "--packet <", "--candidate <", "--input <"]) {
      expect(handoff).not.toContain(unquotedArgument);
    }
    expect(handoff).toMatch(/terminal tool's argument-array\s+interface/i);
  });

  it("does not turn the handoff into a private-data surface", async () => {
    const { claude, agents, handoff } = await readHandoffFiles();
    const text = [claude, agents, handoff].join("\n");

    expect(text).not.toMatch(/\/Users\//u);
    expect(text).not.toMatch(/file:\/\//u);
    expect(text).toMatch(/Never place pilot body/i);
    expect(text).toMatch(/Do not include titles, IDs, paths/i);
    expect(text).toMatch(/private channel/i);
    expect(text).toMatch(/approver\/reviewer\/participant identities/i);
    expect(text).toMatch(/private-disclosure\s+authorization/i);
    expect(text).toMatch(/named execution platform/i);
    expect(text).toMatch(/user-operated local file picker/i);
    expect(text).toMatch(/public, unapproved, or retained chat/i);
    expect(text).toMatch(/primary approver[\s\S]*separately authorize/i);
    expect(text).toMatch(/user-approved minimal or deidentified title/i);
  });

  it("runs a structurally valid synthetic metric through the extracted release ZIP", async () => {
    const sandbox = await realpath(await mkdtemp(join(tmpdir(), "dar claude handoff-")));
    const runtimeRoot = join(sandbox, "runtime");
    const inputRoot = join(sandbox, "input");
    const home = join(sandbox, "home");
    const unrelatedCwd = join(sandbox, "unrelated cwd");
    try {
      await Promise.all([
        chmod(sandbox, 0o700),
        mkdir(inputRoot, { mode: 0o700 }),
        mkdir(home, { mode: 0o700 }),
        mkdir(unrelatedCwd, { mode: 0o700 }),
      ]);
      await Promise.all([chmod(inputRoot, 0o700), chmod(home, 0o700), chmod(unrelatedCwd, 0o700)]);
      await execFileAsync("unzip", ["-q", zipPath, "-d", runtimeRoot], { cwd: ROOT, maxBuffer: 1024 * 1024 });

      const inputPath = join(inputRoot, "synthetic-metrics.json");
      const { handoff } = await readHandoffFiles();
      const documentedInput = handoff.match(
        /<!-- record-usage-pilot-input:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- record-usage-pilot-input:end -->/u,
      );
      expect(documentedInput?.[1]).toBeDefined();
      await writeFile(
        inputPath,
        JSON.stringify({
          ...(JSON.parse(documentedInput?.[1] ?? "{}") as Record<string, unknown>),
          caseKey: "synthetic_handoff_case_0001",
        }),
        { mode: 0o600 },
      );
      await chmod(inputPath, 0o600);

      const cli = join(runtimeRoot, "deliver-dual-audience-report", "scripts", "review-delivery.mjs");
      const result = await execFileAsync(
        process.execPath,
        [cli, "record-usage", "append", "--input", inputPath],
        {
          cwd: unrelatedCwd,
          env: {
            HOME: home,
            PATH: process.env.PATH ?? "",
            NODE_OPTIONS: "",
            NODE_PATH: "",
            LANG: "C",
            LC_ALL: "C",
          },
          maxBuffer: 1024 * 1024,
        },
      );

      const stdout = result.stdout.toString();
      expect(result.stderr.toString()).toBe("");
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(stdout) as unknown).toEqual({ status: "recorded" });
      const usageFile = join(home, ".codex", "state", "deliver-dual-audience-report", "usage", "usage.jsonl");
      expect((await lstat(usageFile)).isFile()).toBe(true);
      await expect(lstat(join(runtimeRoot, "deliver-dual-audience-report", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a dangling runtime-root symlink with the documented guard", async () => {
    const sandbox = await realpath(await mkdtemp(join(tmpdir(), "dar runtime guard-")));
    try {
      const { handoff } = await readHandoffFiles();
      const guard = handoff.match(/node -e '([^']+)' '<private-runtime-root>'/u)?.[1];
      expect(guard).toBeDefined();
      const freshRoot = join(sandbox, "fresh runtime");
      const danglingRoot = join(sandbox, "dangling runtime");
      const lexicalParent = join(sandbox, "lexical parent");
      const lexicalLink = join(sandbox, "lexical link");
      const lexicalEscapeRoot = `${lexicalLink}/../lexical runtime`;
      await mkdir(lexicalParent, { mode: 0o700 });
      await symlink(join(sandbox, "missing target"), danglingRoot);
      await symlink(lexicalParent, lexicalLink);

      await expect(execFileAsync(process.execPath, ["-e", guard ?? "", freshRoot])).resolves.toMatchObject({ stderr: "" });
      await expect(execFileAsync(process.execPath, ["-e", guard ?? "", danglingRoot])).rejects.toMatchObject({ code: 1 });
      await expect(execFileAsync(process.execPath, ["-e", guard ?? "", "relative-runtime-root"])).rejects.toMatchObject({ code: 1 });
      await expect(execFileAsync(process.execPath, ["-e", guard ?? "", lexicalEscapeRoot])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
