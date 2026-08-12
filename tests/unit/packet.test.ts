import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReviewPacketMarkdown,
  validateReviewPacket,
} from "../../src/protocol/index.js";
import {
  buildReviewPacket,
  buildReviewPacketExport,
  createReviewPacketExportCache,
} from "../../src/workbench/packet.js";
import {
  createInitialReviewState,
  reduceReviewState,
} from "../../src/workbench/reducer.js";
import { frozenReviewDocumentFixture, reviewDocumentFixture } from "./persistence-fixtures.js";

interface EdgeText {
  readonly decisionNote: string;
  readonly topicTitle: string;
  readonly overall: string;
}

function apply(
  documentValue: ReturnType<typeof reviewDocumentFixture>,
  state: ReturnType<typeof createInitialReviewState>,
  action: Parameters<typeof reduceReviewState>[2],
) {
  const result = reduceReviewState(documentValue, state, action);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

describe("workbench packet export", () => {
  it("fails closed for an invalid document or state and supports the default clock path", () => {
    const documentValue = reviewDocumentFixture();
    const invalidDocument = structuredClone(documentValue);
    invalidDocument.document.id = "invalid";
    const state = createInitialReviewState(documentValue);
    expect(buildReviewPacket(invalidDocument, state, "2026-08-13T01:02:03.000Z").ok).toBe(false);
    expect(buildReviewPacketExport(invalidDocument, state, "2026-08-13T01:02:03.000Z").ok)
      .toBe(false);

    const invalidState = {
      ...state,
      idHighWater: { ...state.idHighWater, block: 0 },
    };
    expect(createReviewPacketExportCache(documentValue).get(invalidState).ok).toBe(false);

    const withOverall = apply(documentValue, state, {
      type: "SET_OVERALL",
      overall: "Count this export record.",
    });
    const cached = createReviewPacketExportCache(documentValue).get(withOverall);
    expect(cached.ok).toBe(true);
    if (cached.ok) expect(cached.value.recordCount).toBe(1);
  });

  it("@A02 exports a partial JSON-authoritative packet and deterministic Markdown fence", () => {
    const documentValue = reviewDocumentFixture();
    const edge = JSON.parse(readFileSync(
      resolve("tests/fixtures/workbench-recovery/edge-text.json"),
      "utf8",
    )) as EdgeText;
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "EDIT", note: edge.decisionNote },
    });
    state = apply(documentValue, state, {
      type: "ADD_TOPIC",
      title: edge.topicTitle,
    });
    state = apply(documentValue, state, { type: "SET_OVERALL", overall: edge.overall });

    const exported = buildReviewPacketExport(documentValue, state, "2026-08-13T01:02:03.000Z");
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.packet.progress).toEqual({ decided: 1, total: 4, partial: true });
    expect(exported.value.packet.stats).toEqual({ PASS: 0, EDIT: 1, TOPIC: 0, HOLD: 0 });
    expect(exported.value.packet.decisions[0]).toMatchObject({
      blockId: "B001",
      action: "EDIT",
      note: edge.decisionNote,
    });
    expect(exported.value.packet.topics[0]).toMatchObject({ title: edge.topicTitle });
    expect(exported.value.markdown.match(/^````json review-packet\/1$/gmu)).toHaveLength(1);
    expect(exported.value.markdown.match(/^````$/gmu)).toHaveLength(1);
    const parsed = parseReviewPacketMarkdown(exported.value.markdown, documentValue);
    expect(parsed).toEqual({ ok: true, value: exported.value.packet });
    expect(`${exported.value.json.trim()}\n`).toBe(exported.value.json);
    expect(exported.value.markdown).toContain("&lt;/script&gt;");
    expect(exported.value.json).toContain(edge.decisionNote);
    expect(validateReviewPacket(JSON.parse(exported.value.json), documentValue).ok).toBe(true);
  });

  it("@A08/@A17 separates reopened blocks from frozen carried and admits a new decision", () => {
    const documentValue = frozenReviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, { type: "REOPEN_BLOCK", blockId: "B004" });
    const partial = buildReviewPacket(documentValue, state, "2026-08-13T01:02:03.000Z");
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.reopened).toEqual(["B004"]);
    expect(partial.value.frozenCarried).toEqual([]);
    expect(partial.value.progress).toEqual({ decided: 0, total: 4, partial: true });

    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B004",
      decision: { action: "PASS" },
    });
    const repass = buildReviewPacket(documentValue, state, "2026-08-13T01:02:04.000Z");
    expect(repass.ok).toBe(true);
    if (repass.ok) {
      expect(repass.value.reopened).toEqual(["B004"]);
      expect(repass.value.decisions).toContainEqual({ blockId: "B004", action: "PASS" });
    }
  });

  it("reuses one reviewedAt and packet object for every export of an unchanged state digest", () => {
    const documentValue = reviewDocumentFixture();
    const state = createInitialReviewState(documentValue);
    let ticks = 0;
    const cache = createReviewPacketExportCache(documentValue, () => (
      new Date(`2026-08-13T01:02:${String(ticks++).padStart(2, "0")}.000Z`)
    ));
    const first = cache.get(state);
    const second = cache.get(state);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);
    expect(second.value.packet.reviewedAt).toBe(first.value.packet.reviewedAt);
    expect(second.value.markdown).toContain(first.value.json.trim());

    const changed = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    const third = cache.get(changed);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.stateDigest).not.toBe(first.value.stateDigest);

    const reverted = apply(documentValue, changed, {
      type: "UNSET_DECISION",
      blockId: "B001",
    });
    const fourth = cache.get(reverted);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      expect(fourth.value.stateDigest).toBe(first.value.stateDigest);
      expect(fourth.value).not.toBe(first.value);
      expect(fourth.value.packet.reviewedAt).not.toBe(first.value.packet.reviewedAt);
    }

    cache.invalidate();
    const fifth = cache.get(reverted);
    expect(fifth.ok).toBe(true);
    if (fifth.ok) {
      expect(fifth.value.stateDigest).toBe(first.value.stateDigest);
      expect(fifth.value).not.toBe(fourth.ok ? fourth.value : undefined);
    }
  });
});
