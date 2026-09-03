import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import {
  commitFreshFileTransaction,
  validateRelativeTarget,
  type FileTransactionTarget,
} from "../../src/cli/io/index.js";
import {
  nativeFileSystemAdapter,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import { commitFreshFileTransactionWithAdapter } from "../../src/cli/io/transaction.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
let harnessDirectory = "";
let harnessPath = "";

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-fresh-transaction-e2e-")));
  temporaryDirectories.push(path);
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT";
  }
}

beforeAll(async () => {
  harnessDirectory = await realpath(await mkdtemp(join(tmpdir(), "dar-fresh-transaction-harness-")));
  harnessPath = join(harnessDirectory, "crash-harness.mjs");
  const transactionImport = JSON.stringify(resolve("src/cli/io/transaction.ts"));
  const pathsImport = JSON.stringify(resolve("src/cli/io/paths.ts"));
  const fsyncImport = JSON.stringify(resolve("src/cli/io/fsync.ts"));
  await build({
    stdin: {
      contents: `
        import { commitFileTransactionWithAdapter, commitFreshFileTransactionWithAdapter } from ${transactionImport};
        import { resolveOutputRootWithAdapter, validateRelativeTarget } from ${pathsImport};
        import { nativeFileSystemAdapter } from ${fsyncImport};
        const [output, controlPoint, version = "0.2.1", content = "crashed"] = process.argv.slice(2);
        const target = validateRelativeTarget("artifact.txt");
        if (!target.ok) process.exit(81);
        const adapter = {
          ...nativeFileSystemAdapter,
          checkpoint: async (point) => {
            if (controlPoint === "pause-stage" && point === "stage-written:0") {
              process.stdout.write("HELD\\n");
              await new Promise((resolve) => setTimeout(resolve, 700));
            } else if (point === controlPoint) {
              process.exit(86);
            }
          },
        };
        if (controlPoint === "backup-renamed:0") {
          const seeded = await commitFreshFileTransactionWithAdapter({
            outputDir: output,
            generatorVersion: version,
            targets: [{
              target: target.value,
              bytes: new TextEncoder().encode("old"),
              disposition: "create",
              verifyStaged: () => ({ ok: true }),
            }],
          }, nativeFileSystemAdapter);
          if (!seeded.ok) process.exit(83);
        }
        const result = controlPoint === "backup-renamed:0"
          ? await (async () => {
              const root = await resolveOutputRootWithAdapter({
                outputDir: output,
                creation: "must-exist",
                freshness: "allow-business-entries",
              }, nativeFileSystemAdapter);
              if (!root.ok) process.exit(84);
              return commitFileTransactionWithAdapter({
                root: root.value,
                generatorVersion: version,
                targets: [{
                  target: target.value,
                  bytes: new TextEncoder().encode(content),
                  disposition: "replace",
                  verifyStaged: () => ({ ok: true }),
                  verifyExisting: () => ({ ok: true }),
                }],
              }, adapter);
            })()
          : await commitFreshFileTransactionWithAdapter({
              outputDir: output,
              generatorVersion: version,
              targets: [{
                target: target.value,
                bytes: new TextEncoder().encode(content),
                disposition: "create",
                verifyStaged: () => ({ ok: true }),
              }],
            }, adapter);
        process.stdout.write(JSON.stringify(result));
        process.exit(result.ok ? 0 : 82);
      `,
      loader: "ts",
      resolveDir: process.cwd(),
      sourcefile: "fresh-crash-harness.ts",
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

function transactionTarget(content: string, generatorVersion = "0.2.1") {
  const target = validateRelativeTarget("artifact.txt");
  if (!target.ok) throw new Error("target setup failed");
  const file: FileTransactionTarget = {
    target: target.value,
    bytes: encoder.encode(content),
    disposition: "create",
    verifyStaged: () => ({ ok: true }),
  };
  return { generatorVersion, targets: [file] };
}

function metadataWithDevice(metadata: Stats, device: number): Stats {
  return new Proxy(metadata, {
    get(target, property, receiver) {
      if (property === "dev") return device;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function crash(output: string, point: string): void {
  const result = spawnSync(process.execPath, [harnessPath, output, point], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, JSON.stringify({ point, stdout: result.stdout, stderr: result.stderr })).toBe(86);
  expect(result.stdout).toBe("");
}

async function transactionDirectory(output: string): Promise<string> {
  const entries = (await readdir(join(output, ".review-txn"))).filter((entry) => entry.startsWith("TXN-"));
  expect(entries).toHaveLength(1);
  return join(output, ".review-txn", entries[0] as string);
}

function startPausedCommit(output: string) {
  const child = spawn(process.execPath, [harnessPath, output, "pause-stage", "0.2.1", "first"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let held = false;
  let resolveHeld: (() => void) | undefined;
  let rejectHeld: ((error: Error) => void) | undefined;
  const reachedStage = new Promise<void>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (!held && stdout.includes("HELD\n")) {
      held = true;
      resolveHeld?.();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      if (!held) rejectHeld?.(new Error(`writer exited before pause: ${stderr}`));
      resolve({ status, stdout, stderr });
    });
  });
  return { reachedStage, completed };
}

describe("fresh transaction crash recovery", () => {
  it.each([
    "manifest-published:staged",
    "manifest-temp:backing-up",
    "manifest-published:backing-up",
    "manifest-temp:installing",
    "manifest-published:installing",
    "target-installed:0",
    "manifest-temp:committed",
  ])("rolls back an uncommitted crash at %s and continues the current fresh commit", async (point) => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, point);

    const result = await commitFreshFileTransaction({
      outputDir: output,
      ...transactionTarget("retried"),
    });
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("retried");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("cleans a durable committed crash but refuses to represent it as this invocation's success", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "manifest-published:committed");

    const result = await commitFreshFileTransaction({
      outputDir: output,
      ...transactionTarget("must-not-replace"),
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
    });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("crashed");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("restores old bytes after a replace crash at backup-renamed:0 and fresh-rejects the retry", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "backup-renamed:0");

    const result = await commitFreshFileTransaction({
      outputDir: output,
      ...transactionTarget("must-not-overwrite"),
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
    });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it.each([
    "transaction-directory-created",
    "stage-written:0",
    "manifest-temp:staged",
  ])("preserves and blocks a pre-manifest orphan at %s", async (point) => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, point);
    const result = await commitFreshFileTransaction({
      outputDir: output,
      ...transactionTarget("retry"),
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
    expect((await readdir(join(output, ".review-txn"))).some((entry) => entry.startsWith("TXN-"))).toBe(true);
  });

  it("preserves and blocks a corrupt canonical manifest", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "manifest-published:staged");
    const directory = await transactionDirectory(output);
    await writeFile(join(directory, "manifest.json"), "{broken\n");
    await chmod(join(directory, "manifest.json"), 0o600);
    const result = await commitFreshFileTransaction({ outputDir: output, ...transactionTarget("retry") });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
  });

  it("preserves and blocks a staged digest mismatch", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "manifest-published:staged");
    const directory = await transactionDirectory(output);
    await writeFile(join(directory, "stage-000000.bin"), "tampered");
    await chmod(join(directory, "stage-000000.bin"), 0o600);
    const result = await commitFreshFileTransaction({ outputDir: output, ...transactionTarget("retry") });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_DIGEST_MISMATCH" }],
    });
  });

  it("blocks a recovery scene owned by a different generator version", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "manifest-published:staged");
    const result = await commitFreshFileTransaction({
      outputDir: output,
      ...transactionTarget("retry", "0.2.2"),
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_OWNER_UNKNOWN" }],
    });
  });

  it("blocks a recovery manifest with an unknown owner independently of its version", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    crash(output, "manifest-published:staged");
    const directory = await transactionDirectory(output);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, owner: "foreign-owner" })}\n`);
    await chmod(manifestPath, 0o600);
    const result = await commitFreshFileTransaction({ outputDir: output, ...transactionTarget("retry") });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_OWNER_UNKNOWN" }],
    });
    expect(await pathExists(join(output, "artifact.txt"))).toBe(false);
    expect((await readdir(join(output, ".review-txn"))).some((entry) => entry.startsWith("TXN-"))).toBe(true);
  });

  it("rejects a cross-device fresh transaction container before creating a claim", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    await mkdir(output, { mode: 0o700 });
    const containerPath = join(output, ".review-txn");
    await mkdir(containerPath, { mode: 0o700 });
    const rootMetadata = await lstat(output);
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === containerPath
        ? metadataWithDevice(await nativeFileSystemAdapter.lstat(path), rootMetadata.dev + 1)
        : nativeFileSystemAdapter.lstat(path),
    };
    const result = await commitFreshFileTransactionWithAdapter({
      outputDir: output,
      ...transactionTarget("new"),
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "CROSS_DEVICE_TRANSACTION" }],
    });
    expect(await readdir(containerPath)).toEqual([]);
    expect(await pathExists(join(output, "artifact.txt"))).toBe(false);
  });

  it("reports claim-release uncertainty after a successful durable commit", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    let inject = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (point === "manifest-published:committed") inject = true;
      },
      unlink: async (path) => {
        if (inject && path === join(output, ".review-txn", ".writer-claim")) {
          throw new Error("injected release uncertainty");
        }
        await nativeFileSystemAdapter.unlink(path);
      },
    };
    const result = await commitFreshFileTransactionWithAdapter({
      outputDir: output,
      ...transactionTarget("new"),
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/writerClaim" }],
    });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    expect(await pathExists(join(output, ".review-txn", ".writer-claim"))).toBe(true);
  });

  it("serializes a concurrent writer and fresh-rejects after the first writer commits", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const first = startPausedCommit(output);
    await first.reachedStage;
    const second = await commitFreshFileTransaction({ outputDir: output, ...transactionTarget("second") });
    const firstResult = await first.completed;
    expect(firstResult.status, JSON.stringify(firstResult)).toBe(0);
    expect(second).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/outputDir" }],
    });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("first");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("rejects an output-root symlink without modifying its destination", async () => {
    const parent = await temporaryDirectory();
    const outside = join(parent, "outside");
    const output = join(parent, "output");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "sentinel.txt"), "outside", { mode: 0o600 });
    await symlink(outside, output);
    const result = await commitFreshFileTransaction({ outputDir: output, ...transactionTarget("new") });
    expect(result).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    if (!result.ok) expect(["PATH_ESCAPE", "SYMLINK_REJECTED"]).toContain(result.errors[0]?.code);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
  });
});
