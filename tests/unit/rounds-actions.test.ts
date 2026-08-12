import { describe, expect, it } from "vitest";
import {
  blockContentDigest,
  type ReviewDecision,
} from "../../src/protocol/index.js";
import { validateTransition } from "../../src/protocol/transition/index.js";
import {
  addFeedbackResolutions,
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
  topicDerivedDocument,
} from "./rounds-fixtures.js";

describe("round action transitions", () => {
  it("A04_edit_incremental changes only the EDIT block and suspends its active affected downstream", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B002", action: "EDIT", note: "Clarify the canonical rule." }],
    });
    const candidate = candidateBase(current, packet);
    candidate.blocks[1]!.summary = "Normalize set-like arrays using the frozen canonical rule.";
    candidate.blocks[1]!.changed = { round: 2, summary: "Clarified the canonical rule." };
    candidate.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 2,
      affectedDownstreamIds: ["B003"],
      reason: "B003 depends transitively on the canonical-array behavior.",
      usedConservativeClosure: true,
    });
    setContentVersion(current, candidate);

    const before = structuredClone({ current, packet, candidate });
    const result = validateTransition({ current, packet, candidate });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect({ current, packet, candidate }).toEqual(before);
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.candidate.blocks[0]).toEqual(current.blocks[0]);
    expect(result.value.candidate.blocks[2]).toEqual(current.blocks[2]);
    expect(result.value.candidate.blocks[3]).toEqual(current.blocks[3]);
    expect(result.value.candidate.approvals.currentFrozen).not.toContain("B003");
    expect(result.value.suspendedBlockIds).toEqual(["B001", "B002", "B003", "B004"]);
  });

  it("A05_hold_answer requires changed answer content and keeps the source active", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "HOLD", note: "Which legacy actions remain accepted?" }],
    });
    const candidate = candidateBase(current, packet);
    candidate.blocks[3]!.body = [{
      type: "paragraph",
      content: [{ type: "text", text: "Only TRIM and EXPAND migrate into EDIT." }],
    }];
    candidate.blocks[3]!.tier = "T1";
    candidate.blocks[3]!.changed = { round: 2, summary: "Answered and re-triaged legacy actions." };
    setContentVersion(current, candidate);

    const result = validateTransition({ current, packet, candidate });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.candidate.approvals.currentFrozen).not.toContain("B004");
    expect(result.value.candidate.document.contentVersion).toBe(2);
  });

  it("A06_topic_derivation maps exactly one derived proposal without changing or approving the source", () => {
    const current = reviewFixture();
    const topic = {
      id: "TOP-001",
      title: "Explore a migration assistant",
      sourceBlockId: "B004",
    };
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "TOPIC", topicId: topic.id }],
      topics: [topic],
    });
    const candidate = candidateBase(current, packet);
    const derivedDocument = topicDerivedDocument(current, "A");
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derivedDocument.document.id,
      derivedDeliveryId: derivedDocument.delivery.id,
    });
    setContentVersion(current, candidate);

    const result = validateTransition({
      current,
      packet,
      candidate,
      derived: [{ topicId: topic.id, document: derivedDocument }],
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.candidate.blocks[3]).toEqual(current.blocks[3]);
    expect(result.value.candidate.approvals.currentFrozen).not.toContain("B004");
    expect(result.value.derived).toHaveLength(1);
    expect(result.value.derived[0]?.topicId).toBe("TOP-001");
  });

  it("A07_finalize_unchanged freezes every PASS block without rewriting content", () => {
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const packet = makePacket(current, { decisions });
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);

    const result = validateTransition({ current, packet, candidate });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.candidate.document.contentVersion).toBe(1);
    expect(result.value.candidate.document.status).toBe("finalized");
    expect(result.value.candidate.blocks).toEqual(current.blocks);
    expect(result.value.candidate.approvals.currentFrozen).toEqual(["B001", "B002", "B003", "B004"]);
    expect(result.value.candidate.approvals.history).toEqual(current.blocks.map((block) => ({
      blockId: block.id,
      approvedRound: 1,
      approvedContentDigest: blockContentDigest(block),
    })));
    expect(result.value.eligibleBlockIds).toEqual(["B001", "B002", "B003", "B004"]);
    expect(result.value.suspendedBlockIds).toEqual([]);
  });

  it("A21_global_topic_idempotent derives one global topic and then permits finalization", () => {
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const topic = { id: "TOP-001", title: "Independent global follow-up" };
    const packet = makePacket(current, { decisions, topics: [topic] });
    const candidate = candidateBase(current, packet);
    const derivedDocument = topicDerivedDocument(current, "B");
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derivedDocument.document.id,
      derivedDeliveryId: derivedDocument.delivery.id,
    });
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);

    const applied = validateTransition({
      current,
      packet,
      candidate,
      derived: [{ topicId: topic.id, document: derivedDocument }],
    });
    expect(applied).toEqual(expect.objectContaining({ ok: true }));
    if (!applied.ok || applied.value.status !== "apply") return;
    const replay = validateTransition({ current: applied.value.candidate, packet });
    expect(replay).toEqual({
      ok: true,
      value: {
        status: "noop",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
      },
    });
  });

  it("resolves side notes and overall exactly once before applying a round", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      sideNotes: [{ id: "NOTE-001", blockId: "B003", note: "Retain deterministic order." }],
      overall: "Keep the review scope bounded.",
    });
    const candidate = candidateBase(current, packet);
    addFeedbackResolutions(candidate, packet);
    setContentVersion(current, candidate);
    expect(validateTransition({ current, packet, candidate })).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });
});
