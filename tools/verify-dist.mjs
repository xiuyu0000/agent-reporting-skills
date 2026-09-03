import { constants } from "node:fs";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RELEASE_MANIFEST_PATH,
  RELEASE_VERSION,
  RELEASE_ZIP_PATH,
  SKILL_FILES,
  SKILL_NAME,
  SKILL_PREFIX,
  ZIP_TIMESTAMP,
  buildReleaseCandidate,
  createReleaseManifest,
  parseDeterministicZip,
  releaseSha256,
  serializeReleaseManifest,
} from "./release-build.mjs";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_KILL_SETTLE_MS = 750;
const REQUIRED_NODE_RANGE = ">=24 <25";
const REQUIRED_HELP_COMMANDS = ["init", "render", "validate", "consume", "record-usage"];
const FORBIDDEN_ARCHIVE_SEGMENTS = new Set(["node_modules", "src", "test", "tests", "build", "coverage"]);
const FORBIDDEN_ARCHIVE_SUFFIXES = [".ts", ".tsx", ".map", ".py", ".pyc", ".pyo"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactKeys(value, keys, label) {
  assert(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys drifted`);
}

function assertSha256(value, label) {
  assert(typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value), `${label} is not SHA-256`);
}

function sameBinding(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function assertCurrentOwner(status, label) {
  if (typeof process.getuid === "function") {
    assert(status.uid === BigInt(process.getuid()), `${label} is not owned by the current user`);
  }
}

async function bindCanonicalDirectory(path, label) {
  const lexical = resolve(path);
  const status = await lstat(lexical, { bigint: true });
  assert(status.isDirectory() && !status.isSymbolicLink(), `${label} is not a real directory`);
  assert(await realpath(lexical) === lexical, `${label} is not canonical`);
  return { path: lexical, status };
}

async function rebindDirectory(binding, label) {
  const status = await lstat(binding.path, { bigint: true });
  assert(status.isDirectory() && !status.isSymbolicLink(), `${label} stopped being a real directory`);
  assert(await realpath(binding.path) === binding.path, `${label} stopped being canonical`);
  assert(
    status.dev === binding.status.dev
      && status.ino === binding.status.ino
      && status.uid === binding.status.uid
      && status.gid === binding.status.gid
      && status.mode === binding.status.mode,
    `${label} changed during verification`,
  );
}

async function readHandleExactlyTwice(handle, size, label) {
  assert(size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} has an invalid size`);
  const byteLength = Number(size);
  async function readOnce() {
    const bytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const read = await handle.read(bytes, offset, byteLength - offset, offset);
      assert(read.bytesRead > 0, `${label} shrank during read`);
      offset += read.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const eof = await handle.read(probe, 0, 1, byteLength);
    assert(eof.bytesRead === 0, `${label} grew during read`);
    return bytes;
  }
  const first = await readOnce();
  const second = await readOnce();
  assert(first.equals(second), `${label} changed between bounded reads`);
  return first;
}

async function openBoundRegularFile(path, maximumBytes, label, prebinding, {
  requiredMode,
  requireCurrentOwner = false,
} = {}) {
  const held = await openHeldRegularFile(path, maximumBytes, label, prebinding, {
    requiredMode,
    requireCurrentOwner,
  });
  try {
    return await rereadHeldRegularFile(held);
  } finally {
    await held.handle.close();
  }
}

async function openHeldRegularFile(path, maximumBytes, label, prebinding, {
  requiredMode,
  requireCurrentOwner = false,
} = {}) {
  const before = prebinding ?? await lstat(path, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, `${label} is not a single-link regular file`);
  assert(before.size >= 0n && before.size <= BigInt(maximumBytes), `${label} exceeds its byte limit`);
  if (requiredMode !== undefined) assert((before.mode & 0o777n) === BigInt(requiredMode), `${label} mode drifted`);
  if (requireCurrentOwner && typeof process.getuid === "function") {
    assert(before.uid === BigInt(process.getuid()), `${label} is not owned by the current user`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    assert(opened.isFile() && opened.nlink === 1n && sameBinding(before, opened), `${label} changed before open`);
    return { path: resolve(path), maximumBytes, label, requiredMode, requireCurrentOwner, handle, binding: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function rereadHeldRegularFile(held) {
  const handleBefore = await held.handle.stat({ bigint: true });
  assert(
    handleBefore.isFile() && handleBefore.nlink === 1n && sameBinding(handleBefore, held.binding),
    `${held.label} held binding changed before read`,
  );
  const bytes = await readHandleExactlyTwice(held.handle, held.binding.size, held.label);
  const handleAfter = await held.handle.stat({ bigint: true });
  assert(handleAfter.isFile() && sameBinding(handleAfter, held.binding), `${held.label} held binding changed during read`);
  const pathStatus = await lstat(held.path, { bigint: true });
  assert(
    pathStatus.isFile()
      && !pathStatus.isSymbolicLink()
      && pathStatus.nlink === 1n
      && sameBinding(pathStatus, held.binding),
    `${held.label} path binding changed`,
  );
  if (held.requiredMode !== undefined) {
    assert((pathStatus.mode & 0o777n) === BigInt(held.requiredMode), `${held.label} mode drifted after read`);
  }
  if (held.requireCurrentOwner) assertCurrentOwner(pathStatus, held.label);
  assert(bytes.byteLength <= held.maximumBytes, `${held.label} exceeds its byte limit`);
  return { bytes, binding: held.binding };
}

export async function openReleasePairSession({ repositoryRoot = "." } = {}) {
  const repository = await bindCanonicalDirectory(repositoryRoot, "repository root");
  const distribution = await bindCanonicalDirectory(join(repository.path, "dist"), "release dist directory");
  assert(distribution.status.dev === repository.status.dev, "release dist directory crossed a device boundary");
  assert(relative(repository.path, distribution.path) === "dist", "release dist directory escaped the repository root");

  const zipPath = join(repository.path, RELEASE_ZIP_PATH);
  const manifestPath = join(repository.path, RELEASE_MANIFEST_PATH);
  assert(relative(distribution.path, zipPath) === RELEASE_ZIP_PATH.slice("dist/".length), "release ZIP path drifted");
  assert(relative(distribution.path, manifestPath) === RELEASE_MANIFEST_PATH.slice("dist/".length), "release manifest path drifted");

  const [zipBefore, manifestBefore] = await Promise.all([
    lstat(zipPath, { bigint: true }),
    lstat(manifestPath, { bigint: true }),
  ]);
  assert(zipBefore.dev === distribution.status.dev && manifestBefore.dev === distribution.status.dev, "release pair crossed a device boundary");
  const releaseFileRequirements = { requiredMode: 0o644, requireCurrentOwner: true };
  let zip;
  let manifest;
  try {
    [zip, manifest] = await Promise.all([
      openHeldRegularFile(zipPath, MAX_ARCHIVE_BYTES, "release ZIP", zipBefore, releaseFileRequirements),
      openHeldRegularFile(manifestPath, MAX_MANIFEST_BYTES, "release manifest", manifestBefore, releaseFileRequirements),
    ]);
    const session = { repository, distribution, zip, manifest, closed: false };
    const pair = await rereadReleasePairSession(session);
    return { ...session, ...pair };
  } catch (error) {
    await Promise.all([zip?.handle.close().catch(() => undefined), manifest?.handle.close().catch(() => undefined)]);
    throw error;
  }
}

export async function rereadReleasePairSession(session) {
  assert(session !== null && typeof session === "object" && session.closed === false, "release pair session is not open");
  await rebindDirectory(session.repository, "repository root");
  await rebindDirectory(session.distribution, "release dist directory");
  const [zip, manifest] = await Promise.all([
    rereadHeldRegularFile(session.zip),
    rereadHeldRegularFile(session.manifest),
  ]);
  await rebindDirectory(session.repository, "repository root");
  await rebindDirectory(session.distribution, "release dist directory");
  return { zipBytes: zip.bytes, manifestBytes: manifest.bytes };
}

export async function closeReleasePairSession(session) {
  if (session === null || typeof session !== "object" || session.closed === true) return;
  session.closed = true;
  await Promise.all([
    session.zip?.handle.close().catch(() => undefined),
    session.manifest?.handle.close().catch(() => undefined),
  ]);
}

export async function readStableReleasePair(options) {
  const session = await openReleasePairSession(options);
  try {
    return { zipBytes: Buffer.from(session.zipBytes), manifestBytes: Buffer.from(session.manifestBytes) };
  } finally {
    await closeReleasePairSession(session);
  }
}

async function readStableRepositoryFile(relativePath, maximumBytes, label) {
  const repository = await bindCanonicalDirectory(".", "repository root");
  const path = resolve(relativePath);
  const relativePathFromRoot = relative(repository.path, path);
  assert(
    relativePathFromRoot.length > 0
      && !isAbsolute(relativePathFromRoot)
      && relativePathFromRoot !== ".."
      && !relativePathFromRoot.startsWith(`..${sep}`),
    `${label} escaped the repository root`,
  );
  const result = await openBoundRegularFile(path, maximumBytes, label);
  await rebindDirectory(repository, "repository root");
  return result.bytes;
}

function validatePackageContractBytes(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("package.json is not strict UTF-8 JSON");
  }
  assert(isRecord(value), "package.json must be an object");
  assert(value.version === RELEASE_VERSION, "package.json version is not the release version");
  assert(isRecord(value.engines) && value.engines.node === REQUIRED_NODE_RANGE, "package.json Node engine drifted");
  return value;
}

export async function verifyPackageContract(packagePath = "package.json") {
  assert(typeof packagePath === "string" && packagePath.length > 0, "package.json path is invalid");
  const path = resolve(packagePath);
  const parent = await bindCanonicalDirectory(dirname(path), "package.json parent directory");
  const held = await openHeldRegularFile(path, MAX_MANIFEST_BYTES, "package.json", undefined, {
    requireCurrentOwner: true,
  });
  try {
    const result = await rereadHeldRegularFile(held);
    validatePackageContractBytes(result.bytes);
    await rebindDirectory(parent, "package.json parent directory");
    return { path, bytes: Buffer.from(result.bytes), binding: result.binding, parent, held, closed: false };
  } catch (error) {
    await held.handle.close();
    throw error;
  }
}

export async function revalidatePackageContract(contract) {
  assert(
    contract !== null
      && typeof contract === "object"
      && typeof contract.path === "string"
      && Buffer.isBuffer(contract.bytes)
      && contract.binding !== undefined
      && contract.parent !== undefined,
    "package.json binding is invalid",
  );
  assert(contract.closed === false && contract.held !== undefined, "package.json contract is not open");
  await rebindDirectory(contract.parent, "package.json parent directory");
  const result = await rereadHeldRegularFile(contract.held);
  assert(result.bytes.equals(contract.bytes), "package.json bytes changed during release verification");
  validatePackageContractBytes(result.bytes);
  await rebindDirectory(contract.parent, "package.json parent directory");
  return contract;
}

export async function closePackageContract(contract) {
  if (contract === null || typeof contract !== "object" || contract.closed === true) return;
  contract.closed = true;
  await contract.held?.handle.close().catch(() => undefined);
}

export async function verifyPackageContractAcrossOperation(packagePath, operation) {
  assert(typeof operation === "function", "package.json verification operation is invalid");
  const contract = await verifyPackageContract(packagePath);
  try {
    const result = await operation();
    await revalidatePackageContract(contract);
    return result;
  } finally {
    await closePackageContract(contract);
  }
}

export function validateReleaseManifest(value, zipBytes, parsedEntries) {
  assertExactKeys(value, ["format", "version", "skill", "node", "archive", "files", "reproducibility"], "manifest");
  assert(value.format === "deliver-dual-audience-report-release/1", "manifest format drifted");
  assert(value.version === RELEASE_VERSION, "manifest version drifted");
  assert(value.skill === SKILL_NAME, "manifest skill drifted");
  assert(value.node === REQUIRED_NODE_RANGE, "manifest Node range drifted");

  assertExactKeys(
    value.archive,
    ["path", "byteLength", "digest", "entryCount", "compression", "timestamp", "mode", "root"],
    "manifest archive",
  );
  assert(value.archive.path === RELEASE_ZIP_PATH, "manifest archive path drifted");
  assert(value.archive.byteLength === zipBytes.byteLength, "manifest archive byte length drifted");
  assertSha256(value.archive.digest, "manifest archive digest");
  assert(value.archive.digest === releaseSha256(zipBytes), "manifest archive digest mismatch");
  assert(value.archive.entryCount === SKILL_FILES.length, "manifest entry count drifted");
  assert(value.archive.compression === "store", "manifest compression drifted");
  assert(value.archive.timestamp === ZIP_TIMESTAMP, "manifest timestamp drifted");
  assert(value.archive.mode === "0644", "manifest mode drifted");
  assert(value.archive.root === SKILL_NAME, "manifest root drifted");

  assert(Array.isArray(parsedEntries) && parsedEntries.length === SKILL_FILES.length, "parsed ZIP inventory drifted");
  assert(Array.isArray(value.files) && value.files.length === SKILL_FILES.length, "manifest file inventory drifted");
  for (let index = 0; index < parsedEntries.length; index += 1) {
    const file = value.files[index];
    const entry = parsedEntries[index];
    assertExactKeys(file, ["path", "byteLength", "digest"], `manifest file ${index}`);
    assert(file.path === entry.path, `manifest path drifted at ${index}`);
    assert(file.byteLength === entry.byteLength, `manifest byte length drifted at ${index}`);
    assertSha256(file.digest, `manifest file digest ${index}`);
    assert(file.digest === entry.digest, `manifest file digest mismatch at ${index}`);
  }

  assertExactKeys(
    value.reproducibility,
    ["order", "timestamp", "compression", "mode", "extraFields", "comments"],
    "manifest reproducibility",
  );
  assert(value.reproducibility.order === "bytewise-path-ascending", "manifest order contract drifted");
  assert(value.reproducibility.timestamp === ZIP_TIMESTAMP, "manifest reproducibility timestamp drifted");
  assert(value.reproducibility.compression === "store", "manifest reproducibility compression drifted");
  assert(value.reproducibility.mode === "0644", "manifest reproducibility mode drifted");
  assert(value.reproducibility.extraFields === false, "manifest extra field contract drifted");
  assert(value.reproducibility.comments === false, "manifest comment contract drifted");
  return value;
}

function assertRuntimeInventory(entries) {
  const expected = SKILL_FILES.map((path) => `${SKILL_PREFIX}${path}`);
  assert(Array.isArray(entries) && entries.length === SKILL_FILES.length, "release entries are not the exact fixed inventory");
  assert(JSON.stringify(entries.map((entry) => entry.path)) === JSON.stringify(expected), `release ZIP is not the exact ${SKILL_FILES.length}-file Skill inventory`);
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedRelativePath = SKILL_FILES[index];
    assert(entry !== null && typeof entry === "object", `release entry ${index} is not an object`);
    assert(entry.relativePath === expectedRelativePath, `release relative path drifted at ${index}`);
    assert(entry.bytes instanceof Uint8Array, `release entry bytes drifted at ${index}`);
    assert(
      Number.isSafeInteger(entry.byteLength)
        && entry.byteLength === entry.bytes.byteLength
        && entry.byteLength <= MAX_SOURCE_FILE_BYTES,
      `release entry exceeds its byte limit: ${entry.relativePath}`,
    );
    assert(entry.digest === releaseSha256(entry.bytes), `release entry digest drifted: ${entry.relativePath}`);
    total += entry.byteLength;
    assert(total <= MAX_EXTRACTED_BYTES, "release entries exceed the aggregate extraction limit");
    const segments = entry.relativePath.split("/");
    assert(!segments.some((segment) => FORBIDDEN_ARCHIVE_SEGMENTS.has(segment)), `forbidden archive segment: ${entry.relativePath}`);
    assert(!FORBIDDEN_ARCHIVE_SUFFIXES.some((suffix) => entry.relativePath.endsWith(suffix)), `forbidden archive suffix: ${entry.relativePath}`);
  }
}

export async function openSourceSnapshotSession(skillRoot = `skills/${SKILL_NAME}`) {
  const root = await bindCanonicalDirectory(skillRoot, "release Skill root");
  const directoryPaths = new Set([root.path]);
  for (const relativePath of SKILL_FILES) {
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(join(root.path, ...segments.slice(0, index)));
    }
  }
  const directories = [];
  const files = [];
  try {
    for (const path of [...directoryPaths].sort()) {
      directories.push(await bindCanonicalDirectory(path, `release source directory ${path}`));
    }
    let aggregate = 0;
    for (const relativePath of SKILL_FILES) {
      const held = await openHeldRegularFile(
        join(root.path, ...relativePath.split("/")),
        MAX_SOURCE_FILE_BYTES,
        `release source ${relativePath}`,
        undefined,
        { requireCurrentOwner: true },
      );
      aggregate += Number(held.binding.size);
      assert(aggregate <= MAX_EXTRACTED_BYTES, "release source aggregate exceeds its byte limit");
      files.push({ relativePath, held });
    }
    const session = { root, directories, files, closed: false };
    const snapshot = await rereadSourceSnapshotSession(session);
    return { ...session, entries: snapshot.entries };
  } catch (error) {
    await Promise.all(files.map(async ({ held }) => held.handle.close().catch(() => undefined)));
    throw error;
  }
}

export async function rereadSourceSnapshotSession(session) {
  assert(session !== null && typeof session === "object" && session.closed === false, "source snapshot session is not open");
  for (const directory of session.directories) await rebindDirectory(directory, "release source directory");
  const entries = [];
  for (const { relativePath, held } of session.files) {
    const result = await rereadHeldRegularFile(held);
    entries.push({
      path: `${SKILL_PREFIX}${relativePath}`,
      relativePath,
      bytes: result.bytes,
      byteLength: result.bytes.byteLength,
      digest: releaseSha256(result.bytes),
    });
  }
  assertRuntimeInventory(entries);
  for (const directory of session.directories) await rebindDirectory(directory, "release source directory");
  return { entries };
}

export async function closeSourceSnapshotSession(session) {
  if (session === null || typeof session !== "object" || session.closed === true) return;
  session.closed = true;
  await Promise.all(session.files.map(async ({ held }) => held.handle.close().catch(() => undefined)));
}

function rawZipLayout(zipBytes) {
  const eocdOffset = zipBytes.byteLength - 22;
  assert(eocdOffset >= 0 && zipBytes.readUInt32LE(eocdOffset) === 0x06054b50, "adversarial fixture has no final EOCD");
  const count = zipBytes.readUInt16LE(eocdOffset + 10);
  const centralOffset = zipBytes.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert(zipBytes.readUInt32LE(cursor) === 0x02014b50, "adversarial fixture central directory drifted");
    const nameLength = zipBytes.readUInt16LE(cursor + 28);
    const localOffset = zipBytes.readUInt32LE(cursor + 42);
    const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
    assert(nameLength === localNameLength, "adversarial fixture name length drifted");
    const centralNameOffset = cursor + 46;
    const localNameOffset = localOffset + 30;
    const path = zipBytes.subarray(centralNameOffset, centralNameOffset + nameLength).toString("utf8");
    const size = zipBytes.readUInt32LE(cursor + 24);
    entries.push({ path, cursor, nameLength, centralNameOffset, localOffset, localNameOffset, dataOffset: localNameOffset + nameLength, size });
    cursor = centralNameOffset + nameLength;
  }
  return { eocdOffset, centralOffset, entries };
}

function assertParserRejects(label, bytes) {
  let rejected = false;
  try {
    parseDeterministicZip(bytes);
  } catch {
    rejected = true;
  }
  assert(rejected, `release ZIP parser accepted ${label}`);
}

function mutate(zipBytes, callback) {
  const bytes = Buffer.from(zipBytes);
  callback(bytes, rawZipLayout(bytes));
  return bytes;
}

function fixedUnsafeName(length) {
  assert(length >= 3, "ZIP name is too short for traversal mutation");
  return Buffer.from(`../${"x".repeat(length - 3)}`, "utf8");
}

function replaceRawName(bytes, entry, name, locations = "both") {
  const encoded = Buffer.from(name, "utf8");
  assert(encoded.byteLength === entry.nameLength, "adversarial ZIP replacement name length drifted");
  if (locations === "both" || locations === "local") encoded.copy(bytes, entry.localNameOffset);
  if (locations === "both" || locations === "central") encoded.copy(bytes, entry.centralNameOffset);
}

export function runParserAdversarialChecks(zipBytes) {
  const layout = rawZipLayout(zipBytes);
  const first = layout.entries[0];
  assert(first !== undefined && first.size > 0, "release ZIP lacks a mutable first entry");
  assertParserRejects("trailing bytes", Buffer.concat([zipBytes, Buffer.from([0])]));
  assertParserRejects("local UTF-8 flag drift", mutate(zipBytes, (bytes) => bytes.writeUInt16LE(0, first.localOffset + 6)));
  assertParserRejects("central UTF-8 flag drift", mutate(zipBytes, (bytes) => bytes.writeUInt16LE(0, first.cursor + 8)));
  assertParserRejects("local compression method drift", mutate(zipBytes, (bytes) => bytes.writeUInt16LE(8, first.localOffset + 8)));
  assertParserRejects("central compression method drift", mutate(zipBytes, (bytes) => bytes.writeUInt16LE(8, first.cursor + 10)));
  assertParserRejects("entry CRC drift", mutate(zipBytes, (bytes) => { bytes[first.dataOffset] ^= 0xff; }));
  assertParserRejects("local offset gap", mutate(zipBytes, (bytes) => bytes.writeUInt32LE(first.localOffset + 1, first.cursor + 42)));
  assertParserRejects("central directory gap", mutate(zipBytes, (bytes, current) => bytes.writeUInt32LE(current.centralOffset + 1, current.eocdOffset + 16)));
  assertParserRejects("symlink external attributes", mutate(zipBytes, (bytes) => bytes.writeUInt32LE((0o120777 << 16) >>> 0, first.cursor + 38)));
  assertParserRejects("central traversal name", mutate(zipBytes, (bytes) => fixedUnsafeName(first.nameLength).copy(bytes, first.centralNameOffset)));
  assertParserRejects("local traversal name", mutate(zipBytes, (bytes) => fixedUnsafeName(first.nameLength).copy(bytes, first.localNameOffset)));
  assertParserRejects("matching local and central traversal names", mutate(zipBytes, (bytes) => {
    const unsafe = fixedUnsafeName(first.nameLength);
    unsafe.copy(bytes, first.localNameOffset);
    unsafe.copy(bytes, first.centralNameOffset);
  }));

  const duplicateSource = layout.entries.find((entry) => entry.path.endsWith("assets/agent-context.template.md"));
  const duplicateTarget = layout.entries.find((entry) => entry.path.endsWith("references/audience-contracts.md"));
  assert(duplicateSource !== undefined && duplicateTarget !== undefined, "release ZIP lacks duplicate/collision fixtures");
  assert(duplicateSource.nameLength === duplicateTarget.nameLength, "duplicate/collision fixture lengths drifted");
  assertParserRejects("duplicate entry", mutate(zipBytes, (bytes, current) => {
    const source = current.entries.find((entry) => entry.path === duplicateSource.path);
    const target = current.entries.find((entry) => entry.path === duplicateTarget.path);
    assert(source !== undefined && target !== undefined, "duplicate mutation entries disappeared");
    replaceRawName(bytes, target, source.path);
  }));
  const collisionName = duplicateSource.path.replace("context", "contexT");
  assert(collisionName !== duplicateSource.path && Buffer.byteLength(collisionName) === duplicateTarget.nameLength, "portable collision fixture drifted");
  assertParserRejects("portable case collision", mutate(zipBytes, (bytes, current) => {
    const target = current.entries.find((entry) => entry.path === duplicateTarget.path);
    assert(target !== undefined, "portable collision target disappeared");
    replaceRawName(bytes, target, collisionName);
  }));
}

function assertManifestRejects(label, value, zipBytes, entries) {
  let rejected = false;
  try {
    validateReleaseManifest(value, zipBytes, entries);
  } catch {
    rejected = true;
  }
  assert(rejected, `release manifest validator accepted ${label}`);
}

export function runManifestAdversarialChecks(manifest, zipBytes, entries) {
  const archiveDigest = cloneJson(manifest);
  archiveDigest.archive.digest = `sha256:${"0".repeat(64)}`;
  assertManifestRejects("archive digest tamper", archiveDigest, zipBytes, entries);
  const entryDigest = cloneJson(manifest);
  entryDigest.files[0].digest = `sha256:${"0".repeat(64)}`;
  assertManifestRejects("entry digest tamper", entryDigest, zipBytes, entries);
  const entryPath = cloneJson(manifest);
  entryPath.files[0].path = `${SKILL_NAME}/different`;
  assertManifestRejects("entry path tamper", entryPath, zipBytes, entries);
  const entryLength = cloneJson(manifest);
  entryLength.files[0].byteLength += 1;
  assertManifestRejects("entry length tamper", entryLength, zipBytes, entries);
  const extraKey = cloneJson(manifest);
  extraKey.unexpected = true;
  assertManifestRejects("extra key", extraKey, zipBytes, entries);
}

export function assertCanonicalReleaseManifestBytes(manifestBytes, zipBytes, entries) {
  const expected = serializeReleaseManifest(createReleaseManifest(entries, zipBytes));
  assert(expected.equals(manifestBytes), "release manifest bytes differ from the builder-derived canonical manifest");
  return expected;
}

async function createPrivateDirectory(prefix) {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const binding = await openPrivateDirectoryBinding(path, "private temporary directory", { setPrivateMode: true });
  try {
    return binding.path;
  } finally {
    await binding.handle.close();
  }
}

async function openPrivateDirectoryBinding(path, label, { setPrivateMode = false } = {}) {
  const lexical = resolve(path);
  const before = await lstat(lexical, { bigint: true });
  assert(before.isDirectory() && !before.isSymbolicLink(), `${label} is not a real directory`);
  const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0);
  const handle = await open(lexical, directoryFlags);
  try {
    const openedBeforeMode = await handle.stat({ bigint: true });
    assert(openedBeforeMode.isDirectory(), `${label} handle is not a directory`);
    assert(
      openedBeforeMode.dev === before.dev
        && openedBeforeMode.ino === before.ino
        && openedBeforeMode.uid === before.uid
        && openedBeforeMode.gid === before.gid,
      `${label} changed before handle binding`,
    );
    assertCurrentOwner(openedBeforeMode, label);
    if (setPrivateMode) await handle.chmod(0o700);
    const status = await handle.stat({ bigint: true });
    assert(status.isDirectory() && (status.mode & 0o777n) === 0o700n, `${label} mode is not private`);
    assertCurrentOwner(status, label);
    const pathStatus = await lstat(lexical, { bigint: true });
    assert(
      pathStatus.isDirectory()
        && !pathStatus.isSymbolicLink()
        && sameDirectoryIdentity(status, pathStatus),
      `${label} changed after handle binding`,
    );
    assert(await realpath(lexical) === lexical, `${label} is not canonical`);
    return { path: lexical, handle, status };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertPrivateDirectoryBinding(binding, rootPath, label) {
  const handleStatus = await binding.handle.stat({ bigint: true });
  assert(
    handleStatus.isDirectory()
      && sameDirectoryIdentity(handleStatus, binding.status)
      && (handleStatus.mode & 0o777n) === 0o700n,
    `${label} handle binding changed`,
  );
  assertCurrentOwner(handleStatus, label);
  const pathStatus = await lstat(binding.path, { bigint: true });
  assert(
    pathStatus.isDirectory()
      && !pathStatus.isSymbolicLink()
      && sameDirectoryIdentity(handleStatus, pathStatus),
    `${label} path binding changed`,
  );
  assert(await realpath(binding.path) === binding.path, `${label} stopped being canonical`);
  const relativePath = relative(rootPath, binding.path);
  assert(
    relativePath === ""
      || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)),
    `${label} escaped the private root`,
  );
}

async function assertPrivateDirectoryChain(chain) {
  const rootPath = chain[0]?.path;
  assert(typeof rootPath === "string", "private directory chain is empty");
  for (let index = 0; index < chain.length; index += 1) {
    await assertPrivateDirectoryBinding(chain[index], rootPath, `private directory ${index}`);
  }
}

async function createBoundPrivateChild(chain, name) {
  assert(typeof name === "string" && /^[A-Za-z0-9._-]+$/u.test(name) && name !== "." && name !== "..", "private directory name is unsafe");
  await assertPrivateDirectoryChain(chain);
  const parent = chain.at(-1);
  const childPath = join(parent.path, name);
  await mkdir(childPath, { mode: 0o700 });
  const child = await openPrivateDirectoryBinding(childPath, `private directory ${name}`, { setPrivateMode: true });
  try {
    const extended = [...chain, child];
    await assertPrivateDirectoryChain(extended);
    return child;
  } catch (error) {
    await child.handle.close();
    throw error;
  }
}

async function writeBoundPrivateFile(path, bytes, chain, label, mode = 0o600) {
  assert(mode === 0o600 || mode === 0o700, `${label} mode is unsupported`);
  await assertPrivateDirectoryChain(chain);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  let writtenStatus;
  try {
    const created = await handle.stat({ bigint: true });
    assert(created.isFile() && created.nlink === 1n, `${label} is not a single-link regular file`);
    assertCurrentOwner(created, label);
    await assertPrivateDirectoryChain(chain);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    writtenStatus = await handle.stat({ bigint: true });
    assert(
      writtenStatus.isFile()
        && writtenStatus.nlink === 1n
        && (writtenStatus.mode & 0o777n) === BigInt(mode)
        && writtenStatus.size === BigInt(bytes.byteLength),
      `${label} post-write metadata drifted`,
    );
    assertCurrentOwner(writtenStatus, label);
    await assertPrivateDirectoryChain(chain);
    const pathStatus = await lstat(path, { bigint: true });
    assert(
      pathStatus.isFile()
        && !pathStatus.isSymbolicLink()
        && sameBinding(writtenStatus, pathStatus),
      `${label} path binding changed`,
    );
    assert(await realpath(path) === resolve(path), `${label} stopped being canonical`);
  } finally {
    await handle.close();
  }
  await assertPrivateDirectoryChain(chain);
  const verified = await openBoundRegularFile(path, MAX_SOURCE_FILE_BYTES, label, writtenStatus, {
    requiredMode: mode,
    requireCurrentOwner: true,
  });
  await assertPrivateDirectoryChain(chain);
  assert(verified.bytes.equals(bytes), `${label} bytes drifted after write`);
  return verified;
}

async function materializePrivateEntries(entries, physicalRoot, directoryName, { onCheckpoint } = {}) {
  assertRuntimeInventory(entries);
  assert(onCheckpoint === undefined || typeof onCheckpoint === "function", "materialization checkpoint must be a function");
  const root = await openPrivateDirectoryBinding(physicalRoot, "private materialization root");
  const bindings = [root];
  const bindingsByPath = new Map([[root.path, root]]);
  try {
    const skill = await createBoundPrivateChild([root], directoryName);
    bindings.push(skill);
    bindingsByPath.set(skill.path, skill);
    const skillRoot = skill.path;
    for (const entry of entries) {
      const segments = entry.relativePath.split("/");
      const chain = [root, skill];
      let parentPath = skillRoot;
      for (const segment of segments.slice(0, -1)) {
        parentPath = join(parentPath, segment);
        let binding = bindingsByPath.get(parentPath);
        if (binding === undefined) {
          binding = await createBoundPrivateChild(chain, segment);
          bindings.push(binding);
          bindingsByPath.set(binding.path, binding);
        }
        chain.push(binding);
      }
      const target = join(parentPath, segments.at(-1));
      const relativeTarget = relative(skillRoot, target);
      assert(relativeTarget.length > 0 && !isAbsolute(relativeTarget) && !relativeTarget.startsWith(`..${sep}`), "private extraction target escaped");
      await assertPrivateDirectoryChain(chain);
      if (onCheckpoint) {
        await onCheckpoint({
          phase: "after-parent-precheck",
          relativePath: entry.relativePath,
          rootPath: root.path,
          skillRoot,
          parentPath,
          targetPath: target,
        });
      }
      await assertPrivateDirectoryChain(chain);
      const verified = await writeBoundPrivateFile(target, entry.bytes, chain, `extracted ${entry.relativePath}`);
      assert(releaseSha256(verified.bytes) === entry.digest, `extracted digest mismatch: ${entry.relativePath}`);
    }
    await assertPrivateDirectoryChain(bindings);
    return skillRoot;
  } finally {
    await Promise.all([...bindings].reverse().map(async (binding) => binding.handle.close().catch(() => undefined)));
  }
}

export async function materializeReleaseEntries(entries, physicalRoot, options) {
  return materializePrivateEntries(entries, physicalRoot, "skill", options);
}

async function extractPrivate(entries, extractionRoot) {
  return materializePrivateEntries(entries, extractionRoot, SKILL_NAME);
}

export function runBoundedProcess(executable, arguments_, {
  cwd,
  env,
  timeoutMs = PROCESS_TIMEOUT_MS,
  outputLimitBytes = MAX_PROCESS_OUTPUT_BYTES,
} = {}) {
  assert(isAbsolute(executable), "subprocess executable must be absolute");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "subprocess timeout is invalid");
  assert(Number.isSafeInteger(outputLimitBytes) && outputLimitBytes > 0, "subprocess output limit is invalid");
  return new Promise((resolveResult, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(executable, arguments_, {
      cwd,
      env,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let settled = false;
    let terminating = false;
    let killSettleTimer;

    const destroyPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const killProcessTree = () => {
      let groupSignalled = false;
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          groupSignalled = true;
        } catch (error) {
          if (!(error && typeof error === "object" && error.code === "ESRCH")) {
            // Fall back to the direct child below.
          }
        }
      }
      if (!groupSignalled) child.kill("SIGKILL");
      destroyPipes();
    };
    const settleRejected = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killSettleTimer);
      reject(error);
    };
    const terminate = (error) => {
      if (failure === undefined) failure = error;
      if (terminating) return;
      terminating = true;
      clearTimeout(deadlineTimer);
      killProcessTree();
      killSettleTimer = setTimeout(() => {
        killProcessTree();
        child.unref();
        settleRejected(failure);
      }, PROCESS_KILL_SETTLE_MS);
    };
    const deadlineTimer = setTimeout(() => {
      terminate(new Error("subprocess timed out"));
    }, timeoutMs);
    const consume = (stream, assign) => {
      stream.setEncoding("utf8").on("data", (chunk) => {
        if (failure !== undefined) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > outputLimitBytes) {
          terminate(new Error("subprocess output limit exceeded"));
          return;
        }
        assign(chunk);
      });
    };
    consume(child.stdout, (chunk) => { stdout += chunk; });
    consume(child.stderr, (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settleRejected(failure ?? error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killSettleTimer);
      if (failure !== undefined) reject(failure);
      else resolveResult({ code, signal, stdout, stderr });
    });
  });
}

async function findNode24() {
  const candidates = [
    process.env.DAR_NODE24,
    process.execPath,
    "/opt/homebrew/opt/node@24/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      const absolute = resolve(candidate);
      const status = await lstat(absolute);
      if (!status.isFile() || status.isSymbolicLink()) continue;
      const canonical = await realpath(absolute);
      const version = await runBoundedProcess(canonical, ["--version"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        outputLimitBytes: 1024,
      });
      if (version.code === 0 && /^v24\.[0-9]+\.[0-9]+\n$/u.test(version.stdout)) return canonical;
    } catch {
      // Try the next explicitly bounded local candidate.
    }
  }
  throw new Error("Node 24 executable not found; set DAR_NODE24 to an exact Node 24 binary");
}

function scrubRuntimeEnvironment(home, bin, cwd) {
  const environment = {};
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = home;
  environment.PATH = bin;
  environment.PWD = cwd;
  assert(!Object.keys(environment).some((key) => /^npm/u.test(key.toLowerCase())), "npm environment variable survived scrubbing");
  return environment;
}

async function pathIsAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return true;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return !processIsAlive(pid);
}

async function runCli(node24, entry, arguments_, cwd, environment) {
  return runBoundedProcess(node24, [entry, ...arguments_], { cwd, env: environment });
}

export async function runSubprocessAdversarialChecks(node24, cwd, environment) {
  let timedOut = false;
  try {
    await runBoundedProcess(node24, ["-e", "setInterval(() => {}, 1000)"], {
      cwd,
      env: environment,
      timeoutMs: 150,
      outputLimitBytes: 4096,
    });
  } catch (error) {
    timedOut = error instanceof Error && error.message === "subprocess timed out";
  }
  assert(timedOut, "hostile child escaped the subprocess timeout");

  if (process.platform !== "win32") {
    const marker = join(cwd, `.release-descendant-${process.pid}-${Date.now()}.pid`);
    assert(await pathIsAbsent(marker), "hostile descendant marker already exists");
    const descendantSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      `writeFileSync(${JSON.stringify(marker)}, String(descendant.pid), { flag: 'wx', mode: 0o600 });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const startedAt = Date.now();
    let inheritedPipeTimedOut = false;
    let descendantPid;
    let descendantStopped = false;
    try {
      try {
        await runBoundedProcess(node24, ["-e", descendantSource], {
          cwd,
          env: environment,
          timeoutMs: 400,
          outputLimitBytes: 4096,
        });
      } catch (error) {
        inheritedPipeTimedOut = error instanceof Error && error.message === "subprocess timed out";
      }
      const elapsed = Date.now() - startedAt;
      const markerRead = await openBoundRegularFile(marker, 1024, "hostile descendant marker", undefined, {
        requiredMode: 0o600,
        requireCurrentOwner: true,
      });
      descendantPid = Number(new TextDecoder("utf-8", { fatal: true }).decode(markerRead.bytes));
      assert(Number.isSafeInteger(descendantPid) && descendantPid > 1, "hostile descendant PID is invalid");
      descendantStopped = await waitForProcessExit(descendantPid, 1_500);
      assert(inheritedPipeTimedOut, "inherited-pipe descendant escaped the subprocess timeout");
      assert(elapsed < 2_000, "inherited-pipe timeout exceeded its hard settlement bound");
      assert(descendantStopped, "inherited-pipe descendant survived process-group termination");
    } finally {
      if (descendantPid !== undefined && !descendantStopped && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The bounded assertion above remains authoritative; cleanup is best effort.
        }
      }
      await rm(marker, { force: true });
    }
  }

  let capped = false;
  try {
    await runBoundedProcess(node24, ["-e", "process.stdout.write('x'.repeat(131072))"], {
      cwd,
      env: environment,
      timeoutMs: 5_000,
      outputLimitBytes: 4096,
    });
  } catch (error) {
    capped = error instanceof Error && error.message === "subprocess output limit exceeded";
  }
  assert(capped, "hostile child escaped the subprocess output cap");
}

async function verifyInstalledRuntime(skillRoot, root) {
  const node24 = await findNode24();
  const runtimeRoot = await openPrivateDirectoryBinding(root, "installed runtime root");
  const runtimeBindings = [runtimeRoot];
  const skill = await openPrivateDirectoryBinding(skillRoot, "installed Skill root");
  const skillBindings = [runtimeRoot, skill];
  runtimeBindings.push(skill);
  const cwdBinding = await createBoundPrivateChild([runtimeRoot], "unrelated-cwd");
  const homeBinding = await createBoundPrivateChild([runtimeRoot], "home");
  const binBinding = await createBoundPrivateChild([runtimeRoot], "private-bin");
  const deliveryBinding = await createBoundPrivateChild([runtimeRoot], "runtime-delivery");
  runtimeBindings.push(cwdBinding, homeBinding, binBinding, deliveryBinding);
  const cwd = cwdBinding.path;
  const home = homeBinding.path;
  const bin = binBinding.path;
  const npmMarker = join(root, "npm-was-invoked");
  const quotedMarker = npmMarker.replaceAll("'", "'\\''");
  const npmBytes = Buffer.from(`#!/bin/sh\nprintf invoked > '${quotedMarker}'\nexit 97\n`, "utf8");
  await writeBoundPrivateFile(
    join(bin, "npm"),
    npmBytes,
    [runtimeRoot, binBinding],
    "private npm sentinel",
    0o700,
  );
  const environment = scrubRuntimeEnvironment(home, bin, cwd);
  const entry = join(skillRoot, "scripts", "review-delivery.mjs");
  try {
    const runBoundCli = async (arguments_) => {
      await assertPrivateDirectoryChain([runtimeRoot, cwdBinding]);
      await assertPrivateDirectoryChain(skillBindings);
      const result = await runCli(node24, entry, arguments_, cwd, environment);
      await assertPrivateDirectoryChain([runtimeRoot, cwdBinding]);
      await assertPrivateDirectoryChain(skillBindings);
      return result;
    };
    const help = await runBoundCli(["--help"]);
    assert(help.code === 0 && help.signal === null, "installed CLI help failed under Node 24");
    assert(help.stderr === "" && help.stdout.endsWith("\n"), "installed CLI help output drifted");
    for (const command of REQUIRED_HELP_COMMANDS) {
      const matches = help.stdout.match(new RegExp(`\\b${command}\\b`, "gu")) ?? [];
      assert(matches.length === 1, `installed CLI help command drifted: ${command}`);
    }
    assert(!/npm|node_modules/iu.test(help.stdout), "installed CLI help requires development state");
    assert(await pathIsAbsent(npmMarker), "installed CLI invoked npm while printing help");

    const fixtureBytes = await readStableRepositoryFile("tests/fixtures/protocol/review-document.json", MAX_MANIFEST_BYTES, "release runtime fixture");
    const fixture = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes));
    fixture.delivery.outputs.agent = "release_AGENT.md";
    fixture.delivery.outputs.approval = "release_APPROVAL.html";
    fixture.delivery.baseName = "release";
    const deliveryRoot = deliveryBinding.path;
    const contract = join(deliveryRoot, "review-document.json");
    await writeBoundPrivateFile(
      contract,
      Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`, "utf8"),
      [runtimeRoot, deliveryBinding],
      "runtime review document",
    );

    const rendered = await runBoundCli(["render", "--document", contract]);
    assert(rendered.code === 0 && rendered.signal === null && rendered.stderr === "", "installed CLI render failed under Node 24");
    const renderResult = JSON.parse(rendered.stdout);
    assert(renderResult.status === "ok" && renderResult.phase === "render", "installed CLI render result drifted");
    const validated = await runBoundCli(["validate", "delivery", "--document", contract]);
    assert(validated.code === 0 && validated.signal === null && validated.stderr === "", "installed CLI validate failed under Node 24");
    const validateResult = JSON.parse(validated.stdout);
    assert(validateResult.status === "ok" && validateResult.phase === "validate", "installed CLI validate result drifted");
    const agent = await openBoundRegularFile(join(deliveryRoot, fixture.delivery.outputs.agent), MAX_SOURCE_FILE_BYTES, "rendered Agent artifact");
    const approval = await openBoundRegularFile(join(deliveryRoot, fixture.delivery.outputs.approval), MAX_SOURCE_FILE_BYTES, "rendered Approval artifact");
    assert(agent.bytes.byteLength > 0 && approval.bytes.byteLength > 0, "installed CLI produced an empty artifact");
    assert(await pathIsAbsent(npmMarker), "installed CLI invoked npm while rendering or validating");

    const assetsBinding = await openPrivateDirectoryBinding(join(skillRoot, "assets"), "installed Skill assets");
    runtimeBindings.push(assetsBinding);
    const templatePath = join(assetsBinding.path, "review-workbench.template.html");
    const template = await openBoundRegularFile(templatePath, MAX_SOURCE_FILE_BYTES, "installed approval template");
    await assertPrivateDirectoryChain([runtimeRoot, skill, assetsBinding]);
    await rm(templatePath);
    const missing = await runBoundCli(["validate", "delivery", "--document", contract]);
    assert(missing.code === 70 && missing.signal === null && missing.stderr === "", "missing installed template did not fail closed");
    const missingResult = JSON.parse(missing.stdout);
    assert(missingResult.status === "failed" && missingResult.errors?.[0]?.path === "/runtime/approvalTemplateBytes", "missing template error drifted");
    await writeBoundPrivateFile(
      templatePath,
      Buffer.concat([template.bytes, Buffer.from("\n")]),
      [runtimeRoot, skill, assetsBinding],
      "tampered installed template",
    );
    const tampered = await runBoundCli(["validate", "delivery", "--document", contract]);
    assert(tampered.code !== 0 && tampered.signal === null && tampered.stderr === "", "tampered installed template did not fail closed");
    assert(JSON.parse(tampered.stdout).status === "failed", "tampered installed template returned success");
    assert(await pathIsAbsent(npmMarker), "installed CLI invoked npm during template failure checks");
    await runSubprocessAdversarialChecks(node24, cwd, environment);
    assert(await pathIsAbsent(npmMarker), "subprocess checks invoked npm");
    return node24;
  } finally {
    await Promise.all([...runtimeBindings].reverse().map(async (binding) => binding.handle.close().catch(() => undefined)));
  }
}

function decodeManifest(manifestBytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("release manifest is not strict UTF-8 JSON");
  }
}

export async function verifyDistribution({
  repositoryRoot = ".",
  skillRoot,
  onTerminalCheckpoint,
} = {}) {
  assert(onTerminalCheckpoint === undefined || typeof onTerminalCheckpoint === "function", "terminal checkpoint must be a function");
  const repository = resolve(repositoryRoot);
  const liveSkillRoot = skillRoot === undefined
    ? join(repository, "skills", SKILL_NAME)
    : resolve(skillRoot);
  const packageContract = await verifyPackageContract(join(repository, "package.json"));
  try {
    const initialPair = await readStableReleasePair({ repositoryRoot: repository });
    const parsedEntries = parseDeterministicZip(initialPair.zipBytes);
    assertRuntimeInventory(parsedEntries);
    runParserAdversarialChecks(initialPair.zipBytes);
    const manifest = decodeManifest(initialPair.manifestBytes);
    validateReleaseManifest(manifest, initialPair.zipBytes, parsedEntries);
    runManifestAdversarialChecks(manifest, initialPair.zipBytes, parsedEntries);
    assertCanonicalReleaseManifestBytes(initialPair.manifestBytes, initialPair.zipBytes, parsedEntries);

    const liveBefore = await buildReleaseCandidate({ skillRoot: liveSkillRoot });
    assert(liveBefore.zipBytes.equals(initialPair.zipBytes), "release ZIP differs from the live source before physical rebuilds");
    assert(liveBefore.manifestBytes.equals(initialPair.manifestBytes), "release manifest differs from the live source before physical rebuilds");
    const firstRoot = await createPrivateDirectory("dar-release-root-a-");
    const secondRoot = await createPrivateDirectory("dar-release-root-b-");
    const extractionRoot = await createPrivateDirectory("dar-release-extract-");
    let node24;
    try {
      const [firstSkill, secondSkill] = await Promise.all([
        materializeReleaseEntries(liveBefore.entries, firstRoot),
        materializeReleaseEntries(liveBefore.entries, secondRoot),
      ]);
      const first = await buildReleaseCandidate({ skillRoot: firstSkill });
      const second = await buildReleaseCandidate({ skillRoot: secondSkill });
      assert(first.zipBytes.equals(second.zipBytes), "release ZIP differs across physical source roots");
      assert(first.manifestBytes.equals(second.manifestBytes), "release manifest differs across physical source roots");
      assert(first.zipBytes.equals(initialPair.zipBytes), "release ZIP differs from a physical-root rebuild");
      assert(first.manifestBytes.equals(initialPair.manifestBytes), "release manifest differs from a physical-root rebuild");

      const liveAfterRebuilds = await buildReleaseCandidate({ skillRoot: liveSkillRoot });
      assert(liveAfterRebuilds.zipBytes.equals(initialPair.zipBytes), "live release source changed after physical rebuilds");
      assert(liveAfterRebuilds.manifestBytes.equals(initialPair.manifestBytes), "live release manifest changed after physical rebuilds");
      const extractedSkill = await extractPrivate(parsedEntries, extractionRoot);
      node24 = await verifyInstalledRuntime(extractedSkill, extractionRoot);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
      await rm(extractionRoot, { recursive: true, force: true });
    }

    const finalSession = await openReleasePairSession({ repositoryRoot: repository });
    let sourceSession;
    try {
      sourceSession = await openSourceSnapshotSession(liveSkillRoot);
      assert(finalSession.zipBytes.equals(initialPair.zipBytes), "release ZIP changed before terminal verification");
      assert(finalSession.manifestBytes.equals(initialPair.manifestBytes), "release manifest changed before terminal verification");
      assertRuntimeInventory(sourceSession.entries);
      for (let index = 0; index < parsedEntries.length; index += 1) {
        assert(sourceSession.entries[index].bytes.equals(parsedEntries[index].bytes), `live release source drifted at ${index}`);
      }
      if (onTerminalCheckpoint) {
        await onTerminalCheckpoint({
          phase: "held-sessions-open",
          repositoryRoot: repository,
          skillRoot: liveSkillRoot,
          packagePath: packageContract.path,
          zipPath: finalSession.zip.path,
          manifestPath: finalSession.manifest.path,
        });
      }
      const liveFinal = await buildReleaseCandidate({ skillRoot: liveSkillRoot });
      assert(liveFinal.zipBytes.equals(initialPair.zipBytes), "live release source changed before final verification");
      assert(liveFinal.manifestBytes.equals(initialPair.manifestBytes), "live release manifest changed before final verification");
      await revalidatePackageContract(packageContract);
      const terminalSource = await rereadSourceSnapshotSession(sourceSession);
      for (let index = 0; index < parsedEntries.length; index += 1) {
        assert(terminalSource.entries[index].bytes.equals(parsedEntries[index].bytes), `held release source changed at ${index}`);
      }
      const terminalPair = await rereadReleasePairSession(finalSession);
      assert(terminalPair.zipBytes.equals(initialPair.zipBytes), "release ZIP changed before success");
      assert(terminalPair.manifestBytes.equals(initialPair.manifestBytes), "release manifest changed before success");
      const result = {
        version: RELEASE_VERSION,
        entryCount: parsedEntries.length,
        byteLength: terminalPair.zipBytes.byteLength,
        digest: releaseSha256(terminalPair.zipBytes),
        node: node24,
      };
      await revalidatePackageContract(packageContract);
      const finalSource = await rereadSourceSnapshotSession(sourceSession);
      for (let index = 0; index < parsedEntries.length; index += 1) {
        assert(finalSource.entries[index].bytes.equals(parsedEntries[index].bytes), `held release source changed at final boundary ${index}`);
      }
      const finalPair = await rereadReleasePairSession(finalSession);
      assert(finalPair.zipBytes.equals(initialPair.zipBytes), "release ZIP changed at final success boundary");
      assert(finalPair.manifestBytes.equals(initialPair.manifestBytes), "release manifest changed at final success boundary");
      return result;
    } finally {
      await closeSourceSnapshotSession(sourceSession);
      await closeReleasePairSession(finalSession);
    }
  } finally {
    await closePackageContract(packageContract);
  }
}

async function main() {
  const result = await verifyDistribution();
  console.log(JSON.stringify({
    status: "ok",
    version: result.version,
    archive: RELEASE_ZIP_PATH,
    manifest: RELEASE_MANIFEST_PATH,
    entryCount: result.entryCount,
    byteLength: result.byteLength,
    digest: result.digest,
    node: result.node,
  }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "release verification failed");
    process.exitCode = 3;
  });
}
