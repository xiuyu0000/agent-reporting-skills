import {
  computeReviewDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
  validateReviewPacket,
  type ProtocolResult,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type Sha256Digest,
} from "../protocol/index.js";
import type { WorkbenchReviewState } from "./reducer.js";
import { computeWorkbenchStateDigest } from "./state.js";
import {
  effectiveFrozenBlockIds,
  reviewProgress,
  reviewStats,
} from "./selectors.js";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}` as Sha256Digest;

export interface ReviewPacketExport {
  readonly packet: ReviewPacketV1;
  readonly json: string;
  readonly markdown: string;
}

export interface ReviewPacketExportSnapshot extends ReviewPacketExport {
  readonly stateDigest: Sha256Digest;
  readonly recordCount: number;
}

export interface ReviewPacketExportCache {
  get(state: WorkbenchReviewState): ProtocolResult<ReviewPacketExportSnapshot>;
  invalidate(): void;
}

export function buildReviewPacket(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  reviewedAt: string,
): ProtocolResult<ReviewPacketV1> {
  const digest = computeReviewDigest(documentValue);
  if (!digest.ok) return digest;
  const progress = reviewProgress(documentValue, state);
  const stats = reviewStats(state);
  const effectiveFrozen = effectiveFrozenBlockIds(documentValue, state);
  const candidate: ReviewPacketV1 = {
    format: "review-packet/1",
    packetId: packetIdFromSemanticDigest(EMPTY_DIGEST),
    semanticDigest: EMPTY_DIGEST,
    doc: {
      id: documentValue.document.id,
      title: documentValue.document.title,
      contentVersion: documentValue.document.contentVersion,
      round: documentValue.document.round,
      reviewDigest: digest.value,
    },
    reviewedAt,
    idHighWater: { ...state.idHighWater },
    progress,
    frozenCarried: documentValue.blocks
      .map((block) => block.id)
      .filter((blockId) => effectiveFrozen.has(blockId)),
    reopened: [...state.reopened],
    decisions: [...state.decisionsByBlock.values()],
    sideNotes: [...state.sideNotesById.values()],
    topics: [...state.topicsById.values()],
    ...(state.overall === "" ? {} : { overall: state.overall }),
    stats,
  };
  candidate.semanticDigest = packetSemanticDigest(candidate);
  candidate.packetId = packetIdFromSemanticDigest(candidate.semanticDigest as Sha256Digest);
  return validateReviewPacket(candidate, documentValue);
}

export function buildReviewPacketExport(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  reviewedAt: string,
): ProtocolResult<ReviewPacketExport> {
  const packet = buildReviewPacket(documentValue, state, reviewedAt);
  if (!packet.ok) return packet;
  const json = serializeReviewPacketJson(packet.value, documentValue);
  if (!json.ok) return json;
  const markdown = serializeReviewPacketMarkdown(packet.value, documentValue);
  if (!markdown.ok) return markdown;
  return { ok: true, value: { packet: packet.value, json: json.value, markdown: markdown.value } };
}

export function createReviewPacketExportCache(
  documentValue: ReviewDocumentV1,
  now: () => Date = () => new Date(),
): ReviewPacketExportCache {
  let cached: ReviewPacketExportSnapshot | undefined;
  return {
    get(state) {
      const digest = computeWorkbenchStateDigest(documentValue, state);
      if (!digest.ok) return digest;
      if (cached?.stateDigest === digest.value) return { ok: true, value: cached };
      const packet = buildReviewPacketExport(documentValue, state, now().toISOString());
      if (!packet.ok) return packet;
      const snapshot: ReviewPacketExportSnapshot = {
        ...packet.value,
        stateDigest: digest.value,
        recordCount: packet.value.packet.decisions.length
          + packet.value.packet.sideNotes.length
          + packet.value.packet.topics.length
          + packet.value.packet.reopened.length
          + (packet.value.packet.overall === undefined ? 0 : 1),
      };
      cached = snapshot;
      return { ok: true, value: snapshot };
    },
    invalidate() {
      cached = undefined;
    },
  };
}
