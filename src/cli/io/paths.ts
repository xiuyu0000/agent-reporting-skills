import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  portablePathKey,
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
  TRANSACTION_CONTAINER,
  TRANSACTION_DIRECTORY_MODE,
  assertRealDirectory,
  isErrorCode,
  isOwnedByCurrentUser,
  nativeFileSystemAdapter,
  readExactFileHandleBytes,
  sameIdentity,
  syncDirectory,
  type PrivateFileSystemAdapter,
} from "./fsync.js";

const resolvedOutputRootBrand: unique symbol = Symbol("ResolvedOutputRoot");
const resolvedInputRootBrand: unique symbol = Symbol("ResolvedInputRoot");
const validatedRelativeTargetBrand: unique symbol = Symbol("ValidatedRelativeTarget");

export interface ResolvedOutputRoot {
  readonly absolutePath: string;
  readonly createdByThisCall: boolean;
  readonly [resolvedOutputRootBrand]: true;
}

export interface ResolvedInputRoot {
  readonly absolutePath: string;
  readonly [resolvedInputRootBrand]: true;
}

export interface ValidatedRelativeTarget {
  readonly relativePath: string;
  readonly portableKey: PortablePathKey;
  readonly [validatedRelativeTargetBrand]: true;
}

interface RootIdentity {
  absolutePath: string;
  createdByThisCall: boolean;
  metadata: Stats;
  parentPath: string;
  parentMetadata: Stats;
}

interface TargetIdentity {
  relativePath: string;
  portableKey: PortablePathKey;
}

interface InputRootIdentity {
  absolutePath: string;
  metadata: Stats;
  directories: readonly DirectoryIdentity[];
}

export interface DirectoryIdentity {
  absolutePath: string;
  realPath: string;
  metadata: Stats;
}

export interface TargetParentGuard {
  root: RootIdentity;
  finalAbsolutePath: string;
  parentAbsolutePath: string;
  directories: readonly DirectoryIdentity[];
}

interface InputTargetGuard {
  root: InputRootIdentity;
  finalAbsolutePath: string;
  directories: readonly DirectoryIdentity[];
}

interface InputFileSnapshot {
  metadata: Stats;
  realPath: string;
}

const rootRegistry = new WeakMap<object, RootIdentity>();
const inputRootRegistry = new WeakMap<object, InputRootIdentity>();
const targetRegistry = new WeakMap<object, TargetIdentity>();
const SAFE_OUTPUT_INPUT = /^.{1,32768}$/su;
const RESERVED_PORTABLE_SEGMENT = ".review-txn";
export const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;

export class PathBoundaryError extends Error {
  constructor(
    readonly ioCode: CliIoErrorCode,
    readonly errorPath: string,
  ) {
    super(ioCode);
  }
}

function boundary(code: CliIoErrorCode, path: string): never {
  throw new PathBoundaryError(code, path);
}

function resultFromPathError<T>(error: unknown, path: string): CliIoResult<T> {
  if (error instanceof PathBoundaryError) {
    return cliIoFailure([cliIoError(error.ioCode, error.errorPath)]);
  }
  if (isErrorCode(error, "ELOOP")) {
    return cliIoFailure([cliIoError("SYMLINK_REJECTED", path)]);
  }
  if (
    isErrorCode(error, "ENOENT")
    || isErrorCode(error, "ENOTDIR")
    || isErrorCode(error, "EINVAL")
    || isErrorCode(error, "EACCES")
    || isErrorCode(error, "EPERM")
  ) {
    return cliIoFailure([cliIoError("PATH_INVALID", path)]);
  }
  if (isErrorCode(error, "EXDEV")) {
    return cliIoFailure([cliIoError("CROSS_DEVICE_TRANSACTION", path)]);
  }
  return cliIoFailure([cliIoError("IO_OPERATION_FAILED", path)]);
}

function sameDevice(left: Stats, right: Stats): boolean {
  return left.dev === right.dev;
}

async function inspectDirectory(
  adapter: PrivateFileSystemAdapter,
  path: string,
  options: { privateMode?: number; requireOwnership?: boolean } = {},
): Promise<DirectoryIdentity> {
  const metadata = await adapter.lstat(path);
  if (metadata.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/outputDir");
  try {
    assertRealDirectory(metadata, options.privateMode, options.requireOwnership ?? false);
  } catch {
    boundary("PATH_INVALID", "/outputDir");
  }
  const realPath = await adapter.realpath(path);
  return { absolutePath: path, realPath, metadata };
}

async function inspectExistingDirectoryChain(
  adapter: PrivateFileSystemAdapter,
  absolutePath: string,
): Promise<DirectoryIdentity[]> {
  const filesystemRoot = parse(absolutePath).root;
  const directories: DirectoryIdentity[] = [];
  let current = filesystemRoot;
  directories.push(await inspectDirectory(adapter, current));
  const components = absolutePath
    .slice(filesystemRoot.length)
    .split(sep)
    .filter((component) => component.length > 0);
  for (const component of components) {
    current = join(current, component);
    directories.push(await inspectDirectory(adapter, current));
  }
  return directories;
}

async function assertBoundInputDirectoryChain(
  adapter: PrivateFileSystemAdapter,
  directories: readonly DirectoryIdentity[],
  errorPath: "/inputDir" | "/root" | "/target",
  changedCode: "PATH_INVALID" | "IO_OPERATION_FAILED",
): Promise<void> {
  for (const directory of directories) {
    try {
      const current = await adapter.lstat(directory.absolutePath);
      if (current.isSymbolicLink()) boundary("SYMLINK_REJECTED", errorPath);
      if (!current.isDirectory() || !sameIdentity(directory.metadata, current)) {
        boundary(changedCode, errorPath);
      }
      const currentRealPath = await adapter.realpath(directory.absolutePath);
      if (currentRealPath !== directory.realPath || currentRealPath !== directory.absolutePath) {
        boundary("PATH_ESCAPE", errorPath);
      }
    } catch (error) {
      if (error instanceof PathBoundaryError) throw error;
      boundary(isErrorCode(error, "ELOOP") ? "SYMLINK_REJECTED" : changedCode, errorPath);
    }
  }
}

async function inspectExistingInputDirectoryChain(
  adapter: PrivateFileSystemAdapter,
  absolutePath: string,
): Promise<DirectoryIdentity[]> {
  let directories: DirectoryIdentity[];
  try {
    directories = await inspectExistingDirectoryChain(adapter, absolutePath);
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      throw new PathBoundaryError(error.ioCode, "/inputDir");
    }
    throw error;
  }
  for (const directory of directories) {
    if (directory.realPath !== directory.absolutePath) boundary("PATH_ESCAPE", "/inputDir");
  }
  const root = directories.at(-1);
  if (
    root === undefined
    || !isOwnedByCurrentUser(root.metadata)
    || (root.metadata.mode & 0o022) !== 0
  ) {
    boundary("PATH_INVALID", "/inputDir");
  }
  await assertBoundInputDirectoryChain(adapter, directories, "/inputDir", "IO_OPERATION_FAILED");
  return directories;
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

async function verifyTransactionContainer(
  adapter: PrivateFileSystemAdapter,
  root: RootIdentity,
): Promise<void> {
  const rootBefore = await adapter.lstat(root.absolutePath);
  if (!sameIdentity(root.metadata, rootBefore) || (await adapter.realpath(root.absolutePath)) !== root.absolutePath) {
    boundary("PATH_INVALID", "/outputDir");
  }
  const containerPath = join(root.absolutePath, TRANSACTION_CONTAINER);
  const metadata = await lstatIfPresent(adapter, containerPath);
  if (metadata === undefined) {
    await adapter.mkdir(containerPath, TRANSACTION_DIRECTORY_MODE);
    await syncDirectory(adapter, root.absolutePath);
  }
  const observed = await adapter.lstat(containerPath);
  if (observed.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/outputDir/.review-txn");
  try {
    assertRealDirectory(observed, TRANSACTION_DIRECTORY_MODE, true);
  } catch {
    boundary("PATH_INVALID", "/outputDir/.review-txn");
  }
  if (!sameDevice(root.metadata, observed)) {
    boundary("CROSS_DEVICE_TRANSACTION", "/outputDir/.review-txn");
  }
  const containerRealPath = await adapter.realpath(containerPath);
  const relativeContainer = relative(root.absolutePath, containerRealPath);
  if (relativeContainer !== TRANSACTION_CONTAINER) {
    boundary("PATH_ESCAPE", "/outputDir/.review-txn");
  }
  const rootAfter = await adapter.lstat(root.absolutePath);
  if (!sameIdentity(root.metadata, rootAfter) || (await adapter.realpath(root.absolutePath)) !== root.absolutePath) {
    boundary("PATH_INVALID", "/outputDir");
  }
}

function getRootIdentity(root: ResolvedOutputRoot): RootIdentity | undefined {
  if (typeof root !== "object" || root === null) return undefined;
  return rootRegistry.get(root);
}

function getInputRootIdentity(root: ResolvedInputRoot): InputRootIdentity | undefined {
  if (typeof root !== "object" || root === null) return undefined;
  return inputRootRegistry.get(root);
}

export function getTargetIdentity(target: ValidatedRelativeTarget): TargetIdentity | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  return targetRegistry.get(target);
}

async function removeNewRootAfterFailure(
  adapter: PrivateFileSystemAdapter,
  absolutePath: string,
  rootMetadata: Stats | undefined,
  parentPath: string,
  parentMetadata: Stats,
): Promise<boolean> {
  try {
    if (rootMetadata === undefined) return true;
    const currentRoot = await adapter.lstat(absolutePath);
    if (!sameIdentity(rootMetadata, currentRoot) || !currentRoot.isDirectory() || currentRoot.isSymbolicLink()) {
      return false;
    }
    if ((await adapter.realpath(absolutePath)) !== absolutePath) return false;
    const entries = await adapter.readdir(absolutePath);
    if (entries.length === 1 && entries[0]?.name === TRANSACTION_CONTAINER) {
      const containerPath = join(absolutePath, TRANSACTION_CONTAINER);
      const container = await adapter.lstat(containerPath);
      if (
        container.isDirectory()
        && !container.isSymbolicLink()
        && isOwnedByCurrentUser(container)
        && (container.mode & 0o777) === TRANSACTION_DIRECTORY_MODE
        && (await adapter.readdir(containerPath)).length === 0
      ) {
        const confirmedContainer = await adapter.lstat(containerPath);
        if (!sameIdentity(container, confirmedContainer) || (await adapter.realpath(containerPath)) !== containerPath) {
          return false;
        }
        await adapter.rmdir(containerPath);
        await syncDirectory(adapter, absolutePath);
      }
    }
    if ((await adapter.readdir(absolutePath)).length !== 0) return false;
    const currentParent = await adapter.lstat(parentPath);
    if (!sameIdentity(parentMetadata, currentParent)) return false;
    await adapter.rmdir(absolutePath);
    await syncDirectory(adapter, parentPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOutputRootWithAdapter(
  input: {
    outputDir: string;
    creation: "must-exist" | "create-if-missing";
    freshness: "allow-business-entries" | "require-no-business-entries";
  },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<ResolvedOutputRoot>> {
  let created = false;
  let absolutePath = "";
  let createdMetadata: Stats | undefined;
  let parentPath = "";
  let parentMetadata: Stats | undefined;
  try {
    if (
      typeof input !== "object"
      || input === null
      || typeof input.outputDir !== "string"
      || !SAFE_OUTPUT_INPUT.test(input.outputDir)
      || input.outputDir.includes("\0")
      || (input.creation !== "must-exist" && input.creation !== "create-if-missing")
      || (input.freshness !== "allow-business-entries" && input.freshness !== "require-no-business-entries")
    ) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/outputDir")]);
    }
    absolutePath = resolve(input.outputDir);
    parentPath = parse(absolutePath).dir;
    const outputMetadata = await lstatIfPresent(adapter, absolutePath);
    if (outputMetadata === undefined) {
      if (input.creation !== "create-if-missing") {
        return cliIoFailure([cliIoError("PATH_INVALID", "/outputDir")]);
      }
      const parentChain = await inspectExistingDirectoryChain(adapter, parentPath);
      const parent = parentChain.at(-1);
      if (parent === undefined) boundary("PATH_INVALID", "/outputDir");
      parentMetadata = parent.metadata;
      await adapter.mkdir(absolutePath, TRANSACTION_DIRECTORY_MODE);
      created = true;
      const initiallyCreated = await adapter.lstat(absolutePath);
      if (
        !initiallyCreated.isDirectory()
        || initiallyCreated.isSymbolicLink()
        || !isOwnedByCurrentUser(initiallyCreated)
        || (initiallyCreated.mode & 0o777) !== TRANSACTION_DIRECTORY_MODE
      ) {
        boundary("PATH_INVALID", "/outputDir");
      }
      await syncDirectory(adapter, parentPath);
      createdMetadata = await adapter.lstat(absolutePath);
    } else {
      const chain = await inspectExistingDirectoryChain(adapter, absolutePath);
      const observedRoot = chain.at(-1);
      const observedParent = chain.at(-2) ?? chain.at(-1);
      if (observedRoot === undefined || observedParent === undefined) boundary("PATH_INVALID", "/outputDir");
      createdMetadata = observedRoot.metadata;
      parentMetadata = observedParent.metadata;
    }
    if (createdMetadata === undefined || parentMetadata === undefined) boundary("PATH_INVALID", "/outputDir");
    if (!createdMetadata.isDirectory() || createdMetadata.isSymbolicLink() || !isOwnedByCurrentUser(createdMetadata)) {
      boundary(createdMetadata.isSymbolicLink() ? "SYMLINK_REJECTED" : "PATH_INVALID", "/outputDir");
    }
    if ((createdMetadata.mode & 0o022) !== 0) boundary("PATH_INVALID", "/outputDir");
    const canonicalPath = await adapter.realpath(absolutePath);
    if (canonicalPath !== absolutePath) boundary("PATH_ESCAPE", "/outputDir");
    const canonicalMetadata = await adapter.lstat(canonicalPath);
    if (!sameIdentity(createdMetadata, canonicalMetadata)) boundary("PATH_INVALID", "/outputDir");
    absolutePath = canonicalPath;
    parentPath = parse(absolutePath).dir;
    parentMetadata = await adapter.lstat(parentPath);
    if (input.freshness === "require-no-business-entries") {
      const businessEntries = (await adapter.readdir(absolutePath))
        .filter((entry) => entry.name !== TRANSACTION_CONTAINER);
      if (businessEntries.length !== 0) boundary("PATH_INVALID", "/outputDir");
    }
    const identity: RootIdentity = {
      absolutePath,
      createdByThisCall: created,
      metadata: canonicalMetadata,
      parentPath,
      parentMetadata,
    };
    await verifyTransactionContainer(adapter, identity);
    const value = Object.freeze({
      absolutePath,
      createdByThisCall: created,
      [resolvedOutputRootBrand]: true as const,
    });
    rootRegistry.set(value, identity);
    return cliIoSuccess(value);
  } catch (error) {
    if (created && parentMetadata !== undefined) {
      const cleaned = await removeNewRootAfterFailure(
        adapter,
        absolutePath,
        createdMetadata,
        parentPath,
        parentMetadata,
      );
      if (!cleaned) {
        return cliIoFailure([cliIoError("TRANSACTION_RECOVERY_BLOCKED", "/outputDir")], true);
      }
    }
    return resultFromPathError(error, "/outputDir");
  }
}

export async function resolveOutputRoot(input: {
  outputDir: string;
  creation: "must-exist" | "create-if-missing";
  freshness: "allow-business-entries" | "require-no-business-entries";
}): Promise<CliIoResult<ResolvedOutputRoot>> {
  try {
    return await resolveOutputRootWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/outputDir")]);
  }
}

export async function resolveExistingInputRootWithAdapter(
  input: { inputDir: string },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<ResolvedInputRoot>> {
  try {
    if (typeof input !== "object" || input === null) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/inputDir")]);
    }
    let inputDir: string;
    try {
      inputDir = input.inputDir;
    } catch {
      return cliIoFailure([cliIoError("PATH_INVALID", "/inputDir")]);
    }
    if (typeof inputDir !== "string" || !SAFE_OUTPUT_INPUT.test(inputDir) || inputDir.includes("\0")) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/inputDir")]);
    }
    const absolutePath = resolve(inputDir);
    const directories = await inspectExistingInputDirectoryChain(adapter, absolutePath);
    const root = directories.at(-1);
    if (root === undefined) boundary("PATH_INVALID", "/inputDir");
    const identity: InputRootIdentity = {
      absolutePath,
      metadata: root.metadata,
      directories: Object.freeze([...directories]),
    };
    const value = Object.freeze({
      absolutePath,
      [resolvedInputRootBrand]: true as const,
    });
    inputRootRegistry.set(value, identity);
    return cliIoSuccess(value);
  } catch (error) {
    return resultFromPathError(error, "/inputDir");
  }
}

export async function resolveExistingInputRoot(input: {
  inputDir: string;
}): Promise<CliIoResult<ResolvedInputRoot>> {
  try {
    return await resolveExistingInputRootWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/inputDir")]);
  }
}

export function validateRelativeTarget(relativePath: string): CliIoResult<ValidatedRelativeTarget> {
  try {
    const key = portablePathKey(relativePath);
    if (!key.ok) return cliIoFailure([cliIoError("PATH_INVALID", "/relativePath")]);
    if (key.value.split("/")[0] === RESERVED_PORTABLE_SEGMENT) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/relativePath")]);
    }
    const value = Object.freeze({
      relativePath,
      portableKey: key.value,
      [validatedRelativeTargetBrand]: true as const,
    });
    targetRegistry.set(value, { relativePath, portableKey: key.value });
    return cliIoSuccess(value);
  } catch {
    return cliIoFailure([cliIoError("PATH_INVALID", "/relativePath")]);
  }
}

export function assertPortableTargetSet(
  targets: readonly ValidatedRelativeTarget[],
): CliIoResult<readonly ValidatedRelativeTarget[]> {
  try {
    if (!Array.isArray(targets) || targets.length === 0) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/targets")]);
    }
    const seen = new Set<string>();
    const copy: ValidatedRelativeTarget[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const identity = target === undefined ? undefined : getTargetIdentity(target);
      if (identity === undefined) {
        return cliIoFailure([cliIoError("PATH_INVALID", `/targets/${index}/target`)]);
      }
      if (seen.has(identity.portableKey)) {
        return cliIoFailure([cliIoError("PORTABLE_PATH_COLLISION", `/targets/${index}/target`)]);
      }
      seen.add(identity.portableKey);
      copy.push(target);
    }
    return cliIoSuccess(Object.freeze(copy));
  } catch {
    return cliIoFailure([cliIoError("PATH_INVALID", "/targets")]);
  }
}

export async function assertResolvedRoot(
  root: ResolvedOutputRoot,
  adapter: PrivateFileSystemAdapter,
): Promise<RootIdentity> {
  const identity = getRootIdentity(root);
  if (identity === undefined) boundary("PATH_INVALID", "/root");
  const current = await adapter.lstat(identity.absolutePath);
  if (current.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/root");
  if (!current.isDirectory() || !sameIdentity(identity.metadata, current)) {
    boundary("PATH_INVALID", "/root");
  }
  const currentRealPath = await adapter.realpath(identity.absolutePath);
  if (currentRealPath !== identity.absolutePath) boundary("PATH_ESCAPE", "/root");
  await verifyTransactionContainer(adapter, identity);
  return identity;
}

function isContained(rootPath: string, childPath: string): boolean {
  const difference = relative(rootPath, childPath);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function isStableInputFile(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSafeInputFileMetadata(
  metadata: Stats,
  invalidCode: "PATH_INVALID" | "IO_OPERATION_FAILED",
): void {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || !isOwnedByCurrentUser(metadata)
    || (metadata.mode & 0o022) !== 0
    || metadata.nlink !== 1
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 0
  ) {
    boundary(invalidCode, "/target");
  }
}

async function inspectInputFileSnapshot(
  adapter: PrivateFileSystemAdapter,
  path: string,
  root: InputRootIdentity,
  invalidCode: "PATH_INVALID" | "IO_OPERATION_FAILED",
): Promise<InputFileSnapshot> {
  try {
    const metadata = await adapter.lstat(path);
    if (metadata.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/target");
    assertSafeInputFileMetadata(metadata, invalidCode);
    if (!sameDevice(root.metadata, metadata)) boundary("CROSS_DEVICE_TRANSACTION", "/target");
    const realPath = await adapter.realpath(path);
    if (realPath !== path || !isContained(root.absolutePath, realPath)) {
      boundary("PATH_ESCAPE", "/target");
    }
    return { metadata, realPath };
  } catch (error) {
    if (invalidCode === "IO_OPERATION_FAILED" && !(error instanceof PathBoundaryError)) {
      boundary("IO_OPERATION_FAILED", "/target");
    }
    throw error;
  }
}

async function assertResolvedInputRoot(
  root: ResolvedInputRoot,
  adapter: PrivateFileSystemAdapter,
): Promise<InputRootIdentity> {
  const identity = getInputRootIdentity(root);
  if (identity === undefined) boundary("PATH_INVALID", "/root");
  await assertBoundInputDirectoryChain(adapter, identity.directories, "/root", "IO_OPERATION_FAILED");
  return identity;
}

async function inspectInputTargetGuard(
  root: ResolvedInputRoot,
  target: ValidatedRelativeTarget,
  adapter: PrivateFileSystemAdapter,
): Promise<InputTargetGuard> {
  try {
    const rootIdentity = await assertResolvedInputRoot(root, adapter);
    const targetIdentity = getTargetIdentity(target);
    if (targetIdentity === undefined) boundary("PATH_INVALID", "/target");
    const finalAbsolutePath = resolve(rootIdentity.absolutePath, targetIdentity.relativePath);
    if (!isContained(rootIdentity.absolutePath, finalAbsolutePath) || finalAbsolutePath === rootIdentity.absolutePath) {
      boundary("PATH_ESCAPE", "/target");
    }
    const parentRelative = parse(targetIdentity.relativePath).dir;
    const parentSegments = parentRelative === "." ? [] : parentRelative.split("/");
    const directories: DirectoryIdentity[] = [];
    let current = rootIdentity.absolutePath;
    for (const segment of parentSegments) {
      current = join(current, segment);
      const metadata = await adapter.lstat(current);
      if (metadata.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/target");
      try {
        assertRealDirectory(metadata, undefined, true);
      } catch {
        boundary("PATH_INVALID", "/target");
      }
      if (!sameDevice(rootIdentity.metadata, metadata)) {
        boundary("CROSS_DEVICE_TRANSACTION", "/target");
      }
      const realPath = await adapter.realpath(current);
      if (realPath !== current || !isContained(rootIdentity.absolutePath, realPath)) {
        boundary("PATH_ESCAPE", "/target");
      }
      directories.push({ absolutePath: current, realPath, metadata });
    }
    return {
      root: rootIdentity,
      finalAbsolutePath,
      directories: Object.freeze(directories),
    };
  } catch (error) {
    if (error instanceof PathBoundaryError) throw error;
    if (isErrorCode(error, "ELOOP")) boundary("SYMLINK_REJECTED", "/target");
    if (
      isErrorCode(error, "ENOENT")
      || isErrorCode(error, "ENOTDIR")
      || isErrorCode(error, "EINVAL")
      || isErrorCode(error, "EACCES")
      || isErrorCode(error, "EPERM")
    ) {
      boundary("PATH_INVALID", "/target");
    }
    boundary("IO_OPERATION_FAILED", "/target");
  }
}

async function assertInputTargetGuard(
  guard: InputTargetGuard,
  adapter: PrivateFileSystemAdapter,
): Promise<void> {
  await assertBoundInputDirectoryChain(adapter, guard.root.directories, "/root", "IO_OPERATION_FAILED");
  await assertBoundInputDirectoryChain(adapter, guard.directories, "/target", "IO_OPERATION_FAILED");
  for (const directory of guard.directories) {
    if (!sameDevice(guard.root.metadata, directory.metadata)) {
      boundary("CROSS_DEVICE_TRANSACTION", "/target");
    }
  }
}

export async function readRelativeRegularFileWithAdapter(
  input: {
    root: ResolvedInputRoot;
    target: ValidatedRelativeTarget;
    maxBytes: number;
  },
  adapter: PrivateFileSystemAdapter,
): Promise<CliIoResult<{ bytes: Uint8Array; digest: Sha256Digest }>> {
  let root: ResolvedInputRoot;
  let target: ValidatedRelativeTarget;
  let maxBytes: number;
  try {
    if (typeof input !== "object" || input === null) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/root")]);
    }
    try {
      root = input.root;
    } catch {
      return cliIoFailure([cliIoError("PATH_INVALID", "/root")]);
    }
    try {
      target = input.target;
    } catch {
      return cliIoFailure([cliIoError("PATH_INVALID", "/target")]);
    }
    try {
      maxBytes = input.maxBytes;
    } catch {
      return cliIoFailure([cliIoError("PATH_INVALID", "/maxBytes")]);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INPUT_FILE_BYTES) {
      return cliIoFailure([cliIoError("PATH_INVALID", "/maxBytes")]);
    }
    const guard = await inspectInputTargetGuard(root, target, adapter);
    await assertInputTargetGuard(guard, adapter);
    const before = await inspectInputFileSnapshot(adapter, guard.finalAbsolutePath, guard.root, "PATH_INVALID");
    if (before.metadata.size > maxBytes) boundary("PATH_INVALID", "/target");
    let handle;
    try {
      handle = await adapter.open(
        guard.finalAbsolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isErrorCode(error, "ELOOP")) boundary("SYMLINK_REJECTED", "/target");
      boundary("IO_OPERATION_FAILED", "/target");
    }
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      assertSafeInputFileMetadata(opened, "IO_OPERATION_FAILED");
      if (!sameDevice(guard.root.metadata, opened)) boundary("CROSS_DEVICE_TRANSACTION", "/target");
      if (!isStableInputFile(before.metadata, opened) || opened.size > maxBytes) {
        boundary("IO_OPERATION_FAILED", "/target");
      }
      bytes = await readExactFileHandleBytes(handle, opened.size, maxBytes);
      const openedAfterRead = await handle.stat();
      assertSafeInputFileMetadata(openedAfterRead, "IO_OPERATION_FAILED");
      if (!isStableInputFile(opened, openedAfterRead)) boundary("IO_OPERATION_FAILED", "/target");
      await assertInputTargetGuard(guard, adapter);
      const beforeClose = await inspectInputFileSnapshot(
        adapter,
        guard.finalAbsolutePath,
        guard.root,
        "IO_OPERATION_FAILED",
      );
      if (
        beforeClose.realPath !== before.realPath
        || !isStableInputFile(openedAfterRead, beforeClose.metadata)
      ) {
        boundary("IO_OPERATION_FAILED", "/target");
      }
    } catch (error) {
      if (error instanceof PathBoundaryError) throw error;
      boundary("IO_OPERATION_FAILED", "/target");
    } finally {
      try {
        await handle.close();
      } catch {
        boundary("IO_OPERATION_FAILED", "/target");
      }
    }
    await assertInputTargetGuard(guard, adapter);
    const afterClose = await inspectInputFileSnapshot(
      adapter,
      guard.finalAbsolutePath,
      guard.root,
      "IO_OPERATION_FAILED",
    );
    if (afterClose.realPath !== before.realPath || !isStableInputFile(before.metadata, afterClose.metadata)) {
      boundary("IO_OPERATION_FAILED", "/target");
    }
    return cliIoSuccess({ bytes, digest: sha256Bytes(bytes) });
  } catch (error) {
    return resultFromPathError(error, "/target");
  }
}

export async function readRelativeRegularFile(input: {
  root: ResolvedInputRoot;
  target: ValidatedRelativeTarget;
  maxBytes: number;
}): Promise<CliIoResult<{ bytes: Uint8Array; digest: Sha256Digest }>> {
  try {
    return await readRelativeRegularFileWithAdapter(input, nativeFileSystemAdapter);
  } catch {
    return cliIoFailure([cliIoError("IO_OPERATION_FAILED", "/target")]);
  }
}

export async function inspectTargetParent(
  root: ResolvedOutputRoot,
  target: ValidatedRelativeTarget,
  adapter: PrivateFileSystemAdapter,
): Promise<TargetParentGuard> {
  const rootIdentity = await assertResolvedRoot(root, adapter);
  const targetIdentity = getTargetIdentity(target);
  if (targetIdentity === undefined) boundary("PATH_INVALID", "/target");
  const finalAbsolutePath = resolve(rootIdentity.absolutePath, targetIdentity.relativePath);
  if (!isContained(rootIdentity.absolutePath, finalAbsolutePath) || finalAbsolutePath === rootIdentity.absolutePath) {
    boundary("PATH_ESCAPE", "/target");
  }
  const parentRelative = parse(targetIdentity.relativePath).dir;
  const parentSegments = parentRelative === "." ? [] : parentRelative.split("/");
  const directories: DirectoryIdentity[] = [];
  let current = rootIdentity.absolutePath;
  const rootDirectory = await inspectDirectory(adapter, current, { requireOwnership: true });
  directories.push(rootDirectory);
  for (const segment of parentSegments) {
    current = join(current, segment);
    let inspected: DirectoryIdentity;
    try {
      inspected = await inspectDirectory(adapter, current, { requireOwnership: true });
    } catch (error) {
      if (error instanceof PathBoundaryError) throw new PathBoundaryError(error.ioCode, "/target/parent");
      throw error;
    }
    if (!sameDevice(rootIdentity.metadata, inspected.metadata)) {
      boundary("CROSS_DEVICE_TRANSACTION", "/target/parent");
    }
    if (!isContained(rootIdentity.absolutePath, inspected.realPath)) boundary("PATH_ESCAPE", "/target/parent");
    directories.push(inspected);
  }
  return {
    root: rootIdentity,
    finalAbsolutePath,
    parentAbsolutePath: current,
    directories: Object.freeze(directories),
  };
}

export async function assertTargetParentGuard(
  guard: TargetParentGuard,
  adapter: PrivateFileSystemAdapter,
): Promise<void> {
  for (const directory of guard.directories) {
    const current = await adapter.lstat(directory.absolutePath);
    if (current.isSymbolicLink()) boundary("SYMLINK_REJECTED", "/target/parent");
    if (!current.isDirectory() || !sameIdentity(directory.metadata, current)) {
      boundary("PATH_INVALID", "/target/parent");
    }
    if ((await adapter.realpath(directory.absolutePath)) !== directory.realPath) {
      boundary("PATH_ESCAPE", "/target/parent");
    }
  }
}

export async function cleanupCreatedRootIfEmpty(
  root: ResolvedOutputRoot,
  adapter: PrivateFileSystemAdapter,
): Promise<boolean> {
  const identity = getRootIdentity(root);
  if (identity === undefined || !identity.createdByThisCall) return true;
  return removeNewRootAfterFailure(
    adapter,
    identity.absolutePath,
    identity.metadata,
    identity.parentPath,
    identity.parentMetadata,
  );
}

export function pathFailureResult<T>(error: unknown, path: string): CliIoResult<T> {
  return resultFromPathError(error, path);
}
