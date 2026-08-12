import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockContentDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  reviewDigest,
  stateDigest,
  validateReviewDocument,
  validateReviewDocumentAgainst,
  validateReviewPacket,
  validateReviewState,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type ReviewStateV1,
} from "../../src/protocol/index.js";

async function load<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8")) as T;
}

describe("identity, approval, version, and high-water invariants", () => {
  it("accepts a frozen block only with a latest matching approval digest", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    document.approvals.history.push({
      blockId: "B004",
      approvedRound: 1,
      approvedContentDigest: blockContentDigest(document.blocks[3]!),
    });
    document.approvals.currentFrozen.push("B004");
    expect(validateReviewDocument(document).ok).toBe(true);

    document.approvals.history[0]!.approvedContentDigest = `sha256:${"f".repeat(64)}`;
    const mismatch = validateReviewDocument(document);
    expect(mismatch.ok ? [] : mismatch.errors).toContainEqual(
      expect.objectContaining({
        code: "APPROVAL_DIGEST_MISMATCH",
        path: "/approvals/history/0/approvedContentDigest",
        blockId: "B004",
      }),
    );
  });

  it("enforces the mechanical content-version rule without deciding transitions", async () => {
    const current = await load<ReviewDocumentV1>("review-document.json");
    const candidate = structuredClone(current);
    candidate.document.summary = "Changed semantic content needs one version increment.";
    candidate.document.contentVersion = 2;
    candidate.document.round = 2;
    candidate.lineage.previousReviewDigest = reviewDigest(current);
    expect(validateReviewDocumentAgainst(current, candidate).ok).toBe(true);

    candidate.document.contentVersion = 1;
    const stale = validateReviewDocumentAgainst(current, candidate);
    expect(stale.ok ? [] : stale.errors).toContainEqual(
      expect.objectContaining({ code: "CONTENT_VERSION_MISMATCH", path: "/document/contentVersion" }),
    );

    const unchanged = structuredClone(current);
    unchanged.document.contentVersion = 2;
    unchanged.document.round = 2;
    unchanged.lineage.previousReviewDigest = reviewDigest(current);
    const inflated = validateReviewDocumentAgainst(current, unchanged);
    expect(inflated.ok ? [] : inflated.errors).toContainEqual(
      expect.objectContaining({ code: "CONTENT_VERSION_MISMATCH", path: "/document/contentVersion" }),
    );

    const unsafeCurrent = structuredClone(current);
    unsafeCurrent.document.contentVersion = 2 ** 53;
    const unsafeCandidate = structuredClone(unsafeCurrent);
    unsafeCandidate.document.title = "Changed across an unsafe version boundary.";
    unsafeCandidate.document.round = 2;
    unsafeCandidate.lineage.previousReviewDigest = reviewDigest(current);
    const unsafeResult = validateReviewDocumentAgainst(unsafeCurrent, unsafeCandidate);
    expect(unsafeResult.ok ? [] : unsafeResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/document/contentVersion" }),
    );
  });

  it("prevents reuse below a deleted-source high-water mark and history removal", async () => {
    const current = await load<ReviewDocumentV1>("review-document.json");
    current.lineage.idHighWater.source = 5;
    current.approvals.history.push({
      blockId: "B004",
      approvedRound: 1,
      approvedContentDigest: blockContentDigest(current.blocks[3]!),
    });
    const candidate = structuredClone(current);
    candidate.document.round = 2;
    candidate.lineage.previousReviewDigest = reviewDigest(current);
    candidate.evidence.sourceHierarchy.push({
      id: "SRC-002",
      rank: 2,
      label: "Reused historical source number",
      reference: "historical-source",
      freshness: { kind: "static", checkedAt: "2026-08-12T08:00:00Z" },
    });
    candidate.approvals.history = [];
    candidate.document.contentVersion = 2;
    const result = validateReviewDocumentAgainst(current, candidate);
    expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/evidence/sourceHierarchy/1/id" }),
      expect.objectContaining({ code: "APPEND_ONLY_VIOLATION", path: "/approvals/history/0" }),
    ]));
  });

  it("binds a candidate previousReviewDigest to the exact current review", async () => {
    const current = await load<ReviewDocumentV1>("review-document.json");
    const candidate = structuredClone(current);
    candidate.document.round = 2;
    candidate.lineage.previousReviewDigest = `sha256:${"f".repeat(64)}`;
    const result = validateReviewDocumentAgainst(current, candidate);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        code: "IDENTITY_MISMATCH",
        path: "/lineage/previousReviewDigest",
      }),
    );
  });

  it("rejects contextual candidates that do not advance beyond the current round", async () => {
    const current = await load<ReviewDocumentV1>("review-document.json");
    current.document.round = 2;
    current.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
    const candidate = structuredClone(current);
    candidate.lineage.previousReviewDigest = reviewDigest(current);
    const result = validateReviewDocumentAgainst(current, candidate);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH", path: "/document/round" }),
    );
  });

  it("binds packet and state to the exact document digest and seven high-water dimensions", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    packet.doc.reviewDigest = `sha256:${"f".repeat(64)}`;
    state.idHighWater.source = 0;
    const packetResult = validateReviewPacket(packet, document);
    const stateResult = validateReviewState(state, document);
    expect(packetResult.ok ? [] : packetResult.errors).toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH", path: "/doc/reviewDigest" }),
    );
    expect(stateResult.ok ? [] : stateResult.errors).toContainEqual(
      expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/idHighWater/source" }),
    );
  });

  it("refuses packet and state context when the supplied document is invalid", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    document.blocks.length = 3;
    expect(validateReviewPacket(packet, document).ok).toBe(false);
    expect(validateReviewState(state, document).ok).toBe(false);
  });

  it("allows exactly one feedback resolution per source packet and feedback ID", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packetId = "RP-AAAAAAAAAAAAAAAAAAAA";
    document.document.round = 2;
    document.lineage.previousReviewDigest = `sha256:${"b".repeat(64)}`;
    document.lineage.consumedPackets = [{
      packetId,
      semanticDigest: `sha256:${"a".repeat(64)}`,
    }];
    document.lineage.feedbackResolutions = [
      {
        sourcePacketId: packetId,
        feedbackId: "NOTE-001",
        feedbackDigest: `sha256:${"1".repeat(64)}`,
        disposition: "context-only",
        reason: "First resolution.",
      },
      {
        sourcePacketId: packetId,
        feedbackId: "NOTE-001",
        feedbackDigest: `sha256:${"2".repeat(64)}`,
        disposition: "context-only",
        reason: "Conflicting duplicate resolution.",
      },
    ];
    const result = validateReviewDocument(document);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_LINEAGE_ENTRY",
        path: "/lineage/feedbackResolutions/1",
      }),
    );
  });

  it("rejects duplicate impact-assessment tuples within one document", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const assessment = {
      upstreamBlockId: "B001",
      changedAtRound: 1,
      affectedDownstreamIds: ["B002"],
      reason: "Assess the downstream block.",
      usedConservativeClosure: false,
    };
    document.lineage.impactAssessments = [assessment, structuredClone(assessment)];
    const result = validateReviewDocument(document);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_LINEAGE_ENTRY",
        path: "/lineage/impactAssessments/1",
      }),
    );
  });

  it("rejects noncanonical numeric spellings across all seven ID dimensions", async () => {
    const base = await load<ReviewDocumentV1>("review-document.json");
    const documentCases: Array<{ value: ReviewDocumentV1; path: string }> = [];
    const changed = (update: (value: ReviewDocumentV1) => void): ReviewDocumentV1 => {
      const value = structuredClone(base);
      update(value);
      return value;
    };
    documentCases.push(
      { value: changed((value) => { value.blocks[0]!.id = "B0001"; }), path: "/blocks/0/id" },
      {
        value: changed((value) => { value.evidence.sourceHierarchy[0]!.id = "SRC-0001"; }),
        path: "/evidence/sourceHierarchy/0/id",
      },
      {
        value: changed((value) => { value.evidence.facts[0]!.id = "C-0001"; }),
        path: "/evidence/facts/0/id",
      },
      {
        value: changed((value) => {
          value.evidence.decisions.push({
            id: "D-0001",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Decision." }] }],
            confidence: "high",
            sourceRefs: ["SRC-001"],
          });
          value.lineage.idHighWater.decision = 1;
        }),
        path: "/evidence/decisions/0/id",
      },
      {
        value: changed((value) => {
          value.glossary.push({ id: "G-0001", term: "Term", definition: "Definition." });
          value.lineage.idHighWater.glossary = 1;
        }),
        path: "/glossary/0/id",
      },
    );
    for (const item of documentCases) {
      const result = validateReviewDocument(item.value);
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: item.path }),
      );
    }

    const state = await load<ReviewStateV1>("review-state.json");
    state.sideNotes[0]!.id = "NOTE-0001";
    state.topics.push({ id: "TOP-0001", title: "Topic" });
    state.idHighWater.topic = 1;
    state.stateDigest = stateDigest(state);
    const overlay = validateReviewState(state, base);
    expect(overlay.ok ? [] : overlay.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/sideNotes/0/id" }),
      expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/topics/0/id" }),
    ]));
  });

  it("rejects noncanonical next-action numeric aliases without adding a high-water dimension", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    document.continuation.nextActions.push({
      ...structuredClone(document.continuation.nextActions[0]!),
      id: "ACT-0001",
    });
    const result = validateReviewDocument(document);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_ID",
        path: "/continuation/nextActions/1/id",
      }),
    );
  });

  it("reports packet and state semantic errors against the caller's unsorted order", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    const sideNotes = [
      { id: "NOTE-002", blockId: "B003", note: "Valid later note." },
      { id: "NOTE-0001", blockId: "B003", note: "Invalid numeric alias." },
    ];
    packet.sideNotes = structuredClone(sideNotes);
    packet.idHighWater.note = 2;
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    state.sideNotes = structuredClone(sideNotes);
    state.idHighWater.note = 2;
    state.stateDigest = stateDigest(state);

    for (const result of [
      validateReviewPacket(packet, document),
      validateReviewState(state, document),
    ]) {
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({
          code: "HIGH_WATER_REGRESSION",
          path: "/sideNotes/1/id",
        }),
      );
    }
  });

  it("rejects overlay note and topic IDs that reuse numbers below document history", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    document.lineage.idHighWater.note = 5;
    document.lineage.idHighWater.topic = 5;
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const state = await load<ReviewStateV1>("review-state.json");
    for (const overlay of [packet, state]) {
      overlay.sideNotes = [{ id: "NOTE-001", blockId: "B003", note: "Reused." }];
      overlay.topics = [{ id: "TOP-001", title: "Reused", sourceBlockId: "B003" }];
      overlay.decisions = [{ blockId: "B003", action: "TOPIC", topicId: "TOP-001" }];
      overlay.idHighWater.note = 5;
      overlay.idHighWater.topic = 5;
      if (overlay.format === "review-packet/1") {
        overlay.progress = { decided: 1, total: 4, partial: true };
        overlay.stats = { PASS: 0, EDIT: 0, TOPIC: 1, HOLD: 0 };
        overlay.semanticDigest = packetSemanticDigest(overlay);
        overlay.packetId = packetIdFromSemanticDigest(overlay.semanticDigest as `sha256:${string}`);
      } else {
        overlay.stateDigest = stateDigest(overlay);
      }
      const result = overlay.format === "review-packet/1"
        ? validateReviewPacket(overlay, document)
        : validateReviewState(overlay, document);
      expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/sideNotes/0/id" }),
        expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/topics/0/id" }),
        expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/decisions/0/topicId" }),
      ]));
    }

    const valid = await load<ReviewStateV1>("review-state.json");
    valid.sideNotes = [{ id: "NOTE-006", blockId: "B003", note: "Fresh." }];
    valid.topics = [{ id: "TOP-006", title: "Fresh", sourceBlockId: "B003" }];
    valid.decisions = [{ blockId: "B003", action: "TOPIC", topicId: "TOP-006" }];
    valid.idHighWater.note = 6;
    valid.idHighWater.topic = 6;
    valid.doc.reviewDigest = reviewDigest(document);
    valid.stateDigest = stateDigest(valid);
    expect(validateReviewState(valid, document).ok).toBe(true);
  });

  it("rejects NOTE feedback IDs reused across different consumed packets", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    document.document.round = 2;
    document.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
    document.lineage.idHighWater.note = 1;
    document.lineage.consumedPackets = [
      { packetId: "RP-AAAAAAAAAAAAAAAAAAAA", semanticDigest: `sha256:${"1".repeat(64)}` },
      { packetId: "RP-BBBBBBBBBBBBBBBBBBBB", semanticDigest: `sha256:${"2".repeat(64)}` },
    ];
    document.lineage.feedbackResolutions = document.lineage.consumedPackets.map((packet) => ({
      sourcePacketId: packet.packetId,
      feedbackId: "NOTE-001",
      feedbackDigest: `sha256:${(packet.packetId.startsWith("RP-A") ? "3" : "4").repeat(64)}`,
      disposition: "context-only" as const,
      reason: "Resolved.",
    }));
    const result = validateReviewDocument(document);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_ID",
        path: "/lineage/feedbackResolutions/1/feedbackId",
      }),
    );
  });

  it("accepts a reversed but set-equivalent frozenCarried input", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    for (const block of document.blocks.slice(0, 2)) {
      document.approvals.history.push({
        blockId: block.id,
        approvedRound: 1,
        approvedContentDigest: blockContentDigest(block),
      });
    }
    document.approvals.currentFrozen = ["B002", "B001"];
    const packet = await load<ReviewPacketV1>("review-packet.json");
    packet.doc.reviewDigest = reviewDigest(document);
    packet.decisions = [];
    packet.progress = { decided: 0, total: 2, partial: true };
    packet.stats = { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 };
    packet.frozenCarried = ["B002", "B001"];
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    expect(validateReviewPacket(packet, document).ok).toBe(true);
  });

  it("accepts the canonical minimum-width spelling beyond three digits", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    document.blocks.push({
      id: "B1000",
      tier: "T0",
      title: "Large canonical ID",
      summary: "Canonical suffixes grow beyond three digits.",
      body: [{ type: "paragraph", content: [{ type: "text", text: "Still canonical." }] }],
      dependencies: [],
      claimRefs: [],
      decisionRefs: [],
    });
    document.lineage.idHighWater.block = 1000;
    expect(validateReviewDocument(document).ok).toBe(true);
  });
});
