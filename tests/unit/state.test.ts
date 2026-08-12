import { describe, expect, it } from "vitest";
import { canonicalJsonLine } from "../../src/protocol/index.js";
import { buildReviewPacket } from "../../src/workbench/packet.js";
import {
  createInitialReviewState,
  reduceReviewState,
} from "../../src/workbench/reducer.js";
import {
  buildReviewState,
  importReviewStateText,
  serializeReviewStateJson,
} from "../../src/workbench/state.js";
import { frozenReviewDocumentFixture, reviewDocumentFixture } from "./persistence-fixtures.js";

function apply(
  documentValue: ReturnType<typeof reviewDocumentFixture>,
  state: ReturnType<typeof createInitialReviewState>,
  action: Parameters<typeof reduceReviewState>[2],
) {
  const result = reduceReviewState(documentValue, state, action);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

describe("workbench state import and export", () => {
  it("fails closed for invalid document/state inputs and non-object import roots", () => {
    const documentValue = reviewDocumentFixture();
    const invalidDocument = structuredClone(documentValue);
    invalidDocument.document.id = "invalid";
    const state = createInitialReviewState(documentValue);
    expect(buildReviewState(invalidDocument, state, "2026-08-13T01:00:00.000Z").ok).toBe(false);
    expect(serializeReviewStateJson(invalidDocument, state, "2026-08-13T01:00:00.000Z").ok)
      .toBe(false);
    expect(importReviewStateText("[]", documentValue).ok).toBe(false);
    expect(importReviewStateText("null", documentValue).ok).toBe(false);
  });

  it("exports canonical review-state/1 with a stable semantic digest", () => {
    const documentValue = frozenReviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, { type: "REOPEN_BLOCK", blockId: "B004" });
    state = apply(documentValue, state, {
      type: "SET_SIDE_NOTE",
      blockId: "B004",
      note: "Keep history while reopening.",
    });
    const first = buildReviewState(documentValue, state, "2026-08-13T01:00:00.000Z");
    const second = buildReviewState(documentValue, state, "2026-08-13T02:00:00.000Z");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.stateDigest).toBe(second.value.stateDigest);
    const json = serializeReviewStateJson(documentValue, state, first.value.savedAt);
    expect(json).toEqual({ ok: true, value: canonicalJsonLine(first.value) });
  });

  it("@A18 imports exact state and packet only after full identity/invariant validation", () => {
    const documentValue = reviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "HOLD", note: "Need proof." },
    });
    const built = buildReviewState(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const imported = importReviewStateText(canonicalJsonLine(built.value), documentValue, {
      currentState: createInitialReviewState(documentValue),
    });
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value.sourceFormat).toBe("review-state/1");
      expect(imported.value.workbenchState.decisionsByBlock.get("B001"))
        .toEqual({ blockId: "B001", action: "HOLD", note: "Need proof." });
    }

    const packet = buildReviewPacket(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    const packetImport = importReviewStateText(JSON.stringify(packet.value), documentValue, {
      currentState: createInitialReviewState(documentValue),
    });
    expect(packetImport.ok && packetImport.value.sourceFormat === "review-packet/1").toBe(true);

    const wrongIdentity = structuredClone(built.value);
    wrongIdentity.doc.contentVersion += 1;
    const rejected = importReviewStateText(JSON.stringify(wrongIdentity), documentValue, {
      currentState: state,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errors.some((error) => error.code === "IDENTITY_MISMATCH")).toBe(true);
  });

  it("rejects imported high-water regression relative to current memory before Map conversion", () => {
    const documentValue = reviewDocumentFixture();
    const empty = createInitialReviewState(documentValue);
    const old = buildReviewState(documentValue, empty, "2026-08-13T01:00:00.000Z");
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    let current = apply(documentValue, empty, {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      note: "Allocated NOTE-001",
    });
    current = apply(documentValue, current, { type: "DELETE_SIDE_NOTE", noteId: "NOTE-001" });
    expect(current.idHighWater.note).toBe(1);
    const rejected = importReviewStateText(JSON.stringify(old.value), documentValue, {
      currentState: current,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: "HIGH_WATER_REGRESSION",
        path: "/idHighWater/note",
      }));
    }
    expect(current.idHighWater.note).toBe(1);
  });

  it.each([
    ["review-state/1", "state"],
    ["review-packet/1", "packet"],
  ] as const)("never falls back to legacy when an exact %s input is invalid", (format, kind) => {
    const documentValue = reviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "EDIT", note: "Exact v1 data." },
    });
    const value = kind === "state"
      ? buildReviewState(documentValue, state, "2026-08-13T01:00:00.000Z")
      : buildReviewPacket(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const invalid = structuredClone(value.value) as unknown as Record<string, unknown>;
    (invalid.decisions as Array<Record<string, unknown>>)[0]!.action = "TRIM";
    const result = importReviewStateText(JSON.stringify(invalid), documentValue, {
      legacyProfile: "prototype-v1",
      confirmIdentity: true,
      currentState: createInitialReviewState(documentValue),
    });
    expect(result.ok).toBe(false);
    expect(invalid.format).toBe(format);
  });

  it("migrates a confirmed missing-format prototype atomically and never accepts future formats", () => {
    const documentValue = reviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "EDIT", note: "Shorten it." },
    });
    const built = buildReviewState(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const legacy = structuredClone(built.value) as unknown as Record<string, unknown>;
    delete legacy.format;
    const identifiedWithoutConfirmation = importReviewStateText(JSON.stringify(legacy), documentValue, {
      legacyProfile: "prototype-v1",
      currentState: createInitialReviewState(documentValue),
    });
    expect(identifiedWithoutConfirmation.ok).toBe(false);
    if (!identifiedWithoutConfirmation.ok) {
      expect(identifiedWithoutConfirmation.errors).toContainEqual(expect.objectContaining({
        code: "IDENTITY_CONFIRMATION_REQUIRED",
        path: "/doc",
      }));
    }
    const doc = legacy.doc as Record<string, unknown>;
    delete doc.contentVersion;
    (legacy.decisions as Array<Record<string, unknown>>)[0]!.action = "TRIM";

    const withoutConfirmation = importReviewStateText(JSON.stringify(legacy), documentValue, {
      legacyProfile: "prototype-v1",
      currentState: createInitialReviewState(documentValue),
    });
    expect(withoutConfirmation.ok).toBe(false);
    const migrated = importReviewStateText(JSON.stringify(legacy), documentValue, {
      legacyProfile: "prototype-v1",
      confirmIdentity: true,
      currentState: createInitialReviewState(documentValue),
    });
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.value.migrated).toBe(true);
      expect(migrated.value.workbenchState.decisionsByBlock.get("B001"))
        .toEqual({ blockId: "B001", action: "EDIT", note: "【精简】Shorten it." });
    }

    expect(importReviewStateText(JSON.stringify({ format: "review-state/2" }), documentValue, {
      legacyProfile: "prototype-v1",
      confirmIdentity: true,
    })).toEqual(expect.objectContaining({ ok: false, mutated: false }));
  });

  it("migrates a confirmed packet-shaped prototype and immediately exports canonical /1 state", () => {
    const documentValue = reviewDocumentFixture();
    let state = createInitialReviewState(documentValue);
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "EDIT", note: "Expand this proof." },
    });
    const packet = buildReviewPacket(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    const legacy = structuredClone(packet.value) as unknown as Record<string, unknown>;
    delete legacy.format;
    delete (legacy.doc as Record<string, unknown>).round;
    (legacy.decisions as Array<Record<string, unknown>>)[0]!.action = "EXPAND";

    const imported = importReviewStateText(JSON.stringify(legacy), documentValue, {
      legacyProfile: "prototype-v1",
      confirmIdentity: true,
      currentState: createInitialReviewState(documentValue),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toMatchObject({ migrated: true, sourceFormat: "review-packet/1" });
    expect(imported.value.workbenchState.decisionsByBlock.get("B002")).toEqual({
      blockId: "B002",
      action: "EDIT",
      note: "【扩展】Expand this proof.",
    });
    const canonical = serializeReviewStateJson(
      documentValue,
      imported.value.workbenchState,
      "2026-08-13T01:01:00.000Z",
    );
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(JSON.parse(canonical.value)).toMatchObject({
        format: "review-state/1",
        decisions: [{ blockId: "B002", action: "EDIT", note: "【扩展】Expand this proof." }],
      });
      expect(canonical.value).not.toContain("EXPAND");
    }
  });

  it("automatic restore mode rejects packet input and never performs migration inference", () => {
    const documentValue = reviewDocumentFixture();
    const state = createInitialReviewState(documentValue);
    const packet = buildReviewPacket(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    expect(importReviewStateText(JSON.stringify(packet.value), documentValue, { allowPacket: false }).ok)
      .toBe(false);
    expect(importReviewStateText(JSON.stringify({ decisions: [] }), documentValue, {
      allowPacket: false,
    }).ok).toBe(false);
  });

  it("preserves packet overall text while converting a validated packet to state", () => {
    const documentValue = reviewDocumentFixture();
    const state = apply(documentValue, createInitialReviewState(documentValue), {
      type: "SET_OVERALL",
      overall: "Packet overall survives conversion.",
    });
    const packet = buildReviewPacket(documentValue, state, "2026-08-13T01:00:00.000Z");
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    const imported = importReviewStateText(JSON.stringify(packet.value), documentValue);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.workbenchState.overall).toBe("Packet overall survives conversion.");
  });

  it("checks every high-water dimension against current memory", () => {
    const documentValue = reviewDocumentFixture();
    const initial = createInitialReviewState(documentValue);
    const built = buildReviewState(documentValue, initial, "2026-08-13T01:00:00.000Z");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const current = {
      ...initial,
      idHighWater: {
        block: initial.idHighWater.block + 1,
        source: initial.idHighWater.source + 1,
        fact: initial.idHighWater.fact + 1,
        decision: initial.idHighWater.decision + 1,
        glossary: initial.idHighWater.glossary + 1,
        note: initial.idHighWater.note + 1,
        topic: initial.idHighWater.topic + 1,
      },
    };
    const result = importReviewStateText(JSON.stringify(built.value), documentValue, { currentState: current });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toEqual([
        "/idHighWater/block",
        "/idHighWater/source",
        "/idHighWater/fact",
        "/idHighWater/decision",
        "/idHighWater/glossary",
        "/idHighWater/note",
        "/idHighWater/topic",
      ]);
    }
  });
});
