import {
  reviewDigest,
  type ContentNode,
  type InlineNode,
  type ReviewDocumentV1,
} from "../protocol/index.js";
import {
  encodeAgentMarkdownHeadingText,
  parseAgentArtifact,
  validateDeliverableDocument,
} from "../cli/validate.js";
import { generatorError, generatorFailure, generatorSuccess } from "./errors.js";
import { containsDraftDecisionSlot } from "./draft.js";
import { GENERATOR_VERSION, type GeneratorResult } from "./types.js";

const encoder = new TextEncoder();

function entity(character: string): string {
  return `&#${character.codePointAt(0) ?? 0};`;
}

/**
 * Render untrusted text as one Markdown paragraph token. Newlines and Markdown
 * control characters use numeric entities so data cannot create structure.
 */
function escapeMarkdownText(value: string): string {
  let output = "";
  for (const character of value) {
    if (/^[A-Za-z0-9 \p{Letter}\p{Number}]$/u.test(character)) output += character;
    else output += entity(character);
  }
  return output;
}

function safeCodeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function anchorForFragment(fragment: string): string {
  return `#${fragment.slice(1).toLowerCase()}`;
}

function renderInline(node: InlineNode): string {
  switch (node.type) {
    case "text":
      return escapeMarkdownText(node.text);
    case "strong":
      return `**${escapeMarkdownText(node.text)}**`;
    case "emphasis":
      return `_${escapeMarkdownText(node.text)}_`;
    case "inlineCode":
      return `<code>${safeCodeText(node.text)}</code>`;
    case "link": {
      const href = node.href.startsWith("#")
        ? anchorForFragment(node.href)
        : new URL(node.href).href.replaceAll(">", "%3E");
      return `[${escapeMarkdownText(node.text)}](<${href}>)`;
    }
    case "termRef":
      return `[${escapeMarkdownText(node.text ?? node.glossaryId)}](#glossary-${node.glossaryId.toLowerCase()})`;
  }
}

function renderInlineList(nodes: readonly InlineNode[]): string {
  return nodes.map(renderInline).join("");
}

function indentedCode(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  return lines.map((line) => `    ${line}`);
}

function renderSimpleContent(node: Extract<ContentNode, { type: "paragraph" | "list" | "code" }>): string[] {
  if (node.type === "paragraph") return [renderInlineList(node.content)];
  if (node.type === "code") return indentedCode(node.text);
  return node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : "-"} ${renderInlineList(item)}`);
}

function tableCell(nodes: readonly InlineNode[]): string {
  return renderInlineList(nodes).replaceAll("|", "&#124;");
}

function renderContentNode(node: ContentNode): string[] {
  switch (node.type) {
    case "paragraph":
      return [renderInlineList(node.content)];
    case "list":
      return node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : "-"} ${renderInlineList(item)}`);
    case "table":
      return [
        `| ${node.headers.map(tableCell).join(" | ")} |`,
        `| ${node.headers.map(() => "---").join(" | ")} |`,
        ...node.rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`),
      ];
    case "code":
      return indentedCode(node.text);
    case "callout": {
      const heading = node.title === undefined
        ? `**${node.tone.toUpperCase()}**`
        : `**${node.tone.toUpperCase()} ${escapeMarkdownText(node.title)}**`;
      const lines = [heading, "", ...node.content.flatMap((item, index) => [
        ...(index === 0 ? [] : [""]),
        ...renderSimpleContent(item),
      ])];
      return lines.map((line) => line.length === 0 ? ">" : `> ${line}`);
    }
    case "steps":
      return node.items.flatMap((item, index) => {
        // `indentedCode` emits its text verbatim and relies solely on indentation
        // to make it inert. Directly after the step title, with no blank line,
        // those lines are lazy paragraph continuation instead of a code block, so
        // untrusted code text would be parsed as Markdown. A leading code entry
        // therefore gets the same blank separator `callout` already emits.
        const body = item.content.flatMap((entry, entryIndex) => [
          ...(entryIndex === 0 && entry.type !== "code" ? [] : [""]),
          ...renderSimpleContent(entry),
        ]);
        return [
          `${index + 1}. **${escapeMarkdownText(item.title)}**`,
          ...body.map((line) => line.length === 0 ? "   " : `   ${line}`),
        ];
      });
    case "flow":
      return [
        `**${escapeMarkdownText(node.title)}** — ${escapeMarkdownText(node.description)}`,
        ...node.nodes.map((item) => `- ${escapeMarkdownText(item.id)}: ${escapeMarkdownText(item.label)}`),
        ...node.edges.map((edge) => {
          const label = edge.label === undefined ? "" : ` (${escapeMarkdownText(edge.label)})`;
          return `- ${escapeMarkdownText(edge.from)} → ${escapeMarkdownText(edge.to)}${label}`;
        }),
      ];
  }
}

function renderContent(nodes: readonly ContentNode[]): string[] {
  if (nodes.length === 0) return ["_None._"];
  return nodes.flatMap((node, index) => [
    ...(index === 0 ? [] : [""]),
    ...renderContentNode(node),
  ]);
}

function list(values: readonly string[]): string[] {
  return values.length === 0
    ? ["_None._"]
    : values.map((value) => `- ${escapeMarkdownText(value)}`);
}

function stableIds(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `\`${safeCodeText(value)}\``).join(", ");
}

function sourceHierarchy(document: ReviewDocumentV1): string[] {
  if (document.evidence.sourceHierarchy.length === 0) return ["_None._"];
  return document.evidence.sourceHierarchy.flatMap((source) => {
    const expires = source.freshness.kind === "time-sensitive"
      ? `; expires ${escapeMarkdownText(source.freshness.expiresAt)}`
      : "";
    return [
      `#### evidence-source-${source.id}`,
      "",
      `- **${escapeMarkdownText(source.id)} — ${escapeMarkdownText(source.label)}**`,
      `- Rank: ${source.rank}`,
      `- Reference: ${escapeMarkdownText(source.reference)}`,
      `- Freshness: ${escapeMarkdownText(source.freshness.kind)}; checked ${escapeMarkdownText(source.freshness.checkedAt)}${expires}`,
    ];
  });
}

function sharedItems(
  kind: "fact" | "decision",
  items: readonly ReviewDocumentV1["evidence"]["facts"][number][],
): string[] {
  if (items.length === 0) return ["_None._"];
  return items.flatMap((item) => [
    `#### evidence-${kind}-${item.id}`,
    "",
    `- Identity: \`${safeCodeText(item.id)}\``,
    `- Confidence: ${escapeMarkdownText(item.confidence)}`,
    `- Sources: ${stableIds(item.sourceRefs)}`,
    "",
    ...renderContent(item.content),
  ]);
}

function conflicts(document: ReviewDocumentV1): string[] {
  if (document.evidence.conflicts.length === 0) return ["_None._"];
  return document.evidence.conflicts.flatMap((conflict) => [
    `- **${escapeMarkdownText(conflict.severity)} / ${escapeMarkdownText(conflict.status)}** — ${escapeMarkdownText(conflict.description)}`,
    `  - Items: ${stableIds(conflict.itemRefs)}`,
    ...(conflict.resolution === undefined
      ? []
      : [`  - Resolution: ${escapeMarkdownText(conflict.resolution)}`]),
  ]);
}

function decisionBlocks(document: ReviewDocumentV1): string[] {
  const frozen = new Set(document.approvals.currentFrozen);
  return document.blocks.flatMap((block) => {
    const approvals = document.approvals.history
      .filter((record) => record.blockId === block.id)
      .map((record) => record.approvedRound);
    const latestRound = approvals.length === 0 ? undefined : Math.max(...approvals);
    return [
      `#### block-${block.id}`,
      "",
      `**${escapeMarkdownText(block.id)} — ${escapeMarkdownText(block.title)}**`,
      "",
      `- Tier: \`${block.tier}\``,
      `- Summary: ${escapeMarkdownText(block.summary)}`,
      `- State: ${frozen.has(block.id) ? `frozen at round ${latestRound ?? "unknown"}` : "active"}`,
      `- Dependencies: ${stableIds(block.dependencies)}`,
      `- Claim references: ${stableIds(block.claimRefs)}`,
      `- Decision references: ${stableIds(block.decisionRefs)}`,
      ...(block.tier === "T2"
        ? [
            `- Why user judgment is required: ${escapeMarkdownText(block.whyTier)}`,
            `- Question for the reviewer: ${escapeMarkdownText(block.ask)}`,
          ]
        : []),
      ...(block.changed === undefined
        ? []
        : [`- Changed in round ${block.changed.round}: ${escapeMarkdownText(block.changed.summary)}`]),
      "",
      ...renderContent(block.body),
    ];
  });
}

function approvalState(document: ReviewDocumentV1): string[] {
  const frozen = new Set(document.approvals.currentFrozen);
  const active = document.blocks.filter((block) => !frozen.has(block.id)).map((block) => block.id);
  return [
    `- Current frozen blocks: ${stableIds(document.approvals.currentFrozen)}`,
    `- Current active blocks: ${stableIds(active)}`,
    ...(document.approvals.history.length === 0
      ? ["- Approval history: none"]
      : document.approvals.history.map((record) =>
          `- ${safeCodeText(record.blockId)} approved in round ${record.approvedRound} with ${safeCodeText(record.approvedContentDigest)}`)),
  ];
}

function lineage(document: ReviewDocumentV1): string[] {
  const value = document.lineage;
  return [
    `- Previous review digest: ${value.previousReviewDigest === null ? "none" : `\`${value.previousReviewDigest}\``}`,
    `- ID high-water: block=${value.idHighWater.block}, source=${value.idHighWater.source}, fact=${value.idHighWater.fact}, decision=${value.idHighWater.decision}, glossary=${value.idHighWater.glossary}, note=${value.idHighWater.note}, topic=${value.idHighWater.topic}`,
    `- Consumed packets: ${value.consumedPackets.length}`,
    ...value.consumedPackets.map((item) => `  - \`${item.packetId}\` — \`${item.semanticDigest}\``),
    `- Topic mappings: ${value.topicMappings.length}`,
    ...value.topicMappings.map((item) =>
      `  - \`${item.topicId}\` → \`${item.derivedDocumentId}\` / \`${item.derivedDeliveryId}\``),
    `- Impact assessments: ${value.impactAssessments.length}`,
    ...value.impactAssessments.map((item) =>
      `  - \`${item.upstreamBlockId}\`, round ${item.changedAtRound}, affected ${stableIds(item.affectedDownstreamIds)}, conservative=${String(item.usedConservativeClosure)} — ${escapeMarkdownText(item.reason)}`),
    `- Feedback resolutions: ${value.feedbackResolutions.length}`,
    ...value.feedbackResolutions.map((item) =>
      `  - \`${item.sourcePacketId}\` / \`${item.feedbackId}\` / \`${item.feedbackDigest}\` → ${item.disposition}${item.disposition === "converted-to-block" ? ` \`${item.targetBlockId}\`` : ""} — ${escapeMarkdownText(item.reason)}`),
  ];
}

function nextActions(document: ReviewDocumentV1): string[] {
  if (document.continuation.nextActions.length === 0) return ["_None._"];
  return document.continuation.nextActions.map((action) => {
    const owner = action.owner === undefined ? "" : `; owner: ${escapeMarkdownText(action.owner)}`;
    return `- \`${action.id}\` — ${escapeMarkdownText(action.action)}${owner}; verification: ${escapeMarkdownText(action.verification)}`;
  });
}

function glossary(document: ReviewDocumentV1): string[] {
  if (document.glossary.length === 0) return ["_None._"];
  return document.glossary.flatMap((entry) => [
    `#### glossary-${entry.id}`,
    "",
    `- **${escapeMarkdownText(entry.term)}** (\`${entry.id}\`): ${escapeMarkdownText(entry.definition)}`,
  ]);
}

function renderAgentMarkdown(
  document: ReviewDocumentV1,
  generatorVersion: string,
  encodedTitle: string,
): string {
  const lines = [
    "<!-- dar-artifact: review-agent-markdown/1 -->",
    `<!-- dar-generator-version: ${generatorVersion} -->`,
    `<!-- dar-delivery-id: ${document.delivery.id} -->`,
    `<!-- dar-document-id: ${document.document.id} -->`,
    `<!-- dar-content-version: ${document.document.contentVersion} -->`,
    `<!-- dar-round: ${document.document.round} -->`,
    `<!-- dar-review-digest: ${reviewDigest(document)} -->`,
    "",
    `# ${encodedTitle} — Agent Continuation`,
    "",
    "> This document is an evidence synthesis, not a source of truth. Recheck time-sensitive facts against the source hierarchy before continuing.",
    "",
    "## Document identity",
    "",
    `- Document: \`${document.document.id}\``,
    `- Delivery: \`${document.delivery.id}\``,
    `- Content version: ${document.document.contentVersion}`,
    `- Approval round: ${document.document.round}`,
    `- Status: ${document.document.status}`,
    `- Content language: ${escapeMarkdownText(document.document.language)}`,
    `- As of: <code>${safeCodeText(document.document.asOf)}</code>`,
    `- Summary: ${escapeMarkdownText(document.document.summary)}`,
    "",
    "## Objective and boundaries",
    "",
    "### Objective",
    "",
    escapeMarkdownText(document.continuation.objective),
    "",
    "### In scope",
    "",
    ...list(document.continuation.scope),
    "",
    "### Excluded",
    "",
    ...list(document.continuation.exclusions),
    "",
    "## Source hierarchy",
    "",
    ...sourceHierarchy(document),
    "",
    "## Current state",
    "",
    ...renderContent(document.continuation.currentState),
    "",
    "## Shared evidence",
    "",
    "### Facts",
    "",
    ...sharedItems("fact", document.evidence.facts),
    "",
    "### Existing decisions",
    "",
    ...sharedItems("decision", document.evidence.decisions),
    "",
    "### Constraints",
    "",
    ...list(document.evidence.constraints),
    "",
    "### Risks",
    "",
    ...list(document.evidence.risks),
    "",
    "### Open questions and evidence gaps",
    "",
    ...list([...document.evidence.openQuestions, ...document.continuation.evidenceGaps]),
    "",
    "### Source conflicts",
    "",
    ...conflicts(document),
    "",
    "## Decision blocks",
    "",
    ...decisionBlocks(document),
    "",
    "## Approval history and lineage",
    "",
    "### Current frozen and active sets",
    "",
    ...approvalState(document),
    "",
    "### Consumed packets, topics, impacts, and feedback resolutions",
    "",
    ...lineage(document),
    "",
    "## Next actions",
    "",
    ...nextActions(document),
    "",
    "## Validation evidence",
    "",
    ...list(document.continuation.validationEvidence),
    "",
    "## Glossary",
    "",
    ...glossary(document),
    "",
  ];
  return lines.join("\n");
}

export function generateAgentMarkdown(
  input: unknown,
  generatorVersion: string,
): GeneratorResult<string> {
  try {
    if (generatorVersion !== GENERATOR_VERSION) {
      return generatorFailure([generatorError("ARGUMENT_INVALID", "/generatorVersion")]);
    }
    const validated = validateDeliverableDocument(input);
    if (!validated.ok) return generatorFailure(validated.errors);
    if (containsDraftDecisionSlot(validated.value)) {
      return generatorFailure([generatorError("DOCUMENT_NOT_REVIEWABLE", "/document/blocks")]);
    }
    const encodedTitle = encodeAgentMarkdownHeadingText(validated.value.document.title);
    if (!encodedTitle.ok) return generatorFailure(encodedTitle.errors);
    const value = renderAgentMarkdown(validated.value, generatorVersion, encodedTitle.value);
    const parsed = parseAgentArtifact(encoder.encode(value), validated.value, generatorVersion);
    return parsed.ok ? generatorSuccess(value) : generatorFailure(parsed.errors);
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/agent")]);
  }
}

export function generateAgentMarkdownBytes(
  input: unknown,
  generatorVersion: string,
): GeneratorResult<Uint8Array> {
  try {
    const generated = generateAgentMarkdown(input, generatorVersion);
    return generated.ok ? generatorSuccess(encoder.encode(generated.value)) : generated;
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/agent")]);
  }
}
