import { describe, expect, it } from "vitest";
import {
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  type ProtocolErrorCode,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";
import { validateTransition } from "../../src/protocol/transition/index.js";
import {
  addFeedbackResolutions,
  candidateBase,
  freezeBlocks,
  makePacket,
  reviewFixture,
  setContentVersion,
  topicDerivedDocument,
} from "./rounds-fixtures.js";

function expectCode(
  result: ReturnType<typeof validateTransition>,
  code: ProtocolErrorCode,
): void {
  expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
  expect(result.ok ? [] : result.errors).toContainEqual(expect.objectContaining({ code }));
  expect(result).not.toHaveProperty("value");
}

function simpleCandidate(current: ReviewDocumentV1, packet: ReviewPacketV1): ReviewDocumentV1 {
  const candidate = candidateBase(current, packet);
  setContentVersion(current, candidate);
  return candidate;
}

function mutateBlock(candidate: ReviewDocumentV1, index: number, text: string): void {
  candidate.blocks[index]!.summary = text;
  candidate.blocks[index]!.changed = {
    round: candidate.document.round,
    summary: `Changed ${candidate.blocks[index]!.id}.`,
  };
}

describe("transition envelope and lifecycle fail closed", () => {
  it("rejects malformed top-level envelopes without invoking accessors or proxies", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    let gets = 0;
    const accessor = { packet } as Record<string, unknown>;
    Object.defineProperty(accessor, "current", {
      enumerable: true,
      get() {
        gets += 1;
        throw new Error("must not execute");
      },
    });
    const extra = { current, packet, "bad~/key": true };
    const symbolKey = { current, packet } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("extra")] = true;
    const nonEnumerable = { current, packet };
    Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
    const throwingDescriptors = new Proxy({ current, packet }, {
      ownKeys() {
        throw new Error("descriptor failure");
      },
    });
    class ForeignEnvelope {
      current = current;
      packet = packet;
    }
    for (const value of [
      null,
      [],
      new ForeignEnvelope(),
      {},
      extra,
      symbolKey,
      nonEnumerable,
      accessor,
      throwingDescriptors,
    ]) {
      expect(validateTransition(value as never)).toEqual(
        expect.objectContaining({ ok: false, mutated: false }),
      );
    }
    expect(gets).toBe(0);
  });

  it("rejects draft and lifecycle-inconsistent current documents", () => {
    const draft = reviewFixture();
    draft.document.status = "draft";
    expectCode(validateTransition({ current: draft, packet: makePacket(draft) }), "DECISION_APPLICATION_INVALID");

    const allFrozenInReview = reviewFixture();
    freezeBlocks(allFrozenInReview, allFrozenInReview.blocks.map((block) => block.id));
    allFrozenInReview.document.status = "in-review";
    expectCode(
      validateTransition({ current: allFrozenInReview, packet: makePacket(allFrozenInReview) }),
      "FINALIZATION_INVALID",
    );

    const finalizedWithChange = reviewFixture();
    freezeBlocks(finalizedWithChange, finalizedWithChange.blocks.map((block) => block.id));
    finalizedWithChange.document.round = 2;
    finalizedWithChange.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
    finalizedWithChange.blocks[0]!.changed = { round: 2, summary: "Stale display marker." };
    expectCode(
      validateTransition({ current: finalizedWithChange, packet: makePacket(finalizedWithChange) }),
      "FINALIZATION_INVALID",
    );

    const duplicateDerivedIdentity = reviewFixture();
    duplicateDerivedIdentity.lineage.topicMappings.push(
      {
        topicId: "TOP-001",
        derivedDocumentId: "RD-AAAAAAAAAAAAAAAAAAAA",
        derivedDeliveryId: "RDL-AAAAAAAAAAAAAAAAAAAA",
      },
      {
        topicId: "TOP-002",
        derivedDocumentId: "RD-AAAAAAAAAAAAAAAAAAAA",
        derivedDeliveryId: "RDL-BBBBBBBBBBBBBBBBBBBB",
      },
    );
    duplicateDerivedIdentity.lineage.idHighWater.topic = 2;
    expectCode(
      validateTransition({
        current: duplicateDerivedIdentity,
        packet: makePacket(duplicateDerivedIdentity),
      }),
      "DERIVED_TOPIC_INVALID",
    );
  });

  it("uses the transition-specific round error before generic context validation", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const candidate = candidateBase(current, packet);
    candidate.document.round = 3;
    expectCode(validateTransition({ current, packet, candidate }), "TRANSITION_ROUND_INVALID");
  });

  it("binds an unconsumed packet to the exact current document before candidate validation", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    packet.doc.title = "Another title";
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    expectCode(validateTransition({ current, packet, candidate: {} }), "IDENTITY_MISMATCH");
  });

  it("requires an explicit reopen before a finalized document can advance", () => {
    const current = reviewFixture();
    freezeBlocks(current, current.blocks.map((block) => block.id));
    expectCode(validateTransition({ current, packet: makePacket(current) }), "FINALIZATION_INVALID");
  });
});

describe("block ordering, ledger, high-water, and decision application", () => {
  it("rejects removal and reordering of existing blocks", () => {
    const currentWithFive = reviewFixture();
    const fifth = structuredClone(currentWithFive.blocks[3]!);
    fifth.id = "B005";
    fifth.title = "Fifth block";
    currentWithFive.blocks.push(fifth);
    currentWithFive.lineage.idHighWater.block = 5;
    const removalPacket = makePacket(currentWithFive);
    const removed = candidateBase(currentWithFive, removalPacket);
    removed.blocks.pop();
    setContentVersion(currentWithFive, removed);
    expectCode(
      validateTransition({ current: currentWithFive, packet: removalPacket, candidate: removed }),
      "TRANSITION_BLOCK_REMOVED",
    );

    const current = reviewFixture();
    const packet = makePacket(current);
    const reordered = candidateBase(current, packet);
    [reordered.blocks[0], reordered.blocks[1]] = [reordered.blocks[1]!, reordered.blocks[0]!];
    setContentVersion(current, reordered);
    expectCode(validateTransition({ current, packet, candidate: reordered }), "TRANSITION_BLOCK_REORDERED");
  });

  it("requires the exact consumed-packet append and exact mechanical high-water maximum", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const missingLedger = simpleCandidate(current, packet);
    missingLedger.lineage.consumedPackets = [];
    expectCode(
      validateTransition({ current, packet, candidate: missingLedger }),
      "DECISION_APPLICATION_INVALID",
    );

    const inflated = simpleCandidate(current, packet);
    inflated.lineage.idHighWater.source += 1;
    expectCode(validateTransition({ current, packet, candidate: inflated }), "HIGH_WATER_REGRESSION");
  });

  it("requires changed content for EDIT/HOLD and forbids changed content for PASS/TOPIC", () => {
    const current = reviewFixture();
    for (const decision of [
      { blockId: "B004", action: "EDIT" as const, note: "Change it." },
      { blockId: "B004", action: "HOLD" as const, note: "Answer it." },
    ]) {
      const packet = makePacket(current, { decisions: [decision] });
      expectCode(
        validateTransition({ current, packet, candidate: simpleCandidate(current, packet) }),
        "DECISION_APPLICATION_INVALID",
      );
    }

    const passPacket = makePacket(current, { decisions: [{ blockId: "B004", action: "PASS" }] });
    const changedPass = candidateBase(current, passPacket);
    mutateBlock(changedPass, 3, "A PASS cannot rewrite this block.");
    changedPass.approvals.history = [];
    changedPass.approvals.currentFrozen = [];
    setContentVersion(current, changedPass);
    expectCode(validateTransition({ current, packet: passPacket, candidate: changedPass }), "DECISION_APPLICATION_INVALID");

    const topic = { id: "TOP-001", title: "Derived", sourceBlockId: "B004" };
    const topicPacket = makePacket(current, {
      decisions: [{ blockId: "B004", action: "TOPIC", topicId: topic.id }],
      topics: [topic],
    });
    const changedTopic = candidateBase(current, topicPacket);
    mutateBlock(changedTopic, 3, "A TOPIC cannot rewrite this source block.");
    const derived = topicDerivedDocument(current, "C");
    changedTopic.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derived.document.id,
      derivedDeliveryId: derived.delivery.id,
    });
    setContentVersion(current, changedTopic);
    expectCode(
      validateTransition({
        current,
        packet: topicPacket,
        candidate: changedTopic,
        derived: [{ topicId: topic.id, document: derived }],
      }),
      "DECISION_APPLICATION_INVALID",
    );
  });

  it("enforces changed markers and untouched active/frozen protection", () => {
    const current = reviewFixture();
    const editPacket = makePacket(current, {
      decisions: [{ blockId: "B004", action: "EDIT", note: "Change it." }],
    });
    const missingMarker = candidateBase(current, editPacket);
    missingMarker.blocks[3]!.summary = "Changed without a marker.";
    setContentVersion(current, missingMarker);
    expectCode(validateTransition({ current, packet: editPacket, candidate: missingMarker }), "DECISION_APPLICATION_INVALID");

    const unchangedMarker = simpleCandidate(current, makePacket(current));
    unchangedMarker.blocks[3]!.changed = { round: 2, summary: "False marker." };
    expectCode(
      validateTransition({ current, packet: makePacket(current), candidate: unchangedMarker }),
      "DECISION_APPLICATION_INVALID",
    );

    const untouchedPacket = makePacket(current);
    const untouched = candidateBase(current, untouchedPacket);
    mutateBlock(untouched, 3, "Unrequested active-block change.");
    setContentVersion(current, untouched);
    expectCode(validateTransition({ current, packet: untouchedPacket, candidate: untouched }), "UNTOUCHED_BLOCK_CHANGED");

    const frozenCurrent = reviewFixture();
    freezeBlocks(frozenCurrent, ["B004"]);
    const frozenPacket = makePacket(frozenCurrent);
    const frozenChanged = candidateBase(frozenCurrent, frozenPacket);
    mutateBlock(frozenChanged, 3, "Unrequested frozen-block change.");
    frozenChanged.approvals.currentFrozen = [];
    setContentVersion(frozenCurrent, frozenChanged);
    expectCode(
      validateTransition({ current: frozenCurrent, packet: frozenPacket, candidate: frozenChanged }),
      "FROZEN_BLOCK_CHANGED",
    );

    const reopenPacket = makePacket(frozenCurrent, { reopened: ["B004"] });
    const reopenedUntouched = candidateBase(frozenCurrent, reopenPacket);
    mutateBlock(reopenedUntouched, 3, "Reopen alone does not authorize a content change.");
    setContentVersion(frozenCurrent, reopenedUntouched);
    expectCode(
      validateTransition({ current: frozenCurrent, packet: reopenPacket, candidate: reopenedUntouched }),
      "UNTOUCHED_BLOCK_CHANGED",
    );
  });

  it("accepts an explicit new block and rejects approval snapshots that do not apply PASS", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const withNew = candidateBase(current, packet);
    const newBlock = structuredClone(current.blocks[3]!);
    newBlock.id = "B005";
    newBlock.title = "Agent-proposed review block";
    newBlock.changed = { round: 2, summary: "Added as an explicit new approval item." };
    withNew.blocks.splice(2, 0, newBlock);
    withNew.lineage.idHighWater.block = 5;
    setContentVersion(current, withNew);
    expect(validateTransition({ current, packet, candidate: withNew })).toEqual(
      expect.objectContaining({ ok: true }),
    );

    const passPacket = makePacket(current, { decisions: [{ blockId: "B004", action: "PASS" }] });
    const missingApproval = candidateBase(current, passPacket);
    missingApproval.approvals.history = [];
    missingApproval.approvals.currentFrozen = [];
    setContentVersion(current, missingApproval);
    expectCode(
      validateTransition({ current, packet: passPacket, candidate: missingApproval }),
      "DECISION_APPLICATION_INVALID",
    );
  });
});

describe("impact, feedback, topics, and finalization invariants", () => {
  it("accepts an explicit nonconservative no-impact assessment but rejects missing/out-of-closure/incomplete ones", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B002", action: "EDIT", note: "Clarify it." }],
    });
    const noImpact = candidateBase(current, packet);
    mutateBlock(noImpact, 1, "Clarified without downstream semantic impact.");
    noImpact.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 2,
      affectedDownstreamIds: [],
      reason: "Only explanatory wording changed; the dependency contract is identical.",
      usedConservativeClosure: false,
    });
    setContentVersion(current, noImpact);
    expect(validateTransition({ current, packet, candidate: noImpact })).toEqual(
      expect.objectContaining({ ok: true }),
    );

    const missing = candidateBase(current, packet);
    mutateBlock(missing, 1, "Changed without impact assessment.");
    setContentVersion(current, missing);
    expectCode(validateTransition({ current, packet, candidate: missing }), "IMPACT_ASSESSMENT_INVALID");

    const outside = structuredClone(noImpact);
    outside.lineage.impactAssessments[0]!.affectedDownstreamIds = ["B004"];
    expectCode(validateTransition({ current, packet, candidate: outside }), "IMPACT_ASSESSMENT_INVALID");

    const incomplete = structuredClone(noImpact);
    incomplete.lineage.impactAssessments[0]!.usedConservativeClosure = true;
    expectCode(validateTransition({ current, packet, candidate: incomplete }), "IMPACT_ASSESSMENT_INVALID");

    const wrongRound = structuredClone(noImpact);
    wrongRound.lineage.impactAssessments[0]!.changedAtRound = 1;
    expectCode(validateTransition({ current, packet, candidate: wrongRound }), "IMPACT_ASSESSMENT_INVALID");
  });

  it("requires changed downstream blocks to appear in the upstream declared impact set", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [
        { blockId: "B001", action: "EDIT", note: "Change root." },
        { blockId: "B002", action: "EDIT", note: "Change child." },
      ],
    });
    const candidate = candidateBase(current, packet);
    mutateBlock(candidate, 0, "Changed root decision.");
    mutateBlock(candidate, 1, "Changed child decision.");
    candidate.lineage.impactAssessments.push(
      {
        upstreamBlockId: "B001",
        changedAtRound: 2,
        affectedDownstreamIds: ["B003"],
        reason: "Incorrectly omitted changed B002.",
        usedConservativeClosure: false,
      },
      {
        upstreamBlockId: "B002",
        changedAtRound: 2,
        affectedDownstreamIds: [],
        reason: "B002 wording does not change B003 semantics.",
        usedConservativeClosure: false,
      },
    );
    setContentVersion(current, candidate);
    expectCode(validateTransition({ current, packet, candidate }), "IMPACT_ASSESSMENT_INVALID");
  });

  it("requires an impact assessment when a newly added upstream has a new downstream", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const candidate = candidateBase(current, packet);
    const upstream = structuredClone(current.blocks[3]!);
    upstream.id = "B005";
    upstream.title = "New upstream";
    upstream.changed = { round: 2, summary: "Added a new upstream approval item." };
    const downstream = structuredClone(current.blocks[3]!);
    downstream.id = "B006";
    downstream.title = "New downstream";
    downstream.dependencies = [upstream.id];
    downstream.changed = { round: 2, summary: "Added a dependent approval item." };
    candidate.blocks.push(upstream, downstream);
    candidate.lineage.idHighWater.block = 6;
    setContentVersion(current, candidate);
    expectCode(validateTransition({ current, packet, candidate }), "IMPACT_ASSESSMENT_INVALID");

    candidate.lineage.impactAssessments.push({
      upstreamBlockId: upstream.id,
      changedAtRound: 2,
      affectedDownstreamIds: [downstream.id],
      reason: "The new downstream explicitly depends on the new upstream.",
      usedConservativeClosure: true,
    });
    expect(validateTransition({ current, packet, candidate })).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("requires every affected frozen downstream to be explicitly reopened in the packet", () => {
    const current = reviewFixture();
    freezeBlocks(current, ["B003"]);
    const packet = makePacket(current, {
      decisions: [{ blockId: "B002", action: "EDIT", note: "Change upstream." }],
    });
    const candidate = candidateBase(current, packet);
    mutateBlock(candidate, 1, "Changed upstream while B003 is frozen.");
    candidate.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 2,
      affectedDownstreamIds: ["B003"],
      reason: "B003 must be reviewed again.",
      usedConservativeClosure: true,
    });
    candidate.approvals.currentFrozen = [];
    setContentVersion(current, candidate);
    expectCode(validateTransition({ current, packet, candidate }), "IMPACT_ASSESSMENT_INVALID");

    const reopenedPacket = makePacket(current, {
      reopened: ["B003"],
      decisions: [{ blockId: "B002", action: "EDIT", note: "Change upstream." }],
    });
    const reopenedCandidate = candidateBase(current, reopenedPacket);
    mutateBlock(reopenedCandidate, 1, "Changed upstream while B003 is explicitly reopened.");
    reopenedCandidate.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 2,
      affectedDownstreamIds: ["B003"],
      reason: "B003 is explicitly reopened for review.",
      usedConservativeClosure: true,
    });
    setContentVersion(current, reopenedCandidate);
    expect(validateTransition({ current, packet: reopenedPacket, candidate: reopenedCandidate })).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("rejects PASS on an affected downstream while allowing EDIT, HOLD, and TOPIC after reopen", () => {
    const makeFrozenChain = (): ReviewDocumentV1 => {
      const current = reviewFixture();
      freezeBlocks(current, ["B003"]);
      current.document.round = 2;
      current.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
      return current;
    };
    const addUpstreamImpact = (candidate: ReviewDocumentV1): void => {
      mutateBlock(candidate, 1, "Changed frozen-chain upstream.");
      candidate.lineage.impactAssessments.push({
        upstreamBlockId: "B002",
        changedAtRound: 3,
        affectedDownstreamIds: ["B003"],
        reason: "B003 requires approval against the revised B002 semantics.",
        usedConservativeClosure: true,
      });
    };

    const passCurrent = makeFrozenChain();
    const passPacket = makePacket(passCurrent, {
      reopened: ["B003"],
      decisions: [
        { blockId: "B002", action: "EDIT", note: "Change upstream." },
        { blockId: "B003", action: "PASS" },
      ],
    });
    const passCandidate = candidateBase(passCurrent, passPacket);
    addUpstreamImpact(passCandidate);
    passCandidate.approvals.currentFrozen = [];
    setContentVersion(passCurrent, passCandidate);
    const rejectedPass = validateTransition({
      current: passCurrent,
      packet: passPacket,
      candidate: passCandidate,
    });
    expectCode(rejectedPass, "DECISION_APPLICATION_INVALID");
    expect(rejectedPass.ok ? [] : rejectedPass.errors).toContainEqual(expect.objectContaining({
      code: "DECISION_APPLICATION_INVALID",
      path: "/packet/decisions/1/blockId",
      blockId: "B003",
    }));

    for (const action of ["EDIT", "HOLD"] as const) {
      const current = makeFrozenChain();
      const packet = makePacket(current, {
        reopened: ["B003"],
        decisions: [
          { blockId: "B002", action: "EDIT", note: "Change upstream." },
          { blockId: "B003", action, note: `${action} affected downstream.` },
        ],
      });
      const candidate = candidateBase(current, packet);
      addUpstreamImpact(candidate);
      mutateBlock(candidate, 2, `${action} response for affected downstream.`);
      setContentVersion(current, candidate);
      expect(validateTransition({ current, packet, candidate })).toEqual(
        expect.objectContaining({ ok: true }),
      );
    }

    const topicCurrent = makeFrozenChain();
    const topic = { id: "TOP-001", title: "Affected downstream follow-up", sourceBlockId: "B003" };
    const topicPacket = makePacket(topicCurrent, {
      reopened: ["B003"],
      decisions: [
        { blockId: "B002", action: "EDIT", note: "Change upstream." },
        { blockId: "B003", action: "TOPIC", topicId: topic.id },
      ],
      topics: [topic],
    });
    const topicCandidate = candidateBase(topicCurrent, topicPacket);
    addUpstreamImpact(topicCandidate);
    const derived = topicDerivedDocument(topicCurrent, "F");
    topicCandidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derived.document.id,
      derivedDeliveryId: derived.delivery.id,
    });
    setContentVersion(topicCurrent, topicCandidate);
    expect(validateTransition({
      current: topicCurrent,
      packet: topicPacket,
      candidate: topicCandidate,
      derived: [{ topicId: topic.id, document: derived }],
    })).toEqual(expect.objectContaining({ ok: true }));
  });

  it("allows PASS when a nonconservative assessment explicitly declares no downstream impact", () => {
    const current = reviewFixture();
    freezeBlocks(current, ["B003"]);
    current.document.round = 2;
    current.lineage.previousReviewDigest = `sha256:${"b".repeat(64)}`;
    const packet = makePacket(current, {
      reopened: ["B003"],
      decisions: [
        { blockId: "B002", action: "EDIT", note: "Clarify wording without changing semantics." },
        { blockId: "B003", action: "PASS" },
      ],
    });
    const candidate = candidateBase(current, packet);
    mutateBlock(candidate, 1, "Clarified wording with no downstream semantic effect.");
    candidate.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 3,
      affectedDownstreamIds: [],
      reason: "The dependency contract consumed by B003 is unchanged.",
      usedConservativeClosure: false,
    });
    setContentVersion(current, candidate);

    const result = validateTransition({ current, packet, candidate });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.candidate.approvals.currentFrozen).toContain("B003");
    expect(result.value.candidate.approvals.history.at(-1)).toEqual(
      expect.objectContaining({ blockId: "B003", approvedRound: 2 }),
    );
    expect(result.value.suspendedBlockIds).toContain("B003");
  });

  it("validates feedback resolution digest, cardinality, and converted target rules", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      sideNotes: [{ id: "NOTE-001", blockId: "B004", note: "Make this explicit." }],
    });
    expectCode(
      validateTransition({ current, packet, candidate: simpleCandidate(current, packet) }),
      "FEEDBACK_RESOLUTION_INVALID",
    );

    const wrongDigest = candidateBase(current, packet);
    addFeedbackResolutions(wrongDigest, packet);
    wrongDigest.lineage.feedbackResolutions[0]!.feedbackDigest = `sha256:${"f".repeat(64)}`;
    setContentVersion(current, wrongDigest);
    expectCode(validateTransition({ current, packet, candidate: wrongDigest }), "FEEDBACK_RESOLUTION_INVALID");

    const invalidTarget = candidateBase(current, packet);
    mutateBlock(invalidTarget, 3, "Changed active target is not new or explicitly reopened.");
    addFeedbackResolutions(invalidTarget, packet, { "NOTE-001": "B004" });
    setContentVersion(current, invalidTarget);
    expectCode(validateTransition({ current, packet, candidate: invalidTarget }), "FEEDBACK_RESOLUTION_INVALID");
  });

  it("accepts feedback converted to a new block or an explicitly reopened frozen block", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      sideNotes: [{ id: "NOTE-001", blockId: "B004", note: "Create a separate control." }],
    });
    const withNew = candidateBase(current, packet);
    const newBlock = structuredClone(current.blocks[3]!);
    newBlock.id = "B005";
    newBlock.title = "New control";
    newBlock.changed = { round: 2, summary: "Converted NOTE-001 into a block." };
    withNew.blocks.push(newBlock);
    withNew.lineage.idHighWater.block = 5;
    addFeedbackResolutions(withNew, packet, { "NOTE-001": "B005" });
    setContentVersion(current, withNew);
    expect(validateTransition({ current, packet, candidate: withNew })).toEqual(
      expect.objectContaining({ ok: true }),
    );

    const frozenCurrent = reviewFixture();
    freezeBlocks(frozenCurrent, ["B004"]);
    const reopenPacket = makePacket(frozenCurrent, {
      reopened: ["B004"],
      sideNotes: [{ id: "NOTE-001", blockId: "B004", note: "Revise this frozen block." }],
    });
    const reopened = candidateBase(frozenCurrent, reopenPacket);
    mutateBlock(reopened, 3, "Changed after explicit reopen.");
    addFeedbackResolutions(reopened, reopenPacket, { "NOTE-001": "B004" });
    setContentVersion(frozenCurrent, reopened);
    expect(validateTransition({ current: frozenCurrent, packet: reopenPacket, candidate: reopened })).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("rejects missing, extra, duplicated, and non-initial derived topic proposals", () => {
    const current = reviewFixture();
    const topic = { id: "TOP-001", title: "Derived", sourceBlockId: "B004" };
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "TOPIC", topicId: topic.id }],
      topics: [topic],
    });
    const candidate = simpleCandidate(current, packet);
    const derived = topicDerivedDocument(current, "D");
    const malformedCases: unknown[] = [
      [null],
      [{ topicId: 1, document: derived }],
      [{ topicId: topic.id, document: {} }],
      [{ topicId: topic.id, document: derived, extra: true }],
    ];
    for (const derivedInput of malformedCases) {
      const result = validateTransition({ current, packet, candidate, derived: derivedInput as never });
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
      expect(result).not.toHaveProperty("value");
    }

    const semanticCases: unknown[] = [
      [],
      [
        { topicId: topic.id, document: derived },
        { topicId: topic.id, document: topicDerivedDocument(current, "E") },
      ],
      [{ topicId: topic.id, document: { ...derived, document: current.document } }],
      [{ topicId: topic.id, document: { ...derived, delivery: current.delivery } }],
    ];
    for (const derivedInput of semanticCases) {
      expectCode(
        validateTransition({ current, packet, candidate, derived: derivedInput as never }),
        "DERIVED_TOPIC_INVALID",
      );
    }

    const nonInitial = topicDerivedDocument(current, "F");
    nonInitial.document.round = 2;
    nonInitial.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
    expectCode(
      validateTransition({
        current,
        packet,
        candidate,
        derived: [{ topicId: topic.id, document: nonInitial }],
      }),
      "DERIVED_TOPIC_INVALID",
    );

    const markedInitial = topicDerivedDocument(current, "1");
    markedInitial.blocks[0]!.changed = { round: 1, summary: "Initial content is not a revision." };
    expect(validateTransition({
      current,
      packet,
      candidate,
      derived: [{ topicId: topic.id, document: markedInitial }],
    })).toEqual(expect.objectContaining({ ok: false, mutated: false }));
  });

  it("rejects extra derived topics and candidate topic mappings that are missing or wrong", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const candidate = simpleCandidate(current, packet);
    const extra = topicDerivedDocument(current, "A");
    expectCode(
      validateTransition({ current, packet, candidate, derived: [{ topicId: "TOP-001", document: extra }] }),
      "DERIVED_TOPIC_INVALID",
    );

    const topic = { id: "TOP-001", title: "Derived", sourceBlockId: "B004" };
    const topicPacket = makePacket(current, {
      decisions: [{ blockId: "B004", action: "TOPIC", topicId: topic.id }],
      topics: [topic],
    });
    const topicCandidate = simpleCandidate(current, topicPacket);
    const derived = topicDerivedDocument(current, "B");
    expectCode(
      validateTransition({
        current,
        packet: topicPacket,
        candidate: topicCandidate,
        derived: [{ topicId: topic.id, document: derived }],
      }),
      "DERIVED_TOPIC_INVALID",
    );
  });

  it("normalizes multiple derived topic proposals into Unicode topic-ID order", () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      topics: [
        { id: "TOP-002", title: "Second global topic" },
        { id: "TOP-001", title: "First global topic" },
      ],
    });
    const candidate = simpleCandidate(current, packet);
    const first = topicDerivedDocument(current, "A");
    const second = topicDerivedDocument(current, "B");
    candidate.lineage.topicMappings.push(
      {
        topicId: "TOP-002",
        derivedDocumentId: second.document.id,
        derivedDeliveryId: second.delivery.id,
      },
      {
        topicId: "TOP-001",
        derivedDocumentId: first.document.id,
        derivedDeliveryId: first.delivery.id,
      },
    );
    const result = validateTransition({
      current,
      packet,
      candidate,
      derived: [
        { topicId: "TOP-002", document: second },
        { topicId: "TOP-001", document: first },
      ],
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok || result.value.status !== "apply") return;
    expect(result.value.derived.map((item) => item.topicId)).toEqual(["TOP-001", "TOP-002"]);
  });

  it("rejects reuse of a document or delivery identity from a historical topic mapping", () => {
    const current = reviewFixture();
    const historical = topicDerivedDocument(current, "A");
    current.lineage.topicMappings.push({
      topicId: "TOP-001",
      derivedDocumentId: historical.document.id,
      derivedDeliveryId: historical.delivery.id,
    });
    current.lineage.idHighWater.topic = 1;
    const packet = makePacket(current, {
      topics: [{ id: "TOP-002", title: "Another global topic" }],
    });
    const candidate = simpleCandidate(current, packet);
    const reused = topicDerivedDocument(current, "A");
    candidate.lineage.topicMappings.push({
      topicId: "TOP-002",
      derivedDocumentId: reused.document.id,
      derivedDeliveryId: reused.delivery.id,
    });
    expectCode(
      validateTransition({
        current,
        packet,
        candidate,
        derived: [{ topicId: "TOP-002", document: reused }],
      }),
      "DERIVED_TOPIC_INVALID",
    );
  });

  it("rejects false finalization claims and failure to finalize a complete PASS", () => {
    const current = reviewFixture();
    const passPacket = makePacket(current, {
      decisions: current.blocks.map((block) => ({ blockId: block.id, action: "PASS" as const })),
    });
    const stillReviewing = simpleCandidate(current, passPacket);
    expectCode(validateTransition({ current, packet: passPacket, candidate: stillReviewing }), "FINALIZATION_INVALID");

    const partialPacket = makePacket(current);
    const falseFinal = simpleCandidate(current, partialPacket);
    falseFinal.document.status = "finalized";
    expectCode(validateTransition({ current, packet: partialPacket, candidate: falseFinal }), "FINALIZATION_INVALID");

    const draftCandidate = simpleCandidate(current, partialPacket);
    draftCandidate.document.status = "draft";
    expectCode(validateTransition({ current, packet: partialPacket, candidate: draftCandidate }), "FINALIZATION_INVALID");

    const changedFinal = candidateBase(current, passPacket);
    changedFinal.document.summary = "A semantic rewrite cannot accompany mechanical finalization.";
    changedFinal.document.status = "finalized";
    setContentVersion(current, changedFinal);
    expectCode(validateTransition({ current, packet: passPacket, candidate: changedFinal }), "FINALIZATION_INVALID");
  });
});
