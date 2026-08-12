import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitFileTransaction,
  resolveOutputRoot,
  validateRelativeTarget,
} from "../../src/cli/io/index.js";
import {
  nativeFileSystemAdapter,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import { commitFileTransactionWithAdapter } from "../../src/cli/io/transaction.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-path-boundary-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function rootSetup() {
  const parent = await temporaryDirectory();
  const output = join(parent, "output");
  await mkdir(output, { mode: 0o700 });
  const result = await resolveOutputRoot({
    outputDir: output,
    creation: "must-exist",
    freshness: "allow-business-entries",
  });
  if (!result.ok) throw new Error("root setup failed");
  return { parent, output, root: result.value };
}

function validated(path: string) {
  const result = validateRelativeTarget(path);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

function verifier() {
  return { ok: true } as const;
}

function statsWithDevice(metadata: Stats, device: number): Stats {
  return new Proxy(metadata, {
    get(target, property, receiver) {
      if (property === "dev") return device;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("path-boundary E2E", () => {
  it("requires every business parent directory to exist before transaction creation", async () => {
    const { output, root } = await rootSetup();
    const missing = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: validated("missing/child/report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: verifier,
      }],
    });
    expect(missing).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    expect(await readdir(output)).toEqual([".review-txn"]);

    await writeFile(join(output, "not-a-directory"), "file");
    const wrongType = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: validated("not-a-directory/report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: verifier,
      }],
    });
    expect(wrongType).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });
  });

  it("rejects a target-parent device mismatch before creating a random transaction", async () => {
    const { output, root } = await rootSetup();
    const nested = join(output, "nested");
    await mkdir(nested);
    const nestedMetadata = await lstat(nested);
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === nested
        ? statsWithDevice(await nativeFileSystemAdapter.lstat(path), nestedMetadata.dev + 1)
        : nativeFileSystemAdapter.lstat(path),
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: validated("nested/report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: verifier,
      }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "CROSS_DEVICE_TRANSACTION" }] });
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("detects a parent-directory swap after staging and never writes outside the root", async () => {
    const { output, root } = await rootSetup();
    const outside = await temporaryDirectory();
    const nested = join(output, "nested");
    const held = join(output, "nested-held");
    await mkdir(nested);
    let swapped = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!swapped && point === "stage-written:0") {
          swapped = true;
          await rename(nested, held);
          await symlink(outside, nested);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: validated("nested/report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: verifier,
      }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "SYMLINK_REJECTED" }] });
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
    await unlink(nested);
    await rename(held, nested);
  });

  it("detects a target created after preflight and does not overwrite it", async () => {
    const { output, root } = await rootSetup();
    const final = join(output, "report.txt");
    let raced = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!raced && point === "stage-written:0") {
          raced = true;
          await writeFile(final, "racer");
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("report.txt"), bytes: encoder.encode("ours"), disposition: "create", verifyStaged: verifier }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "TARGET_EXISTS" }] });
    expect(await readFile(final, "utf8")).toBe("racer");
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("detects a target-parent permission change after staging and rolls back safely", async () => {
    const { output, root } = await rootSetup();
    const nested = join(output, "nested");
    await mkdir(nested, { mode: 0o700 });
    let changed = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!changed && point === "stage-written:0") {
          changed = true;
          await chmod(nested, 0o777);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("nested/report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
    expect(await readdir(nested)).toEqual([]);
    await chmod(nested, 0o700);
  });

  it("fails closed when output-root permissions change during a transaction", async () => {
    const { output, root } = await rootSetup();
    let changed = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!changed && point === "stage-written:0") {
          changed = true;
          await chmod(output, 0o777);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: true, recoveryRequired: true });
    await expect(readFile(join(output, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(output, 0o700);
  });

  it("detects transaction-directory ABA replacement before manifest publication", async () => {
    const { output, root } = await rootSetup();
    let swapped = false;
    let held = "";
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!swapped && point === "stage-written:0") {
          swapped = true;
          const entries = (await readdir(join(output, ".review-txn"))).filter((entry) => entry.startsWith("TXN-"));
          const name = entries[0] as string;
          const transaction = join(output, ".review-txn", name);
          held = join(output, `${name}-held`);
          await rename(transaction, held);
          await mkdir(transaction, { mode: 0o700 });
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
    expect(held).not.toBe("");
    expect(await readdir(held)).toEqual(["stage-000000.bin"]);
    await expect(readFile(join(output, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects transaction-directory permission drift before continuing", async () => {
    const { output, root } = await rootSetup();
    let changed = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!changed && point === "stage-written:0") {
          changed = true;
          const entries = await readdir(join(output, ".review-txn"));
          await chmod(join(output, ".review-txn", entries[0] as string), 0o777);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: true, recoveryRequired: true });
    await expect(readFile(join(output, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects manifest hard-link and inode substitution instead of continuing to success", async () => {
    for (const mutation of ["hard-link", "inode-swap"] as const) {
      const { output, root } = await rootSetup();
      let changed = false;
      const adapter: PrivateFileSystemAdapter = {
        ...nativeFileSystemAdapter,
        checkpoint: async (point) => {
          if (!changed && point === "manifest-published:staged") {
            changed = true;
            const entries = (await readdir(join(output, ".review-txn"))).filter((entry) => entry.startsWith("TXN-"));
            const directory = join(output, ".review-txn", entries[0] as string);
            const manifest = join(directory, "manifest.json");
            if (mutation === "hard-link") {
              await link(manifest, join(directory, "manifest-hardlink"));
            } else {
              const contents = await readFile(manifest);
              const replacement = join(directory, "manifest-replacement");
              await writeFile(replacement, contents, { mode: 0o600 });
              await chmod(replacement, 0o600);
              await rename(replacement, manifest);
            }
          }
        },
      };
      const result = await commitFileTransactionWithAdapter({
        root,
        generatorVersion: "0.2.0",
        targets: [{ target: validated("report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
      }, adapter);
      expect(result.ok).toBe(false);
      await expect(readFile(join(output, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      if (mutation === "hard-link") {
        expect(result).toMatchObject({ ok: false, mutated: true, recoveryRequired: true });
      } else {
        expect(result).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
      }
    }
  });

  it("detects output-root inode replacement before a write", async () => {
    const { parent, output, root } = await rootSetup();
    const held = join(parent, "output-held");
    await rename(output, held);
    await mkdir(output, { mode: 0o700 });
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{ target: validated("report.txt"), bytes: encoder.encode("safe"), disposition: "create", verifyStaged: verifier }],
    });
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID" }],
    });
    expect(await readdir(output)).toEqual([]);
    expect(await readdir(held)).toEqual([".review-txn"]);
  });

  it("removes a root created by this call when preflight fails and identity remains unchanged", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "fresh-output");
    const rootResult = await resolveOutputRoot({
      outputDir: output,
      creation: "create-if-missing",
      freshness: "require-no-business-entries",
    });
    if (!rootResult.ok) throw new Error("root creation failed");
    const result = await commitFileTransaction({
      root: rootResult.value,
      generatorVersion: "0.2.0",
      targets: [{
        target: validated("report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: () => ({ ok: false }),
      }],
    });
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "STAGED_CONTENT_INVALID" }] });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on invalid generator versions and empty plans", async () => {
    const { root } = await rootSetup();
    expect(await commitFileTransaction({ root, generatorVersion: "latest", targets: [] })).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID", path: "/generatorVersion" }],
    });
    expect(await commitFileTransaction({ root, generatorVersion: "0.2.0", targets: [] })).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID", path: "/targets" }],
    });
  });
});
