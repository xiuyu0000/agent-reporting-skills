import type { ReviewDocumentSchema, ReviewPacketSchema } from "./types.generated.js";

export const CORE_PROTOCOL_VERSION = "review-protocol-core/1" as const;

export type {
  ProtocolError,
  ProtocolErrorCode,
  ProtocolResult,
  SchemaErrorCode,
} from "./errors.js";
export {
  protocolError,
} from "./errors.js";

export type {
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";
export type ContentNode = ReviewDocumentSchema.ContentNode;
export type InlineNode = ReviewDocumentSchema.InlineNode;
export type DecisionBlock = ReviewDocumentSchema.DecisionBlock;
export type ReviewDecision = Readonly<ReviewPacketSchema.PacketDecision>;

export {
  validateReviewDocumentSchema,
  validateReviewPacketSchema,
  validateReviewStateSchema,
} from "./schema.js";

export type { JsonPrimitive, JsonValue } from "./canonical.js";
export {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonLine,
  canonicalReviewDocument,
  canonicalReviewPacket,
  canonicalReviewState,
  compareUnicodeCodePoints,
} from "./canonical.js";

export type {
  FeedbackDigestInput,
  ReviewPacketId,
  Sha256Digest,
} from "./digest.js";
export {
  blockContentDigest,
  documentContentDigest,
  feedbackDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  reviewDigest,
  sha256Bytes,
  stateDigest,
} from "./digest.js";

export type { PortablePathKey } from "./portable-path.js";
export { portablePathKey } from "./portable-path.js";

export type { DependencyGraph, DependencyNode } from "./graph.js";
export {
  buildDependencyGraph,
  downstreamClosure,
  upstreamClosure,
} from "./graph.js";

export type {
  IdHighWater,
  LegacyIdentityConfirmation,
} from "./identity.js";
export {
  confirmLegacyIdentity,
  validateDocumentContext,
  validateDocumentHighWater,
  validateOverlayHighWater,
  validatePacketIdentity,
  validateStateIdentity,
} from "./identity.js";

export {
  computeReviewDigest,
  validateReviewDocument,
  validateReviewDocumentAgainst,
  validateReviewPacket,
  validateReviewState,
} from "./invariants.js";

export type { PrototypeMigrationOptions } from "./migration.js";
export {
  migratePrototypePacket,
  migratePrototypeState,
} from "./migration.js";

export type {
  PrototypePacketUnboundMigrationOptions,
} from "./migration.js";
export { migratePrototypePacketUnbound } from "./migration.js";

export {
  parseReviewPacketMarkdown,
  parseReviewPacketMarkdownUnbound,
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
} from "./packet-markdown.js";
