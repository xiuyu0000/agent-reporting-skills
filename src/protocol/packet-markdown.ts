import { canonicalJsonLine, canonicalReviewPacket } from "./canonical.js";
import { failure, protocolError, success, type ProtocolResult } from "./errors.js";
import { validateReviewDocument, validateReviewPacket } from "./invariants.js";
import type { ReviewDocumentV1, ReviewPacketV1 } from "./types.generated.js";

const ACTION_ORDER = ["EDIT", "HOLD", "TOPIC", "PASS"] as const;
const OPEN_FENCE = "````json review-packet/1";
const CLOSE_FENCE = "````";

function readable(value: string): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("|", "\\|");
}

function renderValidatedMarkdown(packet: ReviewPacketV1, document: ReviewDocumentV1): string {
  const lines = [
    `# Review packet: ${readable(packet.doc.title)}`,
    "",
    `- Document: \`${packet.doc.id}\``,
    `- Content version: ${packet.doc.contentVersion}`,
    `- Review round: ${packet.doc.round}`,
    `- Reviewed at: ${packet.reviewedAt}`,
    `- Progress: ${packet.progress.decided}/${packet.progress.total}`,
    `- Partial: ${packet.progress.partial ? "yes" : "no"}`,
    "",
    "## Next-agent rules",
    "",
    "- PASS freezes only the referenced block at its approved content digest.",
    "- EDIT changes only the touched block; HOLD is answered before work continues.",
    "- TOPIC creates a separate proposal and does not approve its source block.",
    "- Blocks absent from this packet remain unchanged and are never default-approved.",
  ];

  for (const action of ACTION_ORDER) {
    lines.push("", `## ${action}`, "");
    const decisions = packet.decisions.filter((decision) => decision.action === action);
    if (decisions.length === 0) {
      lines.push("- None");
      continue;
    }
    for (const decision of decisions) {
      const block = document.blocks.find((item) => item.id === decision.blockId);
      lines.push(`- \`${decision.blockId}\` ${readable(block?.title ?? "")}`);
      if (decision.quote !== undefined) lines.push(`  - Quote: ${readable(decision.quote)}`);
      if (decision.action === "EDIT" || decision.action === "HOLD") {
        lines.push(`  - Note: ${readable(decision.note)}`);
      }
      if (decision.action === "TOPIC") lines.push(`  - Topic: \`${decision.topicId}\``);
    }
  }

  lines.push("", "## Topics", "");
  if (packet.topics.length === 0) lines.push("- None");
  for (const topic of packet.topics) {
    const source = topic.sourceBlockId === undefined ? "global" : `source ${topic.sourceBlockId}`;
    lines.push(`- \`${topic.id}\` (${source}): ${readable(topic.title)}`);
    if (topic.note !== undefined) lines.push(`  - Note: ${readable(topic.note)}`);
  }

  lines.push("", "## Side notes", "");
  if (packet.sideNotes.length === 0) lines.push("- None");
  for (const note of packet.sideNotes) {
    lines.push(`- \`${note.id}\` on \`${note.blockId}\`: ${readable(note.note)}`);
  }

  lines.push(
    "",
    "## Frozen and reopened",
    "",
    `- Frozen carried: ${packet.frozenCarried.length === 0 ? "None" : packet.frozenCarried.map((id) => `\`${id}\``).join(", ")}`,
    `- Reopened: ${packet.reopened.length === 0 ? "None" : packet.reopened.map((id) => `\`${id}\``).join(", ")}`,
    "",
    "## Overall",
    "",
    packet.overall === undefined ? "None" : readable(packet.overall),
    "",
    "## Statistics",
    "",
    `- PASS: ${packet.stats.PASS}`,
    `- EDIT: ${packet.stats.EDIT}`,
    `- TOPIC: ${packet.stats.TOPIC}`,
    `- HOLD: ${packet.stats.HOLD}`,
    "",
    OPEN_FENCE,
    canonicalJsonLine(canonicalReviewPacket(packet)).trimEnd(),
    CLOSE_FENCE,
    "",
  );
  return lines.join("\n");
}

export function serializeReviewPacketJson(
  packet: ReviewPacketV1,
  document: ReviewDocumentV1,
): ProtocolResult<string> {
  const validatedDocument = validateReviewDocument(document);
  if (!validatedDocument.ok) return validatedDocument;
  const validated = validateReviewPacket(packet, validatedDocument.value);
  return validated.ok
    ? success(canonicalJsonLine(canonicalReviewPacket(validated.value)))
    : validated;
}

export function serializeReviewPacketMarkdown(
  packet: ReviewPacketV1,
  document: ReviewDocumentV1,
): ProtocolResult<string> {
  const validatedDocument = validateReviewDocument(document);
  if (!validatedDocument.ok) return validatedDocument;
  const validatedPacket = validateReviewPacket(packet, validatedDocument.value);
  if (!validatedPacket.ok) return validatedPacket;
  return success(renderValidatedMarkdown(validatedPacket.value, validatedDocument.value));
}

interface PayloadFence {
  start: number;
  end: number;
  payload: string;
}

function findPayloadFences(markdown: string): PayloadFence[] {
  const lines = markdown.split("\n");
  const fences: PayloadFence[] = [];
  const opener = /^ {0,3}`{4}json review-packet\/1[ \t]*$/;
  const closer = /^ {0,3}`{4}[ \t]*$/;
  for (let index = 0; index < lines.length; index += 1) {
    if (!opener.test(lines[index] ?? "")) continue;
    const start = index;
    const payload: string[] = [];
    index += 1;
    while (index < lines.length && !closer.test(lines[index] ?? "")) {
      payload.push(lines[index] ?? "");
      index += 1;
    }
    if (index >= lines.length) return [];
    fences.push({ start, end: index, payload: payload.join("\n") });
  }
  return fences;
}

export function parseReviewPacketMarkdown(
  markdown: string,
  document: ReviewDocumentV1,
): ProtocolResult<ReviewPacketV1> {
  const validatedDocument = validateReviewDocument(document);
  if (!validatedDocument.ok) return validatedDocument;
  if (typeof markdown !== "string") {
    return failure([protocolError("MARKDOWN_CONTAINER_INVALID", "")]);
  }
  if (markdown.includes("\r")) {
    return failure([protocolError("MARKDOWN_CONTAINER_INVALID", "")]);
  }
  const fences = findPayloadFences(markdown);
  if (fences.length !== 1 || fences[0]?.payload.split("\n").length !== 1) {
    return failure([protocolError("MARKDOWN_CONTAINER_INVALID", "")]);
  }
  let input: unknown;
  try {
    input = JSON.parse(fences[0].payload);
  } catch {
    return failure([protocolError("MARKDOWN_CONTAINER_INVALID", "")]);
  }
  const packet = validateReviewPacket(input, validatedDocument.value);
  if (!packet.ok) return packet;
  const expected = renderValidatedMarkdown(packet.value, validatedDocument.value);
  if (markdown !== expected) {
    return failure([protocolError("MARKDOWN_SUMMARY_MISMATCH", "")]);
  }
  return success(packet.value);
}
