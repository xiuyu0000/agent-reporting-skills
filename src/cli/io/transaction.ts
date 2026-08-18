import { join } from "node:path";
import type { Stats } from "node:fs";
import { isProxy } from "node:util/types";
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
  assertFreshResolvedRootWithAdapter,
  assertRecoverySceneBeforeFirstClaimWrite,
  assertResolvedRoot,
  assertTargetParentGuard,
  cleanupCreatedRootIfEmpty,
  bindFreshOutputPath,
  getTargetIdentity,
  inspectTargetParent,
  pathFailureResult,
  probeFreshOutputRootWithAdapter,
  resolveRecoveryOutputRootWithAdapter,
  resolveOutputRootWithAdapter,
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
  /**
   * A replace whose new bytes already equal the installed bytes. Such a target
   * carries no work, and staging it would make the recovery cursor ambiguous:
   * every predicate in `validateCursorState` is digest-only, so `expectedOldDigest
   * === expectedNewDigest` aliases final/backup/stage states that must stay
   * distinguishable. It is excluded from the transaction entirely and reported
   * as already current.
   */
  unchanged?: true;
}

type TransactionTargetSnapshot = Omit<PreparedTransactionTarget,
  "relativePath" | "portableKey" | "newDigest" | "oldDigest" | "existingMetadata" | "guard" | "stageRelativePath" | "backupRelativePath"
>;

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

function snapshotTarget(value: unknown): TransactionTargetSnapshot | undefined {
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

function asOwnedFreshBytes(value: unknown): Uint8Array | undefined {
  try {
    if (
      typeof value !== "object"
      || value === null
      || isProxy(value)
      || !(value instanceof Uint8Array)
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

async function freshVerifierPasses(verifier: ByteVerifier, bytes: Uint8Array): Promise<boolean> {
  try {
    const result: unknown = await verifier(Uint8Array.from(bytes));
    if (typeof result !== "object" || result === null || isProxy(result) || Array.isArray(result)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(result, "ok");
    return descriptor !== undefined
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.value === true;
  } catch {
    return false;
  }
}

function strictVerifier(verifier: ByteVerifier): ByteVerifier {
  return async (bytes) => (await freshVerifierPasses(verifier, bytes)) ? { ok: true } : { ok: false };
}

function snapshotFreshTarget(value: unknown): TransactionTargetSnapshot | undefined {
  try {
    if (
      typeof value !== "object"
      || value === null
      || isProxy(value)
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
    const descriptorKeys = Reflect.ownKeys(descriptors);
    const allowedKeys = new Set(["target", "bytes", "disposition", "verifyStaged", "verifyExisting"]);
    if (descriptorKeys.some((key) =>
      typeof key !== "string"
      || (descriptors[key]?.enumerable === true && !allowedKeys.has(key)))) {
      return undefined;
    }
    const dataValue = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    };
    const target = dataValue("target");
    const bytes = asOwnedFreshBytes(dataValue("bytes"));
    const disposition = dataValue("disposition");
    const verifyStaged = dataValue("verifyStaged");
    const verifyExisting = dataValue("verifyExisting");
    if (
      typeof target !== "object"
      || target === null
      || isProxy(target)
      || bytes === undefined
      || (disposition !== "create" && disposition !== "replace")
      || typeof verifyStaged !== "function"
      || isProxy(verifyStaged)
      || (disposition === "replace" ? typeof verifyExisting !== "function" : verifyExisting !== undefined)
      || (typeof verifyExisting === "function" && isProxy(verifyExisting))
    ) {
      return undefined;
    }
    return {
      target: target as ValidatedRelativeTarget,
      bytes,
      disposition,
      verifyStaged: strictVerifier(verifyStaged as ByteVerifier),
      ...(disposition === "replace"
        ? { verifyExisting: strictVerifier(verifyExisting as ByteVerifier) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function snapshotFreshTargetArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    const lengthValue = lengthDescriptor?.value as unknown;
    if (
      lengthDescriptor === undefined
      || typeof lengthValue !== "number"
      || !Number.isSafeInteger(lengthValue)
      || lengthValue < 1
      || lengthValue > 1024
      || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(descriptors).length !== lengthValue + 1
    ) {
      return undefined;
    }
    const snapshots: unknown[] = [];
    for (let index = 0; index < lengthValue; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      snapshots.push(descriptor.value);
    }
    return Object.freeze(snapshots);
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

async function snapshotAndVerifyFreshTargets(
  value: unknown,
): Promise<CliIoResult<readonly TransactionTargetSnapshot[]>> {
  const targetValues = snapshotFreshTargetArray(value);
  if (targetValues === undefined) return cliIoFailure([cliIoError("PATH_INVALID", "/targets")]);
  const snapshots: TransactionTargetSnapshot[] = [];
  const validatedTargets: ValidatedRelativeTarget[] = [];
  for (const [index, targetValue] of targetValues.entries()) {
    const snapshot = snapshotFreshTarget(targetValue);
    if (snapshot === undefined) {
      return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}`)]);
    }
    if (getTargetIdentity(snapshot.target) === undefined) {
      return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}`)]);
    }
    snapshots.push(snapshot);
    validatedTargets.push(snapshot.target);
  }
  const portableSet = assertPortableTargetSet(validatedTargets);
  if (!portableSet.ok) return portableSet;
  for (const [index, snapshot] of snapshots.entries()) {
    if (!(await freshVerifierPasses(snapshot.verifyStaged, snapshot.bytes))) {
      return cliIoFailure([cliIoError("STAGED_CONTENT_INVALID", `/targets/${index}/bytes`)]);
    }
  }
  return cliIoSuccess(Object.freeze(snapshots));
}

async function snapshotAndVerifyOrdinaryTargets(
  value: unknown,
): Promise<CliIoResult<readonly TransactionTargetSnapshot[]>> {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > 1024) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/targets")]);
    }
    const snapshots: TransactionTargetSnapshot[] = [];
    const validatedTargets: ValidatedRelativeTarget[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const snapshot = snapshotTarget(value[index]);
      if (snapshot === undefined || getTargetIdentity(snapshot.target) === undefined) {
        return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}`)]);
      }
      snapshots.push(snapshot);
      validatedTargets.push(snapshot.target);
    }
    const portableSet = assertPortableTargetSet(validatedTargets);
    if (!portableSet.ok) return portableSet;
    for (const [index, snapshot] of snapshots.entries()) {
      if (!(await verifierPasses(snapshot.verifyStaged, snapshot.bytes))) {
        return cliIoFailure([cliIoError("STAGED_CONTENT_INVALID", `/targets/${index}/bytes`)]);
      }
    }
    return cliIoSuccess(snapshots);
  } catch (error) {
    return pathFailureResult(error, "/targets");
  }
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (
      typeof value !== "object"
      || value === null
      || isProxy(value)
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return undefined;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
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
  input: { root: ResolvedOutputRoot; targets: readonly TransactionTargetSnapshot[] },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<PreparedTransactionTarget[]>> {
  try {
    await assertResolvedRoot(input.root, adapter);
    const preparedTargets: PreparedTransactionTarget[] = [];
    for (const [index, snapshot] of input.targets.entries()) {
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
        // The installed bytes already equal the requested bytes. Identity and
        // parent guards above have passed, so the target is current and needs no
        // write; staging it would build a manifest whose old and new digests are
        // equal, which the recovery cursor cannot tell apart.
        if (old.digest === prepared.newDigest) prepared.unchanged = true;
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
    targets: () => unknown;
  },
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
  options: {
    recoverBeforePreflight: boolean;
    requireFreshBeforeTransaction: boolean;
    targetsPreverified: boolean;
  },
): Promise<CliIoResult<CommitValue>> {
  let preparedTargets: PreparedTransactionTarget[] = [];
  let transactionDirectory: { transactionId: string; path: string; metadata: Stats } | undefined;
  let manifestIdentity: PrivateManifestIdentity | undefined;
  let initiatingFailure: CliIoResult<CommitValue> | undefined;
  try {
    await assertWriterClaim(adapter, claim);
    if (options.recoverBeforePreflight) {
      const recovered = await recoverTransactionsUnderClaimWithAdapter(
        { root: input.root, generatorVersion: input.generatorVersion },
        adapter,
        claim,
      );
      if (!recovered.ok) return recovered;
      await adapter.checkpoint("transaction-recovery-complete");
    }
    if (!options.targetsPreverified) await assertResolvedRoot(input.root, adapter);
    const targetInput = input.targets();
    const snapshots = options.targetsPreverified
      ? cliIoSuccess(targetInput as readonly TransactionTargetSnapshot[])
      : await snapshotAndVerifyOrdinaryTargets(targetInput);
    if (!snapshots.ok) return snapshots;
    const preflight = await preflightTargets({ root: input.root, targets: snapshots.value }, adapter);
    if (!preflight.ok) return preflight;
    preparedTargets = preflight.value;
    // Targets already holding the requested bytes carry no work. Excluding them
    // keeps every manifest record's old and new digest distinct, which the
    // recovery cursor relies on to tell its phases apart.
    const writtenTargets = preparedTargets.filter((target) => target.unchanged !== true);
    await assertWriterClaim(adapter, claim);
    if (options.requireFreshBeforeTransaction) {
      const fresh = await assertFreshResolvedRootWithAdapter(input.root, adapter);
      if (!fresh.ok) return fresh;
      await assertWriterClaim(adapter, claim);
    }
    if (writtenTargets.length === 0) return cliIoSuccess(commitValue(preparedTargets));
    transactionDirectory = await createTransactionDirectory(adapter, input.root);
    await adapter.checkpoint("transaction-directory-created");
    for (const [index, target] of writtenTargets.entries()) {
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
    for (const [index, target] of writtenTargets.entries()) {
      await revalidatePreCommitTarget(adapter, target, index);
    }

    const manifest = buildManifest(transactionDirectory.transactionId, input.generatorVersion, writtenTargets);
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
    for (const [index, target] of writtenTargets.entries()) {
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
    for (const [index, target] of writtenTargets.entries()) {
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
    for (const [index, target] of writtenTargets.entries()) {
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
      const cleaned = await safeCleanupBeforeManifest(adapter, input.root, transactionDirectory, preparedTargets.filter((target) => target.unchanged !== true));
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
  if (
    typeof input !== "object"
    || input === null
    || !isGeneratorVersion(input.generatorVersion)
  ) {
    return cliIoFailure([cliIoError("PATH_INVALID", "/generatorVersion")]);
  }
  let claim: PrivateWriterClaim;
  let result: CliIoResult<CommitValue>;
  try {
    const identity = await assertResolvedRoot(input.root, adapter);
    claim = await acquireWriterClaim(adapter, {
      rootPath: identity.absolutePath,
      rootMetadata: identity.metadata,
      generatorVersion: input.generatorVersion,
    });
    result = await commitFileTransactionUnderClaimWithAdapter({
      root: input.root,
      generatorVersion: input.generatorVersion,
      targets: () => input.targets,
    }, adapter, claim, {
      recoverBeforePreflight: true,
      requireFreshBeforeTransaction: false,
      targetsPreverified: false,
    });
  } catch (error) {
    if (error instanceof WriterClaimError) {
      return cliIoFailure([cliIoError(error.ioCode, error.errorPath)], error.uncertain);
    } else {
      const failure = pathFailureResult<CommitValue>(error, "/writerClaim");
      return failure.ok ? cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/writerClaim")]) : failure;
    }
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

export async function commitFreshFileTransactionWithAdapter(
  input: {
    outputDir: string;
    generatorVersion: string;
    targets: readonly FileTransactionTarget[];
  },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<CommitValue>> {
  const envelope = snapshotExactRecord(input, ["outputDir", "generatorVersion", "targets"]);
  if (envelope === undefined || typeof envelope.outputDir !== "string") {
    return cliIoFailure([cliIoError("PATH_INVALID", "/outputDir")]);
  }
  if (!isGeneratorVersion(envelope.generatorVersion)) {
    return cliIoFailure([cliIoError("PATH_INVALID", "/generatorVersion")]);
  }
  const outputPath = bindFreshOutputPath(envelope.outputDir);
  if (!outputPath.ok) return outputPath;
  const targets = await snapshotAndVerifyFreshTargets(envelope.targets);
  if (!targets.ok) return targets;

  const outputDir = outputPath.value;
  const generatorVersion = envelope.generatorVersion;
  const probe = await probeFreshOutputRootWithAdapter(outputDir, adapter);
  if (!probe.ok) return probe;
  const resolved = probe.value.kind === "recovery"
    ? await resolveRecoveryOutputRootWithAdapter(probe.value, adapter)
    : await resolveOutputRootWithAdapter({
        outputDir,
        creation: "create-if-missing",
        freshness: "require-no-business-entries",
      }, adapter);
  if (!resolved.ok) return resolved;
  const root = resolved.value;
  const recoveryProbe = probe.value.kind === "recovery" ? probe.value : undefined;

  let claim: PrivateWriterClaim | undefined;
  let result: CliIoResult<CommitValue>;
  try {
    if (recoveryProbe !== undefined) await adapter.checkpoint("fresh-recovery-root-resolved");
    const identity = await assertResolvedRoot(root, adapter);
    claim = await acquireWriterClaim(adapter, {
      rootPath: identity.absolutePath,
      rootMetadata: identity.metadata,
      generatorVersion,
      ...(recoveryProbe === undefined
        ? {}
        : { prewriteGuard: async () => assertRecoverySceneBeforeFirstClaimWrite(recoveryProbe, adapter) }),
    });
    const recovered = await recoverTransactionsUnderClaimWithAdapter(
      { root, generatorVersion },
      adapter,
      claim,
    );
    if (!recovered.ok) {
      result = recovered;
    } else {
      const fresh = await assertFreshResolvedRootWithAdapter(root, adapter);
      result = fresh.ok
        ? await commitFileTransactionUnderClaimWithAdapter({
            root,
            generatorVersion,
            targets: () => targets.value,
          }, adapter, claim, {
            recoverBeforePreflight: false,
            requireFreshBeforeTransaction: true,
            targetsPreverified: true,
          })
        : fresh;
    }
  } catch (error) {
    if (error instanceof WriterClaimError) {
      result = cliIoFailure([cliIoError(error.ioCode, error.errorPath)], error.uncertain);
    } else {
      const failure = pathFailureResult<CommitValue>(error, "/writerClaim");
      result = failure.ok ? cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/writerClaim")]) : failure;
    }
  }
  if (claim !== undefined) {
    try {
      await releaseWriterClaim(adapter, claim);
    } catch (error) {
      const failure = error instanceof WriterClaimError
        ? cliIoError(error.ioCode, error.errorPath)
        : cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/writerClaim");
      return cliIoFailure([failure], true);
    }
  }
  if (!result.ok && !result.recoveryRequired) {
    return cleanupRootAfterFailedCommit(root, adapter, result);
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

export async function commitFreshFileTransaction(input: {
  outputDir: string;
  generatorVersion: string;
  targets: readonly FileTransactionTarget[];
}): Promise<CliIoResult<CommitValue>> {
  try {
    return await commitFreshFileTransactionWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transaction")], true);
  }
}
