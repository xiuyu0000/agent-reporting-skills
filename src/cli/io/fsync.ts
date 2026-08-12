import { randomBytes } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { sha256Bytes, type Sha256Digest } from "../../protocol/index.js";

export const TRANSACTION_FORMAT = "review-file-transaction/1" as const;
export const TRANSACTION_OWNER = "deliver-dual-audience-report/v0.2" as const;
export const TRANSACTION_CONTAINER = ".review-txn" as const;
export const TRANSACTION_MANIFEST = "manifest.json" as const;
export const TRANSACTION_MANIFEST_NEXT = "manifest.next" as const;
export const TRANSACTION_DIRECTORY_MODE = 0o700;
export const TRANSACTION_FILE_MODE = 0o600;
export const MAX_TRANSACTION_TARGETS = 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
const WRITER_CLAIM = ".writer-claim";
const WRITER_CLAIM_FORMAT = "review-writer-claim/1";
const WRITER_CLAIM_MAX_BYTES = 4096;
const WRITER_CLAIM_WAIT_MS = 5000;
const WRITER_CLAIM_POLL_MS = 20;
const WRITER_CANDIDATE_PATTERN = /^\.writer-claim-([1-9][0-9]*)-([0-9A-F]{20})\.tmp$/u;
const CURRENT_HOST_ID = sha256Bytes(new TextEncoder().encode(hostname()));
const CURRENT_BOOT_ID = `boot-minute:${Math.round((Date.now() - (uptime() * 1000)) / 60_000)}`;
const CURRENT_PROCESS_START_ID = `start-ms:${Math.round(Date.now() - (process.uptime() * 1000))}`;

export const TRANSACTION_PHASES = [
  "staged",
  "backing-up",
  "installing",
  "committed",
  "rolling-back",
] as const;

export type TransactionPhase = (typeof TRANSACTION_PHASES)[number];

export interface TransactionManifestTarget {
  portableKey: string;
  finalRelativePath: string;
  stageRelativePath: string;
  backupRelativePath?: string;
  expectedNewDigest: Sha256Digest;
  expectedOldDigest?: Sha256Digest;
  backupComplete: boolean;
  installComplete: boolean;
}

export interface TransactionManifest {
  format: typeof TRANSACTION_FORMAT;
  owner: typeof TRANSACTION_OWNER;
  transactionId: string;
  generatorVersion: string;
  phase: TransactionPhase;
  targets: TransactionManifestTarget[];
}

export interface PrivateManifestIdentity {
  metadata: Stats;
  digest: Sha256Digest;
}

export interface PrivateFileSystemAdapter {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<Dirent[]>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  randomBytes(size: number): Uint8Array;
  processAlive(pid: number): boolean;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  checkpoint(point: string): Promise<void>;
}

export const nativeFileSystemAdapter: PrivateFileSystemAdapter = Object.freeze({
  lstat,
  realpath,
  mkdir: async (path: string, mode: number) => {
    await mkdir(path, { mode });
  },
  readdir: async (path: string) => readdir(path, { withFileTypes: true }),
  open,
  link,
  rename,
  unlink,
  rmdir,
  randomBytes,
  processAlive: (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isErrorCode(error, "ESRCH");
    }
  },
  now: Date.now,
  wait: async (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  checkpoint: async () => undefined,
});

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRANSACTION_ID_PATTERN = /^TXN-[0-9A-F]{20}$/u;
const GENERATOR_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const STAGE_PATTERN = /^stage-([0-9]{6})\.bin$/u;
const BACKUP_PATTERN = /^backup-([0-9]{6})\.bin$/u;

export function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

export function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && (left.mode & 0o7777) === (right.mode & 0o7777);
}

export function isOwnedByCurrentUser(metadata: Stats): boolean {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

export function assertRealDirectory(
  metadata: Stats,
  privateMode?: number,
  requireOwnership = privateMode !== undefined,
): void {
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (requireOwnership && !isOwnedByCurrentUser(metadata))
    || (privateMode !== undefined && (metadata.mode & 0o777) !== privateMode)
    || (requireOwnership && privateMode === undefined && (metadata.mode & 0o022) !== 0)
  ) {
    throw new Error("unsafe directory boundary");
  }
}

export function assertRegularFile(
  metadata: Stats,
  privateMode?: number,
  requireOwnership = true,
): void {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (requireOwnership && !isOwnedByCurrentUser(metadata))
    || (privateMode !== undefined && (metadata.mode & 0o777) !== privateMode)
    || (privateMode !== undefined && metadata.nlink !== 1)
  ) {
    throw new Error("unsafe regular file");
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("incomplete write");
    offset += result.bytesWritten;
  }
}

export async function syncDirectory(adapter: PrivateFileSystemAdapter, path: string): Promise<void> {
  const handle = await adapter.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertRealDirectory(await handle.stat());
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncRegularFile(
  adapter: PrivateFileSystemAdapter,
  path: string,
  privateMode?: number,
): Promise<void> {
  const before = await adapter.lstat(path);
  assertRegularFile(before, privateMode);
  const handle = await adapter.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertRegularFile(opened, privateMode);
    if (!sameIdentity(before, opened)) throw new Error("file identity changed");
    await handle.sync();
    const after = await adapter.lstat(path);
    assertRegularFile(after, privateMode);
    if (!sameIdentity(opened, after)) throw new Error("file identity changed");
  } finally {
    await handle.close();
  }
}

export async function writeNewPrivateFile(
  adapter: PrivateFileSystemAdapter,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await adapter.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    TRANSACTION_FILE_MODE,
  );
  try {
    const initial = await handle.stat();
    assertRegularFile(initial, undefined, true);
    if (initial.nlink !== 1) throw new Error("unsafe new private file");
    if ((initial.mode & 0o777) !== TRANSACTION_FILE_MODE) {
      await handle.chmod(TRANSACTION_FILE_MODE);
    }
    await writeAll(handle, bytes);
    await handle.sync();
    const metadata = await handle.stat();
    assertRegularFile(metadata, TRANSACTION_FILE_MODE);
    if (metadata.size !== bytes.byteLength) throw new Error("private file size mismatch");
  } finally {
    await handle.close();
  }
}

export async function readRegularFile(
  adapter: PrivateFileSystemAdapter,
  path: string,
  options: { privateMode?: number; maximumBytes?: number } = {},
): Promise<{ bytes: Uint8Array; metadata: Stats }> {
  const before = await adapter.lstat(path);
  assertRegularFile(before, options.privateMode);
  if (options.maximumBytes !== undefined && before.size > options.maximumBytes) {
    throw new Error("file too large");
  }
  const handle = await adapter.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertRegularFile(opened, options.privateMode);
    if (!sameIdentity(before, opened)) throw new Error("file identity changed");
    if (options.maximumBytes !== undefined && opened.size > options.maximumBytes) {
      throw new Error("file too large");
    }
    const contents = await handle.readFile();
    if (contents.byteLength !== opened.size) throw new Error("file size changed");
    const after = await adapter.lstat(path);
    assertRegularFile(after, options.privateMode);
    if (!sameIdentity(opened, after) || after.size !== opened.size) {
      throw new Error("file identity changed");
    }
    return { bytes: Uint8Array.from(contents), metadata: opened };
  } finally {
    await handle.close();
  }
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseTarget(value: unknown, index: number): TransactionManifestTarget | undefined {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const hasBackup = Object.hasOwn(record, "backupRelativePath") || Object.hasOwn(record, "expectedOldDigest");
  const keys = [
    "portableKey",
    "finalRelativePath",
    "stageRelativePath",
    ...(hasBackup ? ["backupRelativePath", "expectedOldDigest"] : []),
    "expectedNewDigest",
    "backupComplete",
    "installComplete",
  ];
  if (!exactKeys(record, keys)) return undefined;
  const expectedIndex = String(index).padStart(6, "0");
  if (
    typeof record.portableKey !== "string"
    || record.portableKey.length === 0
    || typeof record.finalRelativePath !== "string"
    || record.finalRelativePath.length === 0
    || typeof record.stageRelativePath !== "string"
    || STAGE_PATTERN.exec(record.stageRelativePath)?.[1] !== expectedIndex
    || typeof record.expectedNewDigest !== "string"
    || !DIGEST_PATTERN.test(record.expectedNewDigest)
    || typeof record.backupComplete !== "boolean"
    || typeof record.installComplete !== "boolean"
  ) {
    return undefined;
  }
  if (hasBackup) {
    if (
      typeof record.backupRelativePath !== "string"
      || BACKUP_PATTERN.exec(record.backupRelativePath)?.[1] !== expectedIndex
      || typeof record.expectedOldDigest !== "string"
      || !DIGEST_PATTERN.test(record.expectedOldDigest)
    ) {
      return undefined;
    }
    return {
      portableKey: record.portableKey,
      finalRelativePath: record.finalRelativePath,
      stageRelativePath: record.stageRelativePath,
      backupRelativePath: record.backupRelativePath,
      expectedNewDigest: record.expectedNewDigest as Sha256Digest,
      expectedOldDigest: record.expectedOldDigest as Sha256Digest,
      backupComplete: record.backupComplete,
      installComplete: record.installComplete,
    };
  }
  return {
    portableKey: record.portableKey,
    finalRelativePath: record.finalRelativePath,
    stageRelativePath: record.stageRelativePath,
    expectedNewDigest: record.expectedNewDigest as Sha256Digest,
    backupComplete: record.backupComplete,
    installComplete: record.installComplete,
  };
}

export function isGeneratorVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && GENERATOR_VERSION_PATTERN.test(value);
}

export function serializeTransactionManifest(manifest: TransactionManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
}

export function parseTransactionManifest(bytes: Uint8Array): TransactionManifest | undefined {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = ownRecord(JSON.parse(text));
    if (
      parsed === undefined
      || !exactKeys(parsed, ["format", "owner", "transactionId", "generatorVersion", "phase", "targets"])
      || parsed.format !== TRANSACTION_FORMAT
      || parsed.owner !== TRANSACTION_OWNER
      || typeof parsed.transactionId !== "string"
      || !TRANSACTION_ID_PATTERN.test(parsed.transactionId)
      || !isGeneratorVersion(parsed.generatorVersion)
      || typeof parsed.phase !== "string"
      || !(TRANSACTION_PHASES as readonly string[]).includes(parsed.phase)
      || !Array.isArray(parsed.targets)
      || parsed.targets.length === 0
      || parsed.targets.length > MAX_TRANSACTION_TARGETS
    ) {
      return undefined;
    }
    const targets: TransactionManifestTarget[] = [];
    for (let index = 0; index < parsed.targets.length; index += 1) {
      const target = parseTarget(parsed.targets[index], index);
      if (target === undefined) return undefined;
      targets.push(target);
    }
    const manifest: TransactionManifest = {
      format: TRANSACTION_FORMAT,
      owner: TRANSACTION_OWNER,
      transactionId: parsed.transactionId,
      generatorVersion: parsed.generatorVersion,
      phase: parsed.phase as TransactionPhase,
      targets,
    };
    const canonical = serializeTransactionManifest(manifest);
    if (canonical.byteLength !== bytes.byteLength) return undefined;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (canonical[index] !== bytes[index]) return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

export async function writeTransactionManifest(
  adapter: PrivateFileSystemAdapter,
  transactionDirectory: string,
  manifest: TransactionManifest,
  expectedDirectory?: Stats,
  expectedManifest?: PrivateManifestIdentity,
): Promise<PrivateManifestIdentity> {
  const nextPath = join(transactionDirectory, TRANSACTION_MANIFEST_NEXT);
  const manifestPath = join(transactionDirectory, TRANSACTION_MANIFEST);
  if (expectedDirectory !== undefined) {
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory, expectedDirectory);
  }
  let previous: Stats | undefined;
  try {
    const observedPrevious = await readRegularFile(
      adapter,
      manifestPath,
      { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
    );
    if (expectedManifest === undefined) {
      throw new Error("unexpected previous manifest");
    }
    previous = observedPrevious.metadata;
    const parsedPrevious = parseTransactionManifest(observedPrevious.bytes);
    if (
      parsedPrevious === undefined
      || parsedPrevious.transactionId !== manifest.transactionId
      || parsedPrevious.generatorVersion !== manifest.generatorVersion
      || parsedPrevious.targets.length !== manifest.targets.length
      || parsedPrevious.targets.some((target, index) => {
        const next = manifest.targets[index];
        return next === undefined
          || target.portableKey !== next.portableKey
          || target.finalRelativePath !== next.finalRelativePath
          || target.expectedNewDigest !== next.expectedNewDigest
          || target.expectedOldDigest !== next.expectedOldDigest;
      })
    ) {
      throw new Error("previous manifest content changed");
    }
    if (
      expectedManifest !== undefined
      && (
        !sameIdentity(expectedManifest.metadata, observedPrevious.metadata)
        || expectedManifest.digest !== sha256Bytes(observedPrevious.bytes)
      )
    ) {
      throw new Error("previous manifest identity changed");
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
    if (expectedManifest !== undefined) throw new Error("expected manifest is missing", { cause: error });
  }
  await writeNewPrivateFile(adapter, nextPath, serializeTransactionManifest(manifest));
  const nextIdentity = await adapter.lstat(nextPath);
  assertRegularFile(nextIdentity, TRANSACTION_FILE_MODE);
  await adapter.checkpoint(`manifest-temp:${manifest.phase}`);
  if (expectedDirectory !== undefined) {
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory, expectedDirectory);
  }
  if (previous === undefined) {
    try {
      await adapter.lstat(manifestPath);
      throw new Error("manifest appeared before publication");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  } else {
    const current = await adapter.lstat(manifestPath);
    assertRegularFile(current, TRANSACTION_FILE_MODE);
    if (!sameIdentity(previous, current)) throw new Error("manifest identity changed");
  }
  await adapter.rename(nextPath, manifestPath);
  await syncDirectory(adapter, transactionDirectory);
  const published = await adapter.lstat(manifestPath);
  assertRegularFile(published, TRANSACTION_FILE_MODE);
  if (!sameIdentity(nextIdentity, published)) throw new Error("published manifest identity changed");
  const confirmed = await readRegularFile(
    adapter,
    manifestPath,
    { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
  );
  const parsed = parseTransactionManifest(confirmed.bytes);
  if (parsed === undefined || JSON.stringify(parsed) !== JSON.stringify(manifest)) {
    throw new Error("published manifest content changed");
  }
  if (expectedDirectory !== undefined) {
    await assertPrivateDirectoryIdentity(adapter, transactionDirectory, expectedDirectory);
  }
  await adapter.checkpoint(`manifest-published:${manifest.phase}`);
  return { metadata: published, digest: sha256Bytes(confirmed.bytes) };
}

export async function assertPrivateDirectoryIdentity(
  adapter: PrivateFileSystemAdapter,
  path: string,
  expected: Stats,
): Promise<void> {
  const current = await adapter.lstat(path);
  assertRealDirectory(current, TRANSACTION_DIRECTORY_MODE, true);
  if (!sameIdentity(expected, current)) throw new Error("private directory identity changed");
  const real = await adapter.realpath(path);
  if (real !== path) throw new Error("private directory path changed");
}

export async function readTransactionManifest(
  adapter: PrivateFileSystemAdapter,
  transactionDirectory: string,
): Promise<TransactionManifest | undefined> {
  const result = await readRegularFile(
    adapter,
    join(transactionDirectory, TRANSACTION_MANIFEST),
    { privateMode: TRANSACTION_FILE_MODE, maximumBytes: MAX_MANIFEST_BYTES },
  );
  return parseTransactionManifest(result.bytes);
}

interface WriterClaimRecord {
  format: typeof WRITER_CLAIM_FORMAT;
  owner: typeof TRANSACTION_OWNER;
  generatorVersion: string;
  hostId: Sha256Digest;
  bootId: string;
  pid: number;
  processStartId: string;
  nonce: string;
}

export interface PrivateWriterClaim {
  readonly rootPath: string;
  readonly rootMetadata: Stats;
  readonly containerPath: string;
  readonly containerMetadata: Stats;
  readonly claimPath: string;
  readonly claimMetadata: Stats;
  readonly claimDigest: Sha256Digest;
  readonly record: WriterClaimRecord;
}

export class WriterClaimError extends Error {
  constructor(
    readonly ioCode: "TRANSACTION_OWNER_UNKNOWN" | "TRANSACTION_RECOVERY_BLOCKED" | "IO_OPERATION_FAILED",
    readonly errorPath: string,
    readonly uncertain: boolean,
    options?: ErrorOptions,
  ) {
    super(ioCode, options);
  }
}

function writerClaimBoundary(
  code: WriterClaimError["ioCode"],
  uncertain: boolean,
  options?: ErrorOptions,
): never {
  throw new WriterClaimError(code, "/writerClaim", uncertain, options);
}

function serializeWriterClaim(record: WriterClaimRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

function parseWriterClaim(bytes: Uint8Array): WriterClaimRecord | undefined {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > WRITER_CLAIM_MAX_BYTES) return undefined;
    const parsed = ownRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (
      parsed === undefined
      || !exactKeys(parsed, [
        "format",
        "owner",
        "generatorVersion",
        "hostId",
        "bootId",
        "pid",
        "processStartId",
        "nonce",
      ])
      || parsed.format !== WRITER_CLAIM_FORMAT
      || parsed.owner !== TRANSACTION_OWNER
      || !isGeneratorVersion(parsed.generatorVersion)
      || typeof parsed.hostId !== "string"
      || !DIGEST_PATTERN.test(parsed.hostId)
      || typeof parsed.bootId !== "string"
      || !/^boot-minute:-?[0-9]+$/u.test(parsed.bootId)
      || typeof parsed.pid !== "number"
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.processStartId !== "string"
      || !/^start-ms:[0-9]+$/u.test(parsed.processStartId)
      || typeof parsed.nonce !== "string"
      || !/^[0-9A-F]{20}$/u.test(parsed.nonce)
    ) {
      return undefined;
    }
    const record: WriterClaimRecord = {
      format: WRITER_CLAIM_FORMAT,
      owner: TRANSACTION_OWNER,
      generatorVersion: parsed.generatorVersion,
      hostId: parsed.hostId as Sha256Digest,
      bootId: parsed.bootId,
      pid: parsed.pid,
      processStartId: parsed.processStartId,
      nonce: parsed.nonce,
    };
    const canonical = serializeWriterClaim(record);
    if (canonical.byteLength !== bytes.byteLength) return undefined;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (canonical[index] !== bytes[index]) return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function writerCandidateName(record: Pick<WriterClaimRecord, "pid" | "nonce">): string {
  return `.writer-claim-${record.pid}-${record.nonce}.tmp`;
}

function randomClaimNonce(adapter: PrivateFileSystemAdapter): string {
  const random = adapter.randomBytes(10);
  if (!(random instanceof Uint8Array) || random.byteLength !== 10) {
    writerClaimBoundary("IO_OPERATION_FAILED", false);
  }
  let nonce = "";
  for (const byte of random) nonce += byte.toString(16).padStart(2, "0");
  return nonce.toUpperCase();
}

async function assertClaimContainer(
  adapter: PrivateFileSystemAdapter,
  rootPath: string,
  rootMetadata: Stats,
  containerPath: string,
  containerMetadata: Stats,
): Promise<void> {
  const root = await adapter.lstat(rootPath);
  assertRealDirectory(root, undefined, true);
  if (!sameIdentity(rootMetadata, root) || (await adapter.realpath(rootPath)) !== rootPath) {
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
  }
  await assertPrivateDirectoryIdentity(adapter, containerPath, containerMetadata);
  if (containerMetadata.dev !== rootMetadata.dev) writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
}

async function inspectClaimArtifact(
  adapter: PrivateFileSystemAdapter,
  path: string,
  generatorVersion: string,
  allowedLinks: readonly number[],
): Promise<{ record: WriterClaimRecord; metadata: Stats; digest: Sha256Digest }> {
  let read: Awaited<ReturnType<typeof readRegularFile>>;
  try {
    read = await readRegularFile(adapter, path, { maximumBytes: WRITER_CLAIM_MAX_BYTES });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw error;
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true, { cause: error });
  }
  if (
    (read.metadata.mode & 0o777) !== TRANSACTION_FILE_MODE
    || !allowedLinks.includes(read.metadata.nlink)
  ) {
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
  }
  const record = parseWriterClaim(read.bytes);
  if (record === undefined) writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
  if (record.generatorVersion !== generatorVersion) writerClaimBoundary("TRANSACTION_OWNER_UNKNOWN", true);
  return { record, metadata: read.metadata, digest: sha256Bytes(read.bytes) };
}

async function removeClaimArtifactIfUnchanged(
  adapter: PrivateFileSystemAdapter,
  path: string,
  expected: { metadata: Stats; digest: Sha256Digest },
): Promise<void> {
  const current = await readRegularFile(adapter, path, { maximumBytes: WRITER_CLAIM_MAX_BYTES });
  if (!sameIdentity(expected.metadata, current.metadata) || expected.digest !== sha256Bytes(current.bytes)) {
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
  }
  await adapter.unlink(path);
}

async function cleanOwnCandidate(
  adapter: PrivateFileSystemAdapter,
  containerPath: string,
  candidatePath: string,
  candidate: { metadata: Stats; digest: Sha256Digest },
): Promise<void> {
  try {
    await removeClaimArtifactIfUnchanged(adapter, candidatePath, candidate);
    await syncDirectory(adapter, containerPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    if (error instanceof WriterClaimError) throw error;
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true, { cause: error });
  }
}

export async function acquireWriterClaim(
  adapter: PrivateFileSystemAdapter,
  input: {
    rootPath: string;
    rootMetadata: Stats;
    generatorVersion: string;
  },
): Promise<PrivateWriterClaim> {
  const containerPath = join(input.rootPath, TRANSACTION_CONTAINER);
  const containerMetadata = await adapter.lstat(containerPath);
  await assertClaimContainer(adapter, input.rootPath, input.rootMetadata, containerPath, containerMetadata);
  const record: WriterClaimRecord = {
    format: WRITER_CLAIM_FORMAT,
    owner: TRANSACTION_OWNER,
    generatorVersion: input.generatorVersion,
    hostId: CURRENT_HOST_ID,
    bootId: CURRENT_BOOT_ID,
    pid: process.pid,
    processStartId: CURRENT_PROCESS_START_ID,
    nonce: randomClaimNonce(adapter),
  };
  const candidatePath = join(containerPath, writerCandidateName(record));
  const claimPath = join(containerPath, WRITER_CLAIM);
  let candidate: { metadata: Stats; digest: Sha256Digest } | undefined;
  let claimPublished = false;
  try {
    await writeNewPrivateFile(adapter, candidatePath, serializeWriterClaim(record));
    await syncDirectory(adapter, containerPath);
    const inspectedCandidate = await inspectClaimArtifact(adapter, candidatePath, input.generatorVersion, [1]);
    if (JSON.stringify(inspectedCandidate.record) !== JSON.stringify(record)) {
      writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
    }
    const candidateIdentity = { metadata: inspectedCandidate.metadata, digest: inspectedCandidate.digest };
    candidate = candidateIdentity;
    const deadline = adapter.now() + WRITER_CLAIM_WAIT_MS;
    while (true) {
      await assertClaimContainer(adapter, input.rootPath, input.rootMetadata, containerPath, containerMetadata);
      try {
        await adapter.link(candidatePath, claimPath);
        claimPublished = true;
        await syncDirectory(adapter, containerPath);
        const linkedCandidate = await adapter.lstat(candidatePath);
        const linkedClaim = await adapter.lstat(claimPath);
        if (
          !sameIdentity(linkedCandidate, linkedClaim)
          || linkedCandidate.nlink !== 2
          || linkedClaim.nlink !== 2
        ) {
          writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
        }
        await removeClaimArtifactIfUnchanged(adapter, candidatePath, candidateIdentity);
        candidate = undefined;
        await syncDirectory(adapter, containerPath);
        const claim = await inspectClaimArtifact(adapter, claimPath, input.generatorVersion, [1]);
        if (JSON.stringify(claim.record) !== JSON.stringify(record)) {
          writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
        }
        return Object.freeze({
          rootPath: input.rootPath,
          rootMetadata: input.rootMetadata,
          containerPath,
          containerMetadata,
          claimPath,
          claimMetadata: claim.metadata,
          claimDigest: claim.digest,
          record,
        });
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        let existing: Awaited<ReturnType<typeof inspectClaimArtifact>>;
        try {
          existing = await inspectClaimArtifact(adapter, claimPath, input.generatorVersion, [1, 2]);
        } catch (inspectionError) {
          if (isErrorCode(inspectionError, "ENOENT")) continue;
          throw inspectionError;
        }
        if (
          existing.record.hostId !== CURRENT_HOST_ID
          || existing.record.bootId !== CURRENT_BOOT_ID
        ) {
          writerClaimBoundary("TRANSACTION_OWNER_UNKNOWN", true);
        }
        const ownerAlive = existing.record.pid === process.pid
          ? existing.record.processStartId === CURRENT_PROCESS_START_ID
          : adapter.processAlive(existing.record.pid);
        if (!ownerAlive) {
          try {
            await removeClaimArtifactIfUnchanged(adapter, claimPath, existing);
            await syncDirectory(adapter, containerPath);
          } catch (reclaimError) {
            if (!isErrorCode(reclaimError, "ENOENT")) throw reclaimError;
          }
          continue;
        }
        if (adapter.now() >= deadline) writerClaimBoundary("IO_OPERATION_FAILED", false);
        await adapter.wait(WRITER_CLAIM_POLL_MS);
      }
    }
  } catch (error) {
    if (claimPublished) {
      try {
        const published = await inspectClaimArtifact(adapter, claimPath, input.generatorVersion, [1, 2]);
        if (JSON.stringify(published.record) !== JSON.stringify(record)) {
          writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
        }
        await removeClaimArtifactIfUnchanged(adapter, claimPath, published);
        await syncDirectory(adapter, containerPath);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error;
      }
    }
    if (candidate !== undefined) {
      const candidateToClean = candidate;
      await cleanOwnCandidate(adapter, containerPath, candidatePath, candidateToClean);
    }
    if (error instanceof WriterClaimError) throw error;
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true, { cause: error });
  }
  writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
}

export async function assertWriterClaim(
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
): Promise<void> {
  await assertClaimContainer(
    adapter,
    claim.rootPath,
    claim.rootMetadata,
    claim.containerPath,
    claim.containerMetadata,
  );
  const current = await inspectClaimArtifact(adapter, claim.claimPath, claim.record.generatorVersion, [1]);
  if (
    !sameIdentity(claim.claimMetadata, current.metadata)
    || claim.claimDigest !== current.digest
    || JSON.stringify(claim.record) !== JSON.stringify(current.record)
  ) {
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
  }
}

export async function releaseWriterClaim(
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
): Promise<void> {
  try {
    await assertWriterClaim(adapter, claim);
    await adapter.unlink(claim.claimPath);
    await syncDirectory(adapter, claim.containerPath);
    await assertClaimContainer(
      adapter,
      claim.rootPath,
      claim.rootMetadata,
      claim.containerPath,
      claim.containerMetadata,
    );
  } catch (error) {
    if (error instanceof WriterClaimError) throw error;
    writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true, { cause: error });
  }
}

export async function listTransactionEntriesUnderWriterClaim(
  adapter: PrivateFileSystemAdapter,
  claim: PrivateWriterClaim,
): Promise<Dirent[]> {
  await assertWriterClaim(adapter, claim);
  const entries = await adapter.readdir(claim.containerPath);
  const transactions: Dirent[] = [];
  for (const entry of entries) {
    if (entry.name === WRITER_CLAIM) continue;
    const candidateMatch = WRITER_CANDIDATE_PATTERN.exec(entry.name);
    if (candidateMatch === null) {
      transactions.push(entry);
      continue;
    }
    let candidate: Awaited<ReturnType<typeof inspectClaimArtifact>>;
    try {
      candidate = await inspectClaimArtifact(
        adapter,
        join(claim.containerPath, entry.name),
        claim.record.generatorVersion,
        [1],
      );
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      candidate.record.pid !== Number(candidateMatch[1])
      || candidate.record.nonce !== candidateMatch[2]
    ) {
      writerClaimBoundary("TRANSACTION_RECOVERY_BLOCKED", true);
    }
    if (candidate.record.hostId !== CURRENT_HOST_ID || candidate.record.bootId !== CURRENT_BOOT_ID) {
      writerClaimBoundary("TRANSACTION_OWNER_UNKNOWN", true);
    }
    const ownerAlive = candidate.record.pid === process.pid
      ? candidate.record.processStartId === CURRENT_PROCESS_START_ID
      : adapter.processAlive(candidate.record.pid);
    if (!ownerAlive) {
      await removeClaimArtifactIfUnchanged(adapter, join(claim.containerPath, entry.name), candidate);
      await syncDirectory(adapter, claim.containerPath);
    }
  }
  await assertWriterClaim(adapter, claim);
  return transactions;
}
