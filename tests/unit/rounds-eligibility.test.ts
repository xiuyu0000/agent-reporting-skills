import { describe, expect, it } from "vitest";
import {
  deriveExecutionEligibility,
  validateTransition,
} from "../../src/protocol/transition/index.js";
import {
  candidateBase,
  freezeBlocks,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "./rounds-fixtures.js";

describe("round execution eligibility and reopen behavior", () => {
  it("A16_transitive_hold suspends every transitive downstream while retaining approvals", () => {
    const document = reviewFixture();
    const decisions = [
      { blockId: "B001", action: "HOLD" as const, note: "Need another source." },
      { blockId: "B002", action: "PASS" as const },
      { blockId: "B003", action: "PASS" as const },
      { blockId: "B004", action: "PASS" as const },
    ];
    const result = deriveExecutionEligibility({ document, decisions });
    expect(result).toEqual({
      ok: true,
      value: {
        eligibleBlockIds: ["B004"],
        suspendedBlockIds: ["B001", "B002", "B003"],
      },
    });
  });

  it("preserves frozen approvals but suspends dependents of a reopened undecided block", () => {
    const document = reviewFixture();
    freezeBlocks(document, document.blocks.map((block) => block.id));
    const result = deriveExecutionEligibility({ document, reopened: ["B001"] });
    expect(result).toEqual({
      ok: true,
      value: {
        eligibleBlockIds: ["B004"],
        suspendedBlockIds: ["B001", "B002", "B003"],
      },
    });
    expect(document.approvals.history).toHaveLength(4);
  });

  it("derives a sorted partition without modifying document or overlay inputs", () => {
    const document = reviewFixture();
    const decisions = [
      { blockId: "B004", action: "PASS" as const },
      { blockId: "B001", action: "PASS" as const },
    ];
    const input = { document, decisions };
    const before = structuredClone(input);
    const result = deriveExecutionEligibility(input);
    expect(result).toEqual({
      ok: true,
      value: {
        eligibleBlockIds: ["B001", "B004"],
        suspendedBlockIds: ["B002", "B003"],
      },
    });
    expect(input).toEqual(before);
  });

  it("A17_reapprove_reopened keeps history on a partial reopen and re-freezes on PASS", () => {
    const current = reviewFixture();
    freezeBlocks(current, current.blocks.map((block) => block.id));
    current.document.round = 2;
    current.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;

    const partialPacket = makePacket(current, { reopened: ["B004"] });
    const partialCandidate = candidateBase(current, partialPacket);
    setContentVersion(current, partialCandidate);
    const partial = validateTransition({ current, packet: partialPacket, candidate: partialCandidate });
    expect(partial).toEqual(expect.objectContaining({ ok: true }));
    if (!partial.ok || partial.value.status !== "apply") return;
    expect(partial.value.candidate.document.status).toBe("in-review");
    expect(partial.value.candidate.approvals.history).toEqual(current.approvals.history);
    expect(partial.value.candidate.approvals.currentFrozen).not.toContain("B004");
    expect(partial.value.suspendedBlockIds).toContain("B004");

    const passPacket = makePacket(current, {
      reopened: ["B004"],
      decisions: [{ blockId: "B004", action: "PASS" }],
    });
    const passCandidate = candidateBase(current, passPacket);
    passCandidate.document.status = "finalized";
    setContentVersion(current, passCandidate);
    const passed = validateTransition({ current, packet: passPacket, candidate: passCandidate });
    expect(passed).toEqual(expect.objectContaining({ ok: true }));
    if (!passed.ok || passed.value.status !== "apply") return;
    expect(passed.value.candidate.approvals.history).toHaveLength(5);
    expect(passed.value.candidate.approvals.history.at(-1)).toEqual(
      expect.objectContaining({ blockId: "B004", approvedRound: 2 }),
    );
    expect(passed.value.candidate.approvals.currentFrozen).toContain("B004");
    expect(passed.value.eligibleBlockIds).toEqual(["B001", "B002", "B003", "B004"]);
  });

  it("fails closed for unknown, duplicate, frozen-without-reopen, and malformed overlay inputs", () => {
    const document = reviewFixture();
    freezeBlocks(document, ["B004"]);
    const cases = [
      deriveExecutionEligibility({ document, reopened: ["B999"] }),
      deriveExecutionEligibility({ document, reopened: ["B004", "B004"] }),
      deriveExecutionEligibility({ document, decisions: [{ blockId: "B004", action: "PASS" }] }),
      deriveExecutionEligibility({ document, decisions: [{ blockId: "B999", action: "PASS" }] }),
      deriveExecutionEligibility({ document, decisions: [{ blockId: "B001", action: "EDIT", note: "" }] }),
      deriveExecutionEligibility({ document, decisions: [{ blockId: "B001", action: "TOPIC", topicId: "bad" }] }),
      deriveExecutionEligibility({ document, decisions: [null] as never }),
    ];
    for (const result of cases) {
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }
  });
});
