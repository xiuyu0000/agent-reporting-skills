import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import {
  commitFileTransaction,
  recoverTransactions,
  resolveOutputRoot,
  validateRelativeTarget,
} from "../../src/cli/io/index.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
let harnessDirectory = "";
let harnessPath = "";

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-recovery-")));
  temporaryDirectories.push(path);
  return path;
}

beforeAll(async () => {
  harnessDirectory = await realpath(await mkdtemp(join(tmpdir(), "dar-recovery-harness-")));
  harnessPath = join(harnessDirectory, "crash-harness.mjs");
  const pathsImport = JSON.stringify(resolve("src/cli/io/paths.ts"));
  const transactionImport = JSON.stringify(resolve("src/cli/io/transaction.ts"));
  const recoveryImport = JSON.stringify(resolve("src/cli/io/recovery.ts"));
  const fsyncImport = JSON.stringify(resolve("src/cli/io/fsync.ts"));
  await build({
    stdin: {
      contents: `
        import { resolveOutputRootWithAdapter, validateRelativeTarget } from ${pathsImport};
        import { commitFileTransactionWithAdapter } from ${transactionImport};
        import { recoverTransactionsWithAdapter } from ${recoveryImport};
        import { nativeFileSystemAdapter } from ${fsyncImport};
        const [output, controlPoint, disposition, relativeName = "artifact.txt", content = "new"] = process.argv.slice(2);
        const rootResult = await resolveOutputRootWithAdapter({
          outputDir: output,
          creation: "must-exist",
          freshness: "allow-business-entries",
        }, nativeFileSystemAdapter);
        if (!rootResult.ok) process.exit(81);
        if (disposition === "recover") {
          const result = await recoverTransactionsWithAdapter({
            root: rootResult.value,
            generatorVersion: "0.2.1",
          }, nativeFileSystemAdapter);
          process.stdout.write(JSON.stringify(result));
          process.exit(result.ok ? 0 : 82);
        }
        const targetResult = validateRelativeTarget(relativeName);
        if (!targetResult.ok) process.exit(81);
        const adapter = {
          ...nativeFileSystemAdapter,
          checkpoint: async (point) => {
            if (controlPoint === "pause-stage" && point === "stage-written:0") {
              process.stdout.write("HELD\\n");
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else if (point === controlPoint) {
              process.exit(86);
            }
          },
        };
        const target = disposition === "replace"
          ? {
              target: targetResult.value,
              bytes: new TextEncoder().encode(content),
              disposition: "replace",
              verifyStaged: () => ({ ok: true }),
              verifyExisting: () => ({ ok: true }),
            }
          : {
              target: targetResult.value,
              bytes: new TextEncoder().encode(content),
              disposition: "create",
              verifyStaged: () => ({ ok: true }),
            };
        const result = await commitFileTransactionWithAdapter({
          root: rootResult.value,
          generatorVersion: "0.2.1",
          targets: [target],
        }, adapter);
        process.stdout.write(JSON.stringify(result));
        process.exit(result.ok ? 0 : 82);
      `,
      loader: "ts",
      resolveDir: process.cwd(),
      sourcefile: "crash-harness.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: harnessPath,
    sourcemap: false,
    logLevel: "silent",
  });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

afterAll(async () => {
  if (harnessDirectory !== "") await rm(harnessDirectory, { recursive: true, force: true });
});

async function rootSetup() {
  const parent = await temporaryDirectory();
  const output = join(parent, "output");
  await mkdir(output, { mode: 0o700 });
  const result = await resolveOutputRoot({ outputDir: output, creation: "must-exist", freshness: "allow-business-entries" });
  if (!result.ok) throw new Error("root setup failed");
  return { output, root: result.value };
}

function target() {
  const result = validateRelativeTarget("artifact.txt");
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

async function createOld(output: string, root: Awaited<ReturnType<typeof rootSetup>>["root"]): Promise<void> {
  const result = await commitFileTransaction({
    root,
    generatorVersion: "0.2.1",
    targets: [{
      target: target(),
      bytes: encoder.encode("old"),
      disposition: "create",
      verifyStaged: () => ({ ok: true }),
    }],
  });
  expect(result.ok).toBe(true);
  expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");
}

function crash(output: string, point: string, disposition: "create" | "replace") {
  const result = spawnSync(process.execPath, [harnessPath, output, point, disposition], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(86);
  expect(result.stdout).toBe("");
}

function startPausedCommit(output: string, relativeName: string, content: string) {
  const child = spawn(process.execPath, [harnessPath, output, "pause-stage", "create", relativeName, content], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let observedHeld = false;
  let resolveHeld: (() => void) | undefined;
  let rejectHeld: ((error: Error) => void) | undefined;
  const held = new Promise<void>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (!observedHeld && stdout.includes("HELD\n")) {
      observedHeld = true;
      resolveHeld?.();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      if (!observedHeld) rejectHeld?.(new Error(`writer exited before holding claim: ${stderr}`));
      resolve({ status, stdout, stderr });
    });
  });
  return { held, completed };
}

function runCommit(output: string, relativeName: string, content: string) {
  return spawnSync(process.execPath, [harnessPath, output, "none", "create", relativeName, content], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runRecovery(output: string) {
  return spawnSync(process.execPath, [harnessPath, output, "none", "recover"], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function reopenRoot(output: string) {
  const result = await resolveOutputRoot({ outputDir: output, creation: "must-exist", freshness: "allow-business-entries" });
  if (!result.ok) throw new Error("reopen failed");
  return result.value;
}

async function transactionDirectory(output: string): Promise<string> {
  const entries = (await readdir(join(output, ".review-txn"))).filter((entry) => entry.startsWith("TXN-"));
  expect(entries).toHaveLength(1);
  return join(output, ".review-txn", entries[0] as string);
}

describe("transaction crash recovery E2E", () => {
  it.each([
    "manifest-published:staged",
    "manifest-temp:backing-up",
    "backup-renamed:0",
    "manifest-published:installing",
    "target-installed:0",
    "manifest-temp:committed",
  ])("restores the old replace target after process death at %s", async (point) => {
    const { output, root } = await rootSetup();
    await createOld(output, root);
    crash(output, point, "replace");
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toEqual({ ok: true, value: { rolledBack: 1, cleanedCommitted: 0 } });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
    expect(await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" })).toEqual({
      ok: true,
      value: { rolledBack: 0, cleanedCommitted: 0 },
    });
  });

  it("completes cleanup for a durably committed create after process death", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:committed", "create");
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toEqual({ ok: true, value: { rolledBack: 0, cleanedCommitted: 1 } });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    expect((await stat(join(output, "artifact.txt"))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it.each(["transaction-directory-created", "stage-written:0", "manifest-temp:staged"])(
    "blocks and preserves a pre-manifest orphan after process death at %s",
    async (point) => {
      const { output } = await rootSetup();
      crash(output, point, "create");
      const reopened = await reopenRoot(output);
      const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
      expect(recovered).toMatchObject({
        ok: false,
        mutated: true,
        recoveryRequired: true,
        errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
      });
      expect((await readdir(join(output, ".review-txn"))).length).toBe(1);
    },
  );

  it("blocks a generator-version mismatch without consuming the known transaction", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:staged", "create");
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.2" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_OWNER_UNKNOWN" }],
    });
    expect((await readdir(join(output, ".review-txn"))).filter((entry) => entry.startsWith("TXN-"))).toHaveLength(1);
  });

  it("fails closed on a well-formed writer claim from an unknown host", async () => {
    const { output, root } = await rootSetup();
    const claimPath = join(output, ".review-txn", ".writer-claim");
    const claim = {
      format: "review-writer-claim/1",
      owner: "deliver-dual-audience-report/v0.2",
      generatorVersion: "0.2.1",
      hostId: `sha256:${"0".repeat(64)}`,
      bootId: "boot-minute:0",
      pid: process.pid,
      processStartId: "start-ms:0",
      nonce: "00000000000000000000",
    };
    const bytes = `${JSON.stringify(claim)}\n`;
    await writeFile(claimPath, bytes, { mode: 0o600 });
    await chmod(claimPath, 0o600);
    const recovered = await recoverTransactions({ root, generatorVersion: "0.2.1" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_OWNER_UNKNOWN", path: "/writerClaim" }],
    });
    expect(await readFile(claimPath, "utf8")).toBe(bytes);
    expect(await readdir(join(output, ".review-txn"))).toEqual([".writer-claim"]);
  });

  it("reclaims a dead prior process claim when its PID was reused by the current process", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:staged", "create");
    const claimPath = join(output, ".review-txn", ".writer-claim");
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    claim.pid = process.pid;
    claim.processStartId = "start-ms:0";
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`);
    await chmod(claimPath, 0o600);
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toEqual({ ok: true, value: { rolledBack: 1, cleanedCommitted: 0 } });
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("blocks and preserves a corrupt canonical manifest", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:staged", "create");
    const directory = await transactionDirectory(output);
    await writeFile(join(directory, "manifest.json"), "{broken\n");
    await chmod(join(directory, "manifest.json"), 0o600);
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
    expect((await readdir(join(output, ".review-txn"))).length).toBe(1);
  });

  it("blocks and preserves a staged-file digest mismatch", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:staged", "create");
    const directory = await transactionDirectory(output);
    await writeFile(join(directory, "stage-000000.bin"), "tampered");
    await chmod(join(directory, "stage-000000.bin"), 0o600);
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      errors: [{ code: "TRANSACTION_DIGEST_MISMATCH" }],
    });
    expect((await readdir(join(output, ".review-txn"))).length).toBe(1);
  });

  it("blocks committed cleanup when the installed target digest changed", async () => {
    const { output } = await rootSetup();
    crash(output, "manifest-published:committed", "create");
    await writeFile(join(output, "artifact.txt"), "tampered");
    await chmod(join(output, "artifact.txt"), 0o600);
    const reopened = await reopenRoot(output);
    const recovered = await recoverTransactions({ root: reopened, generatorVersion: "0.2.1" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_DIGEST_MISMATCH" }],
    });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("tampered");
  });

  it.each([
    { secondTarget: "artifact.txt", secondStatus: 82, expected: [["artifact.txt", "first"]] },
    { secondTarget: "second.txt", secondStatus: 0, expected: [["artifact.txt", "first"], ["second.txt", "second"]] },
  ] as const)(
    "serializes live writers without recovering the first transaction when the second target is $secondTarget",
    async ({ secondTarget, secondStatus, expected }) => {
      const { output } = await rootSetup();
      const first = startPausedCommit(output, "artifact.txt", "first");
      await first.held;
      const second = runCommit(output, secondTarget, "second");
      expect(second.error).toBeUndefined();
      expect(second.status, JSON.stringify({ stdout: second.stdout, stderr: second.stderr })).toBe(secondStatus);
      expect(second.stderr).toBe("");
      const firstResult = await first.completed;
      expect(firstResult.status, JSON.stringify(firstResult)).toBe(0);
      expect(firstResult.stderr).toBe("");
      expect(firstResult.stdout).toContain("HELD\n");
      expect(JSON.parse(firstResult.stdout.slice("HELD\n".length))).toMatchObject({ ok: true });
      const secondResult: unknown = JSON.parse(second.stdout);
      if (secondStatus === 0) {
        expect(secondResult).toMatchObject({ ok: true });
      } else {
        expect(secondResult).toMatchObject({
          ok: false,
          mutated: false,
          recoveryRequired: false,
          errors: [{ code: "TARGET_EXISTS" }],
        });
      }
      for (const [relativeName, content] of expected) {
        expect(await readFile(join(output, relativeName), "utf8")).toBe(content);
      }
      expect(await readdir(join(output, ".review-txn"))).toEqual([]);
    },
  );

  it("waits for a live writer claim before running recovery", async () => {
    const { output } = await rootSetup();
    const first = startPausedCommit(output, "artifact.txt", "first");
    await first.held;
    const startedAt = Date.now();
    const recovery = runRecovery(output);
    const elapsed = Date.now() - startedAt;
    expect(recovery.error).toBeUndefined();
    expect(recovery.status, JSON.stringify({ stdout: recovery.stdout, stderr: recovery.stderr })).toBe(0);
    expect(recovery.stderr).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(JSON.parse(recovery.stdout)).toEqual({ ok: true, value: { rolledBack: 0, cleanedCommitted: 0 } });
    const firstResult = await first.completed;
    expect(firstResult.status, JSON.stringify(firstResult)).toBe(0);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("first");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("blocks an orphan transaction directory created without any manifest", async () => {
    const { output, root } = await rootSetup();
    const orphan = join(output, ".review-txn", "TXN-00000000000000000000");
    await mkdir(orphan, { mode: 0o700 });
    const recovered = await recoverTransactions({ root, generatorVersion: "0.2.1" });
    expect(recovered).toMatchObject({
      ok: false,
      mutated: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
    expect(await readdir(orphan)).toEqual([]);
  });
});
