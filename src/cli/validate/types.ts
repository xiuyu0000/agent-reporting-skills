import type {
  ProtocolError,
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
  Sha256Digest,
} from "../../protocol/index.js";
import type { CliIoError } from "../result.js";

export const VAL_ERROR_CODES = [
  "ARGUMENT_INVALID",
  "INPUT_UTF8_INVALID",
  "INPUT_JSON_INVALID",
  "LEGACY_CONTRACT_INCOMPATIBLE",
  "ARTIFACT_FORMAT_INVALID",
  "ARTIFACT_IDENTITY_MISMATCH",
  "PRIVACY_VIOLATION",
  "EXTERNAL_RESOURCE_FORBIDDEN",
  "CSP_INVALID",
  "DOCUMENT_NOT_REVIEWABLE",
  "BLOCKING_CONFLICT",
  "ARTIFACT_MISSING",
  "ARTIFACT_DRIFT",
  "PLACEHOLDER_REMAINS",
  "INTERNAL_LINK_INVALID",
  "SPLIT_GROUP_INVALID",
  "INTERNAL_ERROR",
] as const;

export type ValErrorCode = (typeof VAL_ERROR_CODES)[number];

export interface ValidationError {
  code: ValErrorCode | ProtocolError["code"] | CliIoError["code"];
  path: string;
  blockId: string | null;
  message: string;
  hint: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

export interface UncertaintySummary {
  count: number;
  safeSummaries: string[];
}

export interface ArtifactHandoff {
  relativePath: string;
  byteDigest: Sha256Digest;
}

export interface DeliveryHandoff {
  kind: "delivery";
  generatorVersion: string;
  deliveryId: string;
  documentId: string;
  contentVersion: number;
  round: number;
  asOf: string;
  documentContentDigest: Sha256Digest;
  reviewDigest: Sha256Digest;
  artifacts: { agent: ArtifactHandoff; approval: ArtifactHandoff };
  uncertainties: {
    evidenceGaps: UncertaintySummary;
    unresolvedNonblockingConflicts: UncertaintySummary;
    risks: UncertaintySummary;
    openQuestions: UncertaintySummary;
  };
}

export interface DeliveryPartHandoff {
  part: number;
  title: string;
  summary: string;
  generatorVersion: string;
  deliveryId: string;
  documentId: string;
  contentVersion: number;
  round: number;
  asOf: string;
  documentContentDigest: Sha256Digest;
  reviewDigest: Sha256Digest;
  artifacts: { agent: ArtifactHandoff; approval: ArtifactHandoff };
  uncertainties: DeliveryHandoff["uncertainties"];
}

export interface BatchHandoff {
  kind: "batch";
  groupId: string;
  total: number;
  reason: string;
  parts: DeliveryPartHandoff[];
}

export type ValidateSuccess =
  | { status: "ok"; phase: "validate"; mode: "delivery"; mutated: false; handoff: DeliveryHandoff }
  | { status: "ok"; phase: "validate"; mode: "batch"; mutated: false; handoff: BatchHandoff }
  | {
      status: "ok";
      phase: "validate";
      mode: "packet";
      mutated: false;
      summary: {
        format: "review-packet/1";
        documentId: string;
        contentVersion: number;
        round: number;
        reviewDigest: Sha256Digest;
        packetId: string;
        semanticDigest: Sha256Digest;
      };
      normalized?: ReviewPacketV1;
    }
  | {
      status: "ok";
      phase: "validate";
      mode: "state";
      mutated: false;
      summary: {
        format: "review-state/1";
        documentId: string;
        contentVersion: number;
        round: number;
        reviewDigest: Sha256Digest;
        stateDigest: Sha256Digest;
      };
      normalized?: ReviewStateV1;
    }
  | {
      status: "ok";
      phase: "validate";
      mode: "transition";
      mutated: false;
      summary: {
        status: "apply" | "noop";
        packetId: string;
        semanticDigest: Sha256Digest;
        derivedTopicIds: string[];
      };
    };

export interface ValidateFailure {
  status: "failed";
  phase: "validate";
  mutated: false;
  recoveryRequired: false;
  errors: ValidationError[];
}

export type ValidateCommandResult = ValidateSuccess | ValidateFailure;

export interface ValidateCommandOutcome {
  exitCode: number;
  result: ValidateCommandResult;
}

export interface ParsedAgentArtifact {
  generatorVersion: string;
  deliveryId: string;
  documentId: string;
  contentVersion: number;
  round: number;
  reviewDigest: Sha256Digest;
  text: string;
}

export interface ParsedApprovalArtifact {
  generatorVersion: string;
  document: ReviewDocumentV1;
  text: string;
}

export interface ValidatedDeliveryArtifacts {
  document: ReviewDocumentV1;
  generatorVersion: string;
  agent: ParsedAgentArtifact;
  approval: ParsedApprovalArtifact;
}
