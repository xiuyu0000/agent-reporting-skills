import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRelativeRegularFile,
  resolveExistingInputRoot,
  validateRelativeTarget,
  type ResolvedInputRoot,
  type ValidatedRelativeTarget,
} from "../../src/cli/io/index.js";
import {
  nativeFileSystemAdapter,
  readExactFileHandleBytes,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import {
  readRelativeRegularFileWithAdapter,
  resolveExistingInputRootWithAdapter,
} from "../../src/cli/io/paths.js";
import { sha256Bytes } from "../../src/protocol/index.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(process.cwd(), ".dar-cli-read-unit-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function inputSetup(): Promise<{ parent: string; input: string; root: ResolvedInputRoot }> {
  const parent = await temporaryDirectory();
  const input = join(parent, "input");
  await mkdir(input, { mode: 0o700 });
  const result = await resolveExistingInputRoot({ inputDir: input });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("input root setup failed");
  return { parent, input, root: result.value };
}

function target(relativePath: string): ValidatedRelativeTarget {
  const result = validateRelativeTarget(relativePath);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

async function resolvedRootWithAdapter(
  inputDir: string,
  adapter: PrivateFileSystemAdapter,
): Promise<ResolvedInputRoot> {
  const result = await resolveExistingInputRootWithAdapter({ inputDir }, adapter);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("input root setup failed");
  return result.value;
}

function statsWith(metadata: Stats, overrides: Partial<Pick<Stats, "dev" | "uid">>): Stats {
  return new Proxy(metadata, {
    get(subject, property, receiver) {
      if (property === "dev" && overrides.dev !== undefined) return overrides.dev;
      if (property === "uid" && overrides.uid !== undefined) return overrides.uid;
      const value: unknown = Reflect.get(subject, property, receiver);
      return typeof value === "function" ? value.bind(subject) : value;
    },
  });
}

describe("read-only CLI input facade", () => {
  it("resolves without creating transaction state and returns guarded bytes plus their digest", async () => {
    const { input, root } = await inputSetup();
    const nested = join(input, "nested");
    await mkdir(nested, { mode: 0o700 });
    const content = encoder.encode("verified input\n");
    await writeFile(join(nested, "review.json"), content, { mode: 0o600 });
    const entriesBefore = await readdir(input);

    const result = await readRelativeRegularFile({
      root,
      target: target("nested/review.json"),
      maxBytes: 1024,
    });

    expect(result).toEqual({ ok: true, value: { bytes: content, digest: sha256Bytes(content) } });
    expect(await readdir(input)).toEqual(entriesBefore);
    expect(await readdir(input)).not.toContain(".review-txn");
    expect(root).toMatchObject({ absolutePath: input });

    await writeFile(join(input, "empty.json"), new Uint8Array(), { mode: 0o600 });
    const empty = await readRelativeRegularFile({ root, target: target("empty.json"), maxBytes: 1 });
    expect(empty).toEqual({
      ok: true,
      value: { bytes: new Uint8Array(), digest: sha256Bytes(new Uint8Array()) },
    });
  });

  it("uses only read operations and opens the input with O_RDONLY, O_NOFOLLOW, and O_NONBLOCK", async () => {
    const parent = await temporaryDirectory();
    const input = join(parent, "input");
    await mkdir(input, { mode: 0o700 });
    await writeFile(join(input, "review.json"), "safe", { mode: 0o600 });
    const mutations: string[] = [];
    const openedFlags: number[] = [];
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      mkdir: async () => { mutations.push("mkdir"); throw new Error("mutation forbidden"); },
      readdir: async () => { mutations.push("readdir"); throw new Error("unexpected directory enumeration"); },
      link: async () => { mutations.push("link"); throw new Error("mutation forbidden"); },
      rename: async () => { mutations.push("rename"); throw new Error("mutation forbidden"); },
      unlink: async () => { mutations.push("unlink"); throw new Error("mutation forbidden"); },
      rmdir: async () => { mutations.push("rmdir"); throw new Error("mutation forbidden"); },
      checkpoint: async () => { mutations.push("checkpoint"); throw new Error("unexpected checkpoint"); },
      open: async (path, flags, mode) => {
        openedFlags.push(flags);
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        return new Proxy(handle, {
          get(subject, property, receiver) {
            if (property === "write" || property === "writeFile" || property === "chmod" || property === "sync") {
              return async () => { mutations.push(String(property)); throw new Error("handle mutation forbidden"); };
            }
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        }) as FileHandle;
      },
    };

    const resolved = await resolveExistingInputRootWithAdapter({ inputDir: input }, adapter);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("input root setup failed");
    const read = await readRelativeRegularFileWithAdapter({
      root: resolved.value,
      target: target("review.json"),
      maxBytes: 128,
    }, adapter);
    expect(read.ok).toBe(true);
    expect(mutations).toEqual([]);
    expect(openedFlags).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
    expect(openedFlags[0]! & (
      constants.O_WRONLY
      | constants.O_RDWR
      | constants.O_CREAT
      | constants.O_TRUNC
      | constants.O_APPEND
    )).toBe(0);
    expect(await readdir(input)).toEqual(["review.json"]);
  });

  it("rejects malformed public inputs and bounded-read violations without leaking paths or content", async () => {
    const missingPath = join(await temporaryDirectory(), "missing");
    const malformedRoots = [
      null,
      [],
      { inputDir: "" },
      { inputDir: "bad\0path" },
      new Proxy({ inputDir: missingPath }, { get: () => { throw new Error("secret getter text"); } }),
      { inputDir: missingPath },
    ];
    for (const malformed of malformedRoots) {
      const result = await resolveExistingInputRoot(malformed as { inputDir: string });
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{ code: "PATH_INVALID", path: "/inputDir" }],
      });
      expect(JSON.stringify(result)).not.toContain(missingPath);
      expect(JSON.stringify(result)).not.toContain("secret getter text");
    }

    const { input, root } = await inputSetup();
    await writeFile(join(input, "review.json"), "secret-body", { mode: 0o600 });
    const validTarget = target("review.json");
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_INPUT_FILE_BYTES + 1];
    for (const maxBytes of invalidLimits) {
      const result = await readRelativeRegularFile({ root, target: validTarget, maxBytes });
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{ code: "PATH_INVALID", path: "/maxBytes" }],
      });
    }
    const tooLarge = await readRelativeRegularFile({ root, target: validTarget, maxBytes: 1 });
    expect(tooLarge).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });
    expect(JSON.stringify(tooLarge)).not.toContain(input);
    expect(JSON.stringify(tooLarge)).not.toContain("secret-body");
    const missing = await readRelativeRegularFile({ root, target: target("missing.json"), maxBytes: 128 });
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });
    const missingParent = await readRelativeRegularFile({
      root,
      target: target("missing-parent/review.json"),
      maxBytes: 128,
    });
    expect(missingParent).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    const forgedRoot = await readRelativeRegularFile({
      root: { absolutePath: input } as ResolvedInputRoot,
      target: validTarget,
      maxBytes: 128,
    });
    expect(forgedRoot).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/root" }] });
    const forgedTarget = await readRelativeRegularFile({
      root,
      target: { relativePath: "review.json", portableKey: "review.json" } as ValidatedRelativeTarget,
      maxBytes: 128,
    });
    expect(forgedTarget).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    const hostileRoot = await readRelativeRegularFile(new Proxy(
      { root, target: validTarget, maxBytes: 128 },
      { get: (_subject, property) => property === "root" ? (() => { throw new Error("root getter"); })() : validTarget },
    ));
    expect(hostileRoot).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/root" }] });
    const hostileTarget = await readRelativeRegularFile(new Proxy(
      { root, target: validTarget, maxBytes: 128 },
      { get: (subject, property, receiver) => property === "target"
        ? (() => { throw new Error("target getter"); })()
        : Reflect.get(subject, property, receiver) },
    ));
    expect(hostileTarget).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });
    const hostileLimit = await readRelativeRegularFile(new Proxy(
      { root, target: validTarget, maxBytes: 128 },
      { get: (subject, property, receiver) => property === "maxBytes"
        ? (() => { throw new Error("limit getter"); })()
        : Reflect.get(subject, property, receiver) },
    ));
    expect(hostileLimit).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/maxBytes" }] });
  });

  it("rejects symlinks, unsafe modes, hard links, non-files, and unsafe root boundaries", async () => {
    const parent = await temporaryDirectory();
    const actual = join(parent, "actual");
    const linkedRoot = join(parent, "linked-root");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linkedRoot);
    const symlinkRoot = await resolveExistingInputRoot({ inputDir: linkedRoot });
    expect(symlinkRoot).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED", path: "/inputDir" }] });

    const writableRoot = join(parent, "writable-root");
    await mkdir(writableRoot, { mode: 0o770 });
    await chmod(writableRoot, 0o770);
    const unsafeRoot = await resolveExistingInputRoot({ inputDir: writableRoot });
    expect(unsafeRoot).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/inputDir" }] });

    const writableAncestor = join(parent, "writable-ancestor");
    const nestedRoot = join(writableAncestor, "nested-root");
    await mkdir(nestedRoot, { recursive: true, mode: 0o700 });
    await chmod(writableAncestor, 0o777);
    await chmod(nestedRoot, 0o700);
    const allowedAncestor = await resolveExistingInputRoot({ inputDir: nestedRoot });
    expect(allowedAncestor).toMatchObject({ ok: true, value: { absolutePath: nestedRoot } });
    await chmod(writableAncestor, 0o700);

    const { input, root } = await inputSetup();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "outside.json"), "outside", { mode: 0o600 });
    await symlink(outside, join(input, "linked-parent"));
    const linkedParent = await readRelativeRegularFile({
      root,
      target: target("linked-parent/outside.json"),
      maxBytes: 128,
    });
    expect(linkedParent).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED", path: "/target" }] });

    await symlink(join(outside, "outside.json"), join(input, "linked-final.json"));
    const linkedFinal = await readRelativeRegularFile({
      root,
      target: target("linked-final.json"),
      maxBytes: 128,
    });
    expect(linkedFinal).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED", path: "/target" }] });

    const unsafeParent = join(input, "unsafe-parent");
    await mkdir(unsafeParent, { mode: 0o770 });
    await chmod(unsafeParent, 0o770);
    await writeFile(join(unsafeParent, "review.json"), "safe", { mode: 0o600 });
    const unsafeParentResult = await readRelativeRegularFile({
      root,
      target: target("unsafe-parent/review.json"),
      maxBytes: 128,
    });
    expect(unsafeParentResult).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    await writeFile(join(input, "writable.json"), "unsafe", { mode: 0o660 });
    await chmod(join(input, "writable.json"), 0o660);
    const writableFile = await readRelativeRegularFile({
      root,
      target: target("writable.json"),
      maxBytes: 128,
    });
    expect(writableFile).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    await writeFile(join(input, "hard-linked.json"), "unsafe", { mode: 0o600 });
    await link(join(input, "hard-linked.json"), join(input, "second-link.json"));
    const hardLinked = await readRelativeRegularFile({
      root,
      target: target("hard-linked.json"),
      maxBytes: 128,
    });
    expect(hardLinked).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    await mkdir(join(input, "directory.json"), { mode: 0o700 });
    const directory = await readRelativeRegularFile({
      root,
      target: target("directory.json"),
      maxBytes: 128,
    });
    expect(directory).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });
  });

  it("binds the whole input-root chain and rejects file ownership or device mismatches", async () => {
    const { parent, input, root } = await inputSetup();
    const file = join(input, "review.json");
    await writeFile(file, "safe", { mode: 0o600 });

    await chmod(input, 0o710);
    const changedRoot = await readRelativeRegularFile({ root, target: target("review.json"), maxBytes: 128 });
    expect(changedRoot).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/root" }],
    });
    await chmod(input, 0o700);

    await chmod(parent, 0o710);
    const changedAncestor = await readRelativeRegularFile({ root, target: target("review.json"), maxBytes: 128 });
    expect(changedAncestor).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/root" }],
    });
    await chmod(parent, 0o700);

    const metadata = await nativeFileSystemAdapter.lstat(file);
    const foreignOwner: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === file
        ? statsWith(await nativeFileSystemAdapter.lstat(path), { uid: metadata.uid + 1 })
        : nativeFileSystemAdapter.lstat(path),
    };
    const ownerResult = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, foreignOwner);
    expect(ownerResult).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    const otherDevice: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === file
        ? statsWith(await nativeFileSystemAdapter.lstat(path), { dev: metadata.dev + 1 })
        : nativeFileSystemAdapter.lstat(path),
    };
    const deviceResult = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, otherDevice);
    expect(deviceResult).toMatchObject({
      ok: false,
      errors: [{ code: "CROSS_DEVICE_TRANSACTION", path: "/target" }],
    });
  });

  it("allows a sticky writable system ancestor while enforcing root and inner-parent safety", async () => {
    const { input } = await inputSetup();
    const rootMetadata = await nativeFileSystemAdapter.lstat(input);
    const filesystemRoot = input.slice(0, input.indexOf("/", 1)) || "/";
    const writableAncestorAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        const metadata = await nativeFileSystemAdapter.lstat(path);
        if (path !== filesystemRoot && path !== "/") return metadata;
        return new Proxy(metadata, {
          get(subject, property, receiver) {
            if (property === "mode") return (metadata.mode & ~0o7777) | 0o1777;
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        });
      },
    };
    const allowed = await resolveExistingInputRootWithAdapter({ inputDir: input }, writableAncestorAdapter);
    expect(allowed).toMatchObject({ ok: true, value: { absolutePath: input } });

    const unsafeRootAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        const metadata = await nativeFileSystemAdapter.lstat(path);
        if (path !== input) return metadata;
        return new Proxy(metadata, {
          get(subject, property, receiver) {
            if (property === "mode") return (rootMetadata.mode & ~0o777) | 0o770;
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        });
      },
    };
    const unsafeRoot = await resolveExistingInputRootWithAdapter({ inputDir: input }, unsafeRootAdapter);
    expect(unsafeRoot).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/inputDir" }] });

    const root = await resolvedRootWithAdapter(input, nativeFileSystemAdapter);
    const nested = join(input, "nested");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "review.json"), "safe", { mode: 0o600 });
    const nestedMetadata = await nativeFileSystemAdapter.lstat(nested);
    const unsafeNestedAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        const metadata = await nativeFileSystemAdapter.lstat(path);
        if (path !== nested) return metadata;
        return new Proxy(metadata, {
          get(subject, property, receiver) {
            if (property === "mode") return (nestedMetadata.mode & ~0o777) | 0o770;
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        });
      },
    };
    const unsafeNested = await readRelativeRegularFileWithAdapter({
      root,
      target: target("nested/review.json"),
      maxBytes: 128,
    }, unsafeNestedAdapter);
    expect(unsafeNested).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID", path: "/target" }] });

    const failedNestedAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        if (path === nested) throw Object.assign(new Error("device unavailable"), { code: "EIO" });
        return nativeFileSystemAdapter.lstat(path);
      },
    };
    const failedNested = await readRelativeRegularFileWithAdapter({
      root,
      target: target("nested/review.json"),
      maxBytes: 128,
    }, failedNestedAdapter);
    expect(failedNested).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });
  });

  it("fails closed when the file changes between lstat and fstat", async () => {
    const { input, root } = await inputSetup();
    const file = join(input, "review.json");
    await writeFile(file, "before", { mode: 0o600 });
    let changed = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        if (!changed && path === file) {
          changed = true;
          await writeFile(file, "after!", { mode: 0o600 });
        }
        return handle;
      },
    };
    const result = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });
  });

  it.skipIf(process.platform === "win32")(
    "opens a raced FIFO nonblocking and immediately fails closed",
    async () => {
      const { input, root } = await inputSetup();
      const file = join(input, "review.json");
      const held = join(input, "review-held.json");
      const fifo = join(input, "review-replacement.fifo");
      await writeFile(file, "regular-before-open", { mode: 0o600 });
      await execFileAsync("mkfifo", [fifo]);
      await chmod(fifo, 0o600);
      let swapped = false;
      let openedNonblocking = false;
      const adapter: PrivateFileSystemAdapter = {
        ...nativeFileSystemAdapter,
        open: async (path, flags, mode) => {
          if ((flags & constants.O_NONBLOCK) === 0) {
            throw new Error("O_NONBLOCK is required before the FIFO replacement");
          }
          openedNonblocking = true;
          if (path === file && !swapped) {
            swapped = true;
            await rename(file, held);
            await rename(fifo, file);
          }
          return nativeFileSystemAdapter.open(path, flags, mode);
        },
      };
      const deadlineMs = 1_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        const result = await Promise.race([
          readRelativeRegularFileWithAdapter({
            root,
            target: target("review.json"),
            maxBytes: 128,
          }, adapter),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("FIFO open exceeded its deadline")), deadlineMs);
          }),
        ]);
        expect(performance.now() - started).toBeLessThan(deadlineMs);
        expect(openedNonblocking).toBe(true);
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          ok: false,
          mutated: false,
          recoveryRequired: false,
          errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  );

  it("fails closed on parent permission/identity swaps and a final-target replacement", async () => {
    const { input, root } = await inputSetup();
    const nested = join(input, "nested");
    const nestedHeld = join(input, "nested-held");
    const outside = await temporaryDirectory();
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "review.json"), "original", { mode: 0o600 });
    await writeFile(join(outside, "review.json"), "replacement", { mode: 0o600 });
    let nestedRealpathCalls = 0;
    let parentSwapped = false;
    const parentSwapAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      realpath: async (path) => {
        const observed = await nativeFileSystemAdapter.realpath(path);
        if (path === nested && ++nestedRealpathCalls === 1) {
          await rename(nested, nestedHeld);
          await symlink(outside, nested);
          parentSwapped = true;
        }
        return observed;
      },
    };
    const parentSwap = await readRelativeRegularFileWithAdapter({
      root,
      target: target("nested/review.json"),
      maxBytes: 128,
    }, parentSwapAdapter);
    expect(parentSwap).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "SYMLINK_REJECTED", path: "/target" }],
    });
    expect(parentSwapped).toBe(true);
    await rm(nested);
    await rename(nestedHeld, nested);

    let nestedStats = 0;
    const permissionAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        const metadata = await nativeFileSystemAdapter.lstat(path);
        if (path === nested && ++nestedStats >= 2) {
          return new Proxy(metadata, {
            get(subject, property, receiver) {
              if (property === "mode") return (metadata.mode & ~0o777) | 0o770;
              const value: unknown = Reflect.get(subject, property, receiver);
              return typeof value === "function" ? value.bind(subject) : value;
            },
          });
        }
        return metadata;
      },
    };
    const permissionChange = await readRelativeRegularFileWithAdapter({
      root,
      target: target("nested/review.json"),
      maxBytes: 128,
    }, permissionAdapter);
    expect(permissionChange).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });

    const final = join(input, "final.json");
    const held = join(input, "final-held.json");
    const replacement = join(input, "replacement.json");
    await writeFile(final, "original", { mode: 0o600 });
    await writeFile(replacement, "different-size", { mode: 0o600 });
    let finalSwapped = false;
    const finalSwapAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        if (path === final && !finalSwapped) {
          finalSwapped = true;
          await rename(final, held);
          await rename(replacement, final);
        }
        return nativeFileSystemAdapter.open(path, flags, mode);
      },
    };
    const targetSwap = await readRelativeRegularFileWithAdapter({
      root,
      target: target("final.json"),
      maxBytes: 128,
    }, finalSwapAdapter);
    expect(targetSwap).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });
    await rm(final);
    await rename(held, final);

    const afterClose = join(input, "after-close.json");
    const afterCloseHeld = join(input, "after-close-held.json");
    const afterCloseReplacement = join(input, "after-close-replacement.json");
    await writeFile(afterClose, "original", { mode: 0o600 });
    await writeFile(afterCloseReplacement, "replacement", { mode: 0o600 });
    let swappedAfterClose = false;
    const afterCloseAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        if (path !== afterClose) return handle;
        return new Proxy(handle, {
          get(subject, property, receiver) {
            if (property === "close") {
              return async () => {
                await handle.close();
                await rename(afterClose, afterCloseHeld);
                await rename(afterCloseReplacement, afterClose);
                swappedAfterClose = true;
              };
            }
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        }) as FileHandle;
      },
    };
    const afterCloseSwap = await readRelativeRegularFileWithAdapter({
      root,
      target: target("after-close.json"),
      maxBytes: 128,
    }, afterCloseAdapter);
    expect(swappedAfterClose).toBe(true);
    expect(afterCloseSwap).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });
    await rm(afterClose);
    await rename(afterCloseHeld, afterClose);
  });

  it("detects growth and shrinkage during the bounded read", async () => {
    const { input, root } = await inputSetup();
    const file = join(input, "review.json");
    await writeFile(file, "abc", { mode: 0o600 });
    let grew = false;
    const growthAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        if (path !== file) return handle;
        return new Proxy(handle, {
          get(subject, property, receiver) {
            if (property === "read") {
              return async (...args: Parameters<FileHandle["read"]>) => {
                const result = await handle.read(...args);
                if (!grew) {
                  grew = true;
                  await appendFile(file, "d");
                }
                return result;
              };
            }
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        }) as FileHandle;
      },
    };
    const growth = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, growthAdapter);
    expect(growth).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });

    await writeFile(file, "abcdef", { mode: 0o600 });
    let shrank = false;
    const shrinkAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        if (path !== file) return handle;
        return new Proxy(handle, {
          get(subject, property, receiver) {
            if (property === "read") {
              return async (...args: Parameters<FileHandle["read"]>) => {
                if (!shrank) {
                  shrank = true;
                  await truncate(file, 1);
                }
                return handle.read(...args);
              };
            }
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        }) as FileHandle;
      },
    };
    const shrink = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, shrinkAdapter);
    expect(shrink).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });

    await writeFile(file, "present", { mode: 0o600 });
    let disappeared = false;
    const disappearanceAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (path, flags, mode) => {
        const handle = await nativeFileSystemAdapter.open(path, flags, mode);
        if (path !== file) return handle;
        return new Proxy(handle, {
          get(subject, property, receiver) {
            if (property === "read") {
              return async (...args: Parameters<FileHandle["read"]>) => {
                const result = await handle.read(...args);
                if (!disappeared) {
                  disappeared = true;
                  await unlink(file);
                }
                return result;
              };
            }
            const value: unknown = Reflect.get(subject, property, receiver);
            return typeof value === "function" ? value.bind(subject) : value;
          },
        }) as FileHandle;
      },
    };
    const disappearance = await readRelativeRegularFileWithAdapter({
      root,
      target: target("review.json"),
      maxBytes: 128,
    }, disappearanceAdapter);
    expect(disappearance).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
    });
  });

  it("maps open, read, and close faults to a content-free I/O failure", async () => {
    const { input, root } = await inputSetup();
    const file = join(input, "review.json");
    await writeFile(file, "secret-content", { mode: 0o600 });
    const validatedTarget = target("review.json");
    const faultAdapters: PrivateFileSystemAdapter[] = [
      {
        ...nativeFileSystemAdapter,
        open: async () => { throw Object.assign(new Error("open secret"), { code: "EACCES" }); },
      },
      {
        ...nativeFileSystemAdapter,
        open: async (path, flags, mode) => {
          const handle = await nativeFileSystemAdapter.open(path, flags, mode);
          return new Proxy(handle, {
            get(subject, property, receiver) {
              if (property === "read") return async () => { throw new Error("read secret"); };
              const value: unknown = Reflect.get(subject, property, receiver);
              return typeof value === "function" ? value.bind(subject) : value;
            },
          }) as FileHandle;
        },
      },
      {
        ...nativeFileSystemAdapter,
        open: async (path, flags, mode) => {
          const handle = await nativeFileSystemAdapter.open(path, flags, mode);
          return new Proxy(handle, {
            get(subject, property, receiver) {
              if (property === "close") {
                return async () => {
                  await handle.close();
                  throw new Error("close secret");
                };
              }
              const value: unknown = Reflect.get(subject, property, receiver);
              return typeof value === "function" ? value.bind(subject) : value;
            },
          }) as FileHandle;
        },
      },
    ];
    for (const adapter of faultAdapters) {
      const result = await readRelativeRegularFileWithAdapter({
        root,
        target: validatedTarget,
        maxBytes: 128,
      }, adapter);
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{ code: "IO_OPERATION_FAILED", path: "/target" }],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(input);
      expect(serialized).not.toContain("secret-content");
      expect(serialized).not.toContain("secret");
    }
  });

  it("rejects a preflight oversize file before opening or allocating its declared size", async () => {
    const { input, root } = await inputSetup();
    const file = join(input, "oversize.json");
    await writeFile(file, "two", { mode: 0o600 });
    let opened = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      open: async (...args) => {
        opened = true;
        return nativeFileSystemAdapter.open(...args);
      },
    };
    const result = await readRelativeRegularFileWithAdapter({
      root,
      target: target("oversize.json"),
      maxBytes: 1,
    }, adapter);
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "PATH_INVALID", path: "/target" }],
    });
    expect(opened).toBe(false);
  });
});

describe("bounded file-handle reader", () => {
  it("reads an exact snapshot and rejects invalid, short, or growing sizes", async () => {
    const parent = await temporaryDirectory();
    const file = join(parent, "bounded.bin");
    await writeFile(file, "abc", { mode: 0o600 });
    let handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await expect(readExactFileHandleBytes(handle, -1, 3)).rejects.toThrow();
      await expect(readExactFileHandleBytes(handle, 3, 0)).rejects.toThrow();
      await expect(readExactFileHandleBytes(handle, 3, 2)).rejects.toThrow();
      await expect(readExactFileHandleBytes(handle, 3, 3)).resolves.toEqual(encoder.encode("abc"));
    } finally {
      await handle.close();
    }

    await writeFile(file, "abcdef", { mode: 0o600 });
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await expect(readExactFileHandleBytes(handle, 3, 3)).rejects.toThrow("grew");
    } finally {
      await handle.close();
    }

    await writeFile(file, "a", { mode: 0o600 });
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await expect(readExactFileHandleBytes(handle, 3, 3)).rejects.toThrow("size changed");
    } finally {
      await handle.close();
    }
  });
});
