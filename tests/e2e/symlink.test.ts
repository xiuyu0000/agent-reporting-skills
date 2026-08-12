import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitFileTransaction,
  recoverTransactions,
  resolveOutputRoot,
  validateRelativeTarget,
} from "../../src/cli/io/index.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-symlink-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function target(path: string) {
  const result = validateRelativeTarget(path);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

async function rootSetup() {
  const parent = await temporaryDirectory();
  const output = join(parent, "output");
  await mkdir(output, { mode: 0o700 });
  const result = await resolveOutputRoot({ outputDir: output, creation: "must-exist", freshness: "allow-business-entries" });
  if (!result.ok) throw new Error("root setup failed");
  return { output, root: result.value };
}

describe("symlink rejection E2E", () => {
  it("rejects an output root that is itself a symbolic link", async () => {
    const parent = await temporaryDirectory();
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual);
    await symlink(actual, linked);
    const result = await resolveOutputRoot({
      outputDir: linked,
      creation: "must-exist",
      freshness: "allow-business-entries",
    });
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "SYMLINK_REJECTED" }] });
  });

  it("rejects a symbolic-link transaction container without replacing it", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "output");
    const outside = join(parent, "outside");
    await mkdir(output);
    await mkdir(outside);
    await symlink(outside, join(output, ".review-txn"));
    const result = await resolveOutputRoot({
      outputDir: output,
      creation: "must-exist",
      freshness: "allow-business-entries",
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED" }] });
  });

  it("rejects symbolic links in target parents and at the final target", async () => {
    const { output, root } = await rootSetup();
    const outside = await temporaryDirectory();
    await symlink(outside, join(output, "linked-parent"));
    const parentResult = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: target("linked-parent/report.txt"),
        bytes: encoder.encode("safe"),
        disposition: "create",
        verifyStaged: () => ({ ok: true }),
      }],
    });
    expect(parentResult).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED" }] });

    const external = join(outside, "external.txt");
    await writeFile(external, "outside");
    await symlink(external, join(output, "report.txt"));
    const finalResult = await commitFileTransaction({
      root,
      generatorVersion: "0.2.0",
      targets: [{
        target: target("report.txt"),
        bytes: encoder.encode("ours"),
        disposition: "create",
        verifyStaged: () => ({ ok: true }),
      }],
    });
    expect(finalResult).toMatchObject({ ok: false, errors: [{ code: "SYMLINK_REJECTED" }] });
    expect(await readFile(external, "utf8")).toBe("outside");
  });

  it("blocks recovery when a transaction entry is a symbolic link", async () => {
    const { output, root } = await rootSetup();
    const outside = await temporaryDirectory();
    await symlink(outside, join(output, ".review-txn", "TXN-00000000000000000000"));
    const result = await recoverTransactions({ root, generatorVersion: "0.2.0" });
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_MANIFEST_INVALID" }],
    });
  });
});
