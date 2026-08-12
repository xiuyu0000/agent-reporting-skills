import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_INPUT_FILE_BYTES,
  readRelativeRegularFile,
  resolveExistingInputRoot,
  validateRelativeTarget,
  type ResolvedInputRoot,
  type ValidatedRelativeTarget,
} from "../../src/cli/io/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(process.cwd(), ".dar-read-input-e2e-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "other";
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: number;
  digest?: string;
  linkTarget?: string;
}

async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path);
    const relativePath = relative(root, path) || ".";
    const common = {
      relativePath,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
    };
    if (metadata.isSymbolicLink()) {
      entries.push({ ...common, kind: "symlink", linkTarget: await readlink(path) });
      return;
    }
    if (metadata.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      const children = await readdir(path);
      children.sort();
      for (const child of children) await visit(join(path, child));
      return;
    }
    if (metadata.isFile()) {
      const bytes = await readFile(path);
      entries.push({ ...common, kind: "file", digest: createHash("sha256").update(bytes).digest("hex") });
      return;
    }
    entries.push({ ...common, kind: "other" });
  }
  await visit(root);
  return entries;
}

function target(relativePath: string): ValidatedRelativeTarget {
  const result = validateRelativeTarget(relativePath);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

async function resolvedRoot(input: string): Promise<ResolvedInputRoot> {
  const result = await resolveExistingInputRoot({ inputDir: input });
  if (!result.ok) throw new Error("root setup failed");
  return result.value;
}

describe("read-only input I/O E2E", () => {
  it("reads nested content at the frozen 64 MiB boundary without changing the tree", async () => {
    const parent = await temporaryDirectory();
    const input = join(parent, "input");
    const nested = join(input, "nested");
    const file = join(nested, "boundary.bin");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await chmod(input, 0o700);
    await chmod(nested, 0o700);
    const handle = await open(file, "w", 0o600);
    try {
      await handle.truncate(MAX_INPUT_FILE_BYTES);
    } finally {
      await handle.close();
    }
    await chmod(file, 0o600);
    const before = await snapshotTree(parent);

    const result = await readRelativeRegularFile({
      root: await resolvedRoot(input),
      target: target("nested/boundary.bin"),
      maxBytes: MAX_INPUT_FILE_BYTES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("boundary read failed");
    expect(result.value.bytes.byteLength).toBe(MAX_INPUT_FILE_BYTES);
    expect(result.value.bytes[0]).toBe(0);
    expect(result.value.bytes[MAX_INPUT_FILE_BYTES - 1]).toBe(0);
    expect(result.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await snapshotTree(parent)).toEqual(before);
    expect(await readdir(input)).toEqual(["nested"]);
  }, 20_000);

  it("fails read-only for missing, symlinked, escaped, hard-linked, and permission-unsafe targets", async () => {
    const parent = await temporaryDirectory();
    const input = join(parent, "input");
    const outside = join(parent, "outside");
    await mkdir(input, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(input, "safe.json"), "safe", { mode: 0o600 });
    await writeFile(join(input, "unsafe.json"), "unsafe", { mode: 0o600 });
    await chmod(join(input, "unsafe.json"), 0o666);
    await writeFile(join(input, "hard.json"), "hard", { mode: 0o600 });
    await link(join(input, "hard.json"), join(input, "hard-2.json"));
    await writeFile(join(outside, "external.json"), "outside", { mode: 0o600 });
    await symlink(outside, join(input, "linked-parent"));
    await symlink(join(outside, "external.json"), join(input, "linked-final.json"));
    const root = await resolvedRoot(input);
    const before = await snapshotTree(parent);
    const cases: Array<{
      relativePath: string;
      code: "PATH_INVALID" | "SYMLINK_REJECTED";
    }> = [
      { relativePath: "missing.json", code: "PATH_INVALID" },
      { relativePath: "linked-parent/external.json", code: "SYMLINK_REJECTED" },
      { relativePath: "linked-final.json", code: "SYMLINK_REJECTED" },
      { relativePath: "hard.json", code: "PATH_INVALID" },
      { relativePath: "unsafe.json", code: "PATH_INVALID" },
    ];
    for (const testCase of cases) {
      const result = await readRelativeRegularFile({
        root,
        target: target(testCase.relativePath),
        maxBytes: 1024,
      });
      expect(result).toMatchObject({
        ok: false,
        mutated: false,
        recoveryRequired: false,
        errors: [{ code: testCase.code, path: "/target" }],
      });
      expect(JSON.stringify(result)).not.toContain(input);
      expect(JSON.stringify(result)).not.toContain("outside");
    }

    const escaped = validateRelativeTarget("../outside/external.json");
    expect(escaped).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    expect(await snapshotTree(parent)).toEqual(before);
    expect(await readdir(input)).not.toContain(".review-txn");
  });

  it("rejects root and parent identity swaps without reading the replacement", async () => {
    const parent = await temporaryDirectory();
    const input = join(parent, "input");
    const heldInput = join(parent, "input-held");
    const replacement = join(parent, "replacement");
    await mkdir(input, { mode: 0o700 });
    await mkdir(replacement, { mode: 0o700 });
    await writeFile(join(input, "review.json"), "original", { mode: 0o600 });
    await writeFile(join(replacement, "review.json"), "replacement-secret", { mode: 0o600 });
    const root = await resolvedRoot(input);
    const before = await snapshotTree(parent);

    await rename(input, heldInput);
    await rename(replacement, input);
    const rootSwap = await readRelativeRegularFile({
      root,
      target: target("review.json"),
      maxBytes: 1024,
    });
    expect(rootSwap).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/root" }],
    });
    expect(JSON.stringify(rootSwap)).not.toContain("replacement-secret");
    await rename(input, replacement);
    await rename(heldInput, input);
    expect(await snapshotTree(parent)).toEqual(before);

    const nested = join(input, "nested");
    const nestedHeld = join(input, "nested-held");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "review.json"), "nested-original", { mode: 0o600 });
    const symlinkTarget = join(parent, "replacement-parent");
    await mkdir(symlinkTarget, { mode: 0o700 });
    await writeFile(join(symlinkTarget, "review.json"), "nested-replacement-secret", { mode: 0o600 });
    const guardedNestedTarget = target("nested/review.json");
    const nestedBefore = await snapshotTree(parent);
    await rename(nested, nestedHeld);
    await symlink(symlinkTarget, nested);
    const parentSwap = await readRelativeRegularFile({ root, target: guardedNestedTarget, maxBytes: 1024 });
    expect(parentSwap).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "SYMLINK_REJECTED", path: "/target" }],
    });
    expect(JSON.stringify(parentSwap)).not.toContain("nested-replacement-secret");
    await rm(nested);
    await rename(nestedHeld, nested);
    expect(await snapshotTree(parent)).toEqual(nestedBefore);
  });
});
