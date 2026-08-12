import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalJsonBytes,
  canonicalReviewDocument,
  canonicalReviewPacket,
  canonicalReviewState,
  compareUnicodeCodePoints,
} from "./canonical.js";
import type {
  ReviewDocumentSchema,
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";

export type Sha256Digest = `sha256:${string}`;
export type ReviewPacketId = `RP-${string}`;

export interface FeedbackDigestInput {
  kind: "overall" | "side-note";
  feedbackId: string;
  blockId?: string;
  text: string;
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export function sha256Bytes(input: Uint8Array): Sha256Digest {
  return `sha256:${toHex(sha256(input))}`;
}

function digestValue(value: unknown): Sha256Digest {
  return sha256Bytes(canonicalJsonBytes(value));
}

function blockContentValue(block: ReviewDocumentSchema.DecisionBlock) {
  return {
    tier: block.tier,
    title: block.title,
    summary: block.summary,
    body: block.body,
    ...(block.whyTier === undefined ? {} : { whyTier: block.whyTier }),
    ...(block.ask === undefined ? {} : { ask: block.ask }),
    dependencies: [...block.dependencies].sort(compareUnicodeCodePoints),
    claimRefs: [...block.claimRefs].sort(compareUnicodeCodePoints),
    decisionRefs: [...block.decisionRefs].sort(compareUnicodeCodePoints),
  };
}

export function blockContentDigest(block: ReviewDocumentSchema.DecisionBlock): Sha256Digest {
  return digestValue(blockContentValue(structuredClone(block)));
}

export function documentContentDigest(input: ReviewDocumentV1): Sha256Digest {
  const value = canonicalReviewDocument(input);
  return digestValue({
    title: value.document.title,
    language: value.document.language,
    uiLocale: value.document.uiLocale,
    asOf: value.document.asOf,
    summary: value.document.summary,
    continuation: value.continuation,
    evidence: value.evidence,
    blocks: value.blocks.map((block) => ({ id: block.id, ...blockContentValue(block) })),
    glossary: value.glossary,
  });
}

export function reviewDigest(input: ReviewDocumentV1): Sha256Digest {
  const value = canonicalReviewDocument(input);
  return digestValue({
    document: {
      id: value.document.id,
      contentVersion: value.document.contentVersion,
      round: value.document.round,
      status: value.document.status,
    },
    documentContentDigest: documentContentDigest(value),
    approvals: value.approvals,
    lineage: value.lineage,
  });
}

export function packetSemanticDigest(input: ReviewPacketV1): Sha256Digest {
  const value = canonicalReviewPacket(input);
  return digestValue({
    doc: value.doc,
    idHighWater: value.idHighWater,
    decisions: value.decisions,
    sideNotes: value.sideNotes,
    topics: value.topics,
    ...(value.overall === undefined ? {} : { overall: value.overall }),
    reopened: value.reopened,
    frozenCarried: value.frozenCarried,
  });
}

export function stateDigest(input: ReviewStateV1): Sha256Digest {
  const value = canonicalReviewState(input);
  return digestValue({
    doc: value.doc,
    idHighWater: value.idHighWater,
    decisions: value.decisions,
    sideNotes: value.sideNotes,
    topics: value.topics,
    ...(value.overall === undefined ? {} : { overall: value.overall }),
    reopened: value.reopened,
  });
}

export function feedbackDigest(input: FeedbackDigestInput): Sha256Digest {
  return digestValue({
    kind: input.kind,
    feedbackId: input.feedbackId,
    ...(input.blockId === undefined ? {} : { blockId: input.blockId }),
    text: input.text,
  });
}

export function packetIdFromSemanticDigest(digest: Sha256Digest): ReviewPacketId {
  return `RP-${digest.slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`;
}
