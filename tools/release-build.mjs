import { constants as FS_CONSTANTS } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const RELEASE_VERSION = "0.2.1";
export const SKILL_NAME = "deliver-dual-audience-report";
export const SKILL_PREFIX = `${SKILL_NAME}/`;
export const RELEASE_ZIP_NAME = `${SKILL_NAME}-v${RELEASE_VERSION}.zip`;
export const RELEASE_MANIFEST_NAME = `${SKILL_NAME}-v${RELEASE_VERSION}.manifest.json`;
export const RELEASE_ZIP_PATH = `dist/${RELEASE_ZIP_NAME}`;
export const RELEASE_MANIFEST_PATH = `dist/${RELEASE_MANIFEST_NAME}`;
export const RELEASE_TRANSACTION_DIR = "dist/.release-txn";
export const ZIP_METHOD_STORE = 0;
export const ZIP_MODE = 0o100644;
export const ZIP_TIMESTAMP = "1980-01-01T00:00:00Z";
export const ZIP_DOS_DATE = 0x0021;
export const ZIP_DOS_TIME = 0x0000;

export const SKILL_FILES = Object.freeze([
  "SKILL.md",
  "agents/openai.yaml",
  "assets/agent-context.template.md",
  "assets/review-workbench.template.html",
  "references/approval-writing-examples.md",
  "references/audience-contracts.md",
  "references/evidence-and-privacy.md",
  "references/review-document.schema.json",
  "references/review-packet.schema.json",
  "references/review-protocols.md",
  "references/review-state.schema.json",
  "scripts/review-delivery.mjs",
]);

const REQUIRED_NODE_RANGE = ">=24 <25";
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const TRANSACTION_FORMAT = "deliver-dual-audience-report-release-transaction/1";
const TRANSACTION_MANIFEST = "transaction.json";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EXPECTED_PATHS = Object.freeze(SKILL_FILES.map((path) => `${SKILL_PREFIX}${path}`));
const EXPECTED_SORTED_FILES = Object.freeze([...SKILL_FILES].sort(compareCodeUnits));

if (!sameStrings(SKILL_FILES, EXPECTED_SORTED_FILES)) {
  throw new Error("release inventory must stay in stable bytewise order");
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function assertBoundedInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} exceeds its release boundary`);
  }
}

function modeBits(status) {
  return Number(status.mode & 0o7777n);
}

function sameIdentity(left, right, { timestamps = true } = {}) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && (!timestamps || (
      left.size === right.size
      && left.mtimeNs === right.mtimeNs
      && left.ctimeNs === right.ctimeNs
      && left.birthtimeNs === right.birthtimeNs
    ));
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function sameRegularObject(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function assertRegularStatus(status, label, { singleLink = true, maximum = MAX_ARCHIVE_BYTES } = {}) {
  if (!status.isFile() || status.isSymbolicLink() || (singleLink && status.nlink !== 1n)) {
    throw new Error(`${label} is not a single-link regular file`);
  }
  if (status.size < 0n || status.size > BigInt(maximum)) {
    throw new Error(`${label} exceeds its release boundary`);
  }
}

function assertDirectoryStatus(status, label) {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
}

async function bindCanonicalDirectory(path, label, { timestamps = false } = {}) {
  const canonicalPath = resolve(path);
  const status = await lstat(canonicalPath, { bigint: true });
  assertDirectoryStatus(status, label);
  if (await realpath(canonicalPath) !== canonicalPath) {
    throw new Error(`${label} is not canonical and symlink-free`);
  }
  return { path: canonicalPath, status, timestamps };
}

async function assertDirectoryBinding(binding, label) {
  const current = await lstat(binding.path, { bigint: true });
  assertDirectoryStatus(current, label);
  if (
    !(binding.timestamps
      ? sameIdentity(current, binding.status, { timestamps: true })
      : sameDirectoryIdentity(current, binding.status))
    || await realpath(binding.path) !== binding.path
  ) {
    throw new Error(`${label} binding changed`);
  }
  return current;
}

async function assertRegularPathBinding(path, expected, label, maximum = MAX_ARCHIVE_BYTES) {
  const current = await lstat(path, { bigint: true });
  assertRegularStatus(current, label, { maximum });
  if (!sameIdentity(current, expected)) throw new Error(`${label} binding changed`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} path is no longer canonical`);
  return current;
}

async function readExactHandle(handle, expectedSize, maximum, label) {
  assertBoundedInteger(expectedSize, maximum, label);
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const result = await handle.read(bytes, offset, expectedSize - offset, offset);
    if (result.bytesRead === 0) throw new Error(`${label} became shorter during read`);
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const eof = await handle.read(probe, 0, 1, expectedSize);
  if (eof.bytesRead !== 0) throw new Error(`${label} grew during read`);
  return bytes;
}

async function openBoundedRegular(path, maximum, label) {
  const before = await lstat(path, { bigint: true });
  assertRegularStatus(before, label, { maximum });
  const handle = await open(
    path,
    FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW | FS_CONSTANTS.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularStatus(opened, label, { maximum });
    if (!sameIdentity(opened, before)) throw new Error(`${label} changed before open`);
    return { path, label, maximum, handle, status: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readOpenedStable(opened) {
  const before = await opened.handle.stat({ bigint: true });
  if (!sameIdentity(before, opened.status)) throw new Error(`${opened.label} changed before read`);
  const bytes = await readExactHandle(opened.handle, Number(opened.status.size), opened.maximum, opened.label);
  const after = await opened.handle.stat({ bigint: true });
  if (!sameIdentity(after, opened.status)) throw new Error(`${opened.label} changed during read`);
  return bytes;
}

async function readStableRegularPath(path, maximum, label, {
  expectedStatus,
  requiredMode,
} = {}) {
  const opened = await openBoundedRegular(path, maximum, label);
  try {
    if (expectedStatus && !sameIdentity(opened.status, expectedStatus)) {
      throw new Error(`${label} binding changed`);
    }
    if (requiredMode !== undefined && modeBits(opened.status) !== requiredMode) {
      throw new Error(`${label} mode must be ${requiredMode.toString(8)}`);
    }
    const first = await readOpenedStable(opened);
    const second = await readOpenedStable(opened);
    if (!first.equals(second)) throw new Error(`${label} changed between stable reads`);
    await assertRegularPathBinding(path, opened.status, label, maximum);
    return { bytes: first, status: opened.status };
  } finally {
    await opened.handle.close();
  }
}

export function releaseSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

function assertSafeArchivePath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe release inventory path: ${String(path)}`);
  }
}

function portableArchiveKey(path) {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC").toLocaleLowerCase("en-US"))
    .join("/");
}

function resolveSkillRoot(skillRoot) {
  if (typeof skillRoot !== "string" || skillRoot.length === 0) {
    throw new Error("release Skill root must be a path");
  }
  return isAbsolute(skillRoot) ? resolve(skillRoot) : resolve(REPOSITORY_ROOT, skillRoot);
}

async function assertRepositoryContract() {
  const repository = await bindCanonicalDirectory(REPOSITORY_ROOT, "repository root", { timestamps: false });
  const packagePath = join(REPOSITORY_ROOT, "package.json");
  const packageOpened = await openBoundedRegular(packagePath, MAX_PACKAGE_BYTES, "package.json");
  let packageBytes;
  try {
    const first = await readOpenedStable(packageOpened);
    const second = await readOpenedStable(packageOpened);
    if (!first.equals(second)) throw new Error("package.json changed between initial stable reads");
    packageBytes = first;
    await assertRegularPathBinding(
      packagePath,
      packageOpened.status,
      "package.json",
      MAX_PACKAGE_BYTES,
    );
  } catch (error) {
    await packageOpened.handle.close();
    throw error;
  }
  let packageValue;
  try {
    packageValue = JSON.parse(UTF8_DECODER.decode(packageBytes));
  } catch (error) {
    await packageOpened.handle.close();
    throw new Error("package.json is not strict UTF-8 JSON", { cause: error });
  }
  if (
    packageValue === null
    || typeof packageValue !== "object"
    || Array.isArray(packageValue)
    || packageValue.version !== RELEASE_VERSION
    || packageValue.engines === null
    || typeof packageValue.engines !== "object"
    || Array.isArray(packageValue.engines)
    || packageValue.engines.node !== REQUIRED_NODE_RANGE
  ) {
    await packageOpened.handle.close();
    throw new Error(`package.json must declare version ${RELEASE_VERSION} and Node ${REQUIRED_NODE_RANGE}`);
  }
  try {
    await assertDirectoryBinding(repository, "repository root");
  } catch (error) {
    await packageOpened.handle.close();
    throw error;
  }
  return { repository, packageOpened, packageBytes };
}

async function assertRepositoryContractUnchanged(contract) {
  const { repository, packageOpened, packageBytes } = contract;
  const retainedFirst = await readOpenedStable(packageOpened);
  const retainedSecond = await readOpenedStable(packageOpened);
  if (!retainedFirst.equals(retainedSecond) || !retainedFirst.equals(packageBytes)) {
    throw new Error("package.json bytes changed during release candidate construction");
  }
  await assertRegularPathBinding(
    packageOpened.path,
    packageOpened.status,
    "package.json",
    MAX_PACKAGE_BYTES,
  );
  const reopened = await readStableRegularPath(
    packageOpened.path,
    MAX_PACKAGE_BYTES,
    "package.json final snapshot",
    { expectedStatus: packageOpened.status },
  );
  if (!reopened.bytes.equals(packageBytes)) {
    throw new Error("package.json final bytes differ from the validated contract");
  }
  await assertDirectoryBinding(repository, "repository root");
}

export async function collectReleaseFiles(skillRoot = `skills/${SKILL_NAME}`) {
  const root = resolveSkillRoot(skillRoot);
  const directoryPaths = new Set([root]);
  for (const relativePath of SKILL_FILES) {
    assertSafeArchivePath(relativePath);
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(join(root, ...segments.slice(0, index)));
    }
  }

  const directoryBindings = [];
  for (const path of [...directoryPaths].sort(compareCodeUnits)) {
    const binding = await bindCanonicalDirectory(path, `release input directory ${path}`, { timestamps: true });
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new Error("release input directory escaped the Skill root");
    }
    directoryBindings.push(binding);
  }

  const openedFiles = [];
  let aggregateBytes = 0;
  try {
    for (const relativePath of SKILL_FILES) {
      const sourcePath = join(root, ...relativePath.split("/"));
      const opened = await openBoundedRegular(
        sourcePath,
        MAX_SOURCE_FILE_BYTES,
        `release input ${relativePath}`,
      );
      aggregateBytes += Number(opened.status.size);
      assertBoundedInteger(aggregateBytes, MAX_SOURCE_TOTAL_BYTES, "release input aggregate");
      opened.relativePath = relativePath;
      openedFiles.push(opened);
    }

    const firstReads = [];
    for (const opened of openedFiles) firstReads.push(await readOpenedStable(opened));

    const finalReads = [];
    for (let index = 0; index < openedFiles.length; index += 1) {
      const opened = openedFiles[index];
      const finalBytes = await readOpenedStable(opened);
      if (!finalBytes.equals(firstReads[index])) {
        throw new Error(`${opened.label} changed across the coherent snapshot`);
      }
      finalReads.push(finalBytes);
    }

    for (const binding of directoryBindings) {
      await assertDirectoryBinding(binding, `release input directory ${binding.path}`);
    }
    for (const opened of openedFiles) {
      await assertRegularPathBinding(opened.path, opened.status, opened.label, opened.maximum);
      const handleStatus = await opened.handle.stat({ bigint: true });
      if (!sameIdentity(handleStatus, opened.status)) {
        throw new Error(`${opened.label} changed at final snapshot binding`);
      }
    }

    return openedFiles.map((opened, index) => {
      const bytes = finalReads[index];
      return {
        path: `${SKILL_PREFIX}${opened.relativePath}`,
        relativePath: opened.relativePath,
        bytes,
        byteLength: bytes.byteLength,
        digest: releaseSha256(bytes),
        crc32: crc32(bytes),
      };
    });
  } finally {
    await Promise.all(openedFiles.map(async (opened) => opened.handle.close().catch(() => undefined)));
  }
}

export function createDeterministicZip(entries) {
  if (!Array.isArray(entries) || entries.length !== SKILL_FILES.length) {
    throw new Error("release ZIP inventory must contain exactly 11 files");
  }
  const ordered = [...entries].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (!sameStrings(ordered.map((entry) => entry.path), EXPECTED_PATHS)) {
    throw new Error("release ZIP inventory is incomplete or out of order");
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let aggregateBytes = 0;
  for (const entry of ordered) {
    assertSafeArchivePath(entry.path);
    if (!(entry.bytes instanceof Uint8Array)) throw new Error(`release entry is not bytes: ${entry.path}`);
    const bytes = Buffer.from(entry.bytes);
    assertBoundedInteger(bytes.byteLength, MAX_SOURCE_FILE_BYTES, entry.path);
    aggregateBytes += bytes.byteLength;
    assertBoundedInteger(aggregateBytes, MAX_SOURCE_TOTAL_BYTES, "release ZIP source aggregate");
    const expectedCrc = crc32(bytes);
    const expectedDigest = releaseSha256(bytes);
    if (
      entry.byteLength !== bytes.byteLength
      || entry.crc32 !== expectedCrc
      || entry.digest !== expectedDigest
    ) {
      throw new Error(`release entry metadata does not bind its bytes: ${entry.path}`);
    }

    const name = Buffer.from(entry.path, "utf8");
    if (name.byteLength > 0xffff) throw new Error(`release path is too long: ${entry.path}`);
    assertBoundedInteger(localOffset, 0xffffffff, "release ZIP local offset");
    const local = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(ZIP_METHOD_STORE),
      uint16(ZIP_DOS_TIME),
      uint16(ZIP_DOS_DATE),
      uint32(expectedCrc),
      uint32(bytes.byteLength),
      uint32(bytes.byteLength),
      uint16(name.byteLength),
      uint16(0),
      name,
      bytes,
    ]);
    localParts.push(local);

    centralParts.push(Buffer.concat([
      uint32(0x02014b50),
      uint16((3 << 8) | 20),
      uint16(20),
      uint16(0x0800),
      uint16(ZIP_METHOD_STORE),
      uint16(ZIP_DOS_TIME),
      uint16(ZIP_DOS_DATE),
      uint32(expectedCrc),
      uint32(bytes.byteLength),
      uint32(bytes.byteLength),
      uint16(name.byteLength),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32((ZIP_MODE << 16) >>> 0),
      uint32(localOffset),
      name,
    ]));
    localOffset += local.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  assertBoundedInteger(localOffset, 0xffffffff, "release ZIP central offset");
  assertBoundedInteger(centralDirectory.byteLength, 0xffffffff, "release ZIP central directory");
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(ordered.length),
    uint16(ordered.length),
    uint32(centralDirectory.byteLength),
    uint32(localOffset),
    uint16(0),
  ]);
  const zipBytes = Buffer.concat([...localParts, centralDirectory, end]);
  assertBoundedInteger(zipBytes.byteLength, MAX_ARCHIVE_BYTES, "release ZIP");
  return zipBytes;
}

function assertAvailable(bytes, offset, length, limit, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset > limit
    || length > limit - offset
    || offset + length > bytes.byteLength
  ) {
    throw new Error(`truncated or invalid ${label}`);
  }
}

function decodeZipName(bytes) {
  return UTF8_DECODER.decode(bytes);
}

export function parseDeterministicZip(input) {
  if (!(input instanceof Uint8Array)) throw new Error("release ZIP input must be bytes");
  assertBoundedInteger(input.byteLength, MAX_ARCHIVE_BYTES, "release ZIP");
  const zipBytes = Buffer.from(input);
  if (zipBytes.byteLength < 22) throw new Error("release ZIP is shorter than EOCD");
  const eocdOffset = zipBytes.byteLength - 22;
  if (zipBytes.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error("release ZIP EOCD must be the final 22 bytes");
  }
  const disk = zipBytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = zipBytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = zipBytes.readUInt16LE(eocdOffset + 8);
  const entryCount = zipBytes.readUInt16LE(eocdOffset + 10);
  const centralSize = zipBytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(eocdOffset + 16);
  const commentLength = zipBytes.readUInt16LE(eocdOffset + 20);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== SKILL_FILES.length
    || entryCount !== SKILL_FILES.length
    || commentLength !== 0
    || centralOffset > eocdOffset
    || centralSize !== eocdOffset - centralOffset
  ) {
    throw new Error("release ZIP EOCD is not canonical single-disk ZIP32");
  }

  const entries = [];
  const seen = new Set();
  const portableKeys = new Set();
  let centralCursor = centralOffset;
  let expectedLocalOffset = 0;
  let aggregateBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertAvailable(zipBytes, centralCursor, 46, eocdOffset, "central directory entry");
    if (zipBytes.readUInt32LE(centralCursor) !== 0x02014b50) {
      throw new Error("invalid central directory signature");
    }
    const madeBy = zipBytes.readUInt16LE(centralCursor + 4);
    const needed = zipBytes.readUInt16LE(centralCursor + 6);
    const flags = zipBytes.readUInt16LE(centralCursor + 8);
    const method = zipBytes.readUInt16LE(centralCursor + 10);
    const time = zipBytes.readUInt16LE(centralCursor + 12);
    const date = zipBytes.readUInt16LE(centralCursor + 14);
    const crc = zipBytes.readUInt32LE(centralCursor + 16);
    const compressedSize = zipBytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = zipBytes.readUInt32LE(centralCursor + 24);
    const nameLength = zipBytes.readUInt16LE(centralCursor + 28);
    const extraLength = zipBytes.readUInt16LE(centralCursor + 30);
    const commentEntryLength = zipBytes.readUInt16LE(centralCursor + 32);
    const diskStart = zipBytes.readUInt16LE(centralCursor + 34);
    const internalAttributes = zipBytes.readUInt16LE(centralCursor + 36);
    const externalAttributes = zipBytes.readUInt32LE(centralCursor + 38);
    const localOffset = zipBytes.readUInt32LE(centralCursor + 42);
    if (
      madeBy !== ((3 << 8) | 20)
      || needed !== 20
      || flags !== 0x0800
      || method !== ZIP_METHOD_STORE
      || time !== ZIP_DOS_TIME
      || date !== ZIP_DOS_DATE
      || compressedSize !== uncompressedSize
      || extraLength !== 0
      || commentEntryLength !== 0
      || diskStart !== 0
      || internalAttributes !== 0
      || externalAttributes !== ((ZIP_MODE << 16) >>> 0)
      || localOffset !== expectedLocalOffset
    ) {
      throw new Error("release ZIP central metadata is not canonical");
    }
    assertBoundedInteger(uncompressedSize, MAX_SOURCE_FILE_BYTES, "release ZIP entry");
    aggregateBytes += uncompressedSize;
    assertBoundedInteger(aggregateBytes, MAX_SOURCE_TOTAL_BYTES, "release ZIP entry aggregate");
    assertAvailable(zipBytes, centralCursor + 46, nameLength, eocdOffset, "central entry name");
    const nameBytes = zipBytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const path = decodeZipName(nameBytes);
    assertSafeArchivePath(path);
    if (seen.has(path)) throw new Error(`duplicate release ZIP entry: ${path}`);
    seen.add(path);
    const portableKey = portableArchiveKey(path);
    if (portableKeys.has(portableKey)) throw new Error(`portable release ZIP collision: ${path}`);
    portableKeys.add(portableKey);

    assertAvailable(zipBytes, localOffset, 30, centralOffset, "local entry");
    if (zipBytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid local entry signature");
    const localNeeded = zipBytes.readUInt16LE(localOffset + 4);
    const localFlags = zipBytes.readUInt16LE(localOffset + 6);
    const localMethod = zipBytes.readUInt16LE(localOffset + 8);
    const localTime = zipBytes.readUInt16LE(localOffset + 10);
    const localDate = zipBytes.readUInt16LE(localOffset + 12);
    const localCrc = zipBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = zipBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = zipBytes.readUInt32LE(localOffset + 22);
    const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
    if (
      localNeeded !== 20
      || localFlags !== 0x0800
      || localMethod !== ZIP_METHOD_STORE
      || localTime !== ZIP_DOS_TIME
      || localDate !== ZIP_DOS_DATE
      || localCrc !== crc
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
      || localNameLength !== nameLength
      || localExtraLength !== 0
    ) {
      throw new Error("release ZIP local metadata is not canonical");
    }
    assertAvailable(zipBytes, localOffset + 30, localNameLength, centralOffset, "local entry name");
    const localName = zipBytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localName.equals(nameBytes)) throw new Error("release ZIP local and central names differ");
    const dataOffset = localOffset + 30 + localNameLength;
    assertAvailable(zipBytes, dataOffset, uncompressedSize, centralOffset, "release ZIP entry data");
    const bytes = Buffer.from(zipBytes.subarray(dataOffset, dataOffset + uncompressedSize));
    if (crc32(bytes) !== crc) throw new Error(`release ZIP CRC mismatch: ${path}`);
    entries.push({
      path,
      relativePath: path.startsWith(SKILL_PREFIX) ? path.slice(SKILL_PREFIX.length) : path,
      bytes,
      byteLength: bytes.byteLength,
      digest: releaseSha256(bytes),
      crc32: crc,
      localOffset,
    });
    expectedLocalOffset = dataOffset + uncompressedSize;
    centralCursor += 46 + nameLength;
  }
  if (centralCursor !== eocdOffset || expectedLocalOffset !== centralOffset) {
    throw new Error("release ZIP contains a gap, overlap, or trailing local bytes");
  }
  if (!sameStrings(entries.map((entry) => entry.path), EXPECTED_PATHS)) {
    throw new Error("release ZIP inventory drifted");
  }
  return entries;
}

export function createReleaseManifest(entries, zipBytes) {
  if (!Array.isArray(entries) || !sameStrings(entries.map((entry) => entry.path), EXPECTED_PATHS)) {
    throw new Error("release manifest inventory drifted");
  }
  assertBoundedInteger(zipBytes.byteLength, MAX_ARCHIVE_BYTES, "release ZIP");
  return {
    format: "deliver-dual-audience-report-release/1",
    version: RELEASE_VERSION,
    skill: SKILL_NAME,
    node: REQUIRED_NODE_RANGE,
    archive: {
      path: RELEASE_ZIP_PATH,
      byteLength: zipBytes.byteLength,
      digest: releaseSha256(zipBytes),
      entryCount: entries.length,
      compression: "store",
      timestamp: ZIP_TIMESTAMP,
      mode: "0644",
      root: SKILL_NAME,
    },
    files: entries.map((entry) => ({
      path: entry.path,
      byteLength: entry.byteLength,
      digest: entry.digest,
    })),
    reproducibility: {
      order: "bytewise-path-ascending",
      timestamp: ZIP_TIMESTAMP,
      compression: "store",
      mode: "0644",
      extraFields: false,
      comments: false,
    },
  };
}

export function serializeReleaseManifest(manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertBoundedInteger(bytes.byteLength, MAX_MANIFEST_BYTES, "release manifest");
  return bytes;
}

async function buildReleaseCandidateWithContract({
  skillRoot = `skills/${SKILL_NAME}`,
  version = RELEASE_VERSION,
  onSnapshotCheckpoint,
} = {}, repositoryContract) {
  if (version !== RELEASE_VERSION) throw new Error(`release version must be exactly ${RELEASE_VERSION}`);
  if (onSnapshotCheckpoint !== undefined && typeof onSnapshotCheckpoint !== "function") {
    throw new Error("release snapshot checkpoint hook must be a function");
  }
  if (onSnapshotCheckpoint) await onSnapshotCheckpoint("package-bound");
  const entries = await collectReleaseFiles(skillRoot);
  const firstZipBytes = createDeterministicZip(entries);
  const secondZipBytes = createDeterministicZip(entries);
  if (!firstZipBytes.equals(secondZipBytes)) throw new Error("release ZIP is not reproducible in memory");
  const parsed = parseDeterministicZip(firstZipBytes);
  if (!parsed.every((entry, index) => entry.bytes.equals(entries[index].bytes))) {
    throw new Error("release ZIP did not round-trip its source bytes");
  }
  const manifest = createReleaseManifest(entries, firstZipBytes);
  const manifestBytes = serializeReleaseManifest(manifest);
  await assertRepositoryContractUnchanged(repositoryContract);
  return { entries, zipBytes: firstZipBytes, manifest, manifestBytes };
}

export async function buildReleaseCandidate(options = {}) {
  const repositoryContract = await assertRepositoryContract();
  try {
    return await buildReleaseCandidateWithContract(options, repositoryContract);
  } finally {
    await repositoryContract.packageOpened.handle.close();
  }
}

function randomTransactionName(label) {
  return `${label}-${randomBytes(16).toString("hex")}`;
}

async function syncDirectory(path) {
  const handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const status = await handle.stat({ bigint: true });
    assertDirectoryStatus(status, `directory ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createExclusiveFile(path, bytes, mode, maximum, label) {
  assertBoundedInteger(bytes.byteLength, maximum, label);
  const handle = await open(
    path,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
    mode,
  );
  let status;
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    status = await handle.stat({ bigint: true });
    assertRegularStatus(status, label, { maximum });
    if (modeBits(status) !== mode || status.size !== BigInt(bytes.byteLength)) {
      throw new Error(`${label} durable file metadata drifted`);
    }
  } finally {
    await handle.close();
  }
  const verified = await readStableRegularPath(path, maximum, label, { expectedStatus: status, requiredMode: mode });
  if (!verified.bytes.equals(bytes)) throw new Error(`${label} durable bytes drifted`);
  return verified.status;
}

async function pathDoesNotExist(path) {
  try {
    await lstat(path, { bigint: true });
    return false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function assertAbsent(path, label) {
  if (!(await pathDoesNotExist(path))) throw new Error(`${label} unexpectedly exists`);
}

async function readOptionalTarget(path, maximum, label, distBinding) {
  await assertDirectoryBinding(distBinding, "release dist directory");
  if (await pathDoesNotExist(path)) return { exists: false };
  const value = await readStableRegularPath(path, maximum, label);
  if (value.status.dev !== distBinding.status.dev) throw new Error(`${label} is on an unexpected device`);
  return { exists: true, ...value };
}

async function verifyExactFile(path, bytes, maximum, label, {
  expectedStatus,
  requiredMode = 0o644,
} = {}) {
  const value = await readStableRegularPath(path, maximum, label, { expectedStatus, requiredMode });
  if (!value.bytes.equals(bytes)) throw new Error(`${label} bytes do not match the transaction`);
  return value.status;
}

async function verifyRenamedExactFile(path, bytes, maximum, label, previousStatus, requiredMode) {
  const value = await readStableRegularPath(path, maximum, label, { requiredMode });
  if (!sameRegularObject(value.status, previousStatus)) {
    throw new Error(`${label} changed identity across rename`);
  }
  if (!value.bytes.equals(bytes)) throw new Error(`${label} bytes changed across rename`);
  return value.status;
}

async function createTransactionDirectory(distBinding, transactionPath) {
  await assertDirectoryBinding(distBinding, "release dist directory");
  try {
    await mkdir(transactionPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        `orphaned release transaction at ${RELEASE_TRANSACTION_DIR}; manual investigation required`,
        { cause: error },
      );
    }
    throw error;
  }
  const handle = await open(transactionPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    await handle.chmod(0o700);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const binding = await bindCanonicalDirectory(transactionPath, "release transaction directory", { timestamps: false });
  if (modeBits(binding.status) !== 0o700 || binding.status.dev !== distBinding.status.dev) {
    throw new Error("release transaction directory is not private or is on an unexpected device");
  }
  await syncDirectory(distBinding.path);
  return binding;
}

async function assertTransactionManifestState(state, transactionBinding) {
  const manifestPath = join(transactionBinding.path, TRANSACTION_MANIFEST);
  try {
    await assertDirectoryBinding(transactionBinding, "release transaction directory");
    if (state.manifestStatus === undefined || state.manifestBytes === undefined) {
      await assertAbsent(manifestPath, "transaction manifest");
      return;
    }
    const status = await verifyExactFile(
      manifestPath,
      state.manifestBytes,
      MAX_MANIFEST_BYTES,
      "transaction manifest",
      { expectedStatus: state.manifestStatus, requiredMode: 0o600 },
    );
    if (status.dev !== transactionBinding.status.dev) {
      throw new Error("transaction manifest device drifted");
    }
  } catch (error) {
    state.evidenceUncertain = true;
    throw new Error(
      `release transaction evidence is uncertain; retained at ${RELEASE_TRANSACTION_DIR}`,
      { cause: error },
    );
  }
}

async function writeTransactionManifest(transaction, transactionBinding, state) {
  const manifestPath = join(transactionBinding.path, TRANSACTION_MANIFEST);
  const temporaryPath = join(transactionBinding.path, randomTransactionName("transaction.tmp"));
  const bytes = Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`, "utf8");
  assertBoundedInteger(bytes.byteLength, MAX_MANIFEST_BYTES, "transaction manifest");
  await assertTransactionManifestState(state, transactionBinding);
  const temporaryStatus = await createExclusiveFile(
    temporaryPath,
    bytes,
    0o600,
    MAX_MANIFEST_BYTES,
    "temporary transaction manifest",
  );
  try {
    await assertTransactionManifestState(state, transactionBinding);
    await assertRegularPathBinding(
      temporaryPath,
      temporaryStatus,
      "temporary transaction manifest",
      MAX_MANIFEST_BYTES,
    );
    await assertDirectoryBinding(transactionBinding, "release transaction directory");
    await assertRegularPathBinding(
      temporaryPath,
      temporaryStatus,
      "temporary transaction manifest",
      MAX_MANIFEST_BYTES,
    );
    await rename(temporaryPath, manifestPath);
    await syncDirectory(transactionBinding.path);
    const installedStatus = await verifyRenamedExactFile(
      manifestPath,
      bytes,
      MAX_MANIFEST_BYTES,
      "transaction manifest",
      temporaryStatus,
      0o600,
    );
    state.manifestBytes = bytes;
    state.manifestStatus = installedStatus;
  } catch (error) {
    if (!state.evidenceUncertain && !(await pathDoesNotExist(temporaryPath))) {
      try {
        await assertRegularPathBinding(
          temporaryPath,
          temporaryStatus,
          "temporary transaction manifest",
          MAX_MANIFEST_BYTES,
        );
        await unlink(temporaryPath);
        await syncDirectory(transactionBinding.path);
      } catch {
        // Preserve uncertain transaction evidence for manual investigation.
      }
    }
    throw error;
  }
}

async function recordCheckpoint(transaction, phase, transactionBinding, state, onCheckpoint) {
  transaction.phase = phase;
  await writeTransactionManifest(transaction, transactionBinding, state);
  if (onCheckpoint) await onCheckpoint(phase);
}

function transactionFilePath(transactionBinding, name) {
  if (typeof name !== "string" || !/^[a-z0-9.-]+$/u.test(name) || name.includes("..")) {
    throw new Error("unsafe release transaction file name");
  }
  return join(transactionBinding.path, name);
}

function describePrevious(previous) {
  return previous.exists
    ? {
      exists: true,
      byteLength: previous.bytes.byteLength,
      digest: releaseSha256(previous.bytes),
      mode: modeBits(previous.status).toString(8).padStart(4, "0"),
    }
    : { exists: false };
}

async function backupTarget({
  targetPath,
  backupPath,
  previous,
  maximum,
  label,
  distBinding,
  transactionBinding,
}) {
  await assertDirectoryBinding(distBinding, "release dist directory");
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  await assertAbsent(backupPath, `${label} backup`);
  if (!previous.exists) {
    await assertAbsent(targetPath, label);
    return false;
  }
  await verifyExactFile(targetPath, previous.bytes, maximum, label, {
    expectedStatus: previous.status,
    requiredMode: modeBits(previous.status),
  });
  await assertDirectoryBinding(distBinding, "release dist directory");
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  await assertRegularPathBinding(targetPath, previous.status, label, maximum);
  await rename(targetPath, backupPath);
  await syncDirectory(transactionBinding.path);
  await syncDirectory(distBinding.path);
  await assertAbsent(targetPath, label);
  previous.status = await verifyRenamedExactFile(
    backupPath,
    previous.bytes,
    maximum,
    `${label} backup`,
    previous.status,
    modeBits(previous.status),
  );
  return true;
}

async function installTarget({
  stagedPath,
  targetPath,
  bytes,
  stagedStatus,
  maximum,
  label,
  distBinding,
  transactionBinding,
}) {
  await assertDirectoryBinding(distBinding, "release dist directory");
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  await assertAbsent(targetPath, label);
  await verifyExactFile(stagedPath, bytes, maximum, `${label} staged`, {
    expectedStatus: stagedStatus,
    requiredMode: 0o644,
  });
  await assertDirectoryBinding(distBinding, "release dist directory");
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  await assertAbsent(targetPath, label);
  await assertRegularPathBinding(stagedPath, stagedStatus, `${label} staged`, maximum);
  await rename(stagedPath, targetPath);
  await syncDirectory(distBinding.path);
  await syncDirectory(transactionBinding.path);
  return verifyRenamedExactFile(targetPath, bytes, maximum, label, stagedStatus, 0o644);
}

async function unlinkExact(path, expectedStatus, maximum, label, parentBinding) {
  await assertDirectoryBinding(parentBinding, `${label} parent directory`);
  await assertRegularPathBinding(path, expectedStatus, label, maximum);
  await unlink(path);
  await syncDirectory(parentBinding.path);
  await assertAbsent(path, label);
}

async function cleanupTransaction(transaction, transactionBinding, distBinding, state, knownStatuses = new Map()) {
  await assertTransactionManifestState(state, transactionBinding);
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  const allowedNames = new Set([
    TRANSACTION_MANIFEST,
    transaction.files.stagedZip,
    transaction.files.stagedManifest,
    transaction.files.backupZip,
    transaction.files.backupManifest,
  ]);
  const names = await readdir(transactionBinding.path);
  const unexpected = names.filter((name) => !allowedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`release transaction contains unexpected evidence: ${unexpected.join(", ")}`);
  }
  const cleanupOrder = [
    transaction.files.stagedZip,
    transaction.files.stagedManifest,
    transaction.files.backupZip,
    transaction.files.backupManifest,
    TRANSACTION_MANIFEST,
  ].filter((name) => names.includes(name));
  for (const name of cleanupOrder) {
    await assertTransactionManifestState(state, transactionBinding);
    const path = transactionFilePath(transactionBinding, name);
    const maximum = name === TRANSACTION_MANIFEST || name.includes("manifest")
      ? MAX_MANIFEST_BYTES
      : MAX_ARCHIVE_BYTES;
    const label = `release transaction file ${name}`;
    const status = name === TRANSACTION_MANIFEST
      ? state.manifestStatus
      : knownStatuses.get(name) ?? (await readStableRegularPath(path, maximum, label)).status;
    if (status === undefined) throw new Error(`${label} has no trusted binding`);
    await unlinkExact(path, status, maximum, label, transactionBinding);
  }
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  if ((await readdir(transactionBinding.path)).length !== 0) {
    throw new Error("release transaction directory changed before cleanup");
  }
  await assertDirectoryBinding(distBinding, "release dist directory");
  await rmdir(transactionBinding.path);
  await syncDirectory(distBinding.path);
  await assertAbsent(transactionBinding.path, "release transaction directory");
}

async function removeInstalledCandidate({
  path,
  bytes,
  status,
  maximum,
  label,
  distBinding,
}) {
  if (!status) return;
  await verifyExactFile(path, bytes, maximum, label, { expectedStatus: status, requiredMode: 0o644 });
  await unlinkExact(path, status, maximum, label, distBinding);
}

async function restoreBackup({
  targetPath,
  backupPath,
  previous,
  backedUp,
  maximum,
  label,
  distBinding,
  transactionBinding,
}) {
  if (!backedUp) {
    if (previous.exists) {
      await verifyExactFile(targetPath, previous.bytes, maximum, label, {
        expectedStatus: previous.status,
        requiredMode: modeBits(previous.status),
      });
    } else {
      await assertAbsent(targetPath, label);
    }
    return;
  }
  await assertAbsent(targetPath, label);
  await verifyExactFile(backupPath, previous.bytes, maximum, `${label} backup`, {
    expectedStatus: previous.status,
    requiredMode: modeBits(previous.status),
  });
  await assertDirectoryBinding(distBinding, "release dist directory");
  await assertDirectoryBinding(transactionBinding, "release transaction directory");
  await assertAbsent(targetPath, label);
  await assertRegularPathBinding(backupPath, previous.status, `${label} backup`, maximum);
  await rename(backupPath, targetPath);
  await syncDirectory(distBinding.path);
  await syncDirectory(transactionBinding.path);
  previous.status = await verifyRenamedExactFile(
    targetPath,
    previous.bytes,
    maximum,
    label,
    previous.status,
    modeBits(previous.status),
  );
}

async function rollbackTransaction(context) {
  const {
    transaction,
    transactionBinding,
    distBinding,
    zipPath,
    manifestPath,
    stagedZipPath,
    stagedManifestPath,
    backupZipPath,
    backupManifestPath,
    previousZip,
    previousManifest,
    result,
    state,
  } = context;
  try {
    await assertTransactionManifestState(state, transactionBinding);
    await removeInstalledCandidate({
      path: manifestPath,
      bytes: result.manifestBytes,
      status: state.installedManifestStatus,
      maximum: MAX_MANIFEST_BYTES,
      label: "release manifest",
      distBinding,
    });
    await assertTransactionManifestState(state, transactionBinding);
    await removeInstalledCandidate({
      path: zipPath,
      bytes: result.zipBytes,
      status: state.installedZipStatus,
      maximum: MAX_ARCHIVE_BYTES,
      label: "release ZIP",
      distBinding,
    });
    await assertTransactionManifestState(state, transactionBinding);
    await restoreBackup({
      targetPath: zipPath,
      backupPath: backupZipPath,
      previous: previousZip,
      backedUp: state.zipBackedUp,
      maximum: MAX_ARCHIVE_BYTES,
      label: "release ZIP",
      distBinding,
      transactionBinding,
    });
    await assertTransactionManifestState(state, transactionBinding);
    await restoreBackup({
      targetPath: manifestPath,
      backupPath: backupManifestPath,
      previous: previousManifest,
      backedUp: state.manifestBackedUp,
      maximum: MAX_MANIFEST_BYTES,
      label: "release manifest",
      distBinding,
      transactionBinding,
    });

    const knownStatuses = new Map();
    if (!state.installedZipStatus && !(await pathDoesNotExist(stagedZipPath))) {
      knownStatuses.set(transaction.files.stagedZip, state.stagedZipStatus);
    }
    if (!state.installedManifestStatus && !(await pathDoesNotExist(stagedManifestPath))) {
      knownStatuses.set(transaction.files.stagedManifest, state.stagedManifestStatus);
    }
    await cleanupTransaction(transaction, transactionBinding, distBinding, state, knownStatuses);
  } catch (rollbackError) {
    throw new Error(
      `release transaction rollback is uncertain; evidence retained at ${RELEASE_TRANSACTION_DIR}: ${
        rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure"
      }`,
      { cause: rollbackError },
    );
  }
}

async function ensureDistDirectory(repositoryBinding) {
  const distPath = join(REPOSITORY_ROOT, "dist");
  try {
    const binding = await bindCanonicalDirectory(distPath, "release dist directory", { timestamps: false });
    if (binding.status.dev !== repositoryBinding.status.dev) {
      throw new Error("release dist directory is on an unexpected device");
    }
    return binding;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await assertDirectoryBinding(repositoryBinding, "repository root");
  await mkdir(distPath, { mode: 0o755 });
  await syncDirectory(REPOSITORY_ROOT);
  const binding = await bindCanonicalDirectory(distPath, "release dist directory", { timestamps: false });
  if (binding.status.dev !== repositoryBinding.status.dev) {
    throw new Error("release dist directory is on an unexpected device");
  }
  return binding;
}

export async function writeReleaseCandidate({
  skillRoot = `skills/${SKILL_NAME}`,
  outputDirectory = "dist",
  version = RELEASE_VERSION,
  onCheckpoint,
} = {}) {
  if (version !== RELEASE_VERSION) throw new Error(`release version must be exactly ${RELEASE_VERSION}`);
  if (onCheckpoint !== undefined && typeof onCheckpoint !== "function") {
    throw new Error("release checkpoint hook must be a function");
  }
  const requestedOutput = isAbsolute(outputDirectory)
    ? resolve(outputDirectory)
    : resolve(REPOSITORY_ROOT, outputDirectory);
  const expectedOutput = join(REPOSITORY_ROOT, "dist");
  if (requestedOutput !== expectedOutput) {
    throw new Error("release output is fixed to the repository dist directory");
  }

  const writerContract = await assertRepositoryContract();
  try {
  const result = await buildReleaseCandidateWithContract({ skillRoot, version }, writerContract);
  await assertRepositoryContractUnchanged(writerContract);
  const repositoryBinding = writerContract.repository;
  await assertRepositoryContractUnchanged(writerContract);
  const distBinding = await ensureDistDirectory(repositoryBinding);
  const zipPath = join(distBinding.path, RELEASE_ZIP_NAME);
  const manifestPath = join(distBinding.path, RELEASE_MANIFEST_NAME);
  const transactionPath = join(distBinding.path, ".release-txn");
  if (!(await pathDoesNotExist(transactionPath))) {
    throw new Error(`orphaned release transaction at ${RELEASE_TRANSACTION_DIR}; manual investigation required`);
  }

  const previousZip = await readOptionalTarget(zipPath, MAX_ARCHIVE_BYTES, "release ZIP", distBinding);
  const previousManifest = await readOptionalTarget(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "release manifest",
    distBinding,
  );
  if (
    previousZip.exists
    && previousManifest.exists
    && modeBits(previousZip.status) === 0o644
    && modeBits(previousManifest.status) === 0o644
    && previousZip.bytes.equals(result.zipBytes)
    && previousManifest.bytes.equals(result.manifestBytes)
  ) {
    await verifyExactFile(zipPath, result.zipBytes, MAX_ARCHIVE_BYTES, "release ZIP", {
      expectedStatus: previousZip.status,
      requiredMode: 0o644,
    });
    await verifyExactFile(manifestPath, result.manifestBytes, MAX_MANIFEST_BYTES, "release manifest", {
      expectedStatus: previousManifest.status,
      requiredMode: 0o644,
    });
    await assertRepositoryContractUnchanged(writerContract);
    return { ...result, zipPath, manifestPath };
  }

  await assertRepositoryContractUnchanged(writerContract);
  const transactionBinding = await createTransactionDirectory(distBinding, transactionPath);
  const transaction = {
    format: TRANSACTION_FORMAT,
    version: RELEASE_VERSION,
    phase: "preparing",
    candidate: {
      zip: { byteLength: result.zipBytes.byteLength, digest: releaseSha256(result.zipBytes) },
      manifest: { byteLength: result.manifestBytes.byteLength, digest: releaseSha256(result.manifestBytes) },
    },
    previous: {
      zip: describePrevious(previousZip),
      manifest: describePrevious(previousManifest),
    },
    files: {
      stagedZip: randomTransactionName("staged-zip"),
      stagedManifest: randomTransactionName("staged-manifest"),
      backupZip: randomTransactionName("backup-zip"),
      backupManifest: randomTransactionName("backup-manifest"),
    },
  };
  const stagedZipPath = transactionFilePath(transactionBinding, transaction.files.stagedZip);
  const stagedManifestPath = transactionFilePath(transactionBinding, transaction.files.stagedManifest);
  const backupZipPath = transactionFilePath(transactionBinding, transaction.files.backupZip);
  const backupManifestPath = transactionFilePath(transactionBinding, transaction.files.backupManifest);
  const state = {
    manifestStatus: undefined,
    manifestBytes: undefined,
    evidenceUncertain: false,
    stagedZipStatus: undefined,
    stagedManifestStatus: undefined,
    zipBackedUp: false,
    manifestBackedUp: false,
    installedZipStatus: undefined,
    installedManifestStatus: undefined,
    committed: false,
  };
  const context = {
    transaction,
    transactionBinding,
    distBinding,
    zipPath,
    manifestPath,
    stagedZipPath,
    stagedManifestPath,
    backupZipPath,
    backupManifestPath,
    previousZip,
    previousManifest,
    result,
    state,
  };

  try {
    await assertRepositoryContractUnchanged(writerContract);
    await writeTransactionManifest(transaction, transactionBinding, state);
    await assertDirectoryBinding(transactionBinding, "release transaction directory");
    state.stagedZipStatus = await createExclusiveFile(
      stagedZipPath,
      result.zipBytes,
      0o644,
      MAX_ARCHIVE_BYTES,
      "staged release ZIP",
    );
    await assertDirectoryBinding(transactionBinding, "release transaction directory");
    state.stagedManifestStatus = await createExclusiveFile(
      stagedManifestPath,
      result.manifestBytes,
      0o644,
      MAX_MANIFEST_BYTES,
      "staged release manifest",
    );
    await syncDirectory(transactionBinding.path);
    await recordCheckpoint(transaction, "staged", transactionBinding, state, onCheckpoint);

    await assertRepositoryContractUnchanged(writerContract);
    await assertTransactionManifestState(state, transactionBinding);
    state.zipBackedUp = await backupTarget({
      targetPath: zipPath,
      backupPath: backupZipPath,
      previous: previousZip,
      maximum: MAX_ARCHIVE_BYTES,
      label: "release ZIP",
      distBinding,
      transactionBinding,
    });
    await recordCheckpoint(transaction, "backed-up-zip", transactionBinding, state, onCheckpoint);

    await assertRepositoryContractUnchanged(writerContract);
    await assertTransactionManifestState(state, transactionBinding);
    state.manifestBackedUp = await backupTarget({
      targetPath: manifestPath,
      backupPath: backupManifestPath,
      previous: previousManifest,
      maximum: MAX_MANIFEST_BYTES,
      label: "release manifest",
      distBinding,
      transactionBinding,
    });
    await recordCheckpoint(transaction, "backed-up-manifest", transactionBinding, state, onCheckpoint);

    await assertRepositoryContractUnchanged(writerContract);
    await assertTransactionManifestState(state, transactionBinding);
    state.installedZipStatus = await installTarget({
      stagedPath: stagedZipPath,
      targetPath: zipPath,
      bytes: result.zipBytes,
      stagedStatus: state.stagedZipStatus,
      maximum: MAX_ARCHIVE_BYTES,
      label: "release ZIP",
      distBinding,
      transactionBinding,
    });
    await recordCheckpoint(transaction, "installed-zip", transactionBinding, state, onCheckpoint);

    await assertRepositoryContractUnchanged(writerContract);
    await assertTransactionManifestState(state, transactionBinding);
    state.installedManifestStatus = await installTarget({
      stagedPath: stagedManifestPath,
      targetPath: manifestPath,
      bytes: result.manifestBytes,
      stagedStatus: state.stagedManifestStatus,
      maximum: MAX_MANIFEST_BYTES,
      label: "release manifest",
      distBinding,
      transactionBinding,
    });
    await recordCheckpoint(transaction, "installed-manifest", transactionBinding, state, onCheckpoint);

    await assertRepositoryContractUnchanged(writerContract);
    await verifyExactFile(zipPath, result.zipBytes, MAX_ARCHIVE_BYTES, "release ZIP", {
      expectedStatus: state.installedZipStatus,
      requiredMode: 0o644,
    });
    await verifyExactFile(manifestPath, result.manifestBytes, MAX_MANIFEST_BYTES, "release manifest", {
      expectedStatus: state.installedManifestStatus,
      requiredMode: 0o644,
    });
    await recordCheckpoint(transaction, "verified", transactionBinding, state, onCheckpoint);
    await assertRepositoryContractUnchanged(writerContract);
    await recordCheckpoint(transaction, "before-cleanup", transactionBinding, state, onCheckpoint);
    await assertRepositoryContractUnchanged(writerContract);
    transaction.phase = "committed";
    await writeTransactionManifest(transaction, transactionBinding, state);
    state.committed = true;
    await cleanupTransaction(transaction, transactionBinding, distBinding, state);

    await verifyExactFile(zipPath, result.zipBytes, MAX_ARCHIVE_BYTES, "release ZIP", {
      expectedStatus: state.installedZipStatus,
      requiredMode: 0o644,
    });
    await verifyExactFile(manifestPath, result.manifestBytes, MAX_MANIFEST_BYTES, "release manifest", {
      expectedStatus: state.installedManifestStatus,
      requiredMode: 0o644,
    });
    await assertRepositoryContractUnchanged(writerContract);
    return { ...result, zipPath, manifestPath };
  } catch (error) {
    if (state.evidenceUncertain) {
      throw new Error(
        `release transaction evidence changed unexpectedly; no automatic rollback or cleanup was attempted; `
        + `evidence retained at ${RELEASE_TRANSACTION_DIR}`,
        { cause: error },
      );
    }
    if (state.committed) {
      throw new Error(
        `release candidate pair was durably committed but transaction cleanup or final verification failed; `
        + `${await pathDoesNotExist(transactionPath) ? "transaction evidence was already cleaned" : `evidence retained at ${RELEASE_TRANSACTION_DIR}`}`,
        { cause: error },
      );
    }
    try {
      await assertTransactionManifestState(state, transactionBinding);
      await rollbackTransaction(context);
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : "release transaction failed"}; ${
          rollbackError instanceof Error ? rollbackError.message : "rollback failed"
        }`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
  } finally {
    await writerContract.packageOpened.handle.close();
  }
}

function parseArguments(arguments_) {
  let version;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--version" && index + 1 < arguments_.length) {
      version = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`usage: release-build.mjs --version ${RELEASE_VERSION}`);
    }
  }
  if (version !== RELEASE_VERSION) throw new Error(`release version must be exactly ${RELEASE_VERSION}`);
  return { version };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await writeReleaseCandidate(options);
  console.log(JSON.stringify({
    status: "ok",
    version: RELEASE_VERSION,
    archive: RELEASE_ZIP_PATH,
    manifest: RELEASE_MANIFEST_PATH,
    entryCount: result.entries.length,
    byteLength: result.zipBytes.byteLength,
    digest: result.manifest.archive.digest,
  }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "release build failed");
    process.exitCode = 3;
  });
}
