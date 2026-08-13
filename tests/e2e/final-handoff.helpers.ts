import { spawnSync } from "node:child_process";
import { chmod, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { expect } from "vitest";
import { sha256Bytes, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import type { DeliveryHandoff } from "../../src/cli/validate.js";

const CLI = resolve("skills/deliver-dual-audience-report/scripts/review-delivery.mjs");
export const UNCERTAINTY_KEYS = [
  "evidenceGaps",
  "unresolvedNonblockingConflicts",
  "risks",
  "openQuestions",
] as const;

export type UncertaintyKey = (typeof UNCERTAINTY_KEYS)[number];

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function runDistributed(arguments_: readonly string[], cwd: string): Record<string, unknown> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [CLI, ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(child.stdout.endsWith("\n")).toBe(true);
  expect(child.stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

function configureUncertainties(
  document: ReviewDocumentV1,
  categories: readonly UncertaintyKey[],
): void {
  document.continuation.evidenceGaps = categories.includes("evidenceGaps")
    ? ["Confirm the release owner.", "Verify the migration date."]
    : [];
  document.evidence.conflicts = categories.includes("unresolvedNonblockingConflicts")
    ? [{
        severity: "nonblocking",
        status: "unresolved",
        description: "Two noncritical source timestamps differ.",
        itemRefs: ["C-001"],
      }]
    : [];
  document.evidence.risks = categories.includes("risks")
    ? ["A timing dependency remains.", "Adoption could lag the rollout."]
    : [];
  document.evidence.openQuestions = categories.includes("openQuestions")
    ? ["Which release window applies?", "Who owns the follow-up review?"]
    : [];
}

export async function prepareValidatedFixture(
  root: string,
  label: string,
  categories: readonly UncertaintyKey[],
): Promise<{ root: string; document: ReviewDocumentV1; handoff: DeliveryHandoff }> {
  const document = JSON.parse(await readFile(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
  document.delivery.baseName = `final_${label}`;
  document.delivery.outputs = {
    agent: `final_${label}_AGENT.md`,
    approval: `final_${label}_APPROVAL.html`,
  };
  configureUncertainties(document, categories);
  const contract = join(root, "review-document.json");
  await writePrivate(contract, `${JSON.stringify(document)}\n`);
  expect(runDistributed(["render", "--document", contract], root)).toMatchObject({
    status: "ok",
    phase: "render",
    mutated: true,
  });
  const validated = runDistributed(["validate", "delivery", "--document", contract], root);
  expect(validated).toMatchObject({ status: "ok", phase: "validate", mode: "delivery", mutated: false });
  return { root, document, handoff: validated.handoff as DeliveryHandoff };
}

export function syntheticReplyFixture(root: string, handoff: DeliveryHandoff): string {
  const lines = [
    "Synthetic final-reply verifier fixture (not fresh-Agent evidence).",
    "",
    `Document: \`${handoff.documentId}\``,
    `Content version: \`${handoff.contentVersion}\``,
    `Round: \`${handoff.round}\``,
    `As of: \`${handoff.asOf}\``,
    "",
    `[Agent continuation file](${join(root, handoff.artifacts.agent.relativePath)})`,
    `[Approval decision workspace](${join(root, handoff.artifacts.approval.relativePath)})`,
  ];
  for (const key of UNCERTAINTY_KEYS) {
    const uncertainty = handoff.uncertainties[key];
    if (uncertainty.count === 0) continue;
    lines.push("", `${key} (${uncertainty.count})`);
    for (const summary of uncertainty.safeSummaries) lines.push(`Summary: ${summary}`);
  }
  return `${lines.join("\n")}\n`;
}

function exactlyOnce(text: string, token: string, message: string): void {
  if (text.split(token).length !== 2) throw new Error(message);
}

function semanticLines(
  lines: readonly string[],
  pattern: RegExp,
): Array<{ index: number; line: string }> {
  return lines.flatMap((line, index) => pattern.test(line) ? [{ index, line }] : []);
}

function identitySegments(reply: string): ReadonlyMap<string, string> {
  const labelPattern = /(?:^|[—;,]\s*)\s*(?:[-*+]\s*)?(Document(?:\s+ID)?(?=\s*(?::|=|`|RD-))|Content[ -]?version(?=\s*(?::|=|`|\d))|Round(?=\s*(?::|=|`|\d))|As[ -]?of(?=\s*(?::|=|`|\d)))\b/gimu;
  const matches = [...reply.matchAll(labelPattern)];
  const expectedLabels = ["document", "content-version", "round", "as-of"] as const;
  const segments = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const labelText = match[1]!;
    const label = labelText.toLowerCase().replace(/\s+id$/u, "").replace(/[ -]/gu, "-");
    if (!expectedLabels.includes(label as (typeof expectedLabels)[number]) || segments.has(label)) {
      throw new Error("final reply identity is missing, duplicated, or ambiguous");
    }
    const start = match.index! + match[0]!.lastIndexOf(labelText) + labelText.length;
    const nextLabel = matches[index + 1]?.index ?? reply.length;
    const nextLine = reply.indexOf("\n", start);
    const end = nextLine === -1 ? nextLabel : Math.min(nextLabel, nextLine);
    segments.set(label, reply.slice(start, end));
  }
  if (segments.size !== expectedLabels.length) {
    throw new Error("final reply identity is missing, duplicated, or ambiguous");
  }
  return segments;
}

function exactSingleToken(
  segment: string,
  pattern: RegExp,
  expected: string,
  message: string,
): void {
  const tokens = segment.match(pattern) ?? [];
  if (tokens.length !== 1 || tokens[0] !== expected) throw new Error(message);
}

async function accessibleArtifact(root: string, target: string, expectedRelativePath: string): Promise<string> {
  if (!target.startsWith("/")) throw new Error("link target is not absolute");
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("link target is not a regular file");
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("link target escapes output root");
  }
  if (relative(canonicalRoot, canonicalTarget) !== expectedRelativePath) {
    throw new Error("link target differs from current handoff");
  }
  return readFile(canonicalTarget, "utf8");
}

export async function verifyFinalReplyFixture(
  reply: string,
  root: string,
  handoff: DeliveryHandoff,
): Promise<void> {
  if (/https?:\/\//u.test(reply)) throw new Error("bare or remote URL found");
  const linkTokens = reply.match(/\]\(/gu) ?? [];
  const links = [...reply.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/gu)]
    .map((match) => ({ label: match[1], target: match[2] }));
  if (links.length !== 2 || linkTokens.length !== 2) {
    throw new Error("final reply must contain exactly two links");
  }
  if (!links[0]?.label?.toLowerCase().includes("agent")
    || !links[1]?.label?.toLowerCase().includes("approval")) {
    throw new Error("final reply links must identify Agent then Approval semantics");
  }

  const lines = reply.split(/\r?\n/u);
  const identity = identitySegments(reply);
  exactSingleToken(
    identity.get("document") ?? "",
    /RD-[0-9A-F]{20}/gu,
    handoff.documentId,
    "Document is missing, duplicated, or stale",
  );
  exactSingleToken(
    identity.get("content-version") ?? "",
    /\b\d+\b/gu,
    String(handoff.contentVersion),
    "Content version is missing, duplicated, or stale",
  );
  exactSingleToken(
    identity.get("round") ?? "",
    /\b\d+\b/gu,
    String(handoff.round),
    "Round is missing, duplicated, or stale",
  );
  exactSingleToken(
    identity.get("as-of") ?? "",
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu,
    handoff.asOf,
    "As of is missing, duplicated, or stale",
  );

  const agent = await accessibleArtifact(root, links[0].target!, handoff.artifacts.agent.relativePath);
  const approval = await accessibleArtifact(root, links[1].target!, handoff.artifacts.approval.relativePath);
  const agentBytes = Uint8Array.from(await readFile(links[0].target!));
  const approvalBytes = Uint8Array.from(await readFile(links[1].target!));
  if (sha256Bytes(agentBytes) !== handoff.artifacts.agent.byteDigest
    || sha256Bytes(approvalBytes) !== handoff.artifacts.approval.byteDigest) {
    throw new Error("artifact bytes differ from current handoff");
  }
  for (const marker of [
    `<!-- dar-document-id: ${handoff.documentId} -->`,
    `<!-- dar-content-version: ${handoff.contentVersion} -->`,
    `<!-- dar-round: ${handoff.round} -->`,
    `<!-- dar-review-digest: ${handoff.reviewDigest} -->`,
    `- As of: <code>${handoff.asOf}</code>`,
  ]) exactlyOnce(agent, marker, "Agent identity marker is missing or stale");
  for (const meta of [
    ["dar-document-id", handoff.documentId],
    ["dar-content-version", String(handoff.contentVersion)],
    ["dar-round", String(handoff.round)],
    ["dar-review-digest", handoff.reviewDigest],
  ] as const) exactlyOnce(approval, `<meta name="${meta[0]}" content="${meta[1]}">`, "Approval meta is missing or stale");

  const categoryLineIndexes = new Set<number>();
  const categoryDeclarationPattern = new RegExp(
    `^\\s*(?:[-*+]\\s*)?\`?(?:${UNCERTAINTY_KEYS.join("|")})\\b`,
    "iu",
  );
  const categoryDeclarationLines = lines.filter((line) => categoryDeclarationPattern.test(line));
  for (const key of UNCERTAINTY_KEYS) {
    const uncertainty = handoff.uncertainties[key];
    if (uncertainty.count !== uncertainty.safeSummaries.length) throw new Error("invalid handoff uncertainty count");
    const categoryLines = semanticLines(
      lines,
      new RegExp(`^\\s*(?:[-*+]\\s*)?\`?${key}\\b\`?`, "iu"),
    );
    const categoryOccurrences = categoryDeclarationLines.flatMap((line) =>
      [...line.matchAll(new RegExp(`\\b${key}\\b`, "giu"))]);
    if (uncertainty.count === 0) {
      if (categoryOccurrences.length !== 0) throw new Error("empty uncertainty category was disclosed");
      continue;
    }
    if (categoryOccurrences.length !== 1
      || categoryLines.length !== 1
      || categoryLineIndexes.has(categoryLines[0]!.index)) {
      throw new Error(`${key} count is missing, duplicated, stale, or merged`);
    }
    const countSegment = categoryLines[0]!.line.replace(
      new RegExp(`^\\s*(?:[-*+]\\s*)?\`?${key}\\b\`?\\s*(?:[-—:=()]\\s*)*`, "iu"),
      "",
    );
    const countMatch = /^(\d+)\b(.*)$/u.exec(countSegment);
    if (countMatch === null || countMatch[1] !== String(uncertainty.count)) {
      throw new Error(`${key} count is missing, duplicated, stale, or merged`);
    }
    let countRemainder = countMatch[2]!.trimStart();
    if (countRemainder.startsWith(")")) countRemainder = countRemainder.slice(1).trimStart();
    if (/^[:\-–—]/u.test(countRemainder)) countRemainder = countRemainder.slice(1).trimStart();
    if (countRemainder !== ""
      && !uncertainty.safeSummaries.some((summary) => countRemainder.startsWith(summary))) {
      throw new Error(`${key} count is missing, duplicated, stale, or merged`);
    }
    categoryLineIndexes.add(categoryLines[0]!.index);
    for (const summary of uncertainty.safeSummaries) {
      exactlyOnce(reply, summary, `${key} safe summary is missing or duplicated`);
    }
  }
}
