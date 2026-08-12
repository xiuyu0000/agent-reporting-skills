import {
  constants,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  chmod,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const USAGE_FORMAT = "review-usage/1" as const;
const LOCK_FORMAT = "review-usage-lock/1" as const;
const KEY_FILE = "case-hmac.key";
const KEY_BACKUP_FILE = "case-hmac.key.backup";
const RECORD_FILE = "usage.jsonl";
const LOCK_DIRECTORY = ".usage-append.lock";
const LOCK_MANIFEST = "owner.json";
const APPEND_INTENT = "append-intent.json";
const APPEND_INTENT_FORMAT = "review-usage-append-intent/1" as const;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const DIRECTORY_RETRY_ATTEMPTS = 20;
const DIRECTORY_RETRY_MS = 5;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_BASE_MS = 12;
const LOCK_RETRY_STEP_ATTEMPTS = 50;
const LOCK_RETRY_STEP_MS = 2;
const LOCK_RETRY_MAX_BASE_MS = 18;
const LOCK_RETRY_JITTER_MS = 2;
// The full contention schedule sleeps for at most 3.4s, well below stale-owner recovery.
const STALE_LOCK_MS = 30_000;
const CASE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const CASE_ID_PATTERN = /^CASE-[A-F0-9]{32}$/u;
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const MAX_CORRECTIONS = 1_000;
const MAX_INTERRUPTS = 1_000;
const MAX_SAMPLE_SEQUENCE = 1_000_000;
const MAX_DECISIONS = 15;
const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;
const MAX_REVISION_ROUNDS = 100;

const validationValues = new Set(["passed", "failed", "not-run", "unknown"]);
const resultValues = new Set(["success", "failure", "blocked", "unknown"]);
const inputKeys = new Set([
  "eligible",
  "triggered",
  "correct",
  "validation",
  "result",
  "corrections",
  "interruptions",
  "caseKey",
  "sampleSequence",
  "t0T1DecidedCount",
  "t0T1ActiveReviewMs",
  "totalActiveReviewMs",
  "sourceRevisionRounds",
  "closedLoop",
  "burdenScore",
]);
const storedKeys = new Set([
  "format",
  "caseId",
  ...[...inputKeys].filter((key) => key !== "caseKey"),
]);
const pilotKeys = [
  "sampleSequence",
  "t0T1DecidedCount",
  "t0T1ActiveReviewMs",
  "totalActiveReviewMs",
  "sourceRevisionRounds",
  "closedLoop",
  "burdenScore",
] as const;

type ValidationResult = "passed" | "failed" | "not-run" | "unknown";
type DeliveryResult = "success" | "failure" | "blocked" | "unknown";
type Conclusion = "通过" | "未达标" | "尚未验证";

export interface ContentFreeMetrics {
  eligible: boolean | null;
  triggered: boolean;
  correct: boolean | null;
  validation: ValidationResult;
  result: DeliveryResult;
  corrections: number;
  interruptions: number;
  caseKey?: string;
  sampleSequence?: number;
  t0T1DecidedCount?: number;
  t0T1ActiveReviewMs?: number;
  totalActiveReviewMs?: number;
  sourceRevisionRounds?: number;
  closedLoop?: boolean;
  burdenScore?: number;
}

interface StoredUsageRecord {
  format: typeof USAGE_FORMAT;
  caseId: string;
  eligible: boolean | null;
  triggered: boolean;
  correct: boolean | null;
  validation: ValidationResult;
  result: DeliveryResult;
  corrections: number;
  interruptions: number;
  sampleSequence?: number;
  t0T1DecidedCount?: number;
  t0T1ActiveReviewMs?: number;
  totalActiveReviewMs?: number;
  sourceRevisionRounds?: number;
  closedLoop?: boolean;
  burdenScore?: number;
}

interface LockManifest {
  format: typeof LOCK_FORMAT;
  owner: string;
  pid: number;
  createdAtMs: number;
  heartbeatAtMs: number;
}

interface UsageLock {
  stateDirectory: string;
  manifest: LockManifest;
  released: boolean;
}

interface AppendIntent {
  format: typeof APPEND_INTENT_FORMAT;
  owner: string;
  previousSize: number;
  recordBytes: number;
  recordHmac: string;
}

interface SecureReadResult {
  data: Buffer;
  stats: Stats;
}

interface DirectoryGuard {
  handle: FileHandle;
  identity: Stats;
  path: string;
  requiredMode: number | undefined;
}

export type AppendUsageResult =
  | { status: "recorded" }
  | { status: "not-recorded"; reason: "invalid-input" | "storage-unavailable" };

export interface CaseThresholdResult {
  sampleSequence: number;
  t0T1Under10Seconds: boolean;
  totalUnder30Minutes: boolean;
  revisionRoundsAtMost2: boolean;
  burdenLowerThanOld: boolean;
}

export interface UsageSummary {
  status: "summarized";
  conclusion: Conclusion;
  sampleCount: number;
  aggregate: {
    t0T1DecidedCount: number;
    t0T1ActiveReviewMs: number;
    t0T1AverageDecisionMs: number | null;
    totalActiveReviewMs: number;
    medianBurdenScore: number | null;
  };
  cases: CaseThresholdResult[];
}

export type SummarizeUsageResult =
  | UsageSummary
  | {
      status: "unavailable";
      conclusion: "尚未验证";
      sampleCount: 0;
      aggregate: UsageSummary["aggregate"];
      cases: [];
    };

export interface UsageRuntimeOptions {
  stateDirectory?: string;
  randomBytes?: (size: number) => Buffer;
  clock?: () => number;
  pid?: number;
  boundaryHooks?: {
    afterInputOpen?: () => Promise<void>;
    afterKeyOpen?: () => Promise<void>;
    afterLockAcquired?: (lockDirectory: string) => Promise<void>;
  };
  fileOps?: {
    write?: (handle: FileHandle, data: Buffer) => Promise<number>;
    syncDirectory?: (path: string) => Promise<void>;
  };
}

const emptyAggregate = (): UsageSummary["aggregate"] => ({
  t0T1DecidedCount: 0,
  t0T1ActiveReviewMs: 0,
  t0T1AverageDecisionMs: null,
  totalActiveReviewMs: 0,
  medianBurdenScore: null,
});

const unavailableSummary = (): SummarizeUsageResult => ({
  status: "unavailable",
  conclusion: "尚未验证",
  sampleCount: 0,
  aggregate: emptyAggregate(),
  cases: [],
});

const emptySummary = (): UsageSummary => ({
  status: "summarized",
  conclusion: "尚未验证",
  sampleCount: 0,
  aggregate: emptyAggregate(),
  cases: [],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTristate = (value: unknown): value is boolean | null =>
  typeof value === "boolean" || value === null;

const isBoundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function validateMetrics(value: unknown): ContentFreeMetrics | undefined {
  if (!isObject(value) || Object.keys(value).some((key) => !inputKeys.has(key))) return undefined;
  if (
    !isTristate(value.eligible) ||
    typeof value.triggered !== "boolean" ||
    !isTristate(value.correct) ||
    typeof value.validation !== "string" ||
    !validationValues.has(value.validation) ||
    typeof value.result !== "string" ||
    !resultValues.has(value.result) ||
    !isBoundedInteger(value.corrections, 0, MAX_CORRECTIONS) ||
    !isBoundedInteger(value.interruptions, 0, MAX_INTERRUPTS)
  ) {
    return undefined;
  }
  if (value.caseKey !== undefined && (typeof value.caseKey !== "string" || !CASE_KEY_PATTERN.test(value.caseKey))) {
    return undefined;
  }

  const hasAnyPilotField = pilotKeys.some((key) => value[key] !== undefined);
  if (
    hasAnyPilotField &&
    (typeof value.caseKey !== "string" ||
      !isBoundedInteger(value.sampleSequence, 1, MAX_SAMPLE_SEQUENCE) ||
      !isBoundedInteger(value.t0T1DecidedCount, 0, MAX_DECISIONS) ||
      !isBoundedInteger(value.t0T1ActiveReviewMs, 0, MAX_ACTIVE_MS) ||
      !isBoundedInteger(value.totalActiveReviewMs, 0, MAX_ACTIVE_MS) ||
      value.t0T1ActiveReviewMs > value.totalActiveReviewMs ||
      !isBoundedInteger(value.sourceRevisionRounds, 0, MAX_REVISION_ROUNDS) ||
      typeof value.closedLoop !== "boolean" ||
      !isBoundedInteger(value.burdenScore, -2, 2))
  ) {
    return undefined;
  }
  return value as unknown as ContentFreeMetrics;
}

/* v8 ignore start -- platform/default and defensive impossible-state guards */
function defaultStateDirectory(): string {
  return resolve(homedir(), ".codex", "state", "deliver-dual-audience-report", "usage");
}
/* v8 ignore stop */

function isErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

async function ignoreCleanupFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // Cleanup is best effort; the initiating failure remains authoritative.
  }
}

async function closeGuardQuietly(guard: DirectoryGuard): Promise<void> {
  await ignoreCleanupFailure(guard.handle.close());
}

async function closeGuard(guard: DirectoryGuard): Promise<void> {
  await guard.handle.close();
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("unsafe directory boundary");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe directory boundary");
  if ((await realpath(path)) !== path) throw new Error("non-canonical directory boundary");
}

/* v8 ignore start -- bounded filesystem-race fallback */
async function waitForPlainDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < DIRECTORY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await assertPlainDirectory(path);
      return;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      await delay(DIRECTORY_RETRY_MS);
    }
  }
  throw new Error("directory unavailable");
}
/* v8 ignore stop */

async function preparePrivateDirectory(input: string): Promise<DirectoryGuard> {
  const path = resolve(input);
  const root = parse(path).root;
  await assertPlainDirectory(root);
  let current = root;
  const components = path.slice(root.length).split(sep).filter((component) => component.length > 0);
  for (const component of components) {
    const next = join(current, component);
    try {
      await assertPlainDirectory(next);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (createError) {
        if (!isErrorCode(createError, "EEXIST")) throw createError;
      }
      await waitForPlainDirectory(next);
      await syncDirectory(current);
    }
    current = next;
  }
  await assertPlainDirectory(path);
  const currentMode = (await lstat(path)).mode & 0o777;
  if (currentMode !== 0o700) {
    await chmod(path, 0o700);
    await assertPlainDirectory(path);
  }
  return openDirectoryGuard(path, 0o700);
}

function assertPrivateRegularFile(metadata: Stats, expectedSize?: number): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (expectedSize !== undefined && metadata.size !== expectedSize)
  ) {
    throw new Error("unsafe private file");
  }
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openDirectoryGuard(path: string, requiredMode?: number): Promise<DirectoryGuard> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      !identity.isDirectory() ||
      !pathMetadata.isDirectory() ||
      pathMetadata.isSymbolicLink() ||
      !sameIdentity(identity, pathMetadata) ||
      (await realpath(path)) !== path ||
      (requiredMode !== undefined && ((identity.mode & 0o777) !== requiredMode || (pathMetadata.mode & 0o777) !== requiredMode))
    ) {
      throw new Error("directory identity changed");
    }
    return { handle, identity, path, requiredMode };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectDirectoryGuard(guard: DirectoryGuard): Promise<{ handleMetadata: Stats; pathMetadata: Stats }> {
  const handleMetadata = await guard.handle.stat();
  const pathMetadata = await lstat(guard.path);
  if (
    !handleMetadata.isDirectory() ||
    !pathMetadata.isDirectory() ||
    pathMetadata.isSymbolicLink() ||
    !sameIdentity(guard.identity, handleMetadata) ||
    !sameIdentity(guard.identity, pathMetadata) ||
    (await realpath(guard.path)) !== guard.path
  ) {
    throw new Error("directory identity changed");
  }
  return { handleMetadata, pathMetadata };
}

async function assertDirectoryGuard(guard: DirectoryGuard): Promise<void> {
  const { handleMetadata, pathMetadata } = await inspectDirectoryGuard(guard);
  if (
    guard.requiredMode !== undefined &&
    ((handleMetadata.mode & 0o777) !== guard.requiredMode || (pathMetadata.mode & 0o777) !== guard.requiredMode)
  ) {
    throw new Error("unsafe directory permissions");
  }
}

async function convergeDirectoryGuardMode(guard: DirectoryGuard): Promise<void> {
  const { handleMetadata, pathMetadata } = await inspectDirectoryGuard(guard);
  if (
    guard.requiredMode !== undefined &&
    ((handleMetadata.mode & 0o777) !== guard.requiredMode || (pathMetadata.mode & 0o777) !== guard.requiredMode)
  ) {
    await guard.handle.chmod(guard.requiredMode);
  }
  await assertDirectoryGuard(guard);
}

async function assertRecordIdentity(path: string, handle: FileHandle, identity: Stats): Promise<void> {
  const handleMetadata = await handle.stat();
  const pathMetadata = await lstat(path);
  assertPrivateRegularFile(handleMetadata);
  assertPrivateRegularFile(pathMetadata);
  if (!sameIdentity(identity, handleMetadata) || !sameIdentity(identity, pathMetadata)) {
    throw new Error("record identity changed");
  }
}

async function assertClosedRecordIdentity(path: string, identity: Stats): Promise<void> {
  const pathMetadata = await lstat(path);
  assertPrivateRegularFile(pathMetadata);
  if (!sameIdentity(identity, pathMetadata)) throw new Error("record identity changed");
}

async function openExistingParentGuards(filePath: string): Promise<DirectoryGuard[]> {
  const absolute = resolve(filePath);
  const root = parse(absolute).root;
  const parentComponents = absolute
    .slice(root.length)
    .split(sep)
    .filter((component) => component.length > 0)
    .slice(0, -1);
  const guards: DirectoryGuard[] = [];
  let current = root;
  try {
    guards.push(await openDirectoryGuard(root));
    for (const component of parentComponents) {
      current = join(current, component);
      guards.push(await openDirectoryGuard(current));
    }
    for (const guard of guards) await assertDirectoryGuard(guard);
    return guards;
  } catch (error) {
    await Promise.all(guards.map(closeGuardQuietly));
    throw error;
  }
}

async function assertParentGuards(guards: DirectoryGuard[]): Promise<void> {
  for (const guard of guards) await assertDirectoryGuard(guard);
}

async function closeParentGuards(guards: DirectoryGuard[]): Promise<void> {
  await Promise.all(guards.map(closeGuard));
}

async function securelyReadHandle(handle: FileHandle, maximumBytes: number, privateFile: boolean): Promise<SecureReadResult> {
  const before = await handle.stat();
  if (privateFile) assertPrivateRegularFile(before);
  else if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe input file");
  if (before.size > maximumBytes) throw new Error("file too large");
  const data = await handle.readFile();
  const after = await handle.stat();
  if (!sameSnapshot(before, after) || data.length !== before.size) throw new Error("file changed while reading");
  return { data, stats: after };
}

async function securelyReadPath(
  path: string,
  maximumBytes: number,
  privateFile: boolean,
  afterOpen?: () => Promise<void>,
  guardParents = false,
): Promise<SecureReadResult> {
  const parentGuards = guardParents ? await openExistingParentGuards(path) : [];
  let handle: FileHandle | undefined;
  try {
    if (guardParents) await assertParentGuards(parentGuards);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (afterOpen !== undefined) await afterOpen();
    const result = await securelyReadHandle(handle, maximumBytes, privateFile);
    let pathMetadata: Stats;
    try {
      pathMetadata = await lstat(path);
    } catch (error) {
      throw new Error("file identity changed", { cause: error });
    }
    if (pathMetadata.isSymbolicLink() || !sameIdentity(opened, pathMetadata)) throw new Error("file identity changed");
    if (guardParents) await assertParentGuards(parentGuards);
    return result;
  } finally {
    if (handle !== undefined) await handle.close();
    await closeParentGuards(parentGuards);
  }
}

/* v8 ignore start -- low-level fsync/cleanup error paths are platform injected */
async function writePrivateFile(path: string, data: Buffer, stateDirectory: string, owner: string): Promise<void> {
  const temporary = join(stateDirectory, `.${parse(path).base}.${owner}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const result = await handle.write(data, 0, data.length, null);
    if (result.bytesWritten !== data.length) throw new Error("incomplete private write");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(stateDirectory);
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      await ignoreCleanupFailure(unlink(temporary));
      throw error;
    }
  }
  await rename(temporary, path);
  await syncDirectory(stateDirectory);
}
/* v8 ignore stop */

type KeyRead = { kind: "missing" | "damaged" | "unsafe" } | { kind: "valid"; key: Buffer };

async function readKey(path: string, afterOpen?: () => Promise<void>): Promise<KeyRead> {
  try {
    const result = await securelyReadPath(path, 32, true, afterOpen);
    if (result.data.length !== 32) return { kind: "damaged" };
    return { kind: "valid", key: result.data };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "unsafe" };
  }
}

async function loadOrCreateKey(
  stateDirectory: string,
  owner: string,
  makeRandomBytes: (size: number) => Buffer,
  afterKeyOpen?: () => Promise<void>,
): Promise<Buffer> {
  const primaryPath = join(stateDirectory, KEY_FILE);
  const backupPath = join(stateDirectory, KEY_BACKUP_FILE);
  const primary = await readKey(primaryPath, afterKeyOpen);
  const backup = await readKey(backupPath, afterKeyOpen);
  if (primary.kind === "unsafe" || backup.kind === "unsafe") throw new Error("unsafe key storage");
  if (primary.kind === "valid" && backup.kind === "valid") {
    if (!primary.key.equals(backup.key)) throw new Error("ambiguous key copies");
    return primary.key;
  }
  if (primary.kind === "valid") {
    await writePrivateFile(backupPath, primary.key, stateDirectory, owner);
    return primary.key;
  }
  if (backup.kind === "valid") {
    await writePrivateFile(primaryPath, backup.key, stateDirectory, owner);
    return backup.key;
  }

  const records = await recordFileExists(stateDirectory);
  if (records) throw new Error("key unavailable for existing records");
  const key = makeRandomBytes(32);
  if (key.length !== 32) throw new Error("invalid random source");
  await writePrivateFile(primaryPath, key, stateDirectory, owner);
  await writePrivateFile(backupPath, key, stateDirectory, owner);
  return key;
}

function serializeManifest(manifest: LockManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

/* v8 ignore start -- parser rejection matrix is defensive; invalid locks fail closed at caller */
function parseManifest(data: Buffer): LockManifest | undefined {
  try {
    const value = JSON.parse(data.toString("utf8")) as unknown;
    if (
      !isObject(value) ||
      Object.keys(value).length !== 5 ||
      value.format !== LOCK_FORMAT ||
      typeof value.owner !== "string" ||
      !OWNER_TOKEN_PATTERN.test(value.owner) ||
      !isBoundedInteger(value.pid, 1, 2_147_483_647) ||
      !isBoundedInteger(value.createdAtMs, 0, Number.MAX_SAFE_INTEGER) ||
      !isBoundedInteger(value.heartbeatAtMs, value.createdAtMs, Number.MAX_SAFE_INTEGER)
    ) {
      return undefined;
    }
    return value as unknown as LockManifest;
  } catch {
    return undefined;
  }
}
/* v8 ignore stop */

async function readLockManifest(lockDirectory: string): Promise<LockManifest> {
  await assertPlainDirectory(lockDirectory);
  if (((await lstat(lockDirectory)).mode & 0o777) !== 0o700) throw new Error("unsafe lock directory");
  const { data } = await securelyReadPath(join(lockDirectory, LOCK_MANIFEST), 4096, true);
  const manifest = parseManifest(data);
  if (manifest === undefined) throw new Error("invalid lock owner");
  return manifest;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function lockRetryDelayMs(owner: string, attempt: number): number {
  const base = Math.min(
    LOCK_RETRY_MAX_BASE_MS,
    LOCK_RETRY_BASE_MS + Math.floor(attempt / LOCK_RETRY_STEP_ATTEMPTS) * LOCK_RETRY_STEP_MS,
  );
  const byteOffset = (attempt % (owner.length / 2)) * 2;
  const ownerByte = Number.parseInt(owner.slice(byteOffset, byteOffset + 2), 16);
  return base + ownerByte % (LOCK_RETRY_JITTER_MS + 1);
}

async function removeClaimedLock(claimPath: string, expectedOwner: string): Promise<void> {
  const manifest = await readLockManifest(claimPath);
  if (manifest.owner !== expectedOwner) throw new Error("lock owner changed");
  await unlink(join(claimPath, LOCK_MANIFEST));
  await rmdir(claimPath);
}

/* v8 ignore start -- post-claim rollback branches require filesystem fault injection */
async function recoverStaleLock(stateDirectory: string, expected: LockManifest, now: number, contender: string): Promise<boolean> {
  if (now - expected.heartbeatAtMs <= STALE_LOCK_MS || isProcessAlive(expected.pid)) return false;
  const lockPath = join(stateDirectory, LOCK_DIRECTORY);
  const current = await readLockManifest(lockPath);
  if (
    current.owner !== expected.owner ||
    current.pid !== expected.pid ||
    current.createdAtMs !== expected.createdAtMs ||
    current.heartbeatAtMs !== expected.heartbeatAtMs ||
    isProcessAlive(current.pid)
  ) {
    return false;
  }
  const claimPath = join(stateDirectory, `.usage-stale-${expected.owner}-${contender}`);
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    await removeClaimedLock(claimPath, expected.owner);
    return true;
  } catch (error) {
    try {
      await rename(claimPath, lockPath);
    } catch {
      // The caller fails closed if the exact owner cannot be restored.
    }
    throw error;
  }
}
/* v8 ignore stop */

async function createLockStaging(
  stateDirectory: string,
  manifest: LockManifest,
): Promise<string> {
  const stagingPath = join(stateDirectory, `.usage-lock-stage-${manifest.owner}`);
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    const data = serializeManifest(manifest);
    const handle = await open(
      join(stagingPath, LOCK_MANIFEST),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const result = await handle.write(data, 0, data.length, null);
      if (result.bytesWritten !== data.length) throw new Error("incomplete lock manifest");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(stagingPath);
    await syncDirectory(stateDirectory);
    const observed = await readLockManifest(stagingPath);
    if (observed.owner !== manifest.owner) throw new Error("staged lock owner changed");
    return stagingPath;
  } catch (error) {
    await ignoreCleanupFailure(unlink(join(stagingPath, LOCK_MANIFEST)));
    await ignoreCleanupFailure(rmdir(stagingPath));
    throw error;
  }
}

async function acquireUsageLock(
  stateGuard: DirectoryGuard,
  makeRandomBytes: (size: number) => Buffer,
  clock: () => number,
  pid: number,
): Promise<UsageLock> {
  await assertDirectoryGuard(stateGuard);
  const stateDirectory = stateGuard.path;
  const owner = makeRandomBytes(16).toString("hex");
  if (!OWNER_TOKEN_PATTERN.test(owner) || !isBoundedInteger(pid, 1, 2_147_483_647)) throw new Error("invalid lock identity");
  const lockPath = join(stateDirectory, LOCK_DIRECTORY);
  const createdAtMs = clock();
  if (!isBoundedInteger(createdAtMs, 0, Number.MAX_SAFE_INTEGER)) throw new Error("invalid clock");
  const manifest: LockManifest = {
    format: LOCK_FORMAT,
    owner,
    pid,
    createdAtMs,
    heartbeatAtMs: createdAtMs,
  };
  const stagingPath = await createLockStaging(stateDirectory, manifest);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const now = clock();
      if (!isBoundedInteger(now, 0, Number.MAX_SAFE_INTEGER)) throw new Error("invalid clock");
      try {
        await assertDirectoryGuard(stateGuard);
        await rename(stagingPath, lockPath);
        await assertDirectoryGuard(stateGuard);
        await syncDirectory(stateDirectory);
        await assertDirectoryGuard(stateGuard);
        const observed = await readLockManifest(lockPath);
        if (observed.owner !== owner) throw new Error("published lock owner changed");
        return { stateDirectory, manifest, released: false };
      } catch (error) {
        if (!isErrorCode(error, "EEXIST") && !isErrorCode(error, "ENOTEMPTY")) throw error;
      }

      let existing: LockManifest;
      try {
        await assertDirectoryGuard(stateGuard);
        existing = await readLockManifest(lockPath);
      } catch (error) {
        try {
          const metadata = await lstat(lockPath);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error;
        } catch (inspectionError) {
          if (isErrorCode(inspectionError, "ENOENT")) continue;
          throw inspectionError;
        }
        await delay(lockRetryDelayMs(owner, attempt));
        continue;
      }
      if (await recoverStaleLock(stateDirectory, existing, now, owner)) continue;
      await delay(lockRetryDelayMs(owner, attempt));
    }
    throw new Error("append lock unavailable");
  } catch (error) {
    try {
      await removeClaimedLock(stagingPath, owner);
      await syncDirectory(stateDirectory);
    } catch {
      // A staging directory already published at the canonical path is absent here.
    }
    throw error;
  }
}

/* v8 ignore start -- claim rollback failures need filesystem fault injection; owner checks are integration-tested */
async function releaseUsageLock(lock: UsageLock): Promise<void> {
  if (lock.released) return;
  const lockPath = join(lock.stateDirectory, LOCK_DIRECTORY);
  const current = await readLockManifest(lockPath);
  if (current.owner !== lock.manifest.owner) throw new Error("lock owner changed");
  const claimPath = join(lock.stateDirectory, `.usage-release-${lock.manifest.owner}`);
  await rename(lockPath, claimPath);
  try {
    await removeClaimedLock(claimPath, lock.manifest.owner);
    await syncDirectory(lock.stateDirectory);
    lock.released = true;
  } catch (error) {
    await ignoreCleanupFailure(rename(claimPath, lockPath));
    throw error;
  }
}
/* v8 ignore stop */

async function withUsageLock<T>(
  stateGuard: DirectoryGuard,
  options: UsageRuntimeOptions,
  operation: (lock: UsageLock) => Promise<T>,
): Promise<T> {
  await assertDirectoryGuard(stateGuard);
  const stateDirectory = stateGuard.path;
  const makeRandomBytes = options.randomBytes ?? nodeRandomBytes;
  const lock = await acquireUsageLock(
    stateGuard,
    makeRandomBytes,
    options.clock ?? Date.now,
    options.pid ?? process.pid,
  );
  let operationError: unknown;
  let result: T | undefined;
  try {
    if (options.boundaryHooks?.afterLockAcquired !== undefined) {
      await options.boundaryHooks.afterLockAcquired(join(stateDirectory, LOCK_DIRECTORY));
    }
    await assertDirectoryGuard(stateGuard);
    const observedOwner = await readLockManifest(join(stateDirectory, LOCK_DIRECTORY));
    if (observedOwner.owner !== lock.manifest.owner) throw new Error("lock owner changed before operation");
    result = await operation(lock);
    await assertDirectoryGuard(stateGuard);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await inspectDirectoryGuard(stateGuard);
    await releaseUsageLock(lock);
    await convergeDirectoryGuardMode(stateGuard);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

/* v8 ignore start -- injectable fault boundary; behavior is asserted through callers */
async function writeOnce(handle: FileHandle, data: Buffer, options: UsageRuntimeOptions): Promise<number> {
  if (options.fileOps?.write !== undefined) return options.fileOps.write(handle, data);
  return (await handle.write(data, 0, data.length, null)).bytesWritten;
}

async function syncUsageDirectory(path: string, options: UsageRuntimeOptions): Promise<void> {
  if (options.fileOps?.syncDirectory !== undefined) {
    await options.fileOps.syncDirectory(path);
    return;
  }
  await syncDirectory(path);
}
/* v8 ignore stop */

function buildStoredRecord(metrics: ContentFreeMetrics, caseId: string): StoredUsageRecord {
  const record: StoredUsageRecord = {
    format: USAGE_FORMAT,
    caseId,
    eligible: metrics.eligible,
    triggered: metrics.triggered,
    correct: metrics.correct,
    validation: metrics.validation,
    result: metrics.result,
    corrections: metrics.corrections,
    interruptions: metrics.interruptions,
  };
  if (metrics.sampleSequence !== undefined) record.sampleSequence = metrics.sampleSequence;
  if (metrics.t0T1DecidedCount !== undefined) record.t0T1DecidedCount = metrics.t0T1DecidedCount;
  if (metrics.t0T1ActiveReviewMs !== undefined) record.t0T1ActiveReviewMs = metrics.t0T1ActiveReviewMs;
  if (metrics.totalActiveReviewMs !== undefined) record.totalActiveReviewMs = metrics.totalActiveReviewMs;
  if (metrics.sourceRevisionRounds !== undefined) record.sourceRevisionRounds = metrics.sourceRevisionRounds;
  if (metrics.closedLoop !== undefined) record.closedLoop = metrics.closedLoop;
  if (metrics.burdenScore !== undefined) record.burdenScore = metrics.burdenScore;
  return record;
}

async function recordFileExists(stateDirectory: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(stateDirectory, RECORD_FILE));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe record file");
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function openRecordFile(stateDirectory: string): Promise<FileHandle> {
  const path = join(stateDirectory, RECORD_FILE);
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const handleMetadata = await handle.stat();
    assertPrivateRegularFile(handleMetadata);
    const pathMetadata = await lstat(path);
    if (pathMetadata.isSymbolicLink() || !sameIdentity(handleMetadata, pathMetadata)) throw new Error("record identity changed");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/* v8 ignore start -- parser rejection matrix is defensive; invalid intents fail closed at caller */
function parseAppendIntent(data: Buffer): AppendIntent | undefined {
  try {
    const value = JSON.parse(data.toString("utf8")) as unknown;
    if (
      !isObject(value) ||
      Object.keys(value).length !== 5 ||
      value.format !== APPEND_INTENT_FORMAT ||
      typeof value.owner !== "string" ||
      !OWNER_TOKEN_PATTERN.test(value.owner) ||
      !isBoundedInteger(value.previousSize, 0, MAX_RECORD_BYTES) ||
      !isBoundedInteger(value.recordBytes, 1, MAX_INPUT_BYTES) ||
      typeof value.recordHmac !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.recordHmac)
    ) {
      return undefined;
    }
    return value as unknown as AppendIntent;
  } catch {
    return undefined;
  }
}
/* v8 ignore stop */

async function readAppendIntent(stateDirectory: string): Promise<AppendIntent | undefined> {
  const path = join(stateDirectory, APPEND_INTENT);
  try {
    await normalizePublishedAppendIntent(stateDirectory);
    const { data } = await securelyReadPath(path, 4096, true);
    const intent = parseAppendIntent(data);
    if (intent === undefined) throw new Error("invalid append intent");
    return intent;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function normalizePublishedAppendIntent(stateDirectory: string): Promise<void> {
  const path = join(stateDirectory, APPEND_INTENT);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (before.nlink === 1) {
      assertPrivateRegularFile(before);
      return;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 2 || (before.mode & 0o777) !== 0o600 || before.size > 4096) {
      throw new Error("unsafe append intent publication");
    }
    const data = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameSnapshot(before, afterRead) || data.length !== before.size) throw new Error("append intent changed while recovering");
    const intent = parseAppendIntent(data);
    if (intent === undefined) throw new Error("invalid append intent publication");
    const temporary = join(stateDirectory, `.${APPEND_INTENT}.${intent.owner}.tmp`);
    const pathMetadata = await lstat(path);
    const temporaryMetadata = await lstat(temporary);
    if (
      !sameIdentity(before, pathMetadata) ||
      !sameIdentity(before, temporaryMetadata) ||
      pathMetadata.nlink !== 2 ||
      temporaryMetadata.nlink !== 2 ||
      !pathMetadata.isFile() ||
      !temporaryMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      temporaryMetadata.isSymbolicLink() ||
      (pathMetadata.mode & 0o777) !== 0o600 ||
      (temporaryMetadata.mode & 0o777) !== 0o600
    ) {
      throw new Error("append intent link identity changed");
    }
    await unlink(temporary);
    await syncDirectory(stateDirectory);
    const afterUnlink = await handle.stat();
    const publishedMetadata = await lstat(path);
    assertPrivateRegularFile(afterUnlink, data.length);
    assertPrivateRegularFile(publishedMetadata, data.length);
    if (!sameIdentity(before, afterUnlink) || !sameIdentity(before, publishedMetadata)) {
      throw new Error("append intent publication identity changed");
    }
  } finally {
    await handle.close();
  }
}

async function clearAppendIntent(stateDirectory: string): Promise<void> {
  try {
    await unlink(join(stateDirectory, APPEND_INTENT));
    await syncDirectory(stateDirectory);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function writeAppendIntent(stateDirectory: string, intent: AppendIntent, options: UsageRuntimeOptions): Promise<void> {
  const path = join(stateDirectory, APPEND_INTENT);
  const temporary = join(stateDirectory, `.${APPEND_INTENT}.${intent.owner}.tmp`);
  const data = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  let temporaryIdentity: Stats | undefined;
  try {
    const bytesWritten = await writeOnce(handle, data, options);
    if (bytesWritten !== data.length) throw new Error("incomplete append intent");
    await handle.sync();
    temporaryIdentity = await handle.stat();
    assertPrivateRegularFile(temporaryIdentity, data.length);
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      await ignoreCleanupFailure(unlink(temporary));
      await ignoreCleanupFailure(syncUsageDirectory(stateDirectory, options));
    }
  }
  if (temporaryIdentity === undefined) throw new Error("append intent identity unavailable");
  await assertClosedRecordIdentity(temporary, temporaryIdentity);
  await syncUsageDirectory(stateDirectory, options);
  try {
    await link(temporary, path);
  } catch (error) {
    await ignoreCleanupFailure(unlink(temporary));
    await ignoreCleanupFailure(syncUsageDirectory(stateDirectory, options));
    throw error;
  }
  await syncUsageDirectory(stateDirectory, options);
  await unlink(temporary);
  await syncUsageDirectory(stateDirectory, options);
  const published = await securelyReadPath(path, 4096, true);
  if (!published.data.equals(data)) throw new Error("append intent identity mismatch");
}

async function readAndRepairRecordPayload(stateDirectory: string, key: Buffer): Promise<Buffer> {
  const directoryGuard = await openDirectoryGuard(stateDirectory);
  try {
    await assertDirectoryGuard(directoryGuard);
    const intentBeforeOpen = await readAppendIntent(stateDirectory);
    if (!(await recordFileExists(stateDirectory))) {
      if (intentBeforeOpen !== undefined) {
        if (intentBeforeOpen.previousSize !== 0) throw new Error("append intent missing record file");
        await assertDirectoryGuard(directoryGuard);
        await clearAppendIntent(stateDirectory);
        await assertDirectoryGuard(directoryGuard);
      }
      return Buffer.alloc(0);
    }
    const recordPath = join(stateDirectory, RECORD_FILE);
    const handle = await openRecordFile(stateDirectory);
    const identity = await handle.stat();
    try {
      await assertDirectoryGuard(directoryGuard);
      await assertRecordIdentity(recordPath, handle, identity);
      const { data } = await securelyReadHandle(handle, MAX_RECORD_BYTES, true);
      await assertDirectoryGuard(directoryGuard);
      await assertRecordIdentity(recordPath, handle, identity);
      const intent = intentBeforeOpen;
      if (intent === undefined) {
        if (data.length !== 0 && data[data.length - 1] !== 0x0a) throw new Error("unproven partial record");
        return data;
      }
      if (data.length < intent.previousSize || data.length > intent.previousSize + intent.recordBytes) {
        throw new Error("append intent size mismatch");
      }
      if (data.length === intent.previousSize + intent.recordBytes) {
        const completed = data.subarray(intent.previousSize);
        const completedHmac = createHmac("sha256", key).update(completed).digest("hex");
        if (completedHmac !== intent.recordHmac) throw new Error("append intent digest mismatch");
        await assertRecordIdentity(recordPath, handle, identity);
        await clearAppendIntent(stateDirectory);
        await assertDirectoryGuard(directoryGuard);
        await assertRecordIdentity(recordPath, handle, identity);
        return data;
      }
      await handle.truncate(intent.previousSize);
      await handle.sync();
      await assertDirectoryGuard(directoryGuard);
      await assertRecordIdentity(recordPath, handle, identity);
      await syncDirectory(stateDirectory);
      await assertDirectoryGuard(directoryGuard);
      await assertRecordIdentity(recordPath, handle, identity);
      await clearAppendIntent(stateDirectory);
      await assertDirectoryGuard(directoryGuard);
      await assertRecordIdentity(recordPath, handle, identity);
      return data.subarray(0, intent.previousSize);
    } finally {
      await handle.close();
    }
  } finally {
    await directoryGuard.handle.close();
  }
}

async function appendRecord(
  directoryGuard: DirectoryGuard,
  record: StoredUsageRecord,
  key: Buffer,
  owner: string,
  options: UsageRuntimeOptions,
): Promise<void> {
  const stateDirectory = directoryGuard.path;
  await assertDirectoryGuard(directoryGuard);
  const existing = await readAndRepairRecordPayload(stateDirectory, key);
  if (existing.length > 0) {
    const priorRecords = existing.toString("utf8").slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
    if (!priorRecords.every(isStoredRecord)) throw new Error("invalid existing usage record");
  }
  const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const expectedSize = existing.length + data.length;
  if (!Number.isSafeInteger(expectedSize) || expectedSize > MAX_RECORD_BYTES) throw new Error("usage record capacity exceeded");
  const intent: AppendIntent = {
    format: APPEND_INTENT_FORMAT,
    owner,
    previousSize: existing.length,
    recordBytes: data.length,
    recordHmac: createHmac("sha256", key).update(data).digest("hex"),
  };
  await assertDirectoryGuard(directoryGuard);
  await writeAppendIntent(stateDirectory, intent, options);
  await assertDirectoryGuard(directoryGuard);
  const recordPath = join(stateDirectory, RECORD_FILE);
  const handle = await openRecordFile(stateDirectory);
  const identity = await handle.stat();
  try {
    await assertDirectoryGuard(directoryGuard);
    await assertRecordIdentity(recordPath, handle, identity);
    if ((await handle.stat()).size !== existing.length) throw new Error("usage record size changed before append");
    const bytesWritten = await writeOnce(handle, data, options);
    if (bytesWritten !== data.length) throw new Error("incomplete usage record");
    await assertDirectoryGuard(directoryGuard);
    await assertRecordIdentity(recordPath, handle, identity);
    await handle.sync();
    await assertDirectoryGuard(directoryGuard);
    await assertRecordIdentity(recordPath, handle, identity);
    const finalMetadata = await handle.stat();
    if (finalMetadata.size !== expectedSize) throw new Error("usage record size changed during append");
    const appended = Buffer.alloc(data.length);
    const { bytesRead } = await handle.read(appended, 0, appended.length, existing.length);
    if (bytesRead !== appended.length || createHmac("sha256", key).update(appended).digest("hex") !== intent.recordHmac) {
      throw new Error("usage record digest changed during append");
    }
    await assertDirectoryGuard(directoryGuard);
    await assertRecordIdentity(recordPath, handle, identity);
  } catch (error) {
    try {
      await handle.truncate(existing.length);
      await handle.sync();
    } catch {
      // Preserve the original path/identity failure; intent keeps recovery evidence.
    }
    throw error;
  } finally {
    await handle.close();
  }
  await assertDirectoryGuard(directoryGuard);
  await assertClosedRecordIdentity(recordPath, identity);
  await syncUsageDirectory(stateDirectory, options);
  await assertDirectoryGuard(directoryGuard);
  await assertClosedRecordIdentity(recordPath, identity);
  await clearAppendIntent(stateDirectory);
  await assertDirectoryGuard(directoryGuard);
  await assertClosedRecordIdentity(recordPath, identity);
}

export async function appendUsageMetrics(
  value: unknown,
  options: UsageRuntimeOptions = {},
): Promise<AppendUsageResult> {
  const metrics = validateMetrics(value);
  if (metrics === undefined) return { status: "not-recorded", reason: "invalid-input" };
  let stateGuard: DirectoryGuard | undefined;
  try {
    stateGuard = await preparePrivateDirectory(options.stateDirectory ?? defaultStateDirectory());
    const activeStateGuard = stateGuard;
    await withUsageLock(activeStateGuard, options, async (lock) => {
      const makeRandomBytes = options.randomBytes ?? nodeRandomBytes;
      const key = await loadOrCreateKey(activeStateGuard.path, lock.manifest.owner, makeRandomBytes, options.boundaryHooks?.afterKeyOpen);
      const caseSeed = metrics.caseKey ?? makeRandomBytes(32).toString("base64url");
      const caseId = `CASE-${createHmac("sha256", key).update(caseSeed, "utf8").digest("hex").slice(0, 32).toUpperCase()}`;
      await appendRecord(activeStateGuard, buildStoredRecord(metrics, caseId), key, lock.manifest.owner, options);
    });
    return { status: "recorded" };
  } catch {
    return { status: "not-recorded", reason: "storage-unavailable" };
  } finally {
    if (stateGuard !== undefined) await closeGuardQuietly(stateGuard);
  }
}

function isStoredRecord(value: unknown): value is StoredUsageRecord {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !storedKeys.has(key)) ||
    value.format !== USAGE_FORMAT ||
    typeof value.caseId !== "string" ||
    !CASE_ID_PATTERN.test(value.caseId)
  ) {
    return false;
  }
  const metricsCandidate: Record<string, unknown> = {
    eligible: value.eligible,
    triggered: value.triggered,
    correct: value.correct,
    validation: value.validation,
    result: value.result,
    corrections: value.corrections,
    interruptions: value.interruptions,
  };
  for (const key of pilotKeys) if (value[key] !== undefined) metricsCandidate[key] = value[key];
  if (pilotKeys.some((key) => value[key] !== undefined)) metricsCandidate.caseKey = "stored_case_key_0001";
  return validateMetrics(metricsCandidate) !== undefined;
}

function hasCompletePilot(record: StoredUsageRecord): record is StoredUsageRecord & Required<Pick<StoredUsageRecord, (typeof pilotKeys)[number]>> {
  return pilotKeys.every((key) => record[key] !== undefined);
}

function isEligiblePilot(record: StoredUsageRecord): record is StoredUsageRecord & Required<Pick<StoredUsageRecord, (typeof pilotKeys)[number]>> {
  return (
    hasCompletePilot(record) &&
    record.eligible === true &&
    record.triggered &&
    record.correct === true &&
    record.validation === "passed" &&
    record.result === "success" &&
    record.closedLoop &&
    record.t0T1DecidedCount > 0
  );
}

/* v8 ignore start -- overflow guards retained for tamper resistance beyond bounded v1 fields */
function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new Error("numeric overflow");
  }
  return left + right;
}

function checkedMultiply(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))) {
    throw new Error("numeric overflow");
  }
  return left * right;
}
/* v8 ignore stop */

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error("median requires values");
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error("median requires values");
  return checkedAdd(lower + 2, upper + 2) / 2 - 2;
}

async function loadStoredRecords(stateDirectory: string, key: Buffer): Promise<StoredUsageRecord[]> {
  const payload = await readAndRepairRecordPayload(stateDirectory, key);
  if (payload.length === 0) return [];
  const records = payload.toString("utf8").slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
  if (!records.every(isStoredRecord)) throw new Error("invalid usage record");
  return records;
}

export async function summarizeUsageMetrics(
  minimumSamples = 3,
  maximumSamples = 5,
  options: UsageRuntimeOptions = {},
): Promise<SummarizeUsageResult> {
  if (
    !Number.isInteger(minimumSamples) ||
    !Number.isInteger(maximumSamples) ||
    minimumSamples < 3 ||
    maximumSamples > 5 ||
    minimumSamples > maximumSamples
  ) {
    return unavailableSummary();
  }
  let stateGuard: DirectoryGuard | undefined;
  try {
    const requested = options.stateDirectory ?? defaultStateDirectory();
    try {
      await lstat(requested);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return emptySummary();
      throw error;
    }
    stateGuard = await preparePrivateDirectory(requested);
    const activeStateGuard = stateGuard;
    return await withUsageLock(activeStateGuard, options, async (lock) => {
      const key = await loadOrCreateKey(
        activeStateGuard.path,
        lock.manifest.owner,
        options.randomBytes ?? nodeRandomBytes,
        options.boundaryHooks?.afterKeyOpen,
      );
      const records = await loadStoredRecords(activeStateGuard.path, key);
      const latestCompleteByCase = new Map<
        string,
        StoredUsageRecord & Required<Pick<StoredUsageRecord, (typeof pilotKeys)[number]>>
      >();
      for (const record of records) {
        if (hasCompletePilot(record)) {
          const previous = latestCompleteByCase.get(record.caseId);
          if (previous !== undefined && record.sampleSequence < previous.sampleSequence) return emptySummary();
          latestCompleteByCase.set(record.caseId, record);
        }
      }
      const latestComplete = [...latestCompleteByCase.values()];
      const sequences = new Set(latestComplete.map((record) => record.sampleSequence));
      if (sequences.size !== latestComplete.length) return emptySummary();
      const eligible = latestComplete.filter(isEligiblePilot).sort((left, right) => left.sampleSequence - right.sampleSequence);
      const samples = eligible.slice(0, maximumSamples);
      if (samples.length === 0) return emptySummary();

      let t0T1DecidedCount = 0;
      let t0T1ActiveReviewMs = 0;
      let totalActiveReviewMs = 0;
      for (const record of samples) {
        t0T1DecidedCount = checkedAdd(t0T1DecidedCount, record.t0T1DecidedCount);
        t0T1ActiveReviewMs = checkedAdd(t0T1ActiveReviewMs, record.t0T1ActiveReviewMs);
        totalActiveReviewMs = checkedAdd(totalActiveReviewMs, record.totalActiveReviewMs);
      }
      const t0T1AverageDecisionMs = t0T1ActiveReviewMs / t0T1DecidedCount;
      if (!Number.isFinite(t0T1AverageDecisionMs)) throw new Error("invalid aggregate");
      const medianBurdenScore = median(samples.map((record) => record.burdenScore));
      const tenSeconds = checkedMultiply(10, 1000);
      const thirtyMinutes = checkedMultiply(checkedMultiply(30, 60), 1000);
      const cases = samples.map((record): CaseThresholdResult => ({
        sampleSequence: record.sampleSequence,
        t0T1Under10Seconds: record.t0T1ActiveReviewMs < checkedMultiply(record.t0T1DecidedCount, tenSeconds),
        totalUnder30Minutes: record.totalActiveReviewMs <= thirtyMinutes,
        revisionRoundsAtMost2: record.sourceRevisionRounds <= 2,
        burdenLowerThanOld: record.burdenScore < 0,
      }));
      const aggregate = { t0T1DecidedCount, t0T1ActiveReviewMs, t0T1AverageDecisionMs, totalActiveReviewMs, medianBurdenScore };
      if (samples.length < minimumSamples) {
        return { status: "summarized", conclusion: "尚未验证", sampleCount: samples.length, aggregate, cases };
      }
      const passed =
        t0T1AverageDecisionMs < tenSeconds &&
        cases.every((sample) => sample.totalUnder30Minutes && sample.revisionRoundsAtMost2) &&
        medianBurdenScore < 0;
      return { status: "summarized", conclusion: passed ? "通过" : "未达标", sampleCount: samples.length, aggregate, cases };
    });
  } catch {
    return unavailableSummary();
  } finally {
    if (stateGuard !== undefined) await closeGuardQuietly(stateGuard);
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function runRecordUsageCommand(
  arguments_: readonly string[],
  options: UsageRuntimeOptions = {},
): Promise<AppendUsageResult | SummarizeUsageResult> {
  const [operation, ...rest] = arguments_;
  if (operation === "append") {
    if (rest.length !== 2 || rest[0] !== "--input" || rest[1] === undefined) {
      return { status: "not-recorded", reason: "invalid-input" };
    }
    try {
      const inputPath = resolve(rest[1]);
      const { data } = await securelyReadPath(
        inputPath,
        MAX_INPUT_BYTES,
        false,
        options.boundaryHooks?.afterInputOpen,
        true,
      );
      return await appendUsageMetrics(JSON.parse(data.toString("utf8")) as unknown, options);
    } catch {
      return { status: "not-recorded", reason: "invalid-input" };
    }
  }
  if (operation === "summarize") {
    let minimumSamples = 3;
    let maximumSamples = 5;
    const seen = new Set<string>();
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index];
      const parsed = parsePositiveInteger(rest[index + 1]);
      if (parsed === undefined || flag === undefined || seen.has(flag)) return unavailableSummary();
      seen.add(flag);
      if (flag === "--min-samples") minimumSamples = parsed;
      else if (flag === "--max-samples") maximumSamples = parsed;
      else return unavailableSummary();
    }
    return summarizeUsageMetrics(minimumSamples, maximumSamples, options);
  }
  return { status: "not-recorded", reason: "invalid-input" };
}

export const usageStorageNames = Object.freeze({
  key: KEY_FILE,
  keyBackup: KEY_BACKUP_FILE,
  records: RECORD_FILE,
  lockDirectory: LOCK_DIRECTORY,
  lockManifest: LOCK_MANIFEST,
  lockFormat: LOCK_FORMAT,
  appendIntent: APPEND_INTENT,
  appendIntentFormat: APPEND_INTENT_FORMAT,
});
