import { join } from "node:path";
import type { Stats } from "node:fs";
import {
  sha256Bytes,
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
  inspectTargetParent,
  pathFailureResult,
  validateRelativeTarget,
  type ResolvedOutputRoot,
  type TargetParentGuard,
  type ValidatedRelativeTarget,
} from "./paths.js";
import {
  MAX_MANIFEST_BYTES,
  TRANSACTION_CONTAINER,
  TRANSACTION_DIRECTORY_MODE,
  TRANSACTION_FILE_MODE,
  TRANSACTION_MANIFEST,
  TRANSACTION_MANIFEST_NEXT,
  TRANSACTION_OWNER,
  WriterClaimError,
  acquireWriterClaim,
  assertPrivateDirectoryIdentity,
  assertRealDirectory,
  assertWriterClaim,
  isErrorCode,
  isGeneratorVersion,
  listTransactionEntriesUnderWriterClaim,
  nativeFileSystemAdapter,
  parseTransactionManifest,
  readRegularFile,
  sameIdentity,
  releaseWriterClaim,
  syncDirectory,
  writeTransactionManifest,
  type PrivateFileSystemAdapter,
  type PrivateManifestIdentity,
  type PrivateWriterClaim,
  type TransactionManifest,
  type TransactionManifestTarget,
} from "./fsync.js";

export interface RecoveryValue {
  readonly rolledBack: number;
  readonly cleanedCommitted: number;
}

interface FileState {
  kind: "missing" | "present";
  digest?: Sha256Digest;
  metadata?: Stats;
}

interface PreparedManifestTarget {
  manifestTarget: TransactionManifestTarget;
  target: ValidatedRelativeTarget;
  guard: TargetParentGuard;
  stagePath: string;
  backupPath?: string;
  finalState: FileState;
  stageState: FileState;
  backupState: FileState;
}

interface PreparedTransaction {
  directoryName: string;
  directoryPath: string;
  directoryMetadata: Stats;
  manifestIdentity: PrivateManifestIdentity;
  manifest: TransactionManifest;
  targets: PreparedManifestTarget[];
  hasManifestNext: boolean;
}

const TRANSACTION_NAME_PATTERN = /^TXN-[0-9A-F]{20}$/u;

class RecoveryInspectionError extends Error {
  constructor(
    readonly ioCode: CliIoErrorCode,
    readonly errorPath: string,
  ) {
    super(ioCode);
  }
}

function recoveryBoundary(code: CliIoErrorCode, path: string): never {
  throw new RecoveryInspectionError(code, path);
}

function safeEnvelope(bytes: Uint8Array): { owner?: unknown; generatorVersion?: unknown } | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as { owner?: unknown; generatorVersion?: unknown };
  } catch {
    return undefined;
  }
}

async function inspectFileState(
  adapter: PrivateFileSystemAdapter,
  path: string,
  privateMode?: number,
): Promise<FileState> {
  try {
    const result = await readRegularFile(
      adapter,
      path,
      privateMode === undefined ? {} : { privateMode },
    );
    return { kind: "present", digest: sha256Bytes(result.bytes), metadata: result.metadata };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
}

function expectDigest(state: FileState, digest: Sha256Digest): boolean {
  return state.kind === "present" && state.digest === digest;
}

function expectMissing(state: FileState): boolean {
  return state.kind === "missing";
}

function assertKnownDigest(
  state: FileState,
  allowed: readonly Sha256Digest[],
  path: string,
): void {
  if (state.kind === "present" && (state.digest === undefined || !allowed.includes(state.digest))) {
    recoveryBoundary("TRANSACTION_DIGEST_MISMATCH", path);
  }
}

function validateCursorState(
  manifest: TransactionManifest,
  target: PreparedManifestTarget,
  path: string,
): void {
  const record = target.manifestTarget;
  const replace = record.expectedOldDigest !== undefined;
  const finalOld = replace && expectDigest(target.finalState, record.expectedOldDigest as Sha256Digest);
  const finalNew = expectDigest(target.finalState, record.expectedNewDigest);
  const finalMissing = expectMissing(target.finalState);
  const stageNew = expectDigest(target.stageState, record.expectedNewDigest);
  const stageMissing = expectMissing(target.stageState);
  const backupOld = replace && expectDigest(target.backupState, record.expectedOldDigest as Sha256Digest);
  const backupMissing = expectMissing(target.backupState);

  assertKnownDigest(
    target.finalState,
    replace ? [record.expectedNewDigest, record.expectedOldDigest as Sha256Digest] : [record.expectedNewDigest],
    `${path}/final`,
  );
  assertKnownDigest(target.stageState, [record.expectedNewDigest], `${path}/stage`);
  if (replace) {
    assertKnownDigest(target.backupState, [record.expectedOldDigest as Sha256Digest], `${path}/backup`);
  } else if (!backupMissing) {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${path}/backup`);
  }
  if (finalOld && backupOld) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);

  if (manifest.phase === "committed") {
    if (!record.installComplete || !finalNew || !stageMissing || (replace && !record.backupComplete)) {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    }
    return;
  }
  if (manifest.phase === "staged") {
    if (
      record.backupComplete
      || record.installComplete
      || !stageNew
      || (replace ? !finalOld || !backupMissing : !finalMissing)
    ) {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    }
    return;
  }
  if (manifest.phase === "backing-up") {
    if (record.installComplete || !stageNew) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    if (replace) {
      const completed = record.backupComplete && finalMissing && backupOld;
      const waiting = !record.backupComplete && finalOld && backupMissing;
      const renameWindow = !record.backupComplete && finalMissing && backupOld;
      if (!completed && !waiting && !renameWindow) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    } else if (record.backupComplete || !finalMissing || !backupMissing) {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    }
    return;
  }
  if (manifest.phase === "installing") {
    if (replace && (!record.backupComplete || !backupOld)) {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    }
    if (!replace && record.backupComplete) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    const installed = record.installComplete && finalNew && stageMissing;
    const waiting = !record.installComplete && finalMissing && stageNew;
    const renameWindow = !record.installComplete && finalNew && stageMissing;
    if (!installed && !waiting && !renameWindow) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
    return;
  }
  if (manifest.phase !== "rolling-back") {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", path);
  }
  const safeFinal = finalMissing || finalNew || finalOld;
  const safeStage = stageMissing || stageNew;
  const safeBackup = backupMissing || backupOld;
  if (!safeFinal || !safeStage || !safeBackup) recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", path);
}

async function prepareTransaction(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  generatorVersion: string,
  directoryName: string,
  transactionIndex: number,
): Promise<PreparedTransaction> {
  const basePath = `/transactions/${transactionIndex}`;
  if (!TRANSACTION_NAME_PATTERN.test(directoryName)) {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", basePath);
  }
  const rootIdentity = await assertResolvedRoot(root, adapter);
  const directoryPath = join(rootIdentity.absolutePath, TRANSACTION_CONTAINER, directoryName);
  const metadata = await adapter.lstat(directoryPath);
  if (metadata.isSymbolicLink()) recoveryBoundary("TRANSACTION_MANIFEST_INVALID", basePath);
  try {
    assertRealDirectory(metadata, TRANSACTION_DIRECTORY_MODE, true);
  } catch {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", basePath);
  }
  if (metadata.dev !== rootIdentity.metadata.dev) {
    recoveryBoundary("CROSS_DEVICE_TRANSACTION", basePath);
  }
  await assertPrivateDirectoryIdentity(adapter, directoryPath, metadata);
  let manifestRead: Awaited<ReturnType<typeof readRegularFile>>;
  try {
    manifestRead = await readRegularFile(
      adapter,
      join(directoryPath, TRANSACTION_MANIFEST),
      { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/manifest`);
    }
    throw error;
  }
  const envelope = safeEnvelope(manifestRead.bytes);
  if (
    envelope !== undefined
    && (envelope.owner !== TRANSACTION_OWNER || envelope.generatorVersion !== generatorVersion)
  ) {
    recoveryBoundary("TRANSACTION_OWNER_UNKNOWN", `${basePath}/manifest`);
  }
  const manifest = parseTransactionManifest(manifestRead.bytes);
  if (manifest === undefined || manifest.transactionId !== directoryName) {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/manifest`);
  }
  if (manifest.generatorVersion !== generatorVersion) {
    recoveryBoundary("TRANSACTION_OWNER_UNKNOWN", `${basePath}/manifest/generatorVersion`);
  }

  const validatedTargets: ValidatedRelativeTarget[] = [];
  const preparedTargets: PreparedManifestTarget[] = [];
  for (const [index, manifestTarget] of manifest.targets.entries()) {
    const validated = validateRelativeTarget(manifestTarget.finalRelativePath);
    if (!validated.ok || validated.value.portableKey !== manifestTarget.portableKey) {
      recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/targets/${index}/finalRelativePath`);
    }
    validatedTargets.push(validated.value);
    const guard = await inspectTargetParent(root, validated.value, adapter);
    const stagePath = join(directoryPath, manifestTarget.stageRelativePath);
    const backupPath = manifestTarget.backupRelativePath === undefined
      ? undefined
      : join(directoryPath, manifestTarget.backupRelativePath);
    const [finalState, stageState, backupState] = await Promise.all([
      inspectFileState(adapter, guard.finalAbsolutePath),
      inspectFileState(adapter, stagePath, TRANSACTION_FILE_MODE),
      backupPath === undefined
        ? Promise.resolve<FileState>({ kind: "missing" })
        : inspectFileState(adapter, backupPath, TRANSACTION_FILE_MODE),
    ]);
    const prepared: PreparedManifestTarget = {
      manifestTarget,
      target: validated.value,
      guard,
      stagePath,
      ...(backupPath === undefined ? {} : { backupPath }),
      finalState,
      stageState,
      backupState,
    };
    validateCursorState(manifest, prepared, `${basePath}/targets/${index}`);
    preparedTargets.push(prepared);
  }
  const portableSet = assertPortableTargetSet(validatedTargets);
  if (!portableSet.ok) recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/targets`);

  const allowedEntries = new Set<string>([TRANSACTION_MANIFEST, TRANSACTION_MANIFEST_NEXT]);
  for (const target of manifest.targets) {
    allowedEntries.add(target.stageRelativePath);
    if (target.backupRelativePath !== undefined) allowedEntries.add(target.backupRelativePath);
  }
  const entries = await adapter.readdir(directoryPath);
  if (entries.some((entry) => !allowedEntries.has(entry.name))) {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", basePath);
  }
  const manifestNext = entries.find((entry) => entry.name === TRANSACTION_MANIFEST_NEXT);
  let hasManifestNext = false;
  if (manifestNext !== undefined) {
    const state = await inspectFileState(adapter, join(directoryPath, TRANSACTION_MANIFEST_NEXT), TRANSACTION_FILE_MODE);
    if (state.kind !== "present") recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/manifestNext`);
    hasManifestNext = true;
  }
  await assertPrivateDirectoryIdentity(adapter, directoryPath, metadata);
  const confirmedManifest = await readRegularFile(
    adapter,
    join(directoryPath, TRANSACTION_MANIFEST),
    { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
  );
  if (
    !sameIdentity(manifestRead.metadata, confirmedManifest.metadata)
    || sha256Bytes(manifestRead.bytes) !== sha256Bytes(confirmedManifest.bytes)
  ) {
    recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `${basePath}/manifest`);
  }
  return {
    directoryName,
    directoryPath,
    directoryMetadata: metadata,
    manifestIdentity: {
      metadata: manifestRead.metadata,
      digest: sha256Bytes(manifestRead.bytes),
    },
    manifest,
    targets: preparedTargets,
    hasManifestNext,
  };
}

async function unlinkIfPresent(adapter: PrivateFileSystemAdapter, path: string): Promise<void> {
  try {
    await adapter.unlink(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function refreshState(
  adapter: PrivateFileSystemAdapter,
  target: PreparedManifestTarget,
): Promise<{ final: FileState; stage: FileState; backup: FileState }> {
  return {
    final: await inspectFileState(adapter, target.guard.finalAbsolutePath),
    stage: await inspectFileState(adapter, target.stagePath, TRANSACTION_FILE_MODE),
    backup: target.backupPath === undefined
      ? { kind: "missing" }
      : await inspectFileState(adapter, target.backupPath, TRANSACTION_FILE_MODE),
  };
}

async function publishRollbackCursor(
  adapter: PrivateFileSystemAdapter,
  transaction: PreparedTransaction,
): Promise<void> {
  transaction.manifestIdentity = await writeTransactionManifest(
    adapter,
    transaction.directoryPath,
    transaction.manifest,
    transaction.directoryMetadata,
    transaction.manifestIdentity,
  );
}

async function cleanupTransactionDirectory(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  transaction: PreparedTransaction,
): Promise<void> {
  await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
  for (const target of transaction.targets) {
    await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
    await unlinkIfPresent(adapter, target.stagePath);
    if (target.backupPath !== undefined) {
      await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
      await unlinkIfPresent(adapter, target.backupPath);
    }
  }
  await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
  await unlinkIfPresent(adapter, join(transaction.directoryPath, TRANSACTION_MANIFEST_NEXT));
  const currentManifest = await readRegularFile(
    adapter,
    join(transaction.directoryPath, TRANSACTION_MANIFEST),
    { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
  );
  if (
    !sameIdentity(transaction.manifestIdentity.metadata, currentManifest.metadata)
    || transaction.manifestIdentity.digest !== sha256Bytes(currentManifest.bytes)
  ) {
    throw new Error("manifest identity changed before cleanup");
  }
  await unlinkIfPresent(adapter, join(transaction.directoryPath, TRANSACTION_MANIFEST));
  await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
  if ((await adapter.readdir(transaction.directoryPath)).length !== 0) throw new Error("transaction directory not empty");
  await adapter.rmdir(transaction.directoryPath);
  const rootIdentity = await assertResolvedRoot(root, adapter);
  await syncDirectory(adapter, join(rootIdentity.absolutePath, TRANSACTION_CONTAINER));
}

async function rollbackTransaction(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  transaction: PreparedTransaction,
): Promise<void> {
  await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
  if (transaction.hasManifestNext) {
    await adapter.unlink(join(transaction.directoryPath, TRANSACTION_MANIFEST_NEXT));
    await syncDirectory(adapter, transaction.directoryPath);
    transaction.hasManifestNext = false;
  }
  if (transaction.manifest.phase !== "rolling-back") {
    transaction.manifest.phase = "rolling-back";
    await publishRollbackCursor(adapter, transaction);
  }
  for (let index = transaction.targets.length - 1; index >= 0; index -= 1) {
    const target = transaction.targets[index] as PreparedManifestTarget;
    await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
    await assertTargetParentGuard(target.guard, adapter);
    const record = target.manifestTarget;
    let states = await refreshState(adapter, target);
    if (expectDigest(states.final, record.expectedNewDigest)) {
      await assertTargetParentGuard(target.guard, adapter);
      await adapter.unlink(target.guard.finalAbsolutePath);
      await syncDirectory(adapter, target.guard.parentAbsolutePath);
      record.installComplete = false;
      await publishRollbackCursor(adapter, transaction);
      states = await refreshState(adapter, target);
    }
    if (states.final.kind === "present" && record.expectedOldDigest === undefined) {
      recoveryBoundary("TRANSACTION_DIGEST_MISMATCH", `/transactions/rollback/targets/${index}/final`);
    }
    if (record.expectedOldDigest !== undefined) {
      if (expectDigest(states.final, record.expectedOldDigest)) {
        if (states.backup.kind === "present") {
          recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", `/transactions/rollback/targets/${index}`);
        }
      } else if (states.final.kind === "missing" && expectDigest(states.backup, record.expectedOldDigest)) {
        if (target.backupPath === undefined) throw new Error("missing backup path");
        await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
        await assertTargetParentGuard(target.guard, adapter);
        await adapter.rename(target.backupPath, target.guard.finalAbsolutePath);
        await assertTargetParentGuard(target.guard, adapter);
        await syncDirectory(adapter, target.guard.parentAbsolutePath);
        await syncDirectory(adapter, transaction.directoryPath);
        record.backupComplete = false;
        await publishRollbackCursor(adapter, transaction);
        states = await refreshState(adapter, target);
      } else {
        recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", `/transactions/rollback/targets/${index}/final`);
      }
    } else if (states.final.kind !== "missing") {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", `/transactions/rollback/targets/${index}/final`);
    }
    if (states.stage.kind === "present") {
      if (!expectDigest(states.stage, record.expectedNewDigest)) {
        recoveryBoundary("TRANSACTION_DIGEST_MISMATCH", `/transactions/rollback/targets/${index}/stage`);
      }
      await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
      await adapter.unlink(target.stagePath);
      await syncDirectory(adapter, transaction.directoryPath);
    }
    const verified = await refreshState(adapter, target);
    const restored = record.expectedOldDigest === undefined
      ? verified.final.kind === "missing"
      : expectDigest(verified.final, record.expectedOldDigest);
    if (!restored || verified.stage.kind !== "missing" || verified.backup.kind !== "missing") {
      recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", `/transactions/rollback/targets/${index}`);
    }
  }
  await cleanupTransactionDirectory(adapter, root, transaction);
}

async function cleanupCommittedTransaction(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  transaction: PreparedTransaction,
): Promise<void> {
  await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
  for (const [index, target] of transaction.targets.entries()) {
    await assertTargetParentGuard(target.guard, adapter);
    const final = await inspectFileState(adapter, target.guard.finalAbsolutePath);
    if (!expectDigest(final, target.manifestTarget.expectedNewDigest)) {
      recoveryBoundary("TRANSACTION_DIGEST_MISMATCH", `/transactions/committed/targets/${index}/final`);
    }
  }
  await cleanupTransactionDirectory(adapter, root, transaction);
}

async function prepareAllTransactions(
  adapter: PrivateFileSystemAdapter,
  root: ResolvedOutputRoot,
  generatorVersion: string,
  claim: PrivateWriterClaim,
): Promise<PreparedTransaction[]> {
  await assertResolvedRoot(root, adapter);
  await assertWriterClaim(adapter, claim);
  const entries = (await listTransactionEntriesUnderWriterClaim(adapter, claim))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const transactions: PreparedTransaction[] = [];
  const allTargets: ValidatedRelativeTarget[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as (typeof entries)[number];
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      recoveryBoundary("TRANSACTION_MANIFEST_INVALID", `/transactions/${index}`);
    }
    const transaction = await prepareTransaction(adapter, root, generatorVersion, entry.name, index);
    transactions.push(transaction);
    allTargets.push(...transaction.targets.map((target) => target.target));
  }
  if (allTargets.length > 0) {
    const collision = assertPortableTargetSet(allTargets);
    if (!collision.ok) recoveryBoundary("TRANSACTION_MANIFEST_INVALID", "/transactions/targets");
  }
  await assertResolvedRoot(root, adapter);
  const confirmedEntries = (await listTransactionEntriesUnderWriterClaim(adapter, claim))
    .map((entry) => `${entry.name}:${entry.isDirectory() ? "d" : "o"}:${entry.isSymbolicLink() ? "l" : "r"}`)
    .sort();
  const initialEntries = entries
    .map((entry) => `${entry.name}:${entry.isDirectory() ? "d" : "o"}:${entry.isSymbolicLink() ? "l" : "r"}`)
    .sort();
  if (
    confirmedEntries.length !== initialEntries.length
    || confirmedEntries.some((entry, index) => entry !== initialEntries[index])
  ) {
    recoveryBoundary("TRANSACTION_RECOVERY_BLOCKED", "/transactions");
  }
  for (const transaction of transactions) {
    await assertWriterClaim(adapter, claim);
    await assertPrivateDirectoryIdentity(adapter, transaction.directoryPath, transaction.directoryMetadata);
    const confirmedManifest = await readRegularFile(
      adapter,
      join(transaction.directoryPath, TRANSACTION_MANIFEST),
      { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
    );
    if (
      !sameIdentity(transaction.manifestIdentity.metadata, confirmedManifest.metadata)
      || transaction.manifestIdentity.digest !== sha256Bytes(confirmedManifest.bytes)
    ) {
      recoveryBoundary("TRANSACTION_MANIFEST_INVALID", "/transactions/manifest");
    }
  }
  return transactions;
}

export async function recoverTransactionsUnderClaimWithAdapter(
  input: { root: ResolvedOutputRoot; generatorVersion: string },
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
): Promise<CliIoResult<RecoveryValue>> {
  try {
    if (typeof input !== "object" || input === null || !isGeneratorVersion(input.generatorVersion)) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/generatorVersion")]);
    }
    await assertWriterClaim(adapter, claim);
    const transactions = await prepareAllTransactions(adapter, input.root, input.generatorVersion, claim);
    let rolledBack = 0;
    let cleanedCommitted = 0;
    for (const transaction of transactions) {
      await assertWriterClaim(adapter, claim);
      if (transaction.manifest.phase === "committed") {
        await cleanupCommittedTransaction(adapter, input.root, transaction);
        cleanedCommitted += 1;
      } else {
        await rollbackTransaction(adapter, input.root, transaction);
        rolledBack += 1;
      }
    }
    return cliIoSuccess(Object.freeze({ rolledBack, cleanedCommitted }));
  } catch (error) {
    if (error instanceof RecoveryInspectionError) {
      return cliIoFailure([cliIoError(error.ioCode, error.errorPath)], true);
    }
    const pathResult = pathFailureResult<RecoveryValue>(error, "/transactions");
    if (!pathResult.ok) return cliIoFailure(pathResult.errors, true);
    return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transactions")], true);
  }
}

export async function recoverTransactionsWithAdapter(
  input: { root: ResolvedOutputRoot; generatorVersion: string },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<RecoveryValue>> {
  if (typeof input !== "object" || input === null || !isGeneratorVersion(input.generatorVersion)) {
    return cliIoFailure([cliIoError("PATH_INVALID", "/generatorVersion")]);
  }
  let claim: PrivateWriterClaim | undefined;
  let result: CliIoResult<RecoveryValue>;
  try {
    const identity = await assertResolvedRoot(input.root, adapter);
    claim = await acquireWriterClaim(adapter, {
      rootPath: identity.absolutePath,
      rootMetadata: identity.metadata,
      generatorVersion: input.generatorVersion,
    });
    result = await recoverTransactionsUnderClaimWithAdapter(input, adapter, claim);
  } catch (error) {
    if (error instanceof WriterClaimError) {
      return cliIoFailure([cliIoError(error.ioCode, error.errorPath)], error.uncertain);
    }
    const failure = pathFailureResult<RecoveryValue>(error, "/writerClaim");
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
  return result;
}

export async function recoverTransactions(input: {
  root: ResolvedOutputRoot;
  generatorVersion: string;
}): Promise<CliIoResult<RecoveryValue>> {
  try {
    return await recoverTransactionsWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/transactions")], true);
  }
}
