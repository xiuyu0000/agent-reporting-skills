import { sha256Bytes, type ReviewDocumentV1, type Sha256Digest } from "../../protocol/index.js";
import { validateDeliverableDocument } from "./business.js";
import { validationError, validationErrors, validationSuccess } from "./errors.js";
import { buildDeliveryHandoff } from "./handoff.js";
import { parseAgentArtifact, parseApprovalArtifact } from "./parsers.js";
import { snapshotSafeInput } from "./safe-input.js";
import type { DeliveryHandoff, ValidatedDeliveryArtifacts, ValidationResult } from "./types.js";

interface DeliveryArtifactSetInput {
  document: unknown;
  agentBytes?: Uint8Array;
  approvalBytes?: Uint8Array;
  approvalTemplateBytes: Uint8Array;
  expectedGeneratorVersion?: string;
}

function validateDeliveryArtifactSetSnapshot(
  input: DeliveryArtifactSetInput,
): ValidationResult<ValidatedDeliveryArtifacts> {
  const document = validateDeliverableDocument(input.document);
  if (!document.ok) return document;
  const missing = [
    ...(input.agentBytes === undefined ? [validationError("ARTIFACT_MISSING", "/agent")] : []),
    ...(input.approvalBytes === undefined ? [validationError("ARTIFACT_MISSING", "/approval")] : []),
  ];
  if (missing.length > 0) return validationErrors(missing);
  const agent = parseAgentArtifact(
    input.agentBytes!,
    document.value,
    input.expectedGeneratorVersion,
  );
  const approval = parseApprovalArtifact({
    bytes: input.approvalBytes!,
    templateBytes: input.approvalTemplateBytes,
    expectedDocument: document.value,
    ...(input.expectedGeneratorVersion === undefined
      ? {}
      : { expectedGeneratorVersion: input.expectedGeneratorVersion }),
  });
  if (!agent.ok || !approval.ok) {
    return validationErrors([
      ...(agent.ok ? [] : agent.errors),
      ...(approval.ok ? [] : approval.errors),
    ]);
  }
  if (agent.value.generatorVersion !== approval.value.generatorVersion) {
    return validationErrors([validationError("ARTIFACT_IDENTITY_MISMATCH", "/artifacts/generatorVersion")]);
  }
  return validationSuccess({
    document: document.value,
    generatorVersion: agent.value.generatorVersion,
    agent: agent.value,
    approval: approval.value,
  });
}

export function validateDeliveryArtifactSet(input: DeliveryArtifactSetInput): ValidationResult<ValidatedDeliveryArtifacts> {
  const snapshot = snapshotSafeInput<DeliveryArtifactSetInput>(input, "/input");
  if (!snapshot.ok) return snapshot;
  try {
    return validateDeliveryArtifactSetSnapshot(snapshot.value);
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/artifacts")]);
  }
}

interface DeliveryAndHandoffInput extends DeliveryArtifactSetInput {
  document: unknown;
  agent: { relativePath: string; byteDigest: Sha256Digest };
  approval: { relativePath: string; byteDigest: Sha256Digest };
}

function validateDeliveryAndBuildHandoffSnapshot(
  input: DeliveryAndHandoffInput,
): ValidationResult<{ document: ReviewDocumentV1; handoff: DeliveryHandoff }> {
  const artifacts = validateDeliveryArtifactSetSnapshot(input);
  if (!artifacts.ok) return artifacts;
  if (input.agentBytes === undefined || input.approvalBytes === undefined
    || input.agent.byteDigest !== sha256Bytes(input.agentBytes)
    || input.approval.byteDigest !== sha256Bytes(input.approvalBytes)) {
    return validationErrors([validationError("ARTIFACT_IDENTITY_MISMATCH", "/handoff/artifacts")]);
  }
  const handoff = buildDeliveryHandoff({
    document: artifacts.value.document,
    generatorVersion: artifacts.value.generatorVersion,
    agent: input.agent,
    approval: input.approval,
  });
  return handoff.ok
    ? validationSuccess({ document: artifacts.value.document, handoff: handoff.value })
    : handoff;
}

export function validateDeliveryAndBuildHandoff(
  input: DeliveryAndHandoffInput,
): ValidationResult<{ document: ReviewDocumentV1; handoff: DeliveryHandoff }> {
  const snapshot = snapshotSafeInput<DeliveryAndHandoffInput>(input, "/input");
  if (!snapshot.ok) return snapshot;
  try {
    return validateDeliveryAndBuildHandoffSnapshot(snapshot.value);
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/artifacts")]);
  }
}
