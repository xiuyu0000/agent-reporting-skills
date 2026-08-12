import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  canonicalReviewDocument,
  reviewDigest,
  type ReviewDocumentV1,
} from "../../../src/protocol/index.js";

export const GENERATOR_VERSION = "0.2.0";

const encoder = new TextEncoder();

export function reviewDocumentFixture(): ReviewDocumentV1 {
  return JSON.parse(readFileSync(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

export function validAgentText(
  document: ReviewDocumentV1,
  generatorVersion = GENERATOR_VERSION,
): string {
  return [
    "<!-- dar-artifact: review-agent-markdown/1 -->",
    `<!-- dar-generator-version: ${generatorVersion} -->`,
    `<!-- dar-delivery-id: ${document.delivery.id} -->`,
    `<!-- dar-document-id: ${document.document.id} -->`,
    `<!-- dar-content-version: ${document.document.contentVersion} -->`,
    `<!-- dar-round: ${document.document.round} -->`,
    `<!-- dar-review-digest: ${reviewDigest(document)} -->`,
    "",
    `# ${document.document.title} — Agent Continuation`,
    "",
    "## Document identity",
    "",
    `Snapshot ${document.document.id}; [objective](#objective).`,
    "",
    "## Objective and boundaries",
    "",
    "### Objective",
    "",
    "Continue from the reviewed objective.",
    "",
    "### In scope",
    "",
    "Use the current review document.",
    "",
    "### Excluded",
    "",
    "Do not execute approved work automatically.",
    "",
    "## Source hierarchy",
    "",
    "Recheck time-sensitive sources before continuation.",
    "",
    "## Current state",
    "",
    "The document is ready for review.",
    "",
    "## Shared evidence",
    "",
    "### Facts",
    "",
    "Facts remain bound to their source references.",
    "",
    "### Existing decisions",
    "",
    "No additional machine decision is inferred here.",
    "",
    "### Constraints",
    "",
    "Preserve the protocol boundary.",
    "",
    "### Risks",
    "",
    "Review the listed risks.",
    "",
    "### Open questions and evidence gaps",
    "",
    "Resolve open questions before unsupported execution.",
    "",
    "### Source conflicts",
    "",
    "No blocking conflict remains.",
    "",
    "## Decision blocks",
    "",
    "Review every active decision block.",
    "",
    "## Approval history and lineage",
    "",
    "### Current frozen and active sets",
    "",
    "Use the immutable approval ledger.",
    "",
    "### Consumed packets, topics, impacts, and feedback resolutions",
    "",
    "Use the lineage records as the machine authority.",
    "",
    "## Next actions",
    "",
    "Prepare any semantic revision outside validate.",
    "",
    "## Validation evidence",
    "",
    "The snapshot is validated before handoff.",
    "",
    "## Glossary",
    "",
    "See the canonical document glossary.",
    "",
  ].join("\n");
}

export function validAgentBytes(
  document: ReviewDocumentV1,
  generatorVersion = GENERATOR_VERSION,
): Uint8Array {
  return encoder.encode(validAgentText(document, generatorVersion));
}

export function approvalTemplateText(): string {
  const source = readFileSync(
    resolve("skills/deliver-dual-audience-report/assets/review-workbench.template.html"),
    "utf8",
  );
  if (source.includes('<meta name="dar-artifact" content="review-approval-html/1">')) return source;
  return source.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="dar-artifact" content="review-approval-html/1">',
  );
}

export function approvalTemplateBytes(): Uint8Array {
  return encoder.encode(approvalTemplateText());
}

export function validApprovalText(
  document: ReviewDocumentV1,
  generatorVersion = GENERATOR_VERSION,
  template = approvalTemplateText(),
): string {
  return template
    .replace("@@DAR_GENERATOR_VERSION@@", generatorVersion)
    .replace("@@DAR_DOCUMENT_ID@@", document.document.id)
    .replace("@@DAR_CONTENT_VERSION@@", String(document.document.contentVersion))
    .replace("@@DAR_ROUND@@", String(document.document.round))
    .replace("@@DAR_REVIEW_DIGEST@@", reviewDigest(document))
    .replace(
      "@@DAR_DOCUMENT_BASE64@@",
      Buffer.from(canonicalJson(canonicalReviewDocument(document)), "utf8").toString("base64"),
    );
}

export function validApprovalBytes(
  document: ReviewDocumentV1,
  generatorVersion = GENERATOR_VERSION,
  template = approvalTemplateText(),
): Uint8Array {
  return encoder.encode(validApprovalText(document, generatorVersion, template));
}
