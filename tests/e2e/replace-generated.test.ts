import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-replace-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const parent = await temporaryDirectory();
  const output = join(parent, "output");
  await mkdir(output, { mode: 0o700 });
  const rootResult = await resolveOutputRoot({ outputDir: output, creation: "must-exist", freshness: "allow-business-entries" });
  const targetResult = validateRelativeTarget("approval.html");
  if (!rootResult.ok || !targetResult.ok) throw new Error("setup failed");
  const created = await commitFileTransaction({
    root: rootResult.value,
    generatorVersion: "0.2.0",
    targets: [{
      target: targetResult.value,
      bytes: encoder.encode("delivery=RDL-OLD document=RD-OLD generator=0.2.0"),
      disposition: "create",
      verifyStaged: () => ({ ok: true }),
    }],
  });
  if (!created.ok) throw new Error("initial create failed");
  return { output, root: rootResult.value, target: targetResult.value };
}

const expectedExisting = (input: Uint8Array) => ({
  ok: new TextDecoder().decode(input).includes("delivery=RDL-OLD document=RD-OLD generator=0.2.0"),
} as { ok: true } | { ok: false });

describe("replace-generated E2E", () => {
  it("uses the caller identity verifier before backup and installs exact new bytes", async () => {
    const { output, root, target } = await setup();
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("delivery=RDL-OLD document=RD-OLD generator=0.2.0 revised"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: expectedExisting,
      }],
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(output, "approval.html"), "utf8")).toContain("revised");
    expect((await stat(join(output, "approval.html"))).mode & 0o777).toBe(0o600);
  });

  it("fails before mutation when the generated marker or identity does not match", async () => {
    const { output, root, target } = await setup();
    const before = await readFile(join(output, "approval.html"));
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("replacement"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: () => ({ ok: false }),
      }],
    });
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });
    expect(await readFile(join(output, "approval.html"))).toEqual(before);
  });

  it("detects in-place content change between preflight and backup", async () => {
    const { output, root, target } = await setup();
    const final = join(output, "approval.html");
    let raced = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!raced && point === "stage-written:0") {
          raced = true;
          await writeFile(final, "attacker changed bytes");
          await chmod(final, 0o600);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("replacement"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: () => ({ ok: true }),
      }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });
    expect(await readFile(final, "utf8")).toBe("attacker changed bytes");
  });

  it("detects inode replacement between preflight and backup", async () => {
    const { output, root, target } = await setup();
    const final = join(output, "approval.html");
    const held = join(output, "approval-held.html");
    let raced = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!raced && point === "stage-written:0") {
          raced = true;
          await rename(final, held);
          await writeFile(final, "different inode", { mode: 0o600 });
          await chmod(final, 0o600);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("replacement"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: () => ({ ok: true }),
      }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });
    expect(await readFile(final, "utf8")).toBe("different inode");
    expect(await readFile(held, "utf8")).toContain("delivery=RDL-OLD");
  });

  it("detects a final-target symlink swap and does not alter the external file", async () => {
    const { output, root, target } = await setup();
    const outside = await temporaryDirectory();
    const external = join(outside, "external.html");
    const final = join(output, "approval.html");
    const held = join(output, "approval-held.html");
    await writeFile(external, "outside");
    let raced = false;
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (!raced && point === "stage-written:0") {
          raced = true;
          await rename(final, held);
          await symlink(external, final);
        }
      },
    };
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("replacement"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: () => ({ ok: true }),
      }],
    }, adapter);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED" }] });
    expect(await readFile(external, "utf8")).toBe("outside");
  });
});

describe("replace-generated identical bytes", () => {
  it("stays a healthy no-op and leaves the root writable for the next real replacement", async () => {
    // Re-running a replace after a retry, or after a source edit that does not
    // change generated output, produces exactly the installed bytes. Generation is
    // deterministic, so this is the ordinary repeat path rather than a corner case.
    const { output, root, target } = await setup();
    const identical = encoder.encode("delivery=RDL-OLD document=RD-OLD generator=0.2.0");

    const first = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: identical,
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: expectedExisting,
      }],
    });
    expect(first).toMatchObject({ ok: true });
    expect(await readFile(join(output, "approval.html"), "utf8"))
      .toBe("delivery=RDL-OLD document=RD-OLD generator=0.2.0");

    // The decisive property: the root is not wedged. Before the fix this second
    // command failed with TRANSACTION_RECOVERY_BLOCKED and stayed blocked forever.
    const next = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target,
        bytes: encoder.encode("delivery=RDL-NEW document=RD-NEW generator=0.2.0"),
        disposition: "replace",
        verifyStaged: () => ({ ok: true }),
        verifyExisting: expectedExisting,
      }],
    });
    expect(next).toMatchObject({ ok: true });
    expect(await readFile(join(output, "approval.html"), "utf8"))
      .toBe("delivery=RDL-NEW document=RD-NEW generator=0.2.0");
  });
});
