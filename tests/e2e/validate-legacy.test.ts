import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  serializeReviewPacketMarkdown,
  type ReviewPacketV1,
  type ReviewStateV1,
  type Sha256Digest,
} from "../../src/protocol/index.js";
import { reviewDocumentFixture } from "../fixtures/validate/helpers.js";
import {
  cleanupTemporaryDirectories,
  makeInputRoot,
  runValidate,
  snapshotTree,
  temporaryDirectory,
  writePrivateFile,
} from "../fixtures/validate/e2e.js";

afterAll(cleanupTemporaryDirectories);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve("tests/fixtures/protocol", name), "utf8")) as T;
}

async function setup(): Promise<{
  root: string;
  documentPath: string;
  packet: ReviewPacketV1;
  state: ReviewStateV1;
}> {
  const parent = await temporaryDirectory("validate-legacy");
  const root = await makeInputRoot(parent);
  const document = reviewDocumentFixture();
  const documentPath = join(root, "review-document.json");
  await writePrivateFile(documentPath, `${JSON.stringify(document)}\n`);
  return {
    root,
    documentPath,
    packet: load<ReviewPacketV1>("review-packet.json"),
    state: load<ReviewStateV1>("review-state.json"),
  };
}

describe("packet and state validation subprocess", () => {
  it("validates ordinary /1 JSON and Markdown without echoing normalized input", async () => {
    const { root, documentPath, packet, state } = await setup();
    const packetPath = join(root, "packet.json");
    const statePath = join(root, "state.json");
    const markdownPath = join(root, "packet.md");
    await writePrivateFile(packetPath, `${JSON.stringify(packet)}\n`);
    await writePrivateFile(statePath, `${JSON.stringify(state)}\n`);
    const markdown = serializeReviewPacketMarkdown(packet, reviewDocumentFixture());
    if (!markdown.ok) throw new Error("packet fixture drift");
    await writePrivateFile(markdownPath, markdown.value);
    const before = await snapshotTree(root);

    const packetJson = await runValidate(["packet", "--document", documentPath, "--input", packetPath]);
    const packetMarkdown = await runValidate(["packet", "--document", documentPath, "--input", markdownPath]);
    const stateJson = await runValidate(["state", "--document", documentPath, "--input", statePath]);

    for (const outcome of [packetJson, packetMarkdown]) {
      expect(outcome.status).toBe(0);
      expect(outcome.result).toEqual({
        status: "ok",
        phase: "validate",
        mode: "packet",
        mutated: false,
        summary: {
          format: "review-packet/1",
          documentId: packet.doc.id,
          contentVersion: packet.doc.contentVersion,
          round: packet.doc.round,
          reviewDigest: packet.doc.reviewDigest,
          packetId: packet.packetId,
          semanticDigest: packet.semanticDigest,
        },
      });
      expect(outcome.result).not.toHaveProperty("normalized");
      expect(JSON.stringify(outcome.result)).not.toContain(packet.overall);
    }
    expect(stateJson.status).toBe(0);
    expect(stateJson.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "state",
      mutated: false,
      summary: {
        format: "review-state/1",
        documentId: state.doc.id,
        contentVersion: state.doc.contentVersion,
        round: state.doc.round,
        reviewDigest: state.doc.reviewDigest,
        stateDigest: state.stateDigest,
      },
    });
    expect(stateJson.result).not.toHaveProperty("normalized");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("normalizes legacy actions only under the explicit profile", async () => {
    const { root, documentPath, packet, state } = await setup();
    const legacyPacket = structuredClone(packet) as unknown as Record<string, unknown>;
    const packetDecisions = legacyPacket.decisions as Array<Record<string, unknown>>;
    packetDecisions[0]!.action = "TRIM";
    packetDecisions[0]!.note = "Remove redundant detail.";
    packetDecisions[1]!.action = "EXPAND";
    packetDecisions[1]!.note = "Add one concrete example.";
    legacyPacket.stats = { TRIM: 1, EXPAND: 1 };
    const legacyPacketPath = join(root, "legacy-packet.json");
    await writePrivateFile(legacyPacketPath, `${JSON.stringify(legacyPacket)}\n`);

    const legacyState = structuredClone(state) as unknown as Record<string, unknown>;
    const stateDecisions = legacyState.decisions as Array<Record<string, unknown>>;
    stateDecisions[0]!.action = "TRIM";
    stateDecisions[0]!.note = "Remove redundant state detail.";
    const legacyStatePath = join(root, "legacy-state.json");
    await writePrivateFile(legacyStatePath, `${JSON.stringify(legacyState)}\n`);
    const before = await snapshotTree(root);

    const packetOutcome = await runValidate([
      "packet", "--document", documentPath, "--input", legacyPacketPath,
      "--legacy-profile", "prototype-v1",
    ]);
    const stateOutcome = await runValidate([
      "state", "--document", documentPath, "--input", legacyStatePath,
      "--legacy-profile", "prototype-v1",
    ]);

    expect(packetOutcome.status).toBe(0);
    expect(packetOutcome.result).toEqual(expect.objectContaining({
      status: "ok",
      mode: "packet",
      normalized: expect.objectContaining({
        format: "review-packet/1",
        decisions: expect.arrayContaining([
          expect.objectContaining({ action: "EDIT", note: "【精简】Remove redundant detail." }),
          expect.objectContaining({ action: "EDIT", note: "【扩展】Add one concrete example." }),
        ]),
      }),
    }));
    expect(stateOutcome.status).toBe(0);
    expect(stateOutcome.result).toEqual(expect.objectContaining({
      status: "ok",
      mode: "state",
      normalized: expect.objectContaining({
        format: "review-state/1",
        decisions: expect.arrayContaining([
          expect.objectContaining({ action: "EDIT", note: "【精简】Remove redundant state detail." }),
        ]),
      }),
    }));
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("requires all exact confirmations only when legacy identity is absent", async () => {
    const { root, documentPath, packet } = await setup();
    const identityFree = structuredClone(packet) as unknown as Record<string, unknown>;
    delete identityFree.doc;
    const path = join(root, "identity-free.json");
    await writePrivateFile(path, `${JSON.stringify(identityFree)}\n`);

    const blocked = await runValidate([
      "packet", "--document", documentPath, "--input", path,
      "--legacy-profile", "prototype-v1",
    ]);
    expect(blocked.status).toBe(4);
    expect(blocked.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "IDENTITY_CONFIRMATION_REQUIRED" })],
    }));
    expect(blocked.result).not.toHaveProperty("normalized");

    const confirmed = await runValidate([
      "packet", "--document", documentPath, "--input", path,
      "--legacy-profile", "prototype-v1",
      "--confirm-document-id", packet.doc.id,
      "--confirm-content-version", String(packet.doc.contentVersion),
      "--confirm-round", String(packet.doc.round),
    ]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.result).toEqual(expect.objectContaining({
      status: "ok",
      normalized: expect.objectContaining({ doc: expect.objectContaining({ id: packet.doc.id }) }),
    }));

    const wrong = await runValidate([
      "packet", "--document", documentPath, "--input", path,
      "--legacy-profile", "prototype-v1",
      "--confirm-document-id", "RD-AAAAAAAAAAAAAAAAAAAA",
      "--confirm-content-version", "1",
      "--confirm-round", "1",
    ]);
    expect(wrong.status).toBe(3);
    expect(wrong.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "IDENTITY_MISMATCH" })],
    }));
  });

  it("applies privacy scanning to the complete readable Markdown before parsing", async () => {
    const { root, documentPath, packet } = await setup();
    const sentinel = "private-markdown-token-abcdefgh";
    packet.overall = ["Author", "ization: Bearer ", sentinel].join("");
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as Sha256Digest);
    const markdown = serializeReviewPacketMarkdown(packet, reviewDocumentFixture());
    if (!markdown.ok) throw new Error("private packet setup failed");
    const path = join(root, "private.md");
    await writePrivateFile(path, markdown.value);

    const outcome = await runValidate(["packet", "--document", documentPath, "--input", path]);

    expect(outcome.status).toBe(3);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "PRIVACY_VIOLATION" })],
    }));
    expect(JSON.stringify(outcome.result)).not.toContain(sentinel);
  });
});

describe("stable legacy static-contract incompatibility", () => {
  it.each([
    { schema_version: "dual-audience-report-contract-v1" },
    { format: "dual-audience-report-contract-v1" },
  ])("recognizes both historical discriminator spellings before generic schema errors", async (legacy) => {
    const { root, documentPath } = await setup();
    const input = join(root, "old-contract.json");
    await writePrivateFile(input, `${JSON.stringify({ ...legacy, unexpected: true })}\n`);

    const packet = await runValidate(["packet", "--document", documentPath, "--input", input]);
    const state = await runValidate(["state", "--document", documentPath, "--input", input]);
    for (const outcome of [packet, state]) {
      expect(outcome.status).toBe(3);
      expect(outcome.result).toEqual(expect.objectContaining({
        status: "failed",
        errors: [expect.objectContaining({ code: "LEGACY_CONTRACT_INCOMPATIBLE", path: "/format" })],
      }));
      expect(outcome.result).not.toHaveProperty("normalized");
    }
  });

  it("detects an old contract supplied as the document before touching the input", async () => {
    const parent = await temporaryDirectory("validate-old-document");
    const root = await makeInputRoot(parent);
    const documentPath = join(root, "old-document.json");
    await writePrivateFile(documentPath, '{"schema_version":"dual-audience-report-contract-v1"}\n');
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "packet", "--document", documentPath, "--input", join(root, "missing-packet.json"),
    ]);

    expect(outcome.status).toBe(3);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "LEGACY_CONTRACT_INCOMPATIBLE" })],
    }));
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("rejects duplicate JSON keys as INPUT_JSON_INVALID and malformed UTF-8 without echoing bytes", async () => {
    const { root, documentPath } = await setup();
    const duplicate = join(root, "duplicate.json");
    const malformed = join(root, "malformed.json");
    await writePrivateFile(duplicate, '{"format":"review-packet/1","format":"review-packet/1"}\n');
    await writePrivateFile(malformed, Uint8Array.from([0xff, 0xfe]));

    const duplicateOutcome = await runValidate(["packet", "--document", documentPath, "--input", duplicate]);
    expect(duplicateOutcome.status).toBe(3);
    expect(duplicateOutcome.result).toEqual(expect.objectContaining({
      errors: [expect.objectContaining({ code: "INPUT_JSON_INVALID" })],
    }));
    const malformedOutcome = await runValidate(["packet", "--document", documentPath, "--input", malformed]);
    expect(malformedOutcome.status).toBe(2);
    expect(malformedOutcome.result).toEqual(expect.objectContaining({
      errors: [expect.objectContaining({ code: "INPUT_UTF8_INVALID" })],
    }));
  });
});
