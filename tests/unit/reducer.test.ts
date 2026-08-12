import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  createInitialReviewState,
  normalizeQuote,
  reduceReviewState,
  type WorkbenchReviewState,
} from "../../src/workbench/reducer.js";

function documentFixture(): ReviewDocumentV1 {
  return JSON.parse(readFileSync(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

function apply(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  action: Parameters<typeof reduceReviewState>[2],
): WorkbenchReviewState {
  const result = reduceReviewState(documentValue, state, action);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

describe("review reducer", () => {
  it("sets, overwrites, and unsets decisions without mutating prior snapshots", () => {
    const documentValue = documentFixture();
    const initial = createInitialReviewState(documentValue);
    const passed = apply(documentValue, initial, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS", quote: "  selected\n text  " },
    });
    expect(initial.decisionsByBlock.size).toBe(0);
    expect(passed.decisionsByBlock.get("B001")).toEqual({
      blockId: "B001",
      action: "PASS",
      quote: "selected text",
    });

    const edited = apply(documentValue, passed, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "EDIT", note: "  Change the boundary.  " },
    });
    expect(edited.decisionsByBlock.get("B001")).toEqual({
      blockId: "B001",
      action: "EDIT",
      note: "Change the boundary.",
    });
    const undone = apply(documentValue, edited, { type: "UNSET_DECISION", blockId: "B001" });
    expect(undone.decisionsByBlock.has("B001")).toBe(false);
  });

  it("rejects missing required input and frozen blocks atomically", () => {
    const documentValue = documentFixture();
    documentValue.approvals.currentFrozen = ["B004"];
    const initial = createInitialReviewState(documentValue);
    for (const action of [
      {
        type: "SET_DECISION" as const,
        blockId: "B001",
        decision: { action: "EDIT" as const, note: "   " },
      },
      {
        type: "SET_DECISION" as const,
        blockId: "B001",
        decision: { action: "TOPIC" as const, title: "   " },
      },
      {
        type: "SET_DECISION" as const,
        blockId: "B004",
        decision: { action: "PASS" as const },
      },
    ]) {
      const result = reduceReviewState(documentValue, initial, action);
      expect(result.ok).toBe(false);
      expect(result.state).toBe(initial);
    }
  });

  it("keeps a TOPIC decision and its topic entry as one atomic pair", () => {
    const documentValue = documentFixture();
    const initial = createInitialReviewState(documentValue);
    const first = apply(documentValue, initial, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "TOPIC", title: "New approval path", note: "Independent scope" },
    });
    expect(first.idHighWater.topic).toBe(1);
    expect(first.decisionsByBlock.get("B001")).toEqual({
      blockId: "B001",
      action: "TOPIC",
      topicId: "TOP-001",
    });
    expect(first.topicsById.get("TOP-001")).toEqual({
      id: "TOP-001",
      title: "New approval path",
      note: "Independent scope",
      sourceBlockId: "B001",
    });

    const updated = apply(documentValue, first, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "TOPIC", title: "Renamed path" },
    });
    expect(updated.idHighWater.topic).toBe(1);
    expect(updated.topicsById.get("TOP-001")?.title).toBe("Renamed path");

    const changedId = apply(documentValue, updated, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "TOPIC", title: "Replacement", topicId: "TOP-002" },
    });
    expect(changedId.idHighWater.topic).toBe(2);
    expect(changedId.topicsById.has("TOP-001")).toBe(false);
    expect(changedId.topicsById.has("TOP-002")).toBe(true);

    const replaced = apply(documentValue, changedId, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "HOLD", note: "Need evidence" },
    });
    expect(replaced.topicsById.size).toBe(0);
    expect(replaced.decisionsByBlock.get("B001")?.action).toBe("HOLD");
  });

  it("deletes either side of a block TOPIC pair together", () => {
    const documentValue = documentFixture();
    const topic = apply(documentValue, createInitialReviewState(documentValue), {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "TOPIC", title: "Derived" },
    });
    const deletedByTopic = apply(documentValue, topic, {
      type: "DELETE_TOPIC",
      topicId: "TOP-001",
    });
    expect(deletedByTopic.topicsById.size).toBe(0);
    expect(deletedByTopic.decisionsByBlock.size).toBe(0);

    const recreated = apply(documentValue, deletedByTopic, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "TOPIC", title: "Derived again" },
    });
    expect(recreated.decisionsByBlock.get("B002")).toMatchObject({ topicId: "TOP-002" });
    const deletedByDecision = apply(documentValue, recreated, {
      type: "UNSET_DECISION",
      blockId: "B002",
    });
    expect(deletedByDecision.topicsById.size).toBe(0);
    expect(deletedByDecision.idHighWater.topic).toBe(2);
  });

  it("manages side notes, global topics, and overall text without reusing IDs", () => {
    const documentValue = documentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      note: " First note ",
    });
    state = apply(documentValue, state, {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      noteId: "NOTE-001",
      note: "Edited note",
    });
    expect(state.sideNotesById.get("NOTE-001")?.note).toBe("Edited note");
    state = apply(documentValue, state, { type: "DELETE_SIDE_NOTE", noteId: "NOTE-001" });
    expect(state.idHighWater.note).toBe(1);

    state = apply(documentValue, state, { type: "ADD_TOPIC", title: " Global idea " });
    expect(state.topicsById.get("TOP-001")).toEqual({ id: "TOP-001", title: "Global idea" });
    state = apply(documentValue, state, {
      type: "UPDATE_TOPIC",
      topicId: "TOP-001",
      title: "Updated idea",
      note: "Later",
    });
    state = apply(documentValue, state, { type: "SET_OVERALL", overall: "  Overall  " });
    expect(state.topicsById.get("TOP-001")?.note).toBe("Later");
    expect(state.overall).toBe("Overall");
  });

  it("bulk passes only a validated pending T0/T1 set", () => {
    const documentValue = documentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "HOLD", note: "Already decided" },
    });
    const rejected = reduceReviewState(documentValue, state, {
      type: "BULK_PASS",
      blockIds: ["B001", "B003"],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.state).toBe(state);

    const passed = apply(documentValue, state, {
      type: "BULK_PASS",
      blockIds: ["B003", "B004"],
    });
    expect(passed.decisionsByBlock.get("B001")).toBeUndefined();
    expect(passed.decisionsByBlock.get("B002")?.action).toBe("HOLD");
    expect(passed.decisionsByBlock.get("B003")?.action).toBe("PASS");
    expect(passed.decisionsByBlock.get("B004")?.action).toBe("PASS");
  });

  it("normalizes quote whitespace without truncating the machine-authoritative text", () => {
    const original = `${"a".repeat(500)}\n${"z".repeat(500)}`;
    const normalized = normalizeQuote(original);
    expect(normalized).toBe(`${"a".repeat(500)} ${"z".repeat(500)}`);
    expect(Array.from(normalized ?? "")).toHaveLength(1_001);

    const documentValue = documentFixture();
    const state = apply(documentValue, createInitialReviewState(documentValue), {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS", quote: original },
    });
    expect(state.decisionsByBlock.get("B001")?.quote).toBe(normalized);
  });
});
