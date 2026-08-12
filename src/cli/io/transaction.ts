import { join } from "node:path";
import type { Stats } from "node:fs";
import {
  sha256Bytes,
  type PortablePathKey,
  type Sha256Digest,
} from "../../protocol/index.js";
import {
  cliIoError,
  cliIoFailure,
  cliIoSuccess,
  type CliIoErrorCode,
  type CliIoResult,
} from "../result.js";
import {
  assertPortableTargetSet,
  assertResolvedRoot,
  assertTargetParentGuard,
  cleanupCreatedRootIfEmpty,
  getTargetIdentity,
  inspectTargetParent,
  pathFailureResult,
  type ResolvedOutputRoot,
  type TargetParentGuard,
  type ValidatedRelativeTarget,
} from "./paths.js";
import {
  TRANSACTION_CONTAINER,
  TRANSACTION_DIRECTORY_MODE,
  TRANSACTION_FILE_MODE,
  TRANSACTION_FORMAT,
  TRANSACTION_MANIFEST,
  TRANSACTION_MANIFEST_NEXT,
  TRANSACTION_OWNER,
  WriterClaimError,
  acquireWriterClaim,
  assertPrivateDirectoryIdentity,
  assertRealDirectory,
  assertRegularFile,
  assertWriterClaim,
  isErrorCode,
  isGeneratorVersion,
  nativeFileSystemAdapter,
  parseTransactionManifest,
  readRegularFile,
  releaseWriterClaim,
  sameIdentity,
  syncDirectory,
  syncRegularFile,
  writeNewPrivateFile,
  writeTransactionManifest,
  type PrivateFileSystemAdapter,
  type PrivateManifestIdentity,
  type PrivateWriterClaim,
  type TransactionManifest,
  type TransactionManifestTarget,
} from "./fsync.js";
import { recoverTransactionsUnderClaimWithAdapter } from "./recovery.js";

export type ByteVerifier = (
  bytes: Uint8Array,
) => { ok: true } | { ok: false } | Promise<{ ok: true } | { ok: false }>;

export interface FileTransactionTarget {
  readonly target: ValidatedRelativeTarget;
  readonly bytes: Uint8Array;
  readonly disposition: "create" | "replace";
  readonly verifyStaged: ByteVerifier;
  readonly verifyExisting?: ByteVerifier;
}

export interface CommitValue {
  readonly targets: readonly {
    relativePath: string;
    digest: Sha256Digest;
    disposition: "create" | "replace";
  }[];
}

interface PreparedTransactionTarget {
  target: ValidatedRelativeTarget;
  relativePath: string;
  portableKey: PortablePathKey;
  bytes: Uint8Array;
  disposition: "create" | "replace";
  verifyStaged: ByteVerifier;
  verifyExisting?: ByteVerifier;
  newDigest: Sha256Digest;
  oldDigest?: Sha256Digest;
  existingMetadata?: Stats;
  guard: TargetParentGuard;
  stageRelativePath: string;
  backupRelativePath?: string;
}

class TransactionError extends Error {
  constructor(
    readonly ioCode: CliIoErrorCode,
    readonly errorPath: string,
  ) {
    super(ioCode);
  }
}

function transactionBoundary(code: CliIoErrorCode, path: string): never {
  throw new TransactionError(code, path);
}

function asOwnedBytes(value: unknown): Uint8Array | undefined {
  try {
    if (
      !(value instanceof Uint8Array)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.keys(value).some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key))
    ) {
      return undefined;
    }
    return Uint8Array.from(value);
  } catch {
    return undefined;
  }
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
  return descriptor.value;
}

function snapshotTarget(value: unknown, _index: number): Omit<PreparedTransactionTarget,
  "relativePath" | "portableKey" | "newDigest" | "oldDigest" | "existingMetadata" | "guard" | "stageRelativePath" | "backupRelativePath"
> | undefined {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return undefined;
    }
    const allowed = new Set(["target", "bytes", "disposition", "verifyStaged", "verifyExisting"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
    const target = ownDataValue(value, "target");
    const bytes = asOwnedBytes(ownDataValue(value, "bytes"));
    const disposition = ownDataValue(value, "disposition");
    const verifyStaged = ownDataValue(value, "verifyStaged");
    const verifyExisting = ownDataValue(value, "verifyExisting");
    if (
      typeof target !== "object"
      || target === null
      || bytes === undefined
      || (disposition !== "create" && disposition !== "replace")
      || typeof verifyStaged !== "function"
      || (disposition === "replace" ? typeof verifyExisting !== "function" : verifyExisting !== undefined)
    ) {
      return undefined;
    }
    return {
      target: target as ValidatedRelativeTarget,
      bytes,
      disposition,
      verifyStaged: verifyStaged as ByteVerifier,
      ...(disposition === "replace" ? { verifyExisting: verifyExisting as ByteVerifier } : {}),
    };
  } catch {
    return undefined;
  }
}

async function verifierPasses(verifier: ByteVerifier, bytes: Uint8Array): Promise<boolean> {
  try {
    const result: unknown = await verifier(Uint8Array.from(bytes));
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(result, "ok");
    return descriptor !== undefined
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.value === true;
  } catch {
    return false;
  }
}

async function lstatIfPresent(
  adapter: PrivateFileSystemAdapter,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await adapter.lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function inspectExistingForReplacement(
  adapter: PrivateFileSystemAdapter,
  prepared: PreparedTransactionTarget,
  index: number,
): Promise<{ digest: Sha256Digest; metadata: Stats }> {
  const path = `/targets/${index}/target`;
  const before = await lstatIfPresent(adapter, prepared.guard.finalAbsolutePath);
  if (before === undefined) transactionBoundary("REPLACE_IDENTITY_MISMATCH", path);
  if (before.isSymbolicLink()) transactionBoundary("SYMLINK_REJECTED", path);
  try {
    assertRegularFile(before, TRANSACTION_FILE_MODE);
  } catch {
    transactionBoundary("REPLACE_IDENTITY_MISMATCH", path);
  }
  if (before.dev !== prepared.guard.root.metadata.dev || before.nlink !== 1) {
    transactionBoundary(
      before.dev !== prepared.guard.root.metadata.dev ? "CROSS_DEVICE_TRANSACTION" : "REPLACE_IDENTITY_MISMATCH",
      path,
    );
  }
  const existing = await readRegularFile(
    adapter,
    prepared.guard.finalAbsolutePath,
    { privateMode: TRANSACTION_FILE_MODE },
  );
  if (!sameIdentity(before, existing.metadata)) transactionBoundary("REPLACE_IDENTITY_MISMATCH", path);
  if (!(await verifierPasses(prepared.verifyExisting as ByteVerifier, existing.bytes))) {
    transactionBoundary("REPLACE_IDENTITY_MISMATCH", path);
  }
  return { digest: sha256Bytes(existing.bytes), metadata: existing.metadata };
}

async function preflightTargets(
  input: { root: ResolvedOutputRoot; targets: readonly FileTransactionTarget[] },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<PreparedTransactionTarget[]>> {
  try {
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 1024) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/targets")]);
    }
    await assertResolvedRoot(input.root, adapter);
    const snapshots: Array<ReturnType<typeof snapshotTarget> extends infer T ? Exclude<T, undefined> : never> = [];
    const validatedTargets: ValidatedRelativeTarget[] = [];
    for (let index = 0; index < input.targets.length; index += 1) {
      const snapshot = snapshotTarget(input.targets[index], index);
      if (snapshot === undefined || getTargetIdentity(snapshot.target) === undefined) {
        return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}`)]);
      }
      snapshots.push(snapshot);
      validatedTargets.push(snapshot.target);
    }
    const portableSet = assertPortableTargetSet(validatedTargets);
    if (!portableSet.ok) return portableSet as CliIoResult<PreparedTransactionTarget[]>;

    for (const [index, snapshot] of snapshots.entries()) {
      if (!(await verifierPasses(snapshot.verifyStaged, snapshot.bytes))) {
        return cliIoFailure([cliIoError("STAGED_CONTENT_INVALID", `/targets/${index}/bytes`)]);
      }
    }

    const preparedTargets: PreparedTransactionTarget[] = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const targetIdentity = getTargetIdentity(snapshot.target);
      if (targetIdentity === undefined) return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}/target`)]);
      const guard = await inspectTargetParent(input.root, snapshot.target, adapter);
      const prepared: PreparedTransactionTarget = {
        ...snapshot,
        relativePath: targetIdentity.relativePath,
        portableKey: targetIdentity.portableKey,
        newDigest: sha256Bytes(snapshot.bytes),
        guard,
        stageRelativePath: `stage-${String(index).padStart(6, "0")}.bin`,
        ...(snapshot.disposition === "replace"
          ? { backupRelativePath: `backup-${String(index).padStart(6, "0")}.bin` }
          : {}),
      };
      const observed = await lstatIfPresent(adapter, guard.finalAbsolutePath);
      if (snapshot.disposition === "create") {
        if (observed?.isSymbolicLink()) transactionBoundary("SYMLINK_REJECTED", `/targets/${index}/target`);
        if (observed !== undefined) transactionBoundary("TARGET_EXISTS", `/targets/${index}/target`);
      } else {
        const old = await inspectExistingForReplacement(adapter, prepared, index);
        prepared.oldDigest = old.digest;
        prepared.existingMetadata = old.metadata;
      }
      preparedTargets.push(prepared);
    }
    return cliIoSuccess(preparedTargets);
  } catch (error) {
    if (error instanceof TransactionError) {
      return cliIoFailure([cliIoError(error.ioCode, error.errorPath)]);
    }
    return pathFailureResult(error, "/targets");
  }
}

async function revalidatePreCommitTarget(
  adapter: PrivateFileSystemAdapter,
  prepared: PreparedTransactionTarget,
  index: number,
): Promise<void> {
  await assertTargetParentGuard(prepared.guard, adapter);
  if (prepared.disposition === "create") {
    const current = await lstatIfPresent(adapter, prepared.guard.finalAbsolutePath);
    if (current?.isSymbolicLink()) transactionBoundary("SYMLINK_REJECTED", `/targets/${index}/target`);
    if (current !== undefined) transactionBoundary("TARGET_EXISTS", `/targets/${index}/target`);
    return;
  }
  const current = await inspectExistingForReplacement(adapter, prepared, index);
  if (
    current.digest !== prepared.oldDigest
    || prepared.existingMetadata === undefined
    || !sameIdentity(current.metadata, prepared.existingMetadata)
  ) {
    transactionBoundary("REPLACE_IDENTITY_MISMATCH", `/targets/${index}/target`);
  }
}

async function createTransactionDirectory(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
): Promise<{ transactionId: string; path: string; metadata: Stats }> {
  const rootIdentity = await assertResolvedRoot(root, adapter);
  const containerPath = join(rootIdentity.absolutePath, TRANSACTION_CONTAINER);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = adapter.randomBytes(10);
    if (!(random instanceof Uint8Array) || random.byteLength !== 10) throw new Error("invalid random source");
    let suffix = "";
    for (const byte of random) suffix += byte.toString(16).padStart(2, "0");
    const transactionId = `TXN-${suffix.toUpperCase()}`;
    const path = join(containerPath, transactionId);
    try {
      await adapter.mkdir(path, TRANSACTION_DIRECTORY_MODE);
      await syncDirectory(adapter, containerPath);
      const metadata = await adapter.lstat(path);
      assertRealDirectory(metadata, TRANSACTION_DIRECTORY_MODE, true);
      if (metadata.dev !== rootIdentity.metadata.dev) {
        transactionBoundary("CROSS_DEVICE_TRANSACTION", "/transaction");
      }
      return { transactionId, path, metadata };
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error("transaction identity unavailable");
}

function buildManifest(
  transactionId: string,
  generatorVersion: string,
  targets: readonly PreparedTransactionTarget[],
): TransactionManifest {
  return {
    format: TRANSACTION_FORMAT,
    owner: TRANSACTION_OWNER,
    transactionId,
    generatorVersion,
    phase: "staged",
    targets: targets.map((target): TransactionManifestTarget => ({
      portableKey: target.portableKey,
      finalRelativePath: target.relativePath,
      stageRelativePath: target.stageRelativePath,
      ...(target.backupRelativePath === undefined ? {} : { backupRelativePath: target.backupRelativePath }),
      expectedNewDigest: target.newDigest,
      ...(target.oldDigest === undefined ? {} : { expectedOldDigest: target.oldDigest }),
      backupComplete: false,
      installComplete: false,
    })),
  };
}

async function safeCleanupBeforeManifest(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  transactionDirectory: { path: string; metadata: Stats },
  targets: readonly PreparedTransactionTarget[],
): Promise<boolean> {
  try {
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
    const allowed = new Set<string>([
      TRANSACTION_MANIFEST,
      TRANSACTION_MANIFEST_NEXT,
      ...targets.map((target) => target.stageRelativePath),
      ...targets.flatMap((target) => target.backupRelativePath === undefined ? [] : [target.backupRelativePath]),
    ]);
    const entries = await adapter.readdir(transactionDirectory.path);
    if (entries.some((entry) => !allowed.has(entry.name))) return false;
    for (const entry of entries) {
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      const path = join(transactionDirectory.path, entry.name);
      const metadata = await adapter.lstat(path);
      assertRegularFile(metadata, TRANSACTION_FILE_MODE);
      await adapter.unlink(path);
    }
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
    await syncDirectory(adapter, transactionDirectory.path);
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
    await adapter.rmdir(transactionDirectory.path);
    const rootIdentity = await assertResolvedRoot(root, adapter);
    await syncDirectory(adapter, join(rootIdentity.absolutePath, TRANSACTION_CONTAINER));
    return true;
  } catch {
    return false;
  }
}

async function publishedManifestPhase(
  adapter: PrivateFileSystemAdapter,
  transactionPath: string,
  transactionMetadata: Stats,
): Promise<"none" | "committed" | "uncommitted" | "invalid"> {
  try {
    await assertPrivateDirectoryIdentity(adapter, transactionPath, transactionMetadata);
    const read = await readRegularFile(
      adapter,
      join(transactionPath, TRANSACTION_MANIFEST),
      { privateMode: TRANSACTION_FILE_MODE, maximumBytes: 1024 * 1024 },
    );
    const manifest = parseTransactionManifest(read.bytes);
    if (manifest === undefined) return "invalid";
    return manifest.phase === "committed" ? "committed" : "uncommitted";
  } catch (error) {
    return isErrorCode(error, "ENOENT") ? "none" : "invalid";
  }
}

async function cleanupRootAfterFailedCommit(
  root: ResolvedOutputRoot,
  adapter: PrivateFileSystemAdapter,
  result: CliIoResult<CommitValue>,
): Promise<CliIoResult<CommitValue>> {
  const cleaned = await cleanupCreatedRootIfEmpty(root, adapter);
  if (cleaned) return result;
  return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/root")], true);
}

function commitValue(targets: readonly PreparedTransactionTarget[]): CommitValue {
  return Object.freeze({
    targets: Object.freeze(targets.map((target) => Object.freeze({
      relativePath: target.relativePath,
      digest: target.newDigest,
      disposition: target.disposition,
    }))),
  });
}

async function commitFileTransactionUnderClaimWithAdapter(
  input: {
    root: ResolvedOutputRoot;
    generatorVersion: string;
    targets: readonly FileTransactionTarget[];
  },
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
): Promise<CliIoResult<CommitValue>> {
  let preparedTargets: PreparedTransactionTarget[] = [];
  let transactionDirectory: { transactionId: string; path: string; metadata: Stats } | undefined;
  let manifestIdentity: PrivateManifestIdentity | undefined;
  let initiatingFailure: CliIoResult<CommitValue> | undefined;
  try {
    await assertWriterClaim(adapter, claim);
    const recovered = await recoverTransactionsUnderClaimWithAdapter(
      { root: input.root, generatorVersion: input.generatorVersion },
      adapter,
      claim,
    );
    if (!recovered.ok) return recovered;
    const preflight = await preflightTargets({ root: input.root, targets: input.targets }, adapter);
    if (!preflight.ok) return preflight;
    preparedTargets = preflight.value;
    await assertWriterClaim(adapter, claim);
    transactionDirectory = await createTransactionDirectory(adapter, input.root);
    await adapter.checkpoint("transaction-directory-created");
    for (const [index, target] of preparedTargets.entries()) {
      await assertWriterClaim(adapter, claim);
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      const stagePath = join(transactionDirectory.path, target.stageRelativePath);
      await writeNewPrivateFile(adapter, stagePath, target.bytes);
      const staged = await readRegularFile(adapter, stagePath, { privateMode: TRANSACTION_FILE_MODE });
      if (
        sha256Bytes(staged.bytes) !== target.newDigest
        || !(await verifierPasses(target.verifyStaged, staged.bytes))
      ) {
        transactionBoundary("STAGED_CONTENT_INVALID", `/targets/${index}/bytes`);
      }
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      await adapter.checkpoint(`stage-written:${index}`);
    }
    await syncDirectory(adapter, transactionDirectory.path);
    for (const [index, target] of preparedTargets.entries()) {
      await revalidatePreCommitTarget(adapter, target, index);
    }

    const manifest = buildManifest(transactionDirectory.transactionId, input.generatorVersion, preparedTargets);
    await assertWriterClaim(adapter, claim);
    manifestIdentity = await writeTransactionManifest(
      adapter,
      transactionDirectory.path,
      manifest,
      transactionDirectory.metadata,
      manifestIdentity,
    );

    manifest.phase = "backing-up";
    manifestIdentity = await writeTransactionManifest(
      adapter,
      transactionDirectory.path,
      manifest,
      transactionDirectory.metadata,
      manifestIdentity,
    );
    for (const [index, target] of preparedTargets.entries()) {
      const record = manifest.targets[index] as TransactionManifestTarget;
      if (target.disposition !== "replace") continue;
      await assertWriterClaim(adapter, claim);
      await revalidatePreCommitTarget(adapter, target, index);
      const backupPath = join(transactionDirectory.path, target.backupRelativePath as string);
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      await assertTargetParentGuard(target.guard, adapter);
      await adapter.rename(target.guard.finalAbsolutePath, backupPath);
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      await syncDirectory(adapter, target.guard.parentAbsolutePath);
      await syncDirectory(adapter, transactionDirectory.path);
      await adapter.checkpoint(`backup-renamed:${index}`);
      const backup = await readRegularFile(adapter, backupPath, { privateMode: TRANSACTION_FILE_MODE });
      if (sha256Bytes(backup.bytes) !== target.oldDigest) {
        transactionBoundary("TRANSACTION_DIGEST_MISMATCH", `/targets/${index}/backup`);
      }
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      record.backupComplete = true;
      manifestIdentity = await writeTransactionManifest(
        adapter,
        transactionDirectory.path,
        manifest,
        transactionDirectory.metadata,
        manifestIdentity,
      );
    }

    manifest.phase = "installing";
    manifestIdentity = await writeTransactionManifest(
      adapter,
      transactionDirectory.path,
      manifest,
      transactionDirectory.metadata,
      manifestIdentity,
    );
    for (const [index, target] of preparedTargets.entries()) {
      const record = manifest.targets[index] as TransactionManifestTarget;
      await assertWriterClaim(adapter, claim);
      await assertTargetParentGuard(target.guard, adapter);
      const finalBefore = await lstatIfPresent(adapter, target.guard.finalAbsolutePath);
      if (finalBefore !== undefined) {
        transactionBoundary(
          finalBefore.isSymbolicLink() ? "SYMLINK_REJECTED" : "TARGET_EXISTS",
          `/targets/${index}/target`,
        );
      }
      if (target.disposition === "replace") {
        const backup = await readRegularFile(
          adapter,
          join(transactionDirectory.path, target.backupRelativePath as string),
          { privateMode: TRANSACTION_FILE_MODE },
        );
        if (sha256Bytes(backup.bytes) !== (target.oldDigest as Sha256Digest)) {
          transactionBoundary("TRANSACTION_DIGEST_MISMATCH", `/targets/${index}/backup`);
        }
      }
      const stagePath = join(transactionDirectory.path, target.stageRelativePath);
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      await adapter.rename(stagePath, target.guard.finalAbsolutePath);
      await assertTargetParentGuard(target.guard, adapter);
      await syncRegularFile(adapter, target.guard.finalAbsolutePath);
      await syncDirectory(adapter, target.guard.parentAbsolutePath);
      await syncDirectory(adapter, transactionDirectory.path);
      await adapter.checkpoint(`target-installed:${index}`);
      const installed = await readRegularFile(adapter, target.guard.finalAbsolutePath);
      if (
        sha256Bytes(installed.bytes) !== target.newDigest
        || !(await verifierPasses(target.verifyStaged, installed.bytes))
      ) {
        transactionBoundary("TRANSACTION_DIGEST_MISMATCH", `/targets/${index}/target`);
      }
      await assertPrivateDirectoryIdentity(adapter, transactionDirectory.path, transactionDirectory.metadata);
      record.installComplete = true;
      manifestIdentity = await writeTransactionManifest(
        adapter,
        transactionDirectory.path,
        manifest,
        transactionDirectory.metadata,
        manifestIdentity,
      );
    }
    for (const [index, target] of preparedTargets.entries()) {
      await assertTargetParentGuard(target.guard, adapter);
      const installed = await readRegularFile(adapter, target.guard.finalAbsolutePath);
      if (sha256Bytes(installed.bytes) !== target.newDigest) {
        transactionBoundary("TRANSACTION_DIGEST_MISMATCH", `/targets/${index}/target`);
      }
    }
    manifest.phase = "committed";
    await assertWriterClaim(adapter, claim);
    manifestIdentity = await writeTransactionManifest(
      adapter,
      transactionDirectory.path,
      manifest,
      transactionDirectory.metadata,
      manifestIdentity,
    );
    const cleanup = await recoverTransactionsUnderClaimWithAdapter(
      { root: input.root, generatorVersion: input.generatorVersion },
      adapter,
      claim,
    );
    if (!cleanup.ok) return cleanup;
    return cliIoSuccess(commitValue(preparedTargets));
  } catch (error) {
    if (error instanceof TransactionError) {
      initiatingFailure = cliIoFailure([cliIoError(error.ioCode, error.errorPath)]);
    } else {
      const pathFailure = pathFailureResult<CommitValue>(error, "/transaction");
      initiatingFailure = pathFailure.ok
        ? cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/transaction")])
        : pathFailure;
    }
    if (transactionDirectory === undefined) {
      return initiatingFailure;
    }
    const published = await publishedManifestPhase(adapter, transactionDirectory.path, transactionDirectory.metadata);
    if (published === "none") {
      const cleaned = await safeCleanupBeforeManifest(adapter, input.root, transactionDirectory, preparedTargets);
      if (!cleaned) {
        return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transaction")], true);
      }
      return initiatingFailure;
    }
    if (published === "invalid") {
      return cliIoFailure([cliIoError("TRANSACTION_MANIFEST_INVALID", "/transaction/manifest")], true);
    }
    const recovered = await recoverTransactionsUnderClaimWithAdapter(
      { root: input.root, generatorVersion: input.generatorVersion },
      adapter,
      claim,
    );
    if (!recovered.ok) return recovered;
    if (published === "committed") return cliIoSuccess(commitValue(preparedTargets));
    return initiatingFailure;
  }
}

export async function commitFileTransactionWithAdapter(
  input: {
    root: ResolvedOutputRoot;
    generatorVersion: string;
    targets: readonly FileTransactionTarget[];
  },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<CommitValue>> {
  if (typeof input !== "object" || input === null || !isGeneratorVersion(input.generatorVersion)) {
    return cliIoFailure([cliIoError("PATH_INVALID", "/generatorVersion")]);
  }
  let claim: PrivateWriterClaim | undefined;
  let result: CliIoResult<CommitValue>;
  try {
    const identity = await assertResolvedRoot(input.root, adapter);
    claim = await acquireWriterClaim(adapter, {
      rootPath: identity.absolutePath,
      rootMetadata: identity.metadata,
      generatorVersion: input.generatorVersion,
    });
    result = await commitFileTransactionUnderClaimWithAdapter(input, adapter, claim);
  } catch (error) {
    if (error instanceof WriterClaimError) {
      return cliIoFailure([cliIoError(error.ioCode, error.errorPath)], error.uncertain);
    }
    const failure = pathFailureResult<CommitValue>(error, "/writerClaim");
    return failure.ok ? cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/writerClaim")]) : failure;
  }
  try {
    await releaseWriterClaim(adapter, claim);
  } catch (error) {
    const failure = error instanceof WriterClaimError
      ? cliIoError(error.ioCode, error.errorPath)
      : cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/writerClaim");
    return cliIoFailure([failure], true);
  }
  if (!result.ok && !result.recoveryRequired) {
    return cleanupRootAfterFailedCommit(input.root, adapter, result);
  }
  return result;
}

export async function commitFileTransaction(input: {
  root: ResolvedOutputRoot;
  generatorVersion: string;
  targets: readonly FileTransactionTarget[];
}): Promise<CliIoResult<CommitValue>> {
  try {
    return await commitFileTransactionWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transaction")], true);
  }
}
