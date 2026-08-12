import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockContentDigest,
  canonicalJson,
  canonicalReviewPacket,
  compareUnicodeCodePoints,
  documentContentDigest,
  feedbackDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  portablePathKey,
  reviewDigest,
  sha256Bytes,
  stateDigest,
  validateReviewDocument,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type ReviewStateV1,
} from "../../src/protocol/index.js";

async function load<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8")) as T;
}

describe("JCS canonicalization and shared digests", () => {
  it("rejects non-JSON values and invalid Unicode before canonicalizing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, Number.NaN, Infinity, { omitted: undefined }, cyclic, "\ud800", { "\udc00": "bad" }]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
    expect(canonicalJson("😀")).toBe('"😀"');
    expect(portablePathKey("\ud800")).toEqual(expect.objectContaining({
      ok: false,
      errors: [expect.objectContaining({
        code: "PORTABLE_PATH_INVALID",
        path: "/relativePath",
      })],
    }));
    expect(portablePathKey("emoji-😀/file.json").ok).toBe(true);
  });

  it("canonicalizes a descriptor snapshot without invoking toJSON or Proxy getters", () => {
    let objectGets = 0;
    const object = new Proxy({ z: 1, toJSON: "data", a: 2 }, {
      get(target, property, receiver) {
        objectGets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    let arrayGets = 0;
    const array = new Proxy([1, 2], {
      get(target, property, receiver) {
        arrayGets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(canonicalJson(object)).toBe('{"a":2,"toJSON":"data","z":1}');
    expect(canonicalJson(array)).toBe("[1,2]");
    expect(objectGets).toBe(0);
    expect(arrayGets).toBe(0);

    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, ab: shared })).toBe('{"a":{"x":1},"ab":{"x":1}}');

    const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        value: () => ["polluted"],
        configurable: true,
      });
      expect(canonicalJson([1])).toBe("[1]");
    } finally {
      if (originalArrayToJson) {
        Object.defineProperty(Array.prototype, "toJSON", originalArrayToJson);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
      }
    }
  });

  it("matches the real six-digest golden and packet ID", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    const golden = await load<Record<string, string>>("digests.json");
    const validated = validateReviewDocument(document);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(blockContentDigest(validated.value.blocks[0]!)).toBe(golden.blockContentDigest);
    expect(documentContentDigest(validated.value)).toBe(golden.documentContentDigest);
    expect(reviewDigest(validated.value)).toBe(golden.reviewDigest);
    const semantic = packetSemanticDigest(packet);
    expect(semantic).toBe(golden.packetSemanticDigest);
    expect(packetIdFromSemanticDigest(semantic)).toBe(golden.packetId);
    expect(stateDigest(state)).toBe(golden.stateDigest);
    expect(feedbackDigest({
      kind: "side-note",
      feedbackId: "NOTE-001",
      blockId: "B003",
      text: "Keep the closure deterministic.",
    })).toBe(golden.feedbackDigest);
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe(golden.bytesDigest);
  });

  it("folds portable relative paths exactly and rejects unsafe path forms", () => {
    expect(portablePathKey("Reports/Straße/e\u0301.json")).toEqual({
      ok: true,
      value: "reports/strasse/é.json",
    });
    for (const input of ["", "/absolute", "C:/drive", "a\\b", "a//b", ".", "a/../b", "nul\0byte"]) {
      const result = portablePathKey(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.mutated).toBe(false);
        expect(result.errors).toEqual([
          expect.objectContaining({ code: "PORTABLE_PATH_INVALID", path: "/relativePath" }),
        ]);
      }
    }
  });

  it("sorts only set-like packet arrays and does not mutate the caller", async () => {
    const packet = await load<ReviewPacketV1>("review-packet.json");
    packet.decisions.reverse();
    const before = structuredClone(packet);
    const canonical = canonicalReviewPacket(packet);
    expect(packet).toEqual(before);
    expect(canonical.decisions.map((decision) => decision.blockId)).toEqual(["B001", "B002"]);
    expect(packetSemanticDigest(packet)).toBe(packetSemanticDigest(canonical));
  });

  it("uses JCS object ordering and Unicode code-point collection ordering", () => {
    expect(canonicalJson({ z: 1, a: -0, nested: { b: true, a: null } })).toBe(
      '{"a":0,"nested":{"a":null,"b":true},"z":1}',
    );
    expect(["😀", "z", "é"].sort(compareUnicodeCodePoints)).toEqual(["z", "é", "😀"]);
    expect(compareUnicodeCodePoints("same", "same")).toBe(0);
    expect(compareUnicodeCodePoints("prefix", "prefix-long")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("😀", "\uE000")).toBeGreaterThan(0);
  });

  it("excludes reviewedAt and savedAt from semantic digests", async () => {
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    const packetChanged = { ...packet, reviewedAt: "2026-08-12T10:00:00Z" };
    const stateChanged = { ...state, savedAt: "2026-08-12T10:00:00Z" };
    expect(packetSemanticDigest(packetChanged)).toBe(packetSemanticDigest(packet));
    expect(stateDigest(stateChanged)).toBe(stateDigest(state));
  });

  it("covers optional digest fields and every deterministic document collection sort", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    delete packet.overall;
    delete state.overall;
    expect(packetSemanticDigest(packet)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stateDigest(state)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(feedbackDigest({ kind: "overall", feedbackId: "OVERALL", text: "summary" })).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(blockContentDigest(document.blocks[3]!)).toMatch(/^sha256:[0-9a-f]{64}$/);

    document.evidence.sourceHierarchy.push({
      id: "SRC-002",
      rank: 1,
      label: "Second",
      reference: "second",
      freshness: { kind: "static", checkedAt: "2026-08-12T08:00:00Z" },
    });
    document.evidence.facts[0]!.sourceRefs = ["SRC-002", "SRC-001"];
    document.evidence.conflicts.push({
      itemRefs: ["SRC-002", "SRC-001"],
      description: "sort",
      severity: "nonblocking",
      status: "resolved",
    });
    document.approvals.history = [
      { blockId: "B002", approvedRound: 2, approvedContentDigest: `sha256:${"2".repeat(64)}` },
      { blockId: "B002", approvedRound: 1, approvedContentDigest: `sha256:${"1".repeat(64)}` },
      { blockId: "B001", approvedRound: 1, approvedContentDigest: `sha256:${"0".repeat(64)}` },
    ];
    document.lineage.topicMappings = [
      { topicId: "TOP-002", derivedDocumentId: "RD-44444444444444444444", derivedDeliveryId: "RDL-44444444444444444444" },
      { topicId: "TOP-001", derivedDocumentId: "RD-33333333333333333333", derivedDeliveryId: "RDL-33333333333333333333" },
    ];
    document.lineage.impactAssessments = [
      { upstreamBlockId: "B002", changedAtRound: 2, affectedDownstreamIds: ["B004", "B003"], reason: "two", usedConservativeClosure: false },
      { upstreamBlockId: "B002", changedAtRound: 1, affectedDownstreamIds: [], reason: "one-b", usedConservativeClosure: false },
      { upstreamBlockId: "B001", changedAtRound: 1, affectedDownstreamIds: [], reason: "one-a", usedConservativeClosure: false },
    ];
    document.lineage.feedbackResolutions = [
      { sourcePacketId: "RP-BBBBBBBBBBBBBBBBBBBB", feedbackId: "OVERALL", feedbackDigest: `sha256:${"b".repeat(64)}`, disposition: "context-only", reason: "b" },
      { sourcePacketId: "RP-AAAAAAAAAAAAAAAAAAAA", feedbackId: "NOTE-002", feedbackDigest: `sha256:${"c".repeat(64)}`, disposition: "context-only", reason: "c" },
      { sourcePacketId: "RP-AAAAAAAAAAAAAAAAAAAA", feedbackId: "NOTE-001", feedbackDigest: `sha256:${"a".repeat(64)}`, disposition: "context-only", reason: "a" },
    ];
    const canonical = (await import("../../src/protocol/index.js")).canonicalReviewDocument(document);
    expect(canonical.evidence.sourceHierarchy.map((source) => source.id)).toEqual(["SRC-001", "SRC-002"]);
    expect(canonical.approvals.history.map((item) => `${item.blockId}:${item.approvedRound}`)).toEqual([
      "B001:1", "B002:1", "B002:2",
    ]);
    expect(canonical.lineage.topicMappings.map((item) => item.topicId)).toEqual(["TOP-001", "TOP-002"]);
    expect(canonical.lineage.impactAssessments.map((item) => `${item.changedAtRound}:${item.upstreamBlockId}`)).toEqual([
      "1:B001", "1:B002", "2:B002",
    ]);
    expect(canonical.lineage.feedbackResolutions.map((item) => item.feedbackId)).toEqual([
      "NOTE-001", "NOTE-002", "OVERALL",
    ]);
    expect(canonical.lineage.impactAssessments[2]?.affectedDownstreamIds).toEqual(["B003", "B004"]);
  });
});
