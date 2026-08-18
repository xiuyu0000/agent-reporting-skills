import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import {
  RELEASE_MANIFEST_PATH,
  RELEASE_VERSION,
  RELEASE_ZIP_PATH,
  SKILL_FILES,
  SKILL_NAME,
  parseDeterministicZip,
  releaseSha256,
} from "./release-build.mjs";

const LEGACY_CONTRACT = ["dual-audience", "report-contract", "v1"].join("-");
const LEGACY_RECEIPT = ["dual-audience", "delivery-receipt", "v1"].join("-");
const LEGACY_HUMAN_SUFFIX = ["_HUMAN", ".html"].join("");
const HISTORICAL_UNPROMOTED_ARCHIVE = [
  "deliver-dual-audience-report-v0.1.1",
  ".zip",
].join("");
const ROLLBACK_ARCHIVE = ["deliver-dual-audience-report-v0.1.0", ".zip"].join("");
const ROLLBACK_DIGEST = [
  "3f7f22465c26b8eb88776ce5dcd5c786",
  "3c0763cb855464a463b0b7f5fa4f855b",
].join("");
const LEGACY_FILENAMES = Object.freeze([
  ["init", "delivery.py"].join("_"),
  ["validate", "delivery.py"].join("_"),
  ["record", "usage.py"].join("_"),
  ["report-contract", ".json"].join(""),
  ["report-contract", ".schema.json"].join(""),
  ["delivery-receipt", ".json"].join(""),
  ["delivery-receipt", ".md"].join(""),
  ["agent-report", ".template.md"].join(""),
  ["human-report", ".template.html"].join(""),
]);

const README_PATH = "README.md";
// Tracked planning records describe the retired v0.1 implementation and the exact
// migration away from it, so their legacy narrative is historical evidence rather
// than a current public promise. The boundary is an explicit path list, never a
// `docs/` prefix: every other tracked document stays fully scanned.
export const PLANNING_RECORD_PATHS = Object.freeze([
  "docs/design.md",
  "docs/spec.md",
  "docs/task.md",
]);
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md`;
const PROTOCOLS_PATH = `skills/${SKILL_NAME}/references/review-protocols.md`;
const INSTALLED_CLI_PATH = `skills/${SKILL_NAME}/scripts/review-delivery.mjs`;
const SOURCE_PREDICATE_PATH = "src/cli/validate/text.ts";
const SCANNER_PATH = "tools/scan-legacy-surface.mjs";
const HISTORICAL_ARCHIVE_PATH = `dist/${HISTORICAL_UNPROMOTED_ARCHIVE}`;
const README_MIGRATION_HEADING = "## Breaking migration and v0.1.0 rollback";
const README_NEXT_HEADING = "## Privacy";
const REQUIRED_WORKTREE_SURFACES = Object.freeze([
  ".github/workflows/validate.yml",
  README_PATH,
  "tools/release-build.mjs",
  SCANNER_PATH,
  "tools/verify-dist.mjs",
]);

const SOURCE_REJECTION_FUNCTION = [
  "export function isLegacyStaticContract(value: unknown): boolean {",
  "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) return false;",
  "  const record = value as Record<string, unknown>;",
  `  return record.schema_version === "${LEGACY_CONTRACT}"`,
  `    || record.format === "${LEGACY_CONTRACT}";`,
  "}",
].join("\n");
const SKILL_REJECTION_CONTEXT = [
  `Reject \`${LEGACY_CONTRACT}\` as incompatible input. Do not infer a`,
  "new approval contract from it and do not produce a seemingly valid workbench.",
].join("\n");
const PROTOCOL_REJECTION_CONTEXT = [
  `Reject \`${LEGACY_CONTRACT}\` as an incompatible interface. Do not`,
  "guess a migration to `review-document/1`.",
].join("\n");
const README_CONTRACT_CONTEXT = [
  `v0.2 is intentionally incompatible with \`${LEGACY_CONTRACT}\` and`,
  "does not silently convert that contract.",
].join("\n");
const README_SUFFIX_CONTEXT = [
  `The old static \`*${LEGACY_HUMAN_SUFFIX}\` output is`,
  "not an Approval workspace",
].join("\n");
const README_ROLLBACK_CONTEXT = [
  `asset \`${ROLLBACK_ARCHIVE}\`. Its expected SHA-256 is`,
  `\`${ROLLBACK_DIGEST}\`.`,
].join("\n");

const RETIRED_PROMISE_PATTERNS = Object.freeze([
  {
    label: "obsolete Python runtime claim",
    pattern: new RegExp("\\bPython standard[- ]library\\b", "iu"),
  },
  {
    label: "retired Python CLI invocation",
    pattern: new RegExp("\\bpython(?:3)?\\s+[^\\n]*(?:review-delivery|delivery)\\.(?:py|mjs)\\b", "iu"),
  },
  {
    label: "retired static report promise",
    pattern: new RegExp("\\bstatic (?:human|narrative) report\\b", "iu"),
  },
  {
    label: "obsolete optional-artifact claim",
    pattern: new RegExp(`\\b${["artifact", "waiver"].join(" ")}\\b`, "iu"),
  },
  {
    label: "retired waiver field",
    pattern: new RegExp(`\\b${["waiver", "reason"].join("_")}\\b`, "u"),
  },
  {
    label: "obsolete one-output success claim",
    pattern: new RegExp("\\bsingle[- ]artifact (?:success|delivery)\\b", "iu"),
  },
  {
    label: "retired claim marker",
    pattern: new RegExp(`\\b${["claim", "[CD]-[0-9]{3}", "[a-f0-9]{64}"].join(":")}\\b`, "iu"),
  },
  {
    label: "retired decision marker",
    pattern: new RegExp(`\\b${["decision", "[CD]-[0-9]{3}", "[a-f0-9]{64}"].join(":")}\\b`, "iu"),
  },
  {
    label: "retired HTML claim or decision attribute",
    pattern: new RegExp(`\\bdata-(?:${["claim", "decision"].join("|")})-(?:id|sha256)\\b`, "iu"),
  },
]);

function occurrences(text, needle) {
  const hits = [];
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    hits.push(index);
    cursor = index + needle.length;
  }
  return hits;
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodePublicText(bytes, path) {
  assert(!bytes.includes(0), `${path}: active public surface is binary`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path}: active public surface is not strict UTF-8`);
  }
}

function assertSingleExactContext(path, text, context, expectedHits) {
  const contextHits = occurrences(text, context);
  const markerHits = occurrences(text, LEGACY_CONTRACT);
  assert(contextHits.length === 1, `${path}: legacy rejection context moved or drifted`);
  assert(
    markerHits.length === expectedHits,
    `${path}: legacy contract hit count drifted (${markerHits.length}/${expectedHits})`,
  );
  const start = contextHits[0];
  const end = start + context.length;
  assert(
    markerHits.every((offset) => offset >= start && offset < end),
    `${path}: legacy contract escaped its exact rejection context`,
  );
  return markerHits.map((offset) => ({
    path,
    line: lineForOffset(text, offset),
    kind: "incompatible-input-rejection",
  }));
}

function assertReadmeMigrationContext(path, text) {
  const starts = occurrences(text, README_MIGRATION_HEADING);
  const ends = occurrences(text, README_NEXT_HEADING);
  assert(starts.length === 1 && ends.length === 1 && ends[0] > starts[0], `${path}: migration section boundary drifted`);
  const start = starts[0];
  const end = ends[0];
  const section = text.slice(start, end);
  const required = [
    [README_CONTRACT_CONTEXT, "breaking contract migration"],
    [README_SUFFIX_CONTEXT, "retired output migration"],
    [README_ROLLBACK_CONTEXT, "v0.1.0 rollback"],
  ];
  for (const [context, label] of required) {
    assert(occurrences(section, context).length === 1, `${path}: exact ${label} context drifted`);
  }
  const boundedTerms = [LEGACY_CONTRACT, LEGACY_HUMAN_SUFFIX, ROLLBACK_ARCHIVE, ROLLBACK_DIGEST];
  for (const term of boundedTerms) {
    const allHits = occurrences(text, term);
    assert(allHits.length === 1, `${path}: migration term hit count drifted for ${term}`);
    assert(allHits[0] >= start && allHits[0] < end, `${path}: migration term escaped the bounded section`);
  }
  return [LEGACY_CONTRACT, LEGACY_HUMAN_SUFFIX].map((term) => {
    const offset = text.indexOf(term);
    return {
      path,
      line: lineForOffset(text, offset),
      kind: term === LEGACY_CONTRACT ? "breaking-contract-migration" : "retired-output-migration",
    };
  });
}

function generatedRejectionPattern() {
  const identifier = "([A-Za-z_$][A-Za-z0-9_$]*)";
  const marker = escapeRegExp(LEGACY_CONTRACT);
  return new RegExp(
    [
      `function ${identifier}\\(${identifier}\\)\\{`,
      `if\\(typeof \\2!="object"\\|\\|\\2===null\\|\\|Array\\.isArray\\(\\2\\)\\)return!1;`,
      `let ${identifier}=\\2;`,
      `return \\3\\.schema_version==="${marker}"\\|\\|\\3\\.format==="${marker}"`,
      "\\}",
    ].join(""),
    "gu",
  );
}

function assertGeneratedRejectionContext(path, text) {
  const markerHits = occurrences(text, LEGACY_CONTRACT);
  const matches = [...text.matchAll(generatedRejectionPattern())];
  assert(matches.length === 1, `${path}: minified legacy rejection predicate moved or drifted`);
  assert(markerHits.length === 2, `${path}: generated legacy marker count drifted (${markerHits.length}/2)`);
  const start = matches[0].index ?? -1;
  const end = start + matches[0][0].length;
  assert(
    markerHits.every((offset) => offset >= start && offset < end),
    `${path}: generated legacy marker escaped the exact minified predicate`,
  );
  return markerHits.map((offset) => ({
    path,
    line: lineForOffset(text, offset),
    kind: "generated-incompatible-input-rejection",
  }));
}

function assertKnownLegacyContexts(logicalPath, displayPath, text) {
  if (logicalPath === README_PATH) return assertReadmeMigrationContext(displayPath, text);
  if (logicalPath === SKILL_PATH) {
    return assertSingleExactContext(displayPath, text, SKILL_REJECTION_CONTEXT, 1);
  }
  if (logicalPath === PROTOCOLS_PATH) {
    return assertSingleExactContext(displayPath, text, PROTOCOL_REJECTION_CONTEXT, 1);
  }
  if (logicalPath === SOURCE_PREDICATE_PATH) {
    return assertSingleExactContext(displayPath, text, SOURCE_REJECTION_FUNCTION, 2);
  }
  if (logicalPath === INSTALLED_CLI_PATH) {
    return assertGeneratedRejectionContext(displayPath, text);
  }
  const markerHits = occurrences(text, LEGACY_CONTRACT);
  assert(markerHits.length === 0, `${displayPath}: legacy contract escaped an exact rejection or migration context`);
  const suffixHits = occurrences(text, LEGACY_HUMAN_SUFFIX);
  assert(suffixHits.length === 0, `${displayPath}: retired human artifact suffix escaped README migration`);
  return [];
}

export function scanLogicalText(logicalPath, text, displayPath = logicalPath) {
  const allowedHits = assertKnownLegacyContexts(logicalPath, displayPath, text);
  for (const filename of LEGACY_FILENAMES) {
    assert(!logicalPath.includes(filename), `${displayPath}: retired filename remains in an active path`);
    assert(!text.includes(filename), `${displayPath}: retired filename remains on an active public surface`);
  }
  assert(!logicalPath.includes(HISTORICAL_UNPROMOTED_ARCHIVE), `${displayPath}: unpromoted archive became a current path`);
  assert(
    !text.includes(HISTORICAL_UNPROMOTED_ARCHIVE),
    `${displayPath}: unpromoted historical archive is referenced by a current surface`,
  );
  assert(!text.includes(LEGACY_RECEIPT), `${displayPath}: retired receipt protocol remains on a current surface`);
  for (const { label, pattern } of RETIRED_PROMISE_PATTERNS) {
    assert(!pattern.test(text), `${displayPath}: ${label}`);
  }
  return allowedHits;
}

export function trackedCurrentFiles() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...REQUIRED_WORKTREE_SURFACES])].sort();
}

export function isHistoricalTestPath(path) {
  return path === "tests" || path.startsWith("tests/");
}

export function isPlanningRecordPath(path) {
  return PLANNING_RECORD_PATHS.includes(path);
}

export async function scanRepositorySurfaces() {
  const allowedHits = [];
  const scanned = [];
  const tracked = trackedCurrentFiles();
  for (const path of PLANNING_RECORD_PATHS) {
    assert(tracked.includes(path), `planning record boundary covers an untracked path: ${path}`);
  }
  for (const path of tracked) {
    if (
      isHistoricalTestPath(path)
      || isPlanningRecordPath(path)
      || path === HISTORICAL_ARCHIVE_PATH
      || path === RELEASE_ZIP_PATH
      || path === RELEASE_MANIFEST_PATH
    ) continue;
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    const text = decodePublicText(bytes, path);
    allowedHits.push(...scanLogicalText(path, text));
    scanned.push(path);
  }
  return { allowedHits, scanned };
}

function assertManifestBinding(manifest, zipBytes, entries) {
  assert(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest), "release manifest root drifted");
  assert(manifest.version === RELEASE_VERSION, "release manifest version drifted");
  assert(manifest.skill === SKILL_NAME, "release manifest Skill drifted");
  assert(manifest.archive?.path === RELEASE_ZIP_PATH, "release manifest archive path drifted");
  assert(manifest.archive?.digest === releaseSha256(zipBytes), "release manifest archive digest drifted");
  assert(manifest.archive?.entryCount === SKILL_FILES.length, "release manifest entry count drifted");
  assert(Array.isArray(manifest.files) && manifest.files.length === entries.length, "release manifest inventory drifted");
  for (let index = 0; index < entries.length; index += 1) {
    const declared = manifest.files[index];
    const actual = entries[index];
    assert(declared?.path === actual.path, `release manifest path drifted at ${index}`);
    assert(declared?.byteLength === actual.byteLength, `release manifest byte length drifted at ${index}`);
    assert(declared?.digest === actual.digest, `release manifest digest drifted at ${index}`);
  }
}

async function scanReleaseArtifacts() {
  const [manifestBytes, zipBytes] = await Promise.all([
    readFile(RELEASE_MANIFEST_PATH),
    readFile(RELEASE_ZIP_PATH),
  ]);
  const manifestText = decodePublicText(manifestBytes, RELEASE_MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error(`${RELEASE_MANIFEST_PATH}: release manifest is not JSON`);
  }
  const entries = parseDeterministicZip(zipBytes);
  assertManifestBinding(manifest, zipBytes, entries);
  const allowedHits = scanLogicalText(RELEASE_MANIFEST_PATH, manifestText);
  const scanned = [RELEASE_MANIFEST_PATH, RELEASE_ZIP_PATH];
  for (const entry of entries) {
    const logicalPath = `skills/${entry.path}`;
    const expectedLogicalPath = `skills/${SKILL_NAME}/${entry.relativePath}`;
    assert(logicalPath === expectedLogicalPath, `release ZIP path is not the current Skill: ${entry.path}`);
    const sourceBytes = await readFile(expectedLogicalPath);
    assert(sourceBytes.equals(entry.bytes), `release ZIP content drifted from ${expectedLogicalPath}`);
    const displayPath = `${RELEASE_ZIP_PATH}!/${entry.path}`;
    const text = decodePublicText(entry.bytes, displayPath);
    allowedHits.push(...scanLogicalText(expectedLogicalPath, text, displayPath));
    scanned.push(displayPath);
  }
  return { allowedHits, scanned };
}

function expectSelfTestRejection(label, action) {
  let rejected = false;
  try {
    action();
  } catch {
    rejected = true;
  }
  assert(rejected, `scanner self-test accepted ${label}`);
}

export function runSelfTests() {
  const readme = [
    README_MIGRATION_HEADING,
    "",
    README_CONTRACT_CONTEXT,
    README_SUFFIX_CONTEXT,
    README_ROLLBACK_CONTEXT,
    "",
    README_NEXT_HEADING,
  ].join("\n");
  const skill = SKILL_REJECTION_CONTEXT;
  const protocols = PROTOCOL_REJECTION_CONTEXT;
  const generated = `function nn(e){if(typeof e!="object"||e===null||Array.isArray(e))return!1;let r=e;return r.schema_version==="${LEGACY_CONTRACT}"||r.format==="${LEGACY_CONTRACT}"}`;
  scanLogicalText(README_PATH, readme);
  scanLogicalText(SKILL_PATH, skill);
  scanLogicalText(PROTOCOLS_PATH, protocols);
  scanLogicalText(SOURCE_PREDICATE_PATH, SOURCE_REJECTION_FUNCTION);
  scanLogicalText(INSTALLED_CLI_PATH, generated);
  expectSelfTestRejection("a README marker outside its bounded section", () =>
    scanLogicalText(README_PATH, `${readme}\n${LEGACY_CONTRACT}`));
  expectSelfTestRejection("an added Skill marker", () =>
    scanLogicalText(SKILL_PATH, `${skill}\n${LEGACY_CONTRACT}`));
  expectSelfTestRejection("a moved source predicate", () =>
    scanLogicalText(SOURCE_PREDICATE_PATH, SOURCE_REJECTION_FUNCTION.replace("  const record", "  let moved = true;\n  const record")));
  expectSelfTestRejection("a moved generated predicate", () =>
    scanLogicalText(INSTALLED_CLI_PATH, generated.replace("let r=e;return", "let r=e;r=e;return")));
  expectSelfTestRejection("a generated marker added elsewhere", () =>
    scanLogicalText(INSTALLED_CLI_PATH, `${generated};"${LEGACY_CONTRACT}"`));
  expectSelfTestRejection("scanner-path laundering", () =>
    scanLogicalText(SCANNER_PATH, `negative evidence: ${LEGACY_CONTRACT}`));
  expectSelfTestRejection("a hostile retired filename in added context", () =>
    scanLogicalText("README-extra.md", `run ${LEGACY_FILENAMES[0]}`));
  assert(isHistoricalTestPath("tests/unit/historical.test.ts"), "scanner self-test lost the historical test boundary");
  for (const path of PLANNING_RECORD_PATHS) {
    assert(isPlanningRecordPath(path), `scanner self-test lost the planning record boundary for ${path}`);
  }
  for (const path of [
    "docs/README.md",
    "docs/claude-code-handoff.md",
    "docs/spec.md.bak",
    "docs/archive/spec.md",
    "spec.md",
  ]) {
    assert(!isPlanningRecordPath(path), `scanner self-test widened the planning record boundary to ${path}`);
  }
  expectSelfTestRejection("a legacy marker in a document outside the planning record boundary", () =>
    scanLogicalText("docs/claude-code-handoff.md", `carrier: ${LEGACY_CONTRACT}`));
  expectSelfTestRejection("a retired artifact suffix in a document outside the planning record boundary", () =>
    scanLogicalText("docs/README.md", `output ${LEGACY_HUMAN_SUFFIX}`));
}

async function main() {
  const arguments_ = process.argv.slice(2);
  assert(
    arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--self-test"),
    "usage: scan-legacy-surface.mjs [--self-test]",
  );
  runSelfTests();
  if (arguments_[0] === "--self-test") {
    console.log(JSON.stringify({ status: "ok", selfTest: true }));
    return;
  }
  const release = await scanReleaseArtifacts();
  const repository = await scanRepositorySurfaces();
  console.log(JSON.stringify({
    status: "ok",
    currentSurfaceFiles: repository.scanned.length,
    releaseSurfaceFiles: release.scanned.length,
    historicalTestsExcluded: true,
    planningRecordsExcluded: [...PLANNING_RECORD_PATHS],
    historicalArchive: HISTORICAL_ARCHIVE_PATH,
    allowedLegacyHits: [...repository.allowedHits, ...release.allowedHits],
  }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "legacy surface scan failed");
    process.exitCode = 3;
  });
}
