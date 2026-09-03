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
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { exitCodeForCliIoResult } from "../../src/cli/exit-codes.js";
import {
  CLI_IO_ERROR_CODES,
  cliIoError,
  cliIoFailure,
  cliIoSuccess,
  isCliIoErrorCode,
} from "../../src/cli/result.js";
import {
  assertPortableTargetSet,
  commitFileTransaction,
  recoverTransactions,
  resolveOutputRoot,
  validateRelativeTarget,
  type FileTransactionTarget,
  type ResolvedOutputRoot,
  type ValidatedRelativeTarget,
} from "../../src/cli/io/index.js";
import { resolveOutputRootWithAdapter } from "../../src/cli/io/paths.js";
import {
  acquireWriterClaim,
  assertWriterClaim,
  listTransactionEntriesUnderWriterClaim,
  nativeFileSystemAdapter,
  releaseWriterClaim,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import { commitFileTransactionWithAdapter } from "../../src/cli/io/transaction.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-cli-io-unit-")));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function existingRoot(freshness: "allow-business-entries" | "require-no-business-entries" = "allow-business-entries") {
  const parent = await temporaryDirectory();
  const output = join(parent, "output");
  await mkdir(output, { mode: 0o700 });
  const result = await resolveOutputRoot({ outputDir: output, creation: "must-exist", freshness });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("root setup failed");
  return { parent, output, root: result.value };
}

function target(relativePath: string): ValidatedRelativeTarget {
  const result = validateRelativeTarget(relativePath);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("target setup failed");
  return result.value;
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function valid(): { ok: true } {
  return { ok: true };
}

function checkpointAdapter(point: string): PrivateFileSystemAdapter {
  let armed = true;
  return {
    ...nativeFileSystemAdapter,
    checkpoint: async (observed) => {
      if (armed && observed === point) {
        armed = false;
        throw new Error("injected filesystem checkpoint failure");
      }
    },
  };
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

async function emptyTransactionContainer(output: string): Promise<void> {
  expect(await readdir(join(output, ".review-txn"))).toEqual([]);
}

describe("CLI I/O result and exit-code boundary", () => {
  it("sorts safe errors and preserves the constrained mutation invariant", () => {
    const result = cliIoFailure([
      cliIoError("TARGET_EXISTS", "/targets/2"),
      cliIoError("PATH_INVALID", "/targets/1"),
    ]);
    expect(result).toEqual({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [
        cliIoError("PATH_INVALID", "/targets/1"),
        cliIoError("TARGET_EXISTS", "/targets/2"),
      ],
    });
    expect(cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/")], true)).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
    });
    expect(cliIoError("PATH_INVALID", "unsafe-path").path).toBe("/");
    expect(cliIoError("PATH_INVALID", "/unsafe\0path").path).toBe("/");
    expect(cliIoError("PATH_INVALID", 17 as unknown as string).path).toBe("/");
    expect(cliIoSuccess({ ready: true })).toEqual({ ok: true, value: { ready: true } });
    expect(isCliIoErrorCode("PATH_INVALID")).toBe(true);
    expect(isCliIoErrorCode("NOT_REAL")).toBe(false);
    expect(isCliIoErrorCode(null)).toBe(false);
    for (const code of CLI_IO_ERROR_CODES) {
      const error = cliIoError(code, "/all-codes");
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.hint.length).toBeGreaterThan(0);
    }
    const samePath = cliIoFailure([
      cliIoError("TARGET_EXISTS", "/same"),
      cliIoError("PATH_INVALID", "/same"),
      cliIoError("PATH_INVALID", "/same"),
    ]);
    expect(samePath.ok).toBe(false);
    if (!samePath.ok) {
      expect(samePath.errors.map((error) => error.code)).toEqual([
        "PATH_INVALID",
        "PATH_INVALID",
        "TARGET_EXISTS",
      ]);
    }
    const reversedPath = cliIoFailure([
      cliIoError("PATH_INVALID", "/same-a"),
      cliIoError("PATH_INVALID", "/same-z"),
    ]);
    expect(reversedPath.ok).toBe(false);
    if (!reversedPath.ok) expect(reversedPath.errors.map((error) => error.path)).toEqual(["/same-a", "/same-z"]);
    const reversedCode = cliIoFailure([
      cliIoError("PATH_INVALID", "/same"),
      cliIoError("TARGET_EXISTS", "/same"),
    ]);
    expect(reversedCode.ok).toBe(false);
    if (!reversedCode.ok) expect(reversedCode.errors.map((error) => error.code)).toEqual(["PATH_INVALID", "TARGET_EXISTS"]);
  });

  it("maps normal I/O, integrity, and uncertain recovery to stable exit codes", () => {
    expect(exitCodeForCliIoResult(cliIoSuccess(null))).toBe(0);
    expect(exitCodeForCliIoResult(cliIoFailure([cliIoError("PATH_INVALID", "/outputDir")]))).toBe(2);
    expect(exitCodeForCliIoResult(cliIoFailure([cliIoError("TARGET_EXISTS", "/targets/0")]))).toBe(3);
    expect(exitCodeForCliIoResult(
      cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transactions")], true),
    )).toBe(70);
  });
});

describe("validated output roots and targets", () => {
  it("creates only the fresh root and its private transaction container with exact modes", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "new-output");
    const result = await resolveOutputRoot({
      outputDir: output,
      creation: "create-if-missing",
      freshness: "require-no-business-entries",
    });
    expect(result).toMatchObject({ ok: true, value: { absolutePath: output, createdByThisCall: true } });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, ".review-txn"))).mode & 0o777).toBe(0o700);
    expect(await readdir(output)).toEqual([".review-txn"]);
  });

  it("returns safe non-throwing failures for hostile public facade values", async () => {
    const { root } = await existingRoot();
    const hostileTarget = new Proxy({} as FileTransactionTarget, {
      getOwnPropertyDescriptor: () => { throw new Error("hostile descriptor"); },
    });
    const hostile = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [hostileTarget],
    });
    expect(hostile).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    for (const invalid of [null, [], "text"] as unknown[]) {
      const result = await commitFileTransaction({
        root,
        generatorVersion: "0.2.1",
        targets: [invalid as FileTransactionTarget],
      });
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    }
    const sparseBytes = new Uint8Array(2);
    const invalidDescriptors = [
      { target: target("missing-bytes.txt"), disposition: "create", verifyStaged: valid },
      { target: target("missing-disposition.txt"), bytes: sparseBytes, verifyStaged: valid },
      { target: target("missing-verifier.txt"), bytes: sparseBytes, disposition: "create" },
      Object.defineProperty({ bytes: sparseBytes, disposition: "create", verifyStaged: valid }, "target", {
        get: () => target("getter.txt"),
      }),
      { target: null, bytes: sparseBytes, disposition: "create", verifyStaged: valid },
      { target: target("unknown-field.txt"), bytes: sparseBytes, disposition: "create", verifyStaged: valid, unknown: true },
      Object.assign(Object.create(null), {
        target: target("null-prototype.txt"), bytes: sparseBytes, disposition: "create", verifyStaged: valid,
      }),
      Object.assign(new (class TransactionPlan {})(), {
        target: target("class-instance.txt"), bytes: sparseBytes, disposition: "create", verifyStaged: valid,
      }),
    ];
    for (const invalid of invalidDescriptors) {
      const result = await commitFileTransaction({
        root,
        generatorVersion: "0.2.1",
        targets: [invalid as unknown as FileTransactionTarget],
      });
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    }
    const proxiedBytes = new Proxy(new Uint8Array([1]), {});
    const badBytes = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("proxied-bytes.txt"),
        bytes: proxiedBytes,
        disposition: "create",
        verifyStaged: valid,
      }],
    });
    expect(badBytes).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    const symbolBytes = new Uint8Array([1]);
    Object.defineProperty(symbolBytes, Symbol("hidden"), { value: true });
    const symbolResult = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("symbol-bytes.txt"),
        bytes: symbolBytes,
        disposition: "create",
        verifyStaged: valid,
      }],
    });
    expect(symbolResult).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    const keyedBytes = new Uint8Array([1]);
    Object.defineProperty(keyedBytes, "extra", { value: true, enumerable: true });
    const keyedResult = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("keyed-bytes.txt"),
        bytes: keyedBytes,
        disposition: "create",
        verifyStaged: valid,
      }],
    });
    expect(keyedResult).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    const symbolPlan = {
      target: target("symbol-plan.txt"), bytes: bytes("safe"), disposition: "create" as const, verifyStaged: valid,
    };
    Object.defineProperty(symbolPlan, Symbol("hidden"), { value: true });
    expect(await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [symbolPlan],
    })).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    const badVerifierResults: unknown[] = [
      null,
      "no",
      [],
      {},
      { ok: false },
      { ok: "true" },
      Object.defineProperty({}, "ok", { get: () => true }),
      Object.defineProperty({}, "ok", { set: () => undefined }),
      new Proxy({}, {
        getOwnPropertyDescriptor: () => { throw new Error("hostile result"); },
      }),
    ];
    for (let index = 0; index < badVerifierResults.length; index += 1) {
      const result = await commitFileTransaction({
        root,
        generatorVersion: "0.2.1",
        targets: [{
          target: target(`hostile-${index}.txt`),
          bytes: bytes("safe"),
          disposition: "create",
          verifyStaged: () => badVerifierResults[index] as { ok: true },
        }],
      });
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "STAGED_CONTENT_INVALID" }] });
    }
  });

  it("rejects missing parents, missing must-exist roots, business entries, and malformed calls", async () => {
    const parent = await temporaryDirectory();
    const missingParent = await resolveOutputRoot({
      outputDir: join(parent, "missing", "output"),
      creation: "create-if-missing",
      freshness: "allow-business-entries",
    });
    expect(missingParent).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    const missing = await resolveOutputRoot({
      outputDir: join(parent, "absent"),
      creation: "must-exist",
      freshness: "allow-business-entries",
    });
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });

    const output = join(parent, "busy");
    await mkdir(output);
    await writeFile(join(output, "business.txt"), "keep");
    const busy = await resolveOutputRoot({
      outputDir: output,
      creation: "must-exist",
      freshness: "require-no-business-entries",
    });
    expect(busy).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });
    expect(await readdir(output)).toEqual(["business.txt"]);

    const hostile = await resolveOutputRoot(new Proxy({} as never, {
      get: () => { throw new Error("hostile getter"); },
    }));
    expect(hostile.ok).toBe(false);

    for (const invalid of [
      null,
      [],
      {},
      { outputDir: 17, creation: "must-exist", freshness: "allow-business-entries" },
      { outputDir: "", creation: "must-exist", freshness: "allow-business-entries" },
      { outputDir: "bad\0path", creation: "must-exist", freshness: "allow-business-entries" },
      { outputDir: output, creation: "sometimes", freshness: "allow-business-entries" },
      { outputDir: output, creation: "must-exist", freshness: "sometimes" },
      { outputDir: "x".repeat(32769), creation: "must-exist", freshness: "allow-business-entries" },
    ] as unknown[]) {
      const result = await resolveOutputRoot(invalid as Parameters<typeof resolveOutputRoot>[0]);
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    }
  });

  it("brands safe targets, rejects reserved/ambiguous paths, and detects Unicode collisions", () => {
    for (const invalid of ["", "/absolute", "../escape", "a/../b", "a//b", "a\\b", "C:/drive", ".review-txn/x", ".REVIEW-TXN/x", "bad\0name"]) {
      expect(validateRelativeTarget(invalid)).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });
    }
    const first = target("Straße/report.txt");
    const second = target("STRASSE/report.txt");
    expect(assertPortableTargetSet([first, second])).toMatchObject({
      ok: false,
      errors: [{ code: "PORTABLE_PATH_COLLISION", path: "/targets/1/target" }],
    });
    expect(assertPortableTargetSet([target("e\u0301.txt"), target("é.txt")])).toMatchObject({
      ok: false,
      errors: [{ code: "PORTABLE_PATH_COLLISION" }],
    });
    expect(assertPortableTargetSet([])).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });
    expect(assertPortableTargetSet(null as unknown as readonly ValidatedRelativeTarget[])).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID" }],
    });
    expect(assertPortableTargetSet([{} as ValidatedRelativeTarget])).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID" }],
    });
    const hostileSet = new Proxy([first], {
      get: () => { throw new Error("hostile target set"); },
    });
    expect(assertPortableTargetSet(hostileSet)).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID" }],
    });
    const sparseSet = new Array<ValidatedRelativeTarget>(1);
    expect(assertPortableTargetSet(sparseSet)).toMatchObject({
      ok: false,
      errors: [{ code: "PATH_INVALID" }],
    });
  });

  it("fails closed for malformed private writer claims without deleting them", async () => {
    const { output, root } = await existingRoot();
    const claimPath = join(output, ".review-txn", ".writer-claim");
    const base = {
      format: "review-writer-claim/1",
      owner: "deliver-dual-audience-report/v0.2",
      generatorVersion: "0.2.1",
      hostId: `sha256:${"0".repeat(64)}`,
      bootId: "boot-minute:0",
      pid: 1,
      processStartId: "start-ms:0",
      nonce: "00000000000000000000",
    };
    const encoded = (value: unknown) => bytes(`${JSON.stringify(value)}\n`);
    const variants: Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array(4097),
      new Uint8Array([0xff]),
      bytes("{broken\n"),
      encoded(null),
      encoded([]),
      encoded({}),
      encoded({ ...base, extra: true }),
      encoded({ ...base, format: "review-writer-claim/2" }),
      encoded({ ...base, owner: "unknown" }),
      encoded({ ...base, generatorVersion: "latest" }),
      encoded({ ...base, hostId: 17 }),
      encoded({ ...base, hostId: "sha256:no" }),
      encoded({ ...base, bootId: 17 }),
      encoded({ ...base, bootId: "boot:unknown" }),
      encoded({ ...base, pid: "1" }),
      encoded({ ...base, pid: Number.MAX_SAFE_INTEGER + 1 }),
      encoded({ ...base, pid: 0 }),
      encoded({ ...base, processStartId: 17 }),
      encoded({ ...base, processStartId: "start:unknown" }),
      encoded({ ...base, nonce: 17 }),
      encoded({ ...base, nonce: "not-a-nonce" }),
      encoded({
        nonce: base.nonce,
        processStartId: base.processStartId,
        pid: base.pid,
        bootId: base.bootId,
        hostId: base.hostId,
        generatorVersion: base.generatorVersion,
        owner: base.owner,
        format: base.format,
      }),
      bytes(`${JSON.stringify(base)} \n`),
    ];
    for (const variant of variants) {
      await writeFile(claimPath, variant, { mode: 0o600 });
      await chmod(claimPath, 0o600);
      const result = await recoverTransactions({ root, generatorVersion: "0.2.1" });
      expect(result).toMatchObject({
        ok: false,
        mutated: true,
        recoveryRequired: true,
        errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/writerClaim" }],
      });
      expect(await readFile(claimPath)).toEqual(Buffer.from(variant));
      await unlink(claimPath);
    }
    await writeFile(claimPath, encoded(base), { mode: 0o600 });
    await chmod(claimPath, 0o644);
    expect(await recoverTransactions({ root, generatorVersion: "0.2.1" })).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/writerClaim" }],
    });
    await unlink(claimPath);
    await mkdir(claimPath, { mode: 0o700 });
    expect(await recoverTransactions({ root, generatorVersion: "0.2.1" })).toMatchObject({
      ok: false,
      mutated: true,
      recoveryRequired: true,
      errors: [{ code: "TRANSACTION_RECOVERY_BLOCKED", path: "/writerClaim" }],
    });
    await rm(claimPath, { recursive: true });
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("guards writer-claim publication, identity, release, and container device", async () => {
    const { output, root } = await existingRoot();
    const rootMetadata = await lstat(output);
    const container = join(output, ".review-txn");
    const claim = await acquireWriterClaim(nativeFileSystemAdapter, {
      rootPath: output,
      rootMetadata,
      generatorVersion: "0.2.1",
    });
    const claimBytes = await readFile(claim.claimPath);
    expect((await stat(claim.claimPath)).mode & 0o777).toBe(0o600);

    const extraLink = join(container, "claim-extra-link");
    await link(claim.claimPath, extraLink);
    await expect(assertWriterClaim(nativeFileSystemAdapter, claim)).rejects.toThrow();
    await unlink(extraLink);
    await assertWriterClaim(nativeFileSystemAdapter, claim);

    const replacement = join(container, "claim-replacement");
    await writeFile(replacement, claimBytes, { mode: 0o600 });
    await chmod(replacement, 0o600);
    await rename(replacement, claim.claimPath);
    await expect(assertWriterClaim(nativeFileSystemAdapter, claim)).rejects.toThrow();
    await unlink(claim.claimPath);

    const crossDeviceAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === container
        ? metadataWithDevice(await nativeFileSystemAdapter.lstat(path), rootMetadata.dev + 1)
        : nativeFileSystemAdapter.lstat(path),
    };
    await expect(acquireWriterClaim(crossDeviceAdapter, {
      rootPath: output,
      rootMetadata,
      generatorVersion: "0.2.1",
    })).rejects.toThrow();

    const escapedRootAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      realpath: async (path) => path === output ? `${output}-changed` : nativeFileSystemAdapter.realpath(path),
    };
    await expect(acquireWriterClaim(escapedRootAdapter, {
      rootPath: output,
      rootMetadata,
      generatorVersion: "0.2.1",
    })).rejects.toThrow();
    expect(await readdir(container)).toEqual([]);

    const invalidRandom = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("random.txt"), bytes: bytes("safe"), disposition: "create", verifyStaged: valid }],
    }, { ...nativeFileSystemAdapter, randomBytes: () => new Uint8Array(9) });
    expect(invalidRandom).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/writerClaim" }],
    });

    let raced = false;
    const missingClaimRace: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      link: async (existingPath, newPath) => {
        if (!raced) {
          raced = true;
          throw Object.assign(new Error("simulated released claim"), { code: "EEXIST" });
        }
        await nativeFileSystemAdapter.link(existingPath, newPath);
      },
    };
    const racedCommit = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("race.txt"), bytes: bytes("safe"), disposition: "create", verifyStaged: valid }],
    }, missingClaimRace);
    expect(racedCommit.ok).toBe(true);

    const copyLinkAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      link: async (existingPath, newPath) => {
        await writeFile(newPath, await readFile(existingPath), { mode: 0o600 });
        await chmod(newPath, 0o600);
      },
    };
    const copiedClaim = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("copy-link.txt"), bytes: bytes("safe"), disposition: "create", verifyStaged: valid }],
    }, copyLinkAdapter);
    expect(copiedClaim).toMatchObject({ ok: false, mutated: true, recoveryRequired: true });
    expect((await readdir(container)).sort()).toEqual([]);
  });

  it("validates and cleans writer-claim candidates only while holding the exact claim", async () => {
    const { output } = await existingRoot();
    const rootMetadata = await lstat(output);
    const container = join(output, ".review-txn");
    const claim = await acquireWriterClaim(nativeFileSystemAdapter, {
      rootPath: output,
      rootMetadata,
      generatorVersion: "0.2.1",
    });
    const currentRecord = JSON.parse(await readFile(claim.claimPath, "utf8")) as Record<string, unknown>;
    const writeCandidate = async (nonce: string, overrides: Record<string, unknown> = {}) => {
      const record: Record<string, unknown> = { ...currentRecord, nonce, ...overrides };
      const path = join(container, `.writer-claim-${record.pid as number}-${nonce}.tmp`);
      await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };

    const stale = await writeCandidate("11111111111111111111", { processStartId: "start-ms:0" });
    expect(await listTransactionEntriesUnderWriterClaim(nativeFileSystemAdapter, claim)).toEqual([]);
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });

    const mismatched = await writeCandidate("22222222222222222222");
    const mismatchedName = join(container, `.writer-claim-${process.pid}-33333333333333333333.tmp`);
    await rename(mismatched, mismatchedName);
    await expect(listTransactionEntriesUnderWriterClaim(nativeFileSystemAdapter, claim)).rejects.toThrow();
    await unlink(mismatchedName);

    const remote = await writeCandidate("44444444444444444444", { hostId: `sha256:${"0".repeat(64)}` });
    await expect(listTransactionEntriesUnderWriterClaim(nativeFileSystemAdapter, claim)).rejects.toThrow();
    await unlink(remote);

    const disappearing = await writeCandidate("55555555555555555555");
    let removed = false;
    const disappearingAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        if (!removed && path === disappearing) {
          removed = true;
          await unlink(disappearing);
        }
        return nativeFileSystemAdapter.lstat(path);
      },
    };
    expect(await listTransactionEntriesUnderWriterClaim(disappearingAdapter, claim)).toEqual([]);

    const releaseFailureAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      unlink: async (path) => {
        if (path === claim.claimPath) throw Object.assign(new Error("simulated release failure"), { code: "EIO" });
        await nativeFileSystemAdapter.unlink(path);
      },
    };
    await expect(releaseWriterClaim(releaseFailureAdapter, claim)).rejects.toThrow();
    await releaseWriterClaim(nativeFileSystemAdapter, claim);
    expect(await readdir(container)).toEqual([]);
  });
});

describe("file transaction facade", () => {
  it("commits multiple create targets in input order without transaction residue", async () => {
    const { output, root } = await existingRoot();
    await mkdir(join(output, "nested"));
    let verifierCalls = 0;
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [
        { target: target("agent.md"), bytes: bytes("agent\n"), disposition: "create", verifyStaged: () => { verifierCalls += 1; return valid(); } },
        { target: target("nested/approval.html"), bytes: bytes("<main>safe</main>\n"), disposition: "create", verifyStaged: valid },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("commit failed");
    expect(result.value.targets.map((item) => item.relativePath)).toEqual(["agent.md", "nested/approval.html"]);
    expect(result.value.targets.every((item) => item.digest.startsWith("sha256:"))).toBe(true);
    expect(verifierCalls).toBe(3);
    expect(await readFile(join(output, "agent.md"), "utf8")).toBe("agent\n");
    expect(await readFile(join(output, "nested/approval.html"), "utf8")).toBe("<main>safe</main>\n");
    expect((await stat(join(output, "agent.md"))).mode & 0o777).toBe(0o600);
    await emptyTransactionContainer(output);
  });

  it("replaces only a verifier-approved private generated file and restores it on mismatch", async () => {
    const { output, root } = await existingRoot();
    const artifact = target("artifact.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("old"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);

    const mismatch = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("new"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: () => ({ ok: false }),
      }],
    });
    expect(mismatch).toMatchObject({ ok: false, mutated: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");

    const replaced = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("new"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: (input) => input[0] === "o".charCodeAt(0) ? valid() : { ok: false },
      }],
    });
    expect(replaced.ok).toBe(true);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    await emptyTransactionContainer(output);
  });

  it("treats a byte-identical replace as already current instead of a wedging transaction", async () => {
    // Every recovery-cursor predicate is digest-only, so a manifest whose old and
    // new digests are equal cannot be told apart from its own successor states.
    // Re-rendering an unchanged document produces exactly those bytes, so this is
    // an ordinary action, not a corner case.
    const { output, root } = await existingRoot();
    const artifact = target("artifact.txt");
    const same = (): { ok: true } => valid();
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("stable"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);

    const identical = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("stable"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: same,
      }],
    });
    expect(identical).toMatchObject({ ok: true });
    expect(identical.ok && identical.value.targets).toEqual([
      { relativePath: "artifact.txt", digest: expect.any(String), disposition: "replace" },
    ]);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("stable");
    // No transaction may be left behind: a leftover ambiguous manifest is what
    // permanently blocks every later write into this root.
    await emptyTransactionContainer(output);

    // The root stays usable afterwards, both for another identical write and for
    // a genuinely different one.
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("stable"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: same,
      }],
    })).ok).toBe(true);
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("moved on"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: same,
      }],
    })).ok).toBe(true);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("moved on");
    await emptyTransactionContainer(output);
  });

  it("never loses the installed file when an identical replace is interrupted", async () => {
    const { output, root } = await existingRoot();
    const artifact = target("artifact.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("precious"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);

    // Interrupt at the same point that used to delete the original: with equal
    // digests the rollback could not tell the installed file from the new one.
    const interrupted = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("precious"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: () => valid(),
      }],
    }, checkpointAdapter("manifest-published:staged"));

    // There is no crash window left to hit: the identical replace short-circuits
    // before any transaction directory exists, so the injected failure never fires.
    expect(interrupted).toMatchObject({ ok: true });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("precious");
    expect((await readdir(output)).sort()).toEqual([".review-txn", "artifact.txt"]);
    await emptyTransactionContainer(output);
  });

  it("rejects missing and cross-device replacement targets before staging", async () => {
    const { output, root } = await existingRoot();
    const missing = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("missing.txt"),
        bytes: bytes("new"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: valid,
      }],
    });
    expect(missing).toMatchObject({ ok: false, mutated: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });

    const artifact = target("artifact.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("old"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);
    const finalPath = join(output, "artifact.txt");
    const metadata = await lstat(finalPath);
    const adapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => path === finalPath
        ? metadataWithDevice(await nativeFileSystemAdapter.lstat(path), metadata.dev + 1)
        : nativeFileSystemAdapter.lstat(path),
    };
    const crossDevice = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("new"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: valid,
      }],
    }, adapter);
    expect(crossDevice).toMatchObject({ ok: false, mutated: false, errors: [{ code: "CROSS_DEVICE_TRANSACTION" }] });
    expect(await readFile(finalPath, "utf8")).toBe("old");
  });

  it("rejects create collisions, forged brands, malformed plans, and verifier exceptions before staging", async () => {
    const { output, root } = await existingRoot();
    await writeFile(join(output, "exists.txt"), "external");
    const exists = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("exists.txt"), bytes: bytes("new"), disposition: "create", verifyStaged: valid }],
    });
    expect(exists).toMatchObject({ ok: false, mutated: false, errors: [{ code: "TARGET_EXISTS" }] });
    expect(await readFile(join(output, "exists.txt"), "utf8")).toBe("external");

    const forgedRoot = await commitFileTransaction({
      root: { absolutePath: output, createdByThisCall: false } as ResolvedOutputRoot,
      generatorVersion: "0.2.1",
      targets: [{ target: target("safe.txt"), bytes: bytes("safe"), disposition: "create", verifyStaged: valid }],
    });
    expect(forgedRoot.ok).toBe(false);

    const forgedTarget = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: { relativePath: "safe.txt", portableKey: "safe.txt" } as ValidatedRelativeTarget,
        bytes: bytes("safe"),
        disposition: "create",
        verifyStaged: valid,
      }],
    });
    expect(forgedTarget).toMatchObject({ ok: false, errors: [{ code: "PATH_INVALID" }] });

    for (const plan of [
      { target: target("a.txt"), bytes: bytes("a"), disposition: "create", verifyStaged: () => { throw new Error("secret"); } },
      { target: target("a.txt"), bytes: bytes("a"), disposition: "create", verifyStaged: () => ({ ok: false }) },
      { target: target("a.txt"), bytes: "not bytes", disposition: "create", verifyStaged: valid },
      { target: target("a.txt"), bytes: bytes("a"), disposition: "replace", verifyStaged: valid },
      { target: target("a.txt"), bytes: bytes("a"), disposition: "create", verifyStaged: valid, verifyExisting: valid },
    ]) {
      const result = await commitFileTransaction({
        root,
        generatorVersion: "0.2.1",
        targets: [plan as unknown as FileTransactionTarget],
      });
      expect(result.ok).toBe(false);
    }
    expect((await readdir(output)).sort()).toEqual([".review-txn", "exists.txt"]);
  });

  it("maps low-level filesystem boundary codes without disclosing their messages", async () => {
    const parent = await temporaryDirectory();
    for (const [code, expected] of [
      ["ELOOP", "SYMLINK_REJECTED"],
      ["ENOTDIR", "PATH_INVALID"],
      ["EXDEV", "CROSS_DEVICE_TRANSACTION"],
    ] as const) {
      const output = join(parent, `output-${code}`);
      const adapter: PrivateFileSystemAdapter = {
        ...nativeFileSystemAdapter,
        lstat: async () => {
          throw Object.assign(new Error("private operating-system detail"), { code });
        },
      };
      const result = await resolveOutputRootWithAdapter({
        outputDir: output,
        creation: "must-exist",
        freshness: "allow-business-entries",
      }, adapter);
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: expected }] });
      if (!result.ok) expect(JSON.stringify(result)).not.toContain("private operating-system detail");
    }
  });

  it("rejects malformed transaction envelopes and preserves ordinary lstat failures", async () => {
    const { root } = await existingRoot();
    for (const invalidVersion of [null, "", "v0.2.1", "1.0"] as unknown[]) {
      const result = await commitFileTransaction({
        root,
        generatorVersion: invalidVersion as string,
        targets: [{ target: target("safe.txt"), bytes: bytes("safe"), disposition: "create", verifyStaged: valid }],
      });
      expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    }
    const empty = await commitFileTransaction({ root, generatorVersion: "0.2.1", targets: [] });
    expect(empty).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });
    const oversized = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: Array.from({ length: 1025 }, () => ({
        target: target("same.txt"),
        bytes: bytes("safe"),
        disposition: "create" as const,
        verifyStaged: valid,
      })),
    });
    expect(oversized).toMatchObject({ ok: false, mutated: false, errors: [{ code: "PATH_INVALID" }] });

    const failingAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      lstat: async (path) => {
        if (path.endsWith("ordinary-io.txt")) {
          throw Object.assign(new Error("private operating-system detail"), { code: "EIO" });
        }
        return nativeFileSystemAdapter.lstat(path);
      },
    };
    const ordinaryFailure = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("ordinary-io.txt"),
        bytes: bytes("safe"),
        disposition: "create",
        verifyStaged: valid,
      }],
    }, failingAdapter);
    expect(ordinaryFailure).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/targets" }],
    });
  });

  it("reruns staged verification after writing and rolls back a second-pass failure", async () => {
    const { output, root } = await existingRoot();
    let calls = 0;
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("artifact.txt"),
        bytes: bytes("content"),
        disposition: "create",
        verifyStaged: () => {
          calls += 1;
          return calls === 1 ? { ok: true } : { ok: false };
        },
      }],
    });
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "STAGED_CONTENT_INVALID" }] });
    expect(calls).toBe(2);
    expect(await readdir(output)).toEqual([".review-txn"]);
    await emptyTransactionContainer(output);
  });

  it("rolls back when installed bytes fail the final semantic verifier", async () => {
    const { output, root } = await existingRoot();
    let calls = 0;
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: target("artifact.txt"),
        bytes: bytes("content"),
        disposition: "create",
        verifyStaged: () => {
          calls += 1;
          return calls < 3 ? { ok: true } : { ok: false };
        },
      }],
    });
    expect(result).toMatchObject({ ok: false, mutated: false, errors: [{ code: "TRANSACTION_DIGEST_MISMATCH" }] });
    expect(calls).toBe(3);
    await expect(readFile(join(output, "artifact.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await emptyTransactionContainer(output);
  });

  it.each([
    "transaction-directory-created",
    "stage-written:0",
    "manifest-temp:staged",
    "manifest-published:staged",
    "manifest-temp:backing-up",
    "manifest-published:backing-up",
    "manifest-temp:installing",
    "manifest-published:installing",
    "target-installed:0",
    "manifest-temp:committed",
  ])("rolls a create transaction back after injected fault at %s", async (point) => {
    const { output, root } = await existingRoot();
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("artifact.txt"), bytes: bytes("new"), disposition: "create", verifyStaged: valid }],
    }, checkpointAdapter(point));
    expect(result).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    expect(await readdir(output)).toEqual([".review-txn"]);
    await emptyTransactionContainer(output);
  });

  it.each([
    "backup-renamed:0",
    "manifest-published:installing",
    "target-installed:0",
    "manifest-temp:committed",
  ])("restores an existing generated target after injected replace fault at %s", async (point) => {
    const { output, root } = await existingRoot();
    const artifact = target("artifact.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("old"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{
        target: artifact,
        bytes: bytes("new"),
        disposition: "replace",
        verifyStaged: valid,
        verifyExisting: valid,
      }],
    }, checkpointAdapter(point));
    expect(result).toMatchObject({ ok: false, mutated: false });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");
    await emptyTransactionContainer(output);
  });

  it("treats a durably committed manifest as success when final cleanup is interrupted", async () => {
    const { output, root } = await existingRoot();
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("artifact.txt"), bytes: bytes("new"), disposition: "create", verifyStaged: valid }],
    }, checkpointAdapter("manifest-published:committed"));
    expect(result.ok).toBe(true);
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("new");
    await emptyTransactionContainer(output);
  });

  it("rolls mixed create/replace targets back in reverse order", async () => {
    const { output, root } = await existingRoot();
    const existing = target("existing.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: existing, bytes: bytes("old"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);
    const result = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [
        { target: existing, bytes: bytes("replacement"), disposition: "replace", verifyStaged: valid, verifyExisting: valid },
        { target: target("created.txt"), bytes: bytes("created"), disposition: "create", verifyStaged: valid },
      ],
    }, checkpointAdapter("target-installed:1"));
    expect(result).toMatchObject({ ok: false, mutated: false });
    expect(await readFile(join(output, "existing.txt"), "utf8")).toBe("old");
    expect(await readdir(output)).toEqual([".review-txn", "existing.txt"]);
  });

  it("bounds a live-writer wait without treating its transaction as abandoned", async () => {
    const { output, root } = await existingRoot();
    let signalHeld: (() => void) | undefined;
    let releaseWriter: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const holdingAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      checkpoint: async (point) => {
        if (point === "stage-written:0") {
          signalHeld?.();
          await release;
        }
      },
    };
    const first = commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("first.txt"), bytes: bytes("first"), disposition: "create", verifyStaged: valid }],
    }, holdingAdapter);
    await held;
    let clock = 0;
    const boundedAdapter: PrivateFileSystemAdapter = {
      ...nativeFileSystemAdapter,
      now: () => {
        clock += 6000;
        return clock;
      },
      wait: async () => undefined,
    };
    const blocked = await commitFileTransactionWithAdapter({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: target("second.txt"), bytes: bytes("second"), disposition: "create", verifyStaged: valid }],
    }, boundedAdapter);
    expect(blocked).toMatchObject({
      ok: false,
      mutated: false,
      recoveryRequired: false,
      errors: [{ code: "IO_OPERATION_FAILED", path: "/writerClaim" }],
    });
    expect(await readdir(join(output, ".review-txn"))).not.toEqual([]);
    releaseWriter?.();
    expect((await first).ok).toBe(true);
    expect(await readFile(join(output, "first.txt"), "utf8")).toBe("first");
    await expect(readFile(join(output, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await emptyTransactionContainer(output);
  });

  it("refuses to replace a generated file whose permission identity changed", async () => {
    const { output, root } = await existingRoot();
    const artifact = target("artifact.txt");
    expect((await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("old"), disposition: "create", verifyStaged: valid }],
    })).ok).toBe(true);
    await chmod(join(output, "artifact.txt"), 0o644);
    const result = await commitFileTransaction({
      root,
      generatorVersion: "0.2.1",
      targets: [{ target: artifact, bytes: bytes("new"), disposition: "replace", verifyStaged: valid, verifyExisting: valid }],
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "REPLACE_IDENTITY_MISMATCH" }] });
    expect(await readFile(join(output, "artifact.txt"), "utf8")).toBe("old");
  });
});
