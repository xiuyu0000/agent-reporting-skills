import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blockContentDigest,
  documentContentDigest,
  feedbackDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  reviewDigest,
  type ReviewDecision,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";

export type PacketTopic = ReviewPacketV1["topics"][number];
export type PacketSideNote = ReviewPacketV1["sideNotes"][number];

export function reviewFixture(): ReviewDocumentV1 {
  return JSON.parse(
    readFileSync(resolve("tests/fixtures/protocol/review-document.json"), "utf8"),
  ) as ReviewDocumentV1;
}

function numericSuffix(value: string): number {
  return Number(/(\d+)$/.exec(value)?.[1] ?? 0);
}

export function makePacket(
  document: ReviewDocumentV1,
  input: {
    decisions?: readonly ReviewDecision[];
    reopened?: readonly string[];
    sideNotes?: readonly PacketSideNote[];
    topics?: readonly PacketTopic[];
    overall?: string;
  } = {},
): ReviewPacketV1 {
  const decisions = [...structuredClone(input.decisions ?? [])] as ReviewDecision[];
  const reopened = [...(input.reopened ?? [])];
  const sideNotes = [...structuredClone(input.sideNotes ?? [])] as PacketSideNote[];
  const topics = [...structuredClone(input.topics ?? [])] as PacketTopic[];
  const frozenCarried = document.approvals.currentFrozen.filter((id) => !reopened.includes(id));
  const packet: ReviewPacketV1 = {
    format: "review-packet/1",
    packetId: `RP-${"0".repeat(20)}`,
    semanticDigest: `sha256:${"0".repeat(64)}`,
    doc: {
      id: document.document.id,
      title: document.document.title,
      contentVersion: document.document.contentVersion,
      round: document.document.round,
      reviewDigest: reviewDigest(document),
    },
    reviewedAt: "2026-08-12T10:00:00Z",
    idHighWater: {
      ...document.lineage.idHighWater,
      note: Math.max(
        document.lineage.idHighWater.note,
        ...sideNotes.map((note) => numericSuffix(note.id)),
      ),
      topic: Math.max(
        document.lineage.idHighWater.topic,
        ...topics.map((topic) => numericSuffix(topic.id)),
      ),
    },
    progress: {
      decided: decisions.length,
      total: document.blocks.length - frozenCarried.length,
      partial: decisions.length < document.blocks.length - frozenCarried.length,
    },
    frozenCarried,
    reopened,
    decisions,
    sideNotes,
    topics,
    ...(input.overall === undefined ? {} : { overall: input.overall }),
    stats: { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 },
  };
  for (const decision of packet.decisions) packet.stats[decision.action] += 1;
  packet.semanticDigest = packetSemanticDigest(packet);
  packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
  return packet;
}

export function candidateBase(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
): ReviewDocumentV1 {
  const candidate = structuredClone(current);
  candidate.document.round += 1;
  candidate.document.status = "in-review";
  candidate.lineage.previousReviewDigest = reviewDigest(current);
  candidate.lineage.consumedPackets.push({
    packetId: packet.packetId,
    semanticDigest: packet.semanticDigest,
  });
  for (const block of candidate.blocks) delete block.changed;
  const frozen = new Set(current.approvals.currentFrozen);
  for (const blockId of packet.reopened) frozen.delete(blockId);
  for (const decision of packet.decisions) {
    if (decision.action === "PASS") {
      const block = candidate.blocks.find((item) => item.id === decision.blockId);
      if (block !== undefined) {
        candidate.approvals.history.push({
          blockId: decision.blockId,
          approvedRound: current.document.round,
          approvedContentDigest: blockContentDigest(block),
        });
        frozen.add(decision.blockId);
      }
    } else {
      frozen.delete(decision.blockId);
    }
  }
  candidate.approvals.currentFrozen = [...frozen];
  for (const key of Object.keys(candidate.lineage.idHighWater) as Array<keyof typeof candidate.lineage.idHighWater>) {
    candidate.lineage.idHighWater[key] = Math.max(
      candidate.lineage.idHighWater[key],
      packet.idHighWater[key],
    );
  }
  return candidate;
}

export function setContentVersion(
  current: ReviewDocumentV1,
  candidate: ReviewDocumentV1,
): void {
  candidate.document.contentVersion = documentContentDigest(current) === documentContentDigest(candidate)
    ? current.document.contentVersion
    : current.document.contentVersion + 1;
}

export function freezeBlocks(
  document: ReviewDocumentV1,
  blockIds: readonly string[],
): void {
  for (const blockId of blockIds) {
    const block = document.blocks.find((item) => item.id === blockId);
    if (block === undefined) throw new Error(`Unknown block ${blockId}`);
    document.approvals.history.push({
      blockId,
      approvedRound: document.document.round,
      approvedContentDigest: blockContentDigest(block),
    });
  }
  document.approvals.currentFrozen = [...blockIds];
  document.document.status = blockIds.length === document.blocks.length ? "finalized" : "in-review";
}

export function addFeedbackResolutions(
  candidate: ReviewDocumentV1,
  packet: ReviewPacketV1,
  conversions: Readonly<Record<string, string>> = {},
): void {
  for (const note of packet.sideNotes) {
    const targetBlockId = conversions[note.id];
    candidate.lineage.feedbackResolutions.push(targetBlockId === undefined
      ? {
          sourcePacketId: packet.packetId,
          feedbackId: note.id,
          feedbackDigest: feedbackDigest({
            kind: "side-note",
            feedbackId: note.id,
            blockId: note.blockId,
            text: note.note,
          }),
          disposition: "context-only",
          reason: "Retained as review context.",
        }
      : {
          sourcePacketId: packet.packetId,
          feedbackId: note.id,
          feedbackDigest: feedbackDigest({
            kind: "side-note",
            feedbackId: note.id,
            blockId: note.blockId,
            text: note.note,
          }),
          disposition: "converted-to-block",
          targetBlockId,
          reason: "Converted into an explicit review block.",
        });
  }
  if (packet.overall !== undefined) {
    const targetBlockId = conversions.OVERALL;
    candidate.lineage.feedbackResolutions.push(targetBlockId === undefined
      ? {
          sourcePacketId: packet.packetId,
          feedbackId: "OVERALL",
          feedbackDigest: feedbackDigest({
            kind: "overall",
            feedbackId: "OVERALL",
            text: packet.overall,
          }),
          disposition: "context-only",
          reason: "Retained as overall context.",
        }
      : {
          sourcePacketId: packet.packetId,
          feedbackId: "OVERALL",
          feedbackDigest: feedbackDigest({
            kind: "overall",
            feedbackId: "OVERALL",
            text: packet.overall,
          }),
          disposition: "converted-to-block",
          targetBlockId,
          reason: "Converted into an explicit review block.",
        });
  }
}

export function topicDerivedDocument(
  source: ReviewDocumentV1,
  suffix: string,
): ReviewDocumentV1 {
  const document = structuredClone(source);
  document.delivery.id = `RDL-${suffix.repeat(20).slice(0, 20)}`;
  document.delivery.baseName = `topic_${suffix}`;
  document.delivery.outputs = {
    agent: `topic_${suffix}_AGENT.md`,
    approval: `topic_${suffix}_APPROVAL.html`,
  };
  document.document.id = `RD-${suffix.repeat(20).slice(0, 20)}`;
  document.document.title = `Derived topic ${suffix}`;
  document.document.round = 1;
  document.document.contentVersion = 1;
  document.document.status = "in-review";
  document.lineage.previousReviewDigest = null;
  document.lineage.consumedPackets = [];
  document.lineage.topicMappings = [];
  document.lineage.impactAssessments = [];
  document.lineage.feedbackResolutions = [];
  document.approvals.history = [];
  document.approvals.currentFrozen = [];
  for (const block of document.blocks) delete block.changed;
  return document;
}
