import {
  buildDependencyGraph,
  compareUnicodeCodePoints,
  validateReviewDocument,
  type ProtocolError,
  type ProtocolResult,
  type ReviewDecision,
  type ReviewDocumentV1,
} from "../index.js";
import { error, fail, prefixedErrors, snapshotRecord, succeed } from "./result.js";

export interface ExecutionEligibility {
  eligibleBlockIds: readonly string[];
  suspendedBlockIds: readonly string[];
}

export interface ExecutionEligibilityInput {
  document: ReviewDocumentV1;
  decisions?: readonly ReviewDecision[];
  reopened?: readonly string[];
}

const BLOCK_ID = /^B(?=0*[1-9])[0-9]{3,}$/;
const TOPIC_ID = /^TOP-(?=0*[1-9])[0-9]{3,}$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateDecisions(input: unknown): ProtocolResult<readonly ReviewDecision[]> {
  if (!Array.isArray(input)) return fail([error("SCHEMA_TYPE", "/decisions")]);
  const decisions: ReviewDecision[] = [];
  const errors: ProtocolError[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    const path = `/decisions/${index}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(error("SCHEMA_TYPE", path));
      continue;
    }
    const record = value as Record<string, unknown>;
    const action = record.action;
    const allowed = action === "PASS"
      ? new Set(["blockId", "action", "quote"])
      : action === "EDIT" || action === "HOLD"
        ? new Set(["blockId", "action", "note", "quote"])
        : action === "TOPIC"
          ? new Set(["blockId", "action", "topicId", "quote"])
          : new Set(["blockId", "action"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) errors.push(error("SCHEMA_ADDITIONAL_PROPERTIES", `${path}/${key}`));
    }
    if (!nonEmpty(record.blockId) || !BLOCK_ID.test(record.blockId)) {
      errors.push(error("SCHEMA_PATTERN", `${path}/blockId`));
    }
    if (!(["PASS", "EDIT", "TOPIC", "HOLD"] as unknown[]).includes(action)) {
      errors.push(error("SCHEMA_ENUM", `${path}/action`));
    }
    if ((action === "EDIT" || action === "HOLD") && !nonEmpty(record.note)) {
      errors.push(error("SCHEMA_MIN_LENGTH", `${path}/note`));
    }
    if (action === "TOPIC" && (!nonEmpty(record.topicId) || !TOPIC_ID.test(record.topicId))) {
      errors.push(error("SCHEMA_PATTERN", `${path}/topicId`));
    }
    if (Object.hasOwn(record, "quote") && !nonEmpty(record.quote)) {
      errors.push(error("SCHEMA_MIN_LENGTH", `${path}/quote`));
    }
    if (typeof record.blockId === "string") {
      if (seen.has(record.blockId)) {
        errors.push(error("DUPLICATE_DECISION", `${path}/blockId`, record.blockId));
      }
      seen.add(record.blockId);
    }
    if (errors.some((item) => item.path === path || item.path.startsWith(`${path}/`))) continue;
    decisions.push(record as unknown as ReviewDecision);
  }
  return errors.length === 0 ? succeed(decisions) : fail(errors);
}

function validateReopened(input: unknown): ProtocolResult<readonly string[]> {
  if (!Array.isArray(input)) return fail([error("SCHEMA_TYPE", "/reopened")]);
  const errors: ProtocolError[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    if (typeof value !== "string") {
      errors.push(error("SCHEMA_TYPE", `/reopened/${index}`));
    } else if (!BLOCK_ID.test(value)) {
      errors.push(error("SCHEMA_PATTERN", `/reopened/${index}`));
    } else if (seen.has(value)) {
      errors.push(error("SCHEMA_UNIQUE_ITEMS", `/reopened/${index}`, value));
    }
    if (typeof value === "string") seen.add(value);
  }
  return errors.length === 0 ? succeed([...seen]) : fail(errors);
}

export function deriveExecutionEligibility(
  input: ExecutionEligibilityInput,
): ProtocolResult<ExecutionEligibility> {
  const snapshot = snapshotRecord(input, "/input", ["document", "decisions", "reopened"], ["document"]);
  if (!snapshot.ok) return snapshot;
  const documentResult = validateReviewDocument(snapshot.value.document);
  if (!documentResult.ok) return fail(prefixedErrors(documentResult.errors, "/document"));
  const document = documentResult.value;
  const decisionsResult = validateDecisions(snapshot.value.decisions ?? []);
  if (!decisionsResult.ok) return decisionsResult;
  const reopenedResult = validateReopened(snapshot.value.reopened ?? []);
  if (!reopenedResult.ok) return reopenedResult;

  const errors: ProtocolError[] = [];
  const blockIds = new Set(document.blocks.map((block) => block.id));
  const frozen = new Set(document.approvals.currentFrozen);
  const reopened = new Set(reopenedResult.value);
  const decisions = new Map(decisionsResult.value.map((decision) => [decision.blockId, decision]));
  for (const [index, blockId] of reopenedResult.value.entries()) {
    if (!frozen.has(blockId)) errors.push(error("UNKNOWN_REFERENCE", `/reopened/${index}`, blockId));
  }
  for (const [index, decision] of decisionsResult.value.entries()) {
    if (!blockIds.has(decision.blockId)) {
      errors.push(error("UNKNOWN_REFERENCE", `/decisions/${index}/blockId`, decision.blockId));
    } else if (frozen.has(decision.blockId) && !reopened.has(decision.blockId)) {
      errors.push(error("DECISION_APPLICATION_INVALID", `/decisions/${index}/blockId`, decision.blockId));
    }
  }
  if (errors.length > 0) return fail(errors);

  const graph = buildDependencyGraph(document.blocks);
  if (!graph.ok) return graph;
  const ownApproval = new Map<string, boolean>();
  for (const block of document.blocks) {
    ownApproval.set(
      block.id,
      (frozen.has(block.id) && !reopened.has(block.id))
        || decisions.get(block.id)?.action === "PASS",
    );
  }
  const memo = new Map<string, boolean>();
  const isEligible = (blockId: string): boolean => {
    const cached = memo.get(blockId);
    if (cached !== undefined) return cached;
    if (!ownApproval.get(blockId)) {
      memo.set(blockId, false);
      return false;
    }
    const eligible = (graph.value.dependenciesByBlock.get(blockId) ?? []).every(isEligible);
    memo.set(blockId, eligible);
    return eligible;
  };
  const eligibleBlockIds = document.blocks
    .map((block) => block.id)
    .filter(isEligible)
    .sort(compareUnicodeCodePoints);
  const eligible = new Set(eligibleBlockIds);
  const suspendedBlockIds = document.blocks
    .map((block) => block.id)
    .filter((blockId) => !eligible.has(blockId))
    .sort(compareUnicodeCodePoints);
  return succeed({ eligibleBlockIds, suspendedBlockIds });
}
