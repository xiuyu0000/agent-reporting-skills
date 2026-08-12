import {
  canonicalJson,
  documentContentDigest,
  portablePathKey,
  reviewDigest,
  type ReviewDocumentV1,
  type Sha256Digest,
} from "../../protocol/index.js";
import { validateDeliverableDocument } from "./business.js";
import { validationError, validationErrors, validationSuccess } from "./errors.js";
import { isSemver } from "./text.js";
import { snapshotSafeJson } from "./safe-input.js";
import type {
  BatchHandoff,
  DeliveryHandoff,
  DeliveryPartHandoff,
  UncertaintySummary,
  ValidationResult,
} from "./types.js";

function uncertainty(values: readonly string[]): UncertaintySummary {
  return { count: values.length, safeSummaries: [...values] };
}

function uncertainties(document: ReviewDocumentV1): DeliveryHandoff["uncertainties"] {
  const conflicts = document.evidence.conflicts
    .filter((conflict) => conflict.severity === "nonblocking" && conflict.status === "unresolved")
    .map((conflict) => conflict.description);
  return {
    evidenceGaps: uncertainty(document.continuation.evidenceGaps),
    unresolvedNonblockingConflicts: uncertainty(conflicts),
    risks: uncertainty(document.evidence.risks),
    openQuestions: uncertainty(document.evidence.openQuestions),
  };
}

interface DeliveryHandoffInput {
  document: ReviewDocumentV1;
  generatorVersion: string;
  agent: { relativePath: string; byteDigest: Sha256Digest };
  approval: { relativePath: string; byteDigest: Sha256Digest };
}

function buildDeliveryHandoffSnapshot(input: DeliveryHandoffInput): ValidationResult<DeliveryHandoff> {
  const validatedDocument = validateDeliverableDocument(input.document);
  if (!validatedDocument.ok) return validatedDocument;
  const document = validatedDocument.value;
  const agentPath = portablePathKey(input.agent.relativePath);
  const approvalPath = portablePathKey(input.approval.relativePath);
  const declaredAgentPath = portablePathKey(document.delivery.outputs.agent);
  const declaredApprovalPath = portablePathKey(document.delivery.outputs.approval);
  if (!agentPath.ok || !approvalPath.ok || !declaredAgentPath.ok || !declaredApprovalPath.ok
    || input.agent.relativePath !== document.delivery.outputs.agent
    || input.approval.relativePath !== document.delivery.outputs.approval
    || agentPath.value === approvalPath.value) {
    return validationErrors([validationError("ARTIFACT_IDENTITY_MISMATCH", "/handoff/artifacts")]);
  }
  if (typeof input.generatorVersion !== "string" || !isSemver(input.generatorVersion)
    || typeof input.agent.byteDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.agent.byteDigest)
    || typeof input.approval.byteDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.approval.byteDigest)) {
    return validationErrors([validationError("ARTIFACT_IDENTITY_MISMATCH", "/handoff")]);
  }
  return validationSuccess({
    kind: "delivery",
    generatorVersion: input.generatorVersion,
    deliveryId: document.delivery.id,
    documentId: document.document.id,
    contentVersion: document.document.contentVersion,
    round: document.document.round,
    asOf: document.document.asOf,
    documentContentDigest: documentContentDigest(document),
    reviewDigest: reviewDigest(document),
    artifacts: {
      agent: { relativePath: input.agent.relativePath, byteDigest: input.agent.byteDigest },
      approval: { relativePath: input.approval.relativePath, byteDigest: input.approval.byteDigest },
    },
    uncertainties: uncertainties(document),
  });
}

export function buildDeliveryHandoff(input: DeliveryHandoffInput): ValidationResult<DeliveryHandoff> {
  const snapshot = snapshotSafeJson<DeliveryHandoffInput>(input, "/input");
  if (!snapshot.ok) return snapshot;
  try {
    return buildDeliveryHandoffSnapshot(snapshot.value);
  } catch {
    return validationErrors([validationError("ARTIFACT_IDENTITY_MISMATCH", "/handoff")]);
  }
}

interface BatchHandoffInput {
  deliveries: readonly {
    document: ReviewDocumentV1;
    contractRelativePath: string;
    handoff: DeliveryHandoff;
  }[];
}

function buildBatchHandoffSnapshot(input: BatchHandoffInput): ValidationResult<BatchHandoff> {
  if (input.deliveries.length === 0) {
    return validationErrors([validationError("SPLIT_GROUP_INVALID", "/batch")]);
  }
  const ordered = [...input.deliveries].sort((left, right) =>
    (left.document.delivery.splitGroup?.part ?? 0) - (right.document.delivery.splitGroup?.part ?? 0));
  const first = ordered[0]?.document.delivery.splitGroup;
  const errors = [] as ReturnType<typeof validationError>[];
  if (first === undefined || first.total !== ordered.length) {
    errors.push(validationError("SPLIT_GROUP_INVALID", "/batch/group"));
  }
  const documentIds = new Set<string>();
  const deliveryIds = new Set<string>();
  const portableKeys = new Set<string>();
  const baseNameKeys = new Set<string>();
  const generatorVersion = ordered[0]?.handoff.generatorVersion;
  for (const [index, item] of ordered.entries()) {
    const group = item.document.delivery.splitGroup;
    if (group === undefined || first === undefined || group.groupId !== first.groupId
      || group.total !== first.total || group.reason !== first.reason || group.part !== index + 1
      || item.handoff.generatorVersion !== generatorVersion) {
      errors.push(validationError("SPLIT_GROUP_INVALID", `/batch/parts/${index}`));
    }
    if (documentIds.has(item.document.document.id) || deliveryIds.has(item.document.delivery.id)) {
      errors.push(validationError("SPLIT_GROUP_INVALID", `/batch/parts/${index}/identity`));
    }
    documentIds.add(item.document.document.id);
    deliveryIds.add(item.document.delivery.id);
    const expectedHandoff = buildDeliveryHandoffSnapshot({
      document: item.document,
      generatorVersion: item.handoff.generatorVersion,
      agent: item.handoff.artifacts.agent,
      approval: item.handoff.artifacts.approval,
    });
    if (!expectedHandoff.ok || canonicalJson(expectedHandoff.value) !== canonicalJson(item.handoff)) {
      errors.push(validationError("SPLIT_GROUP_INVALID", `/batch/parts/${index}/handoff`));
    }
    const paths = [
      item.contractRelativePath,
      item.handoff.artifacts.agent.relativePath,
      item.handoff.artifacts.approval.relativePath,
    ];
    for (const path of paths) {
      const key = portablePathKey(path);
      if (!key.ok || portableKeys.has(key.value)) {
        errors.push(validationError("SPLIT_GROUP_INVALID", `/batch/parts/${index}/paths`));
      } else portableKeys.add(key.value);
    }
    const baseNameKey = portablePathKey(item.document.delivery.baseName);
    if (!baseNameKey.ok || baseNameKeys.has(baseNameKey.value)) {
      errors.push(validationError("SPLIT_GROUP_INVALID", `/batch/parts/${index}/baseName`));
    } else baseNameKeys.add(baseNameKey.value);
  }
  if (errors.length > 0 || first === undefined) return validationErrors(errors);
  const parts: DeliveryPartHandoff[] = ordered.map(({ document, handoff }) => ({
    part: document.delivery.splitGroup!.part,
    title: document.document.title,
    summary: document.document.summary,
    generatorVersion: handoff.generatorVersion,
    deliveryId: handoff.deliveryId,
    documentId: handoff.documentId,
    contentVersion: handoff.contentVersion,
    round: handoff.round,
    asOf: handoff.asOf,
    documentContentDigest: handoff.documentContentDigest,
    reviewDigest: handoff.reviewDigest,
    artifacts: handoff.artifacts,
    uncertainties: handoff.uncertainties,
  }));
  return validationSuccess({
    kind: "batch",
    groupId: first.groupId,
    total: first.total,
    reason: first.reason,
    parts,
  });
}

export function buildBatchHandoff(input: BatchHandoffInput): ValidationResult<BatchHandoff> {
  const snapshot = snapshotSafeJson<BatchHandoffInput>(input, "/input");
  if (!snapshot.ok) return snapshot;
  try {
    return buildBatchHandoffSnapshot(snapshot.value);
  } catch {
    return validationErrors([validationError("SPLIT_GROUP_INVALID", "/batch")]);
  }
}
