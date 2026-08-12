import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockContentDigest,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import {
  createInitialReviewState,
  reduceReviewState,
  type ReviewAction,
  type WorkbenchReviewState,
} from "../../src/workbench/reducer.js";
import {
  activeBlockIds,
  bulkPassPreview,
  executionEligibility,
  nextBlockId,
  nextPendingBlockId,
  pendingBlockIds,
  reviewProgress,
  reviewStats,
  visibleBlockIds,
} from "../../src/workbench/selectors.js";

function documentFixture(): ReviewDocumentV1 {
  return JSON.parse(readFileSync(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

function apply(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  action: ReviewAction,
): WorkbenchReviewState {
  const result = reduceReviewState(documentValue, state, action);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

function eligibility(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): { readonly eligibleBlockIds: readonly string[]; readonly suspendedBlockIds: readonly string[] } {
  const result = executionEligibility(documentValue, state);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => error.code).join(","));
  return result.value;
}

describe("review selectors", () => {
  it("derives active progress, pending navigation, and stats", () => {
    const documentValue = documentFixture();
    documentValue.approvals.currentFrozen = ["B004"];
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "EDIT", note: "Change" },
    });
    expect(activeBlockIds(documentValue, state)).toEqual(["B001", "B002", "B003"]);
    expect(reviewProgress(documentValue, state)).toEqual({ decided: 2, total: 3, partial: true });
    expect(pendingBlockIds(documentValue, state)).toEqual(["B003"]);
    expect(nextPendingBlockId(documentValue, state, "B002")).toBe("B003");
    expect(reviewStats(state)).toEqual({ PASS: 1, EDIT: 1, TOPIC: 0, HOLD: 0 });
  });

  it("filters and searches block, decision, side-note, and topic text", () => {
    const documentValue = documentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "EDIT", note: "Make arrays deterministic" },
    });
    state = apply(documentValue, state, {
      type: "SET_SIDE_NOTE",
      blockId: "B003",
      note: "closure observation",
    });
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B004",
      decision: { action: "TOPIC", title: "Migration follow-up" },
    });

    expect(visibleBlockIds(documentValue, state, "pending", "")).toEqual(["B001", "B003"]);
    expect(visibleBlockIds(documentValue, state, "t2", "")).toEqual(["B001"]);
    expect(visibleBlockIds(documentValue, state, "annotated", "")).toEqual(["B002", "B003", "B004"]);
    expect(visibleBlockIds(documentValue, state, "all", "deterministic")).toEqual(["B002"]);
    expect(visibleBlockIds(documentValue, state, "all", "observation")).toEqual(["B003"]);
    expect(visibleBlockIds(documentValue, state, "all", "follow-up")).toEqual(["B004"]);
    expect(visibleBlockIds(documentValue, state, "all", "B001")).toEqual(["B001"]);
  });

  it("previews bulk scope without T2, frozen, or previously decided blocks", () => {
    const documentValue = documentFixture();
    documentValue.approvals.currentFrozen = ["B004"];
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "HOLD", note: "Wait" },
    });
    expect(bulkPassPreview(documentValue, state, ["B001", "B002", "B003", "B004"]))
      .toEqual({ blockIds: ["B003"], t0: 1, t1: 0, excludedT2: 1 });
  });

  it("wraps forward and backward block navigation", () => {
    const ids = ["B001", "B002", "B003"];
    expect(nextBlockId(ids, "B003", 1)).toBe("B001");
    expect(nextBlockId(ids, "B001", -1)).toBe("B003");
    expect(nextBlockId(ids, undefined, 1)).toBe("B001");
    expect(nextBlockId([], "B001", 1)).toBeUndefined();
  });

  it("finds the next pending block by document order after the current block becomes decided", () => {
    const documentValue = documentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "PASS" },
    });
    expect(nextPendingBlockId(documentValue, state, "B002")).toBe("B003");
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B003",
      decision: { action: "PASS" },
    });
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B004",
      decision: { action: "PASS" },
    });
    expect(nextPendingBlockId(documentValue, state, "B004")).toBe("B001");
  });

  it("uses the transition facade for transitive execution eligibility", () => {
    const documentValue = documentFixture();
    let state = createInitialReviewState(documentValue);
    expect(eligibility(documentValue, state)).toEqual({
      eligibleBlockIds: [],
      suspendedBlockIds: ["B001", "B002", "B003", "B004"],
    });

    for (const blockId of ["B001", "B002", "B003", "B004"]) {
      state = apply(documentValue, state, {
        type: "SET_DECISION",
        blockId,
        decision: { action: "PASS" },
      });
    }
    expect(eligibility(documentValue, state)).toEqual({
      eligibleBlockIds: ["B001", "B002", "B003", "B004"],
      suspendedBlockIds: [],
    });

    const blockingDecisions = [
      { action: "EDIT" as const, note: "Change the root" },
      { action: "HOLD" as const, note: "Answer the root question" },
      { action: "TOPIC" as const, title: "Separate root topic" },
    ];
    for (const decision of blockingDecisions) {
      const blocked = apply(documentValue, state, {
        type: "SET_DECISION",
        blockId: "B001",
        decision,
      });
      expect(eligibility(documentValue, blocked)).toEqual({
        eligibleBlockIds: ["B004"],
        suspendedBlockIds: ["B001", "B002", "B003"],
      });
    }

    const pending = apply(documentValue, state, { type: "UNSET_DECISION", blockId: "B001" });
    expect(eligibility(documentValue, pending)).toEqual({
      eligibleBlockIds: ["B004"],
      suspendedBlockIds: ["B001", "B002", "B003"],
    });
  });

  it("keeps immutable approvals while a reopened root suspends its frozen downstream", () => {
    const documentValue = documentFixture();
    documentValue.approvals.history = documentValue.blocks.map((block) => ({
      blockId: block.id,
      approvedRound: documentValue.document.round,
      approvedContentDigest: blockContentDigest(block),
    }));
    documentValue.approvals.currentFrozen = documentValue.blocks.map((block) => block.id);
    const initial = createInitialReviewState(documentValue);
    const reopened: WorkbenchReviewState = {
      ...initial,
      reopened: new Set(["B001"]),
    };
    expect(eligibility(documentValue, reopened)).toEqual({
      eligibleBlockIds: ["B004"],
      suspendedBlockIds: ["B001", "B002", "B003"],
    });
    expect(documentValue.approvals.currentFrozen).toEqual(["B001", "B002", "B003", "B004"]);

    const repassed = apply(documentValue, reopened, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    expect(eligibility(documentValue, repassed)).toEqual({
      eligibleBlockIds: ["B001", "B002", "B003", "B004"],
      suspendedBlockIds: [],
    });

    const invalidOverlay: WorkbenchReviewState = {
      ...initial,
      reopened: new Set(["B999"]),
    };
    expect(executionEligibility(documentValue, invalidOverlay).ok).toBe(false);
  });
});
