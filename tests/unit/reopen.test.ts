import { describe, expect, it } from "vitest";
import { canReopenBlock, reopenFrozenBlock } from "../../src/workbench/reopen.js";
import {
  createInitialReviewState,
  reduceReviewState,
} from "../../src/workbench/reducer.js";
import { reviewProgress } from "../../src/workbench/selectors.js";
import { frozenReviewDocumentFixture } from "./persistence-fixtures.js";

describe("frozen block reopening", () => {
  it("@A08 reopens exactly one frozen block without changing immutable approval history", () => {
    const documentValue = frozenReviewDocumentFixture();
    const beforeDocument = structuredClone(documentValue);
    const initial = createInitialReviewState(documentValue);
    expect(canReopenBlock(documentValue, initial, "B004")).toBe(true);
    expect(reviewProgress(documentValue, initial)).toEqual({ decided: 0, total: 3, partial: true });
    const reopened = reopenFrozenBlock(documentValue, initial, "B004");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.state.reopened).toEqual(new Set(["B004"]));
    expect(reviewProgress(documentValue, reopened.state)).toEqual({ decided: 0, total: 4, partial: true });
    expect(documentValue).toEqual(beforeDocument);
    expect(canReopenBlock(documentValue, reopened.state, "B004")).toBe(false);
    expect(reopenFrozenBlock(documentValue, reopened.state, "B004")).toMatchObject({
      ok: false,
      code: "BLOCK_ALREADY_REOPENED",
      state: reopened.state,
    });
  });

  it("@A17 permits a reopened block decision and CLEAR keeps history outside state", () => {
    const documentValue = frozenReviewDocumentFixture();
    const reopened = reopenFrozenBlock(documentValue, createInitialReviewState(documentValue), "B004");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const passed = reduceReviewState(documentValue, reopened.state, {
      type: "SET_DECISION",
      blockId: "B004",
      decision: { action: "PASS" },
    });
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.state.decisionsByBlock.get("B004")).toEqual({ blockId: "B004", action: "PASS" });
    const cleared = reduceReviewState(documentValue, passed.state, { type: "CLEAR_REVIEW" });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.state.reopened.size).toBe(0);
      expect(cleared.state.decisionsByBlock.size).toBe(0);
      expect(documentValue.approvals.history).toHaveLength(1);
      expect(documentValue.approvals.currentFrozen).toEqual(["B004"]);
    }
  });
});
