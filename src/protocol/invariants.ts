import stringWidth from "string-width";
import { canonicalJson, canonicalReviewDocument, canonicalReviewPacket, canonicalReviewState } from "./canonical.js";
import {
  blockContentDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  reviewDigest,
  stateDigest,
  type Sha256Digest,
} from "./digest.js";
import {
  failure,
  protocolError,
  success,
  type ProtocolError,
  type ProtocolResult,
} from "./errors.js";
import { buildDependencyGraph } from "./graph.js";
import {
  validateDocumentContext,
  validateDocumentHighWater,
  validateOverlayHighWater,
  validatePacketIdentity,
  validateStateIdentity,
} from "./identity.js";
import {
  cloneSafeJson,
  validateReviewDocumentSchema,
  validateReviewPacketSchema,
  validateReviewStateSchema,
} from "./schema.js";
import type {
  ReviewDocumentSchema,
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";

function collectFailure<T>(result: ProtocolResult<T>, errors: ProtocolError[]): void {
  if (!result.ok) errors.push(...result.errors);
}

function addUnsafeInteger(
  value: number,
  path: string,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  if (!Number.isSafeInteger(value)) {
    errors.push(protocolError("SCHEMA_TYPE", path, blockId));
  }
}

function addDuplicateIds<T extends { id: string }>(
  items: readonly T[],
  path: string,
  errors: ProtocolError[],
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) errors.push(protocolError("DUPLICATE_ID", `${path}/${index}/id`));
    seen.add(item.id);
  }
}

function addCanonicalActionIds(
  items: readonly { id: string }[],
  path: string,
  errors: ProtocolError[],
): void {
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const match = /^ACT-(\d+)$/.exec(item.id);
    const number = match === null ? Number.NaN : Number(match[1]);
    const canonical = Number.isSafeInteger(number)
      ? `ACT-${String(number).padStart(3, "0")}`
      : "";
    if (item.id !== canonical || seen.has(number)) {
      errors.push(protocolError("DUPLICATE_ID", `${path}/${index}/id`));
    }
    seen.add(number);
  }
}

function addUnknownReferences(
  references: readonly string[],
  known: ReadonlySet<string>,
  path: string,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  for (const [index, reference] of references.entries()) {
    if (!known.has(reference)) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `${path}/${index}`, blockId));
    }
  }
}

function validateInlineNodes(
  nodes: readonly ReviewDocumentSchema.InlineNode[],
  path: string,
  glossaryIds: ReadonlySet<string>,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  for (const [index, node] of nodes.entries()) {
    if (node.type === "termRef" && !glossaryIds.has(node.glossaryId)) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `${path}/${index}/glossaryId`));
    }
    if (node.type === "link" && !isAllowedLinkHref(node.href)) {
      errors.push(protocolError("SCHEMA_FORMAT", `${path}/${index}/href`, blockId));
    }
  }
}

const INTERNAL_LINK_PATTERN = /^#[A-Za-z][A-Za-z0-9_.:-]*$/;

export function isAllowedLinkHref(href: string): boolean {
  if (href.startsWith("#")) return INTERNAL_LINK_PATTERN.test(href);
  if (href.startsWith("//")) return false;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function collectInlineLinkErrors(
  value: unknown,
  path: string,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    const node = asRecord(item);
    if (node?.type === "link" && typeof node.href === "string" && !isAllowedLinkHref(node.href)) {
      errors.push(protocolError("SCHEMA_FORMAT", `${path}/${index}/href`, blockId));
    }
  }
}

function collectContentLinkErrors(
  value: unknown,
  path: string,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    const node = asRecord(item);
    if (node === undefined) continue;
    const nodePath = `${path}/${index}`;
    if (node.type === "paragraph") {
      collectInlineLinkErrors(node.content, `${nodePath}/content`, errors, blockId);
    } else if (node.type === "list" && Array.isArray(node.items)) {
      for (const [itemIndex, listItem] of node.items.entries()) {
        collectInlineLinkErrors(listItem, `${nodePath}/items/${itemIndex}`, errors, blockId);
      }
    } else if (node.type === "table") {
      if (Array.isArray(node.headers)) {
        for (const [headerIndex, header] of node.headers.entries()) {
          collectInlineLinkErrors(
            header,
            `${nodePath}/headers/${headerIndex}`,
            errors,
            blockId,
          );
        }
      }
      if (Array.isArray(node.rows)) {
        for (const [rowIndex, row] of node.rows.entries()) {
          if (!Array.isArray(row)) continue;
          for (const [cellIndex, cell] of row.entries()) {
            collectInlineLinkErrors(
              cell,
              `${nodePath}/rows/${rowIndex}/${cellIndex}`,
              errors,
              blockId,
            );
          }
        }
      }
    } else if (node.type === "callout") {
      collectContentLinkErrors(node.content, `${nodePath}/content`, errors, blockId);
    } else if (node.type === "steps" && Array.isArray(node.items)) {
      for (const [stepIndex, stepValue] of node.items.entries()) {
        const step = asRecord(stepValue);
        collectContentLinkErrors(
          step?.content,
          `${nodePath}/items/${stepIndex}/content`,
          errors,
          blockId,
        );
      }
    } else if (node.type === "scale" && Array.isArray(node.items)) {
      for (const [itemIndex, itemValue] of node.items.entries()) {
        const item = asRecord(itemValue);
        if (item?.note === undefined) continue;
        collectInlineLinkErrors(item.note, `${nodePath}/items/${itemIndex}/note`, errors, blockId);
      }
    }
  }
}

function collectDocumentLinkErrors(value: unknown): ProtocolError[] {
  const document = asRecord(value);
  if (document === undefined) return [];
  const errors: ProtocolError[] = [];
  const continuation = asRecord(document.continuation);
  collectContentLinkErrors(continuation?.currentState, "/continuation/currentState", errors);
  const evidence = asRecord(document.evidence);
  for (const collectionName of ["facts", "decisions"] as const) {
    const collection = evidence?.[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const [index, itemValue] of collection.entries()) {
      const item = asRecord(itemValue);
      collectContentLinkErrors(
        item?.content,
        `/evidence/${collectionName}/${index}/content`,
        errors,
      );
    }
  }
  if (Array.isArray(document.blocks)) {
    for (const [index, blockValue] of document.blocks.entries()) {
      const block = asRecord(blockValue);
      collectContentLinkErrors(
        block?.body,
        `/blocks/${index}/body`,
        errors,
        typeof block?.id === "string" ? block.id : null,
      );
    }
  }
  return errors;
}

function validateContentNodes(
  nodes: readonly ReviewDocumentSchema.ContentNode[],
  path: string,
  glossaryIds: ReadonlySet<string>,
  errors: ProtocolError[],
  blockId: string | null = null,
): void {
  for (const [index, node] of nodes.entries()) {
    const nodePath = `${path}/${index}`;
    switch (node.type) {
      case "paragraph":
        validateInlineNodes(node.content, `${nodePath}/content`, glossaryIds, errors, blockId);
        break;
      case "list":
        for (const [itemIndex, item] of node.items.entries()) {
          validateInlineNodes(item, `${nodePath}/items/${itemIndex}`, glossaryIds, errors, blockId);
        }
        break;
      case "table":
        for (const [headerIndex, header] of node.headers.entries()) {
          validateInlineNodes(
            header,
            `${nodePath}/headers/${headerIndex}`,
            glossaryIds,
            errors,
            blockId,
          );
        }
        for (const [rowIndex, row] of node.rows.entries()) {
          if (row.length !== node.headers.length) {
            errors.push(protocolError("TABLE_WIDTH_MISMATCH", `${nodePath}/rows/${rowIndex}`));
          }
          for (const [cellIndex, cell] of row.entries()) {
            validateInlineNodes(
              cell,
              `${nodePath}/rows/${rowIndex}/${cellIndex}`,
              glossaryIds,
              errors,
              blockId,
            );
          }
        }
        break;
      case "callout":
        validateContentNodes(node.content, `${nodePath}/content`, glossaryIds, errors, blockId);
        break;
      case "steps":
        for (const [stepIndex, step] of node.items.entries()) {
          validateContentNodes(
            step.content,
            `${nodePath}/items/${stepIndex}/content`,
            glossaryIds,
            errors,
            blockId,
          );
        }
        break;
      case "flow": {
        const nodeIds = new Set<string>();
        for (const [flowNodeIndex, flowNode] of node.nodes.entries()) {
          if (nodeIds.has(flowNode.id)) {
            errors.push(protocolError("DUPLICATE_ID", `${nodePath}/nodes/${flowNodeIndex}/id`));
          }
          nodeIds.add(flowNode.id);
        }
        for (const [edgeIndex, edge] of node.edges.entries()) {
          if (!nodeIds.has(edge.from)) {
            errors.push(protocolError("UNKNOWN_REFERENCE", `${nodePath}/edges/${edgeIndex}/from`));
          }
          if (!nodeIds.has(edge.to)) {
            errors.push(protocolError("UNKNOWN_REFERENCE", `${nodePath}/edges/${edgeIndex}/to`));
          }
        }
        break;
      }
      case "scale":
        for (const [itemIndex, item] of node.items.entries()) {
          if (item.note === undefined) continue;
          validateInlineNodes(
            item.note,
            `${nodePath}/items/${itemIndex}/note`,
            glossaryIds,
            errors,
            blockId,
          );
        }
        break;
      case "code":
        break;
    }
  }
}

function validateDocumentSemantics(document: ReviewDocumentV1): ProtocolError[] {
  const errors: ProtocolError[] = [];
  addUnsafeInteger(document.document.contentVersion, "/document/contentVersion", errors);
  addUnsafeInteger(document.document.round, "/document/round", errors);
  if (document.delivery.splitGroup !== undefined) {
    addUnsafeInteger(document.delivery.splitGroup.part, "/delivery/splitGroup/part", errors);
    addUnsafeInteger(document.delivery.splitGroup.total, "/delivery/splitGroup/total", errors);
    if (document.delivery.splitGroup.part > document.delivery.splitGroup.total) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/delivery/splitGroup/part"));
    }
  }
  try {
    Intl.getCanonicalLocales(document.document.language);
  } catch {
    errors.push(protocolError("INVALID_LANGUAGE_TAG", "/document/language"));
  }

  addCanonicalActionIds(document.continuation.nextActions, "/continuation/nextActions", errors);
  addDuplicateIds(document.evidence.sourceHierarchy, "/evidence/sourceHierarchy", errors);
  addDuplicateIds(document.evidence.facts, "/evidence/facts", errors);
  addDuplicateIds(document.evidence.decisions, "/evidence/decisions", errors);
  addDuplicateIds(document.blocks, "/blocks", errors);
  addDuplicateIds(document.glossary, "/glossary", errors);

  const sourceIds = new Set(document.evidence.sourceHierarchy.map((source) => source.id));
  const factIds = new Set(document.evidence.facts.map((fact) => fact.id));
  const decisionIds = new Set(document.evidence.decisions.map((decision) => decision.id));
  const glossaryIds = new Set(document.glossary.map((entry) => entry.id));
  const blockIds = new Set(document.blocks.map((block) => block.id));
  const evidenceIds = new Set([...sourceIds, ...factIds, ...decisionIds]);

  for (const [index, fact] of document.evidence.facts.entries()) {
    addUnknownReferences(fact.sourceRefs, sourceIds, `/evidence/facts/${index}/sourceRefs`, errors);
    validateContentNodes(fact.content, `/evidence/facts/${index}/content`, glossaryIds, errors);
  }
  for (const [index, source] of document.evidence.sourceHierarchy.entries()) {
    addUnsafeInteger(source.rank, `/evidence/sourceHierarchy/${index}/rank`, errors);
  }
  for (const [index, decision] of document.evidence.decisions.entries()) {
    addUnknownReferences(
      decision.sourceRefs,
      sourceIds,
      `/evidence/decisions/${index}/sourceRefs`,
      errors,
    );
    validateContentNodes(
      decision.content,
      `/evidence/decisions/${index}/content`,
      glossaryIds,
      errors,
    );
  }
  for (const [index, conflict] of document.evidence.conflicts.entries()) {
    addUnknownReferences(conflict.itemRefs, evidenceIds, `/evidence/conflicts/${index}/itemRefs`, errors);
  }
  validateContentNodes(
    document.continuation.currentState,
    "/continuation/currentState",
    glossaryIds,
    errors,
  );

  for (const [index, block] of document.blocks.entries()) {
    if (block.changed !== undefined) {
      addUnsafeInteger(block.changed.round, `/blocks/${index}/changed/round`, errors, block.id);
    }
    if (stringWidth(block.title) > 32) {
      errors.push(protocolError("TEXT_WIDTH_EXCEEDED", `/blocks/${index}/title`, block.id));
    }
    if (stringWidth(block.summary) > 80) {
      errors.push(protocolError("TEXT_WIDTH_EXCEEDED", `/blocks/${index}/summary`, block.id));
    }
    addUnknownReferences(
      block.dependencies,
      blockIds,
      `/blocks/${index}/dependencies`,
      errors,
      block.id,
    );
    addUnknownReferences(block.claimRefs, factIds, `/blocks/${index}/claimRefs`, errors, block.id);
    addUnknownReferences(
      block.decisionRefs,
      decisionIds,
      `/blocks/${index}/decisionRefs`,
      errors,
      block.id,
    );
    validateContentNodes(block.body, `/blocks/${index}/body`, glossaryIds, errors, block.id);
    if (block.changed !== undefined && block.changed.round !== document.document.round) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", `/blocks/${index}/changed/round`, block.id));
    }
    if (document.document.round === 1 && block.changed !== undefined) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", `/blocks/${index}/changed`, block.id));
    }
  }
  collectFailure(buildDependencyGraph(document.blocks), errors);

  const asOf = Date.parse(document.document.asOf);
  const referencedSources = new Set(
    [...document.evidence.facts, ...document.evidence.decisions].flatMap((item) => item.sourceRefs),
  );
  for (const [index, source] of document.evidence.sourceHierarchy.entries()) {
    if (!referencedSources.has(source.id)) continue;
    const checkedAt = Date.parse(source.freshness.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > asOf) {
      errors.push(protocolError("FRESHNESS_INVALID", `/evidence/sourceHierarchy/${index}/freshness/checkedAt`));
    }
    if (source.freshness.kind === "time-sensitive") {
      const expiresAt = Date.parse(source.freshness.expiresAt);
      if (!Number.isFinite(expiresAt) || checkedAt >= expiresAt || asOf >= expiresAt) {
        errors.push(protocolError("FRESHNESS_INVALID", `/evidence/sourceHierarchy/${index}/freshness/expiresAt`));
      }
    }
  }

  const historyKeys = new Set<string>();
  const historyByBlock = new Map<string, ReviewDocumentSchema.ApprovalRecord[]>();
  for (const [index, approval] of document.approvals.history.entries()) {
    addUnsafeInteger(approval.approvedRound, `/approvals/history/${index}/approvedRound`, errors);
    const key = `${approval.blockId}:${approval.approvedRound}`;
    if (historyKeys.has(key)) {
      errors.push(protocolError("DUPLICATE_LINEAGE_ENTRY", `/approvals/history/${index}`));
    }
    historyKeys.add(key);
    if (!blockIds.has(approval.blockId)) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `/approvals/history/${index}/blockId`));
    }
    if (approval.approvedRound > document.document.round) {
      errors.push(protocolError("FUTURE_APPROVAL", `/approvals/history/${index}/approvedRound`));
    }
    const records = historyByBlock.get(approval.blockId) ?? [];
    records.push(approval);
    historyByBlock.set(approval.blockId, records);
  }
  for (const [index, blockId] of document.approvals.currentFrozen.entries()) {
    const block = document.blocks.find((item) => item.id === blockId);
    const records = historyByBlock.get(blockId) ?? [];
    if (!block) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `/approvals/currentFrozen/${index}`));
      continue;
    }
    if (records.length === 0) {
      errors.push(protocolError("FROZEN_WITHOUT_APPROVAL", `/approvals/currentFrozen/${index}`, blockId));
      continue;
    }
    const latest = records.reduce((left, right) =>
      left.approvedRound > right.approvedRound ? left : right);
    if (latest.approvedContentDigest !== blockContentDigest(block)) {
      const approvalIndex = document.approvals.history.indexOf(latest);
      errors.push(
        protocolError(
          "APPROVAL_DIGEST_MISMATCH",
          `/approvals/history/${approvalIndex}/approvedContentDigest`,
          blockId,
        ),
      );
    }
  }

  if ((document.document.round === 1) !== (document.lineage.previousReviewDigest === null)) {
    errors.push(protocolError("IDENTITY_MISMATCH", "/lineage/previousReviewDigest"));
  }
  const consumedIds = new Set<string>();
  for (const [index, packet] of document.lineage.consumedPackets.entries()) {
    if (consumedIds.has(packet.packetId)) {
      errors.push(protocolError("DUPLICATE_LINEAGE_ENTRY", `/lineage/consumedPackets/${index}/packetId`));
    }
    consumedIds.add(packet.packetId);
    if (packetIdFromSemanticDigest(packet.semanticDigest as Sha256Digest) !== packet.packetId) {
      errors.push(protocolError("PACKET_ID_DIGEST_MISMATCH", `/lineage/consumedPackets/${index}/packetId`));
    }
  }
  const topicMappingIds = new Set<string>();
  for (const [index, mapping] of document.lineage.topicMappings.entries()) {
    if (topicMappingIds.has(mapping.topicId)) {
      errors.push(protocolError("DUPLICATE_LINEAGE_ENTRY", `/lineage/topicMappings/${index}/topicId`));
    }
    topicMappingIds.add(mapping.topicId);
  }
  const impactAssessmentKeys = new Set<string>();
  for (const [index, assessment] of document.lineage.impactAssessments.entries()) {
    addUnsafeInteger(
      assessment.changedAtRound,
      `/lineage/impactAssessments/${index}/changedAtRound`,
      errors,
    );
    const key = `${assessment.changedAtRound}:${assessment.upstreamBlockId}`;
    if (impactAssessmentKeys.has(key)) {
      errors.push(protocolError("DUPLICATE_LINEAGE_ENTRY", `/lineage/impactAssessments/${index}`));
    }
    impactAssessmentKeys.add(key);
    if (!blockIds.has(assessment.upstreamBlockId)) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `/lineage/impactAssessments/${index}/upstreamBlockId`));
    }
    addUnknownReferences(
      assessment.affectedDownstreamIds,
      blockIds,
      `/lineage/impactAssessments/${index}/affectedDownstreamIds`,
      errors,
    );
    if (assessment.changedAtRound > document.document.round) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", `/lineage/impactAssessments/${index}/changedAtRound`));
    }
  }
  const resolutionKeys = new Set<string>();
  const resolvedNoteIds = new Set<string>();
  for (const [index, resolution] of document.lineage.feedbackResolutions.entries()) {
    const key = `${resolution.sourcePacketId}:${resolution.feedbackId}`;
    if (resolutionKeys.has(key)) {
      errors.push(protocolError("DUPLICATE_LINEAGE_ENTRY", `/lineage/feedbackResolutions/${index}`));
    }
    resolutionKeys.add(key);
    if (resolution.feedbackId.startsWith("NOTE-")) {
      if (resolvedNoteIds.has(resolution.feedbackId)) {
        errors.push(protocolError(
          "DUPLICATE_ID",
          `/lineage/feedbackResolutions/${index}/feedbackId`,
        ));
      }
      resolvedNoteIds.add(resolution.feedbackId);
    }
    if (!consumedIds.has(resolution.sourcePacketId)) {
      errors.push(
        protocolError(
          "UNKNOWN_PACKET_REFERENCE",
          `/lineage/feedbackResolutions/${index}/sourcePacketId`,
        ),
      );
    }
    if (resolution.disposition === "converted-to-block" && !blockIds.has(resolution.targetBlockId)) {
      errors.push(protocolError("UNKNOWN_REFERENCE", `/lineage/feedbackResolutions/${index}/targetBlockId`));
    }
  }
  collectFailure(validateDocumentHighWater(document), errors);
  return errors;
}

function packetOrStateSemantics(
  input: ReviewPacketV1 | ReviewStateV1,
  document: ReviewDocumentV1 | undefined,
): ProtocolError[] {
  const errors: ProtocolError[] = [];
  addUnsafeInteger(input.doc.contentVersion, "/doc/contentVersion", errors);
  addUnsafeInteger(input.doc.round, "/doc/round", errors);
  if (input.format === "review-packet/1") {
    addUnsafeInteger(input.progress.decided, "/progress/decided", errors);
    addUnsafeInteger(input.progress.total, "/progress/total", errors);
    for (const action of ["PASS", "EDIT", "TOPIC", "HOLD"] as const) {
      addUnsafeInteger(input.stats[action], `/stats/${action}`, errors);
    }
  }
  const decisionBlocks = new Set<string>();
  for (const [index, decision] of input.decisions.entries()) {
    if (decisionBlocks.has(decision.blockId)) {
      errors.push(protocolError("DUPLICATE_DECISION", `/decisions/${index}/blockId`, decision.blockId));
    }
    decisionBlocks.add(decision.blockId);
  }
  addDuplicateIds(input.sideNotes, "/sideNotes", errors);
  addDuplicateIds(input.topics, "/topics", errors);

  const topicsById = new Map(input.topics.map((topic) => [topic.id, topic]));
  const mappedTopicIds = new Set<string>();
  for (const [index, decision] of input.decisions.entries()) {
    if (decision.action !== "TOPIC") continue;
    const topic = topicsById.get(decision.topicId);
    if (!topic || topic.sourceBlockId !== decision.blockId || mappedTopicIds.has(decision.topicId)) {
      errors.push(protocolError("TOPIC_MAPPING_MISMATCH", `/decisions/${index}/topicId`, decision.blockId));
    }
    mappedTopicIds.add(decision.topicId);
  }
  for (const [index, topic] of input.topics.entries()) {
    if (topic.sourceBlockId !== undefined) {
      const decision = input.decisions.find(
        (item) => item.action === "TOPIC" && item.topicId === topic.id && item.blockId === topic.sourceBlockId,
      );
      if (!decision) errors.push(protocolError("TOPIC_MAPPING_MISMATCH", `/topics/${index}/sourceBlockId`));
    }
  }

  if (document) {
    const blockIds = new Set(document.blocks.map((block) => block.id));
    const frozen = new Set(document.approvals.currentFrozen);
    const reopened = new Set(input.reopened);
    for (const [index, blockId] of input.reopened.entries()) {
      if (!frozen.has(blockId)) errors.push(protocolError("UNKNOWN_REFERENCE", `/reopened/${index}`, blockId));
    }
    for (const [index, decision] of input.decisions.entries()) {
      if (!blockIds.has(decision.blockId)) {
        errors.push(protocolError("UNKNOWN_REFERENCE", `/decisions/${index}/blockId`, decision.blockId));
      } else if (frozen.has(decision.blockId) && !reopened.has(decision.blockId)) {
        errors.push(protocolError("IDENTITY_MISMATCH", `/decisions/${index}/blockId`, decision.blockId));
      }
    }
    for (const [index, note] of input.sideNotes.entries()) {
      if (!blockIds.has(note.blockId)) {
        errors.push(protocolError("UNKNOWN_REFERENCE", `/sideNotes/${index}/blockId`, note.blockId));
      }
    }
    for (const [index, topic] of input.topics.entries()) {
      if (topic.sourceBlockId !== undefined && !blockIds.has(topic.sourceBlockId)) {
        errors.push(protocolError("UNKNOWN_REFERENCE", `/topics/${index}/sourceBlockId`, topic.sourceBlockId));
      }
    }
  }

  collectFailure(validateOverlayHighWater(input, document), errors);
  return errors;
}

export function validateReviewDocument(input: unknown): ProtocolResult<ReviewDocumentV1> {
  const schema = validateReviewDocumentSchema(input);
  if (!schema.ok) {
    const safe = cloneSafeJson(input);
    if (!safe.ok) return schema;
    const linkErrors = collectDocumentLinkErrors(safe.value).filter((error) =>
      !schema.errors.some((schemaError) =>
        schemaError.code === error.code && schemaError.path === error.path));
    return linkErrors.length === 0 ? schema : failure([...schema.errors, ...linkErrors]);
  }
  const errors = validateDocumentSemantics(schema.value);
  return errors.length === 0 ? success(canonicalReviewDocument(schema.value)) : failure(errors);
}

export function validateReviewDocumentAgainst(
  currentInput: unknown,
  candidateInput: unknown,
): ProtocolResult<ReviewDocumentV1> {
  const current = validateReviewDocument(currentInput);
  if (!current.ok) return current;
  const candidate = validateReviewDocument(candidateInput);
  if (!candidate.ok) return candidate;
  return validateDocumentContext(current.value, candidate.value);
}

export function computeReviewDigest(document: ReviewDocumentV1): ProtocolResult<Sha256Digest> {
  const validated = validateReviewDocument(document);
  return validated.ok ? success(reviewDigest(validated.value)) : validated;
}

export function validateReviewPacket(
  input: unknown,
  document?: ReviewDocumentV1,
): ProtocolResult<ReviewPacketV1> {
  const validatedDocument = document === undefined ? undefined : validateReviewDocument(document);
  if (validatedDocument !== undefined && !validatedDocument.ok) return validatedDocument;
  const documentValue = validatedDocument?.value;
  const schema = validateReviewPacketSchema(input);
  if (!schema.ok) return schema;
  const value = schema.value;
  const errors = packetOrStateSemantics(value, documentValue);
  const decided = value.decisions.length;
  if (value.progress.decided !== decided) {
    errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/progress/decided"));
  }
  if (value.progress.total < decided) {
    errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/progress/total"));
  }
  if (value.progress.partial !== (decided < value.progress.total)) {
    errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/progress/partial"));
  }
  const stats = { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 };
  for (const decision of value.decisions) stats[decision.action] += 1;
  for (const action of Object.keys(stats) as Array<keyof typeof stats>) {
    if (value.stats[action] !== stats[action]) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", `/stats/${action}`));
    }
  }
  const overlap = new Set(value.frozenCarried);
  for (const [index, blockId] of value.reopened.entries()) {
    if (overlap.has(blockId)) {
      errors.push(protocolError("FROZEN_REOPENED_OVERLAP", `/reopened/${index}`, blockId));
    }
  }
  if (documentValue) {
    collectFailure(validatePacketIdentity(documentValue, value), errors);
    const expectedFrozen = documentValue.approvals.currentFrozen
      .filter((blockId) => !value.reopened.includes(blockId))
      .sort();
    const actualFrozen = [...value.frozenCarried].sort();
    if (canonicalJson(actualFrozen) !== canonicalJson(expectedFrozen)) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/frozenCarried"));
    }
    const expectedTotal = documentValue.blocks.length - value.frozenCarried.length;
    if (value.progress.total !== expectedTotal) {
      errors.push(protocolError("DERIVED_VALUE_MISMATCH", "/progress/total"));
    }
  }
  const semanticDigest = packetSemanticDigest(value);
  if (value.semanticDigest !== semanticDigest) {
    errors.push(protocolError("DIGEST_MISMATCH", "/semanticDigest"));
  }
  if (value.packetId !== packetIdFromSemanticDigest(semanticDigest)) {
    errors.push(protocolError("PACKET_ID_DIGEST_MISMATCH", "/packetId"));
  }
  return errors.length === 0 ? success(canonicalReviewPacket(value)) : failure(errors);
}

export function validateReviewState(
  input: unknown,
  document?: ReviewDocumentV1,
): ProtocolResult<ReviewStateV1> {
  const validatedDocument = document === undefined ? undefined : validateReviewDocument(document);
  if (validatedDocument !== undefined && !validatedDocument.ok) return validatedDocument;
  const documentValue = validatedDocument?.value;
  const schema = validateReviewStateSchema(input);
  if (!schema.ok) return schema;
  const value = schema.value;
  const errors = packetOrStateSemantics(value, documentValue);
  if (documentValue) collectFailure(validateStateIdentity(documentValue, value), errors);
  if (value.stateDigest !== stateDigest(value)) {
    errors.push(protocolError("DIGEST_MISMATCH", "/stateDigest"));
  }
  return errors.length === 0 ? success(canonicalReviewState(value)) : failure(errors);
}
