import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import type { ByteVerifier } from "../../src/cli/io/index.js";
import { reviewDigest, sha256Bytes, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  createExactGeneratedArtifactByteVerifiers,
  createGeneratedReplacementByteVerifiers,
} from "../../src/cli/validate.js";
import { generateArtifactBytes } from "../../src/generators/index.js";
import {
  GENERATOR_VERSION,
  approvalTemplateBytes,
  reviewDocumentFixture,
  validAgentBytes,
  validApprovalBytes,
} from "../fixtures/validate/helpers.js";
import {
  cleanupTemporaryDirectories,
  makeInputRoot,
  runValidate,
  runValidateHostileThrow,
  snapshotTree,
  temporaryDirectory,
  writePrivateFile,
} from "../fixtures/validate/e2e.js";

afterAll(cleanupTemporaryDirectories);

async function writeDelivery(
  root: string,
  document: ReviewDocumentV1,
  contractName = "review-document.json",
): Promise<string> {
  const contractPath = join(root, contractName);
  await writePrivateFile(contractPath, `${JSON.stringify(document, null, 2)}\n`);
  await writePrivateFile(join(root, document.delivery.outputs.agent), validAgentBytes(document));
  await writePrivateFile(join(root, document.delivery.outputs.approval), validApprovalBytes(document));
  return contractPath;
}

function splitPart(part: number): ReviewDocumentV1 {
  const document = reviewDocumentFixture();
  const suffix = part === 1 ? "A" : "B";
  document.delivery.id = `RDL-${suffix.repeat(20)}`;
  document.delivery.baseName = `split_${part}`;
  document.delivery.outputs = {
    agent: `split_${part}_AGENT.md`,
    approval: `split_${part}_APPROVAL.html`,
  };
  document.delivery.splitGroup = {
    groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
    part,
    total: 2,
    reason: "Independent decision boundaries.",
  };
  document.document.id = `RD-${suffix.repeat(20)}`;
  document.document.title = `Split part ${part}`;
  document.document.summary = `Boundary for split part ${part}.`;
  return document;
}

describe("validate delivery subprocess", () => {
  it("provides transaction-compatible exact callbacks for one real freshly generated pair", async () => {
    const document = reviewDocumentFixture();
    const templateBytes = approvalTemplateBytes();
    const generated = generateArtifactBytes({ document, approvalTemplateBytes: templateBytes });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const result = createExactGeneratedArtifactByteVerifiers({
      document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
      agentBytes: generated.value.agent,
      approvalBytes: generated.value.approval,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agentVerifier: ByteVerifier = result.value.agent;
    const approvalVerifier: ByteVerifier = result.value.approval;
    expect(await agentVerifier(generated.value.agent)).toEqual({ ok: true });
    expect(await approvalVerifier(generated.value.approval)).toEqual({ ok: true });
    expect(await agentVerifier(generated.value.approval)).toEqual({ ok: false });
    expect(await approvalVerifier(generated.value.agent)).toEqual({ ok: false });
  });

  it("provides transaction-compatible exact-byte callbacks after paired cross-round preflight", async () => {
    const previous = reviewDocumentFixture();
    const current = structuredClone(previous);
    current.document.title = "Current replacement snapshot";
    current.document.contentVersion = 2;
    current.document.round = 2;
    current.lineage.previousReviewDigest = reviewDigest(previous);
    const agentBytes = validAgentBytes(previous);
    const approvalBytes = validApprovalBytes(previous);

    const result = createGeneratedReplacementByteVerifiers({
      currentDocument: current,
      generatorVersion: GENERATOR_VERSION,
      templateBytes: approvalTemplateBytes(),
      existingAgentBytes: agentBytes,
      existingApprovalBytes: approvalBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agentVerifier: ByteVerifier = result.value.agent;
    const approvalVerifier: ByteVerifier = result.value.approval;
    expect(await agentVerifier(agentBytes)).toEqual({ ok: true });
    expect(await approvalVerifier(approvalBytes)).toEqual({ ok: true });
    const driftedAgent = new Uint8Array(agentBytes);
    const driftedApproval = new Uint8Array(approvalBytes);
    driftedAgent[8] = (driftedAgent[8] ?? 0) ^ 1;
    driftedApproval[8] = (driftedApproval[8] ?? 0) ^ 1;
    expect(await agentVerifier(driftedAgent)).toEqual({ ok: false });
    expect(await approvalVerifier(driftedApproval)).toEqual({ ok: false });
  });

  it("returns the closed handoff and leaves every inode, byte, mode, and directory entry unchanged", async () => {
    const parent = await temporaryDirectory("validate-delivery");
    const root = await makeInputRoot(parent);
    const document = reviewDocumentFixture();
    document.continuation.evidenceGaps = ["Confirm the final owner."];
    document.evidence.risks = ["A timing dependency remains."];
    document.evidence.openQuestions = ["Which release window applies?"];
    document.evidence.conflicts.push({
      itemRefs: ["SRC-001", "C-001"],
      description: "A noncritical source timestamp differs.",
      severity: "nonblocking",
      status: "unresolved",
    });
    const contract = await writeDelivery(root, document);
    const before = await snapshotTree(root);

    const outcome = await runValidate(["validate", "delivery", "--document", contract]);

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(outcome.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "delivery",
      mutated: false,
      handoff: expect.objectContaining({
        kind: "delivery",
        generatorVersion: GENERATOR_VERSION,
        deliveryId: document.delivery.id,
        documentId: document.document.id,
        contentVersion: 1,
        round: 1,
        asOf: document.document.asOf,
        documentContentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        reviewDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        artifacts: {
          agent: {
            relativePath: document.delivery.outputs.agent,
            byteDigest: sha256Bytes(validAgentBytes(document)),
          },
          approval: {
            relativePath: document.delivery.outputs.approval,
            byteDigest: sha256Bytes(validApprovalBytes(document)),
          },
        },
        uncertainties: {
          evidenceGaps: { count: 1, safeSummaries: ["Confirm the final owner."] },
          unresolvedNonblockingConflicts: { count: 1, safeSummaries: ["A noncritical source timestamp differs."] },
          risks: { count: 1, safeSummaries: ["A timing dependency remains."] },
          openQuestions: { count: 1, safeSummaries: ["Which release window applies?"] },
        },
      }),
    });
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(root)).not.toContain(".review-txn");
  });

  it("fails closed for artifact drift without leaking input or returning a handoff", async () => {
    const parent = await temporaryDirectory("validate-drift");
    const root = await makeInputRoot(parent);
    const document = reviewDocumentFixture();
    const contract = await writeDelivery(root, document);
    await writePrivateFile(
      join(root, document.delivery.outputs.agent),
      validAgentBytes(document, "0.2.1"),
    );
    const privateSentinel = "secret-sentinel-that-must-not-appear";
    document.evidence.risks.push(["Author", "ization: Bearer ", privateSentinel].join(""));
    await writePrivateFile(contract, `${JSON.stringify(document)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate(["delivery", "--document", contract]);

    expect(outcome.status).toBe(3);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      phase: "validate",
      mutated: false,
      recoveryRequired: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "PRIVACY_VIOLATION" })]),
    }));
    expect(outcome.result).not.toHaveProperty("handoff");
    expect(outcome.result).not.toHaveProperty("summary");
    expect(JSON.stringify(outcome.result)).not.toContain(privateSentinel);
    expect(JSON.stringify(outcome.result)).not.toContain(root);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("runs the business gate before touching absent generated artifacts", async () => {
    const parent = await temporaryDirectory("validate-draft");
    const root = await makeInputRoot(parent);
    const document = reviewDocumentFixture();
    document.document.status = "draft";
    const contract = join(root, "review-document.json");
    await writePrivateFile(contract, `${JSON.stringify(document)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate(["delivery", "--document", contract]);

    expect(outcome.status).toBe(4);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "DOCUMENT_NOT_REVIEWABLE" })],
    }));
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("preserves PRQ-I/O PATH_INVALID exit 2 for a missing artifact slot on disk", async () => {
    const parent = await temporaryDirectory("validate-missing-artifact");
    const root = await makeInputRoot(parent);
    const document = reviewDocumentFixture();
    const contract = join(root, "review-document.json");
    await writePrivateFile(contract, `${JSON.stringify(document)}\n`);
    await writePrivateFile(join(root, document.delivery.outputs.approval), validApprovalBytes(document));
    const before = await snapshotTree(root);

    const outcome = await runValidate(["delivery", "--document", contract]);

    expect(outcome.status).toBe(2);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "PATH_INVALID", path: "/target" })],
    }));
    expect(outcome.result).not.toHaveProperty("handoff");
    expect(JSON.stringify(outcome.result)).not.toContain("ARTIFACT_MISSING");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("rejects one split-group part in delivery mode instead of bypassing batch closure", async () => {
    const parent = await temporaryDirectory("validate-single-split");
    const root = await makeInputRoot(parent);
    const contract = await writeDelivery(root, splitPart(1), "part-1.review-document.json");
    const before = await snapshotTree(root);

    const outcome = await runValidate(["delivery", "--document", contract]);

    expect(outcome.status).toBe(5);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({
        code: "SPLIT_GROUP_INVALID",
        path: "/document/delivery/splitGroup",
      })],
    }));
    expect(outcome.result).not.toHaveProperty("handoff");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("rejects hostile or ambiguous arguments with exit 2 and a closed failure envelope", async () => {
    const hostileFlag = ["--Author", "ization:Bearer-private-argument-abcdefgh"].join("");
    const cases = [
      [],
      ["unknown-mode"],
      ["delivery", "--unknown", "x"],
      ["delivery", hostileFlag, "x"],
      ["delivery", "--document"],
      ["delivery", "--document", "a", "--document", "b"],
      ["batch", "--document", "a"],
      ["transition", "--current", "a", "--packet", "b"],
      ["packet", "--document", "a", "--input", "b", "--legacy-profile", "unknown"],
      ["packet", "--document", "a", "--input", "b", "--confirm-round", "1"],
    ];
    for (const arguments_ of cases) {
      const outcome = await runValidate(arguments_);
      expect(outcome.status, arguments_.join(" ")).toBe(2);
      expect(outcome.result, arguments_.join(" ")).toEqual({
        status: "failed",
        phase: "validate",
        mutated: false,
        recoveryRequired: false,
        errors: [expect.objectContaining({ code: "ARGUMENT_INVALID" })],
      });
      expect(JSON.stringify(outcome.result)).not.toContain(hostileFlag);
    }
  });

  it("sanitizes an unclassified subprocess throw into the exact exit-70 envelope", async () => {
    const sentinel = "hostile-subprocess-text-that-must-not-leak";
    const outcome = await runValidateHostileThrow(sentinel);
    expect(outcome.status).toBe(70);
    expect(outcome.stderr).toBe("");
    expect(outcome.result).toEqual({
      status: "failed",
      phase: "validate",
      mutated: false,
      recoveryRequired: false,
      errors: [{
        code: "INTERNAL_ERROR",
        path: "",
        blockId: null,
        message: expect.any(String),
        hint: expect.any(String),
      }],
    });
    expect(JSON.stringify(outcome.result)).not.toContain(sentinel);
    expect(JSON.stringify(outcome.result)).not.toContain("Error");
  });
});

describe("validate split batch subprocess", () => {
  it("returns numerically ordered closed parts and remains read-only", async () => {
    const parent = await temporaryDirectory("validate-batch");
    const root = await makeInputRoot(parent);
    const first = splitPart(1);
    const second = splitPart(2);
    const firstPath = await writeDelivery(root, first, "first.review-document.json");
    const secondPath = await writeDelivery(root, second, "second.review-document.json");
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "batch",
      "--document", secondPath,
      "--document", firstPath,
    ]);

    expect(outcome.status).toBe(0);
    expect(outcome.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "batch",
      mutated: false,
      handoff: expect.objectContaining({
        kind: "batch",
        groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
        total: 2,
        reason: "Independent decision boundaries.",
        parts: [
          expect.objectContaining({ part: 1, title: first.document.title, documentId: first.document.id }),
          expect.objectContaining({ part: 2, title: second.document.title, documentId: second.document.id }),
        ],
      }),
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("rejects documents from different resolved roots without changing either tree", async () => {
    const parent = await temporaryDirectory("validate-batch-root");
    const firstRoot = await makeInputRoot(parent, "one");
    const secondRoot = await makeInputRoot(parent, "two");
    const firstPath = await writeDelivery(firstRoot, splitPart(1), "first.review-document.json");
    const secondPath = await writeDelivery(secondRoot, splitPart(2), "second.review-document.json");
    const before = await snapshotTree(parent);

    const outcome = await runValidate([
      "batch", "--document", firstPath, "--document", secondPath,
    ]);

    expect(outcome.status).toBe(5);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "SPLIT_GROUP_INVALID", path: "/batch/root" })],
    }));
    expect(await snapshotTree(parent)).toEqual(before);
  });
});
