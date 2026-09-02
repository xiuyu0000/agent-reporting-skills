import { describe, expect, it } from "vitest";
import {
  buildBatchHandoff,
  buildDeliveryHandoff,
  createAgentArtifactByteVerifier,
  createApprovalArtifactByteVerifier,
  decodeStrictUtf8,
  parseAgentArtifact,
  parseApprovalArtifact,
  parseStrictJson,
  validateDeliverableDocument,
  validateDeliveryAndBuildHandoff,
  validateDeliveryArtifactSet,
  runValidateCommand,
} from "../../src/cli/validate.js";
import {
  exitCodeForValidationErrors,
  failureEnvelope,
  fromCliIoError,
  fromProtocolError,
  validationError,
  validationErrors,
  validationSuccess,
} from "../../src/cli/validate/errors.js";
import { cliIoError } from "../../src/cli/result.js";
import { resolveInputRoot } from "../../src/cli/validate/read.js";
import { isLegacyStaticContract, isSemver } from "../../src/cli/validate/text.js";
import {
  protocolError,
  sha256Bytes,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import { freezeBlocks } from "./rounds-fixtures.js";
import {
  GENERATOR_VERSION,
  approvalTemplateBytes,
  reviewDocumentFixture,
  validAgentBytes,
  validApprovalBytes,
} from "../fixtures/validate/helpers.js";

function errorCodes(result: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  return result.errors?.map((error) => error.code) ?? [];
}

describe("delivery business gate", () => {
  it("accepts an active in-review document and a fully frozen finalized document", () => {
    const active = reviewDocumentFixture();
    expect(validateDeliverableDocument(active)).toEqual({ ok: true, value: active });

    const finalized = reviewDocumentFixture();
    freezeBlocks(finalized, finalized.blocks.map((block) => block.id));
    expect(validateDeliverableDocument(finalized)).toEqual({ ok: true, value: finalized });
  });

  it("blocks drafts, blocking conflicts, already-complete in-review documents, and bad finalization", () => {
    const draft = reviewDocumentFixture();
    draft.document.status = "draft";
    expect(errorCodes(validateDeliverableDocument(draft))).toContain("DOCUMENT_NOT_REVIEWABLE");

    const conflict = reviewDocumentFixture();
    conflict.evidence.conflicts.push({
      itemRefs: ["SRC-001", "C-001"],
      description: "The source claims remain unresolved.",
      severity: "blocking",
      status: "unresolved",
    });
    expect(errorCodes(validateDeliverableDocument(conflict))).toContain("BLOCKING_CONFLICT");

    const completeReview = reviewDocumentFixture();
    freezeBlocks(completeReview, completeReview.blocks.map((block) => block.id));
    completeReview.document.status = "in-review";
    expect(errorCodes(validateDeliverableDocument(completeReview))).toContain("DOCUMENT_NOT_REVIEWABLE");

    const incompleteFinal = reviewDocumentFixture();
    incompleteFinal.document.status = "finalized";
    expect(errorCodes(validateDeliverableDocument(incompleteFinal))).toContain("DOCUMENT_NOT_REVIEWABLE");

    const changedFinal = reviewDocumentFixture();
    changedFinal.document.round = 2;
    changedFinal.lineage.previousReviewDigest = `sha256:${"0".repeat(64)}`;
    changedFinal.blocks[0]!.changed = { round: 2, summary: "Still active." };
    freezeBlocks(changedFinal, changedFinal.blocks.map((block) => block.id));
    expect(errorCodes(validateDeliverableDocument(changedFinal))).toContain("DOCUMENT_NOT_REVIEWABLE");
  });

  it("delegates protocol freshness, source-reference, URL, and privacy validation", () => {
    const stale = reviewDocumentFixture();
    stale.evidence.sourceHierarchy[0]!.freshness = {
      kind: "time-sensitive",
      checkedAt: "2026-08-12T08:00:00Z",
      expiresAt: "2026-08-12T08:30:00Z",
    };
    expect(errorCodes(validateDeliverableDocument(stale))).toContain("FRESHNESS_INVALID");

    const dangling = reviewDocumentFixture();
    dangling.evidence.facts[0]!.sourceRefs = ["SRC-999"];
    expect(errorCodes(validateDeliverableDocument(dangling))).toContain("UNKNOWN_REFERENCE");

    const unsafeLink = reviewDocumentFixture();
    const paragraph = unsafeLink.blocks[0]?.body[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture drift");
    paragraph.content.push({ type: "link", text: "unsafe", href: "javascript:alert(1)" });
    expect(errorCodes(validateDeliverableDocument(unsafeLink))).toContain("SCHEMA_FORMAT");

    // A scale item's note is inline content too, so it must fail closed the
    // same way; the traversal for it is a separate branch from the paragraph's.
    const unsafeScaleNote = reviewDocumentFixture();
    unsafeScaleNote.blocks[0]?.body.push({
      type: "scale",
      title: "Carrier strength",
      description: "How reliably each carrier holds a rule.",
      axis: { lowLabel: "weakest", highLabel: "strongest" },
      items: [
        { label: "Spoken", position: 5 },
        {
          label: "Checked",
          position: 95,
          note: [{ type: "link", text: "unsafe", href: "javascript:alert(1)" }],
        },
      ],
    });
    expect(errorCodes(validateDeliverableDocument(unsafeScaleNote))).toContain("SCHEMA_FORMAT");

    // And an unknown glossary reference inside that same note.
    const danglingTerm = reviewDocumentFixture();
    danglingTerm.blocks[0]?.body.push({
      type: "scale",
      title: "Carrier strength",
      description: "How reliably each carrier holds a rule.",
      axis: { lowLabel: "weakest", highLabel: "strongest" },
      items: [
        { label: "Spoken", position: 5 },
        { label: "Checked", position: 95, note: [{ type: "termRef", glossaryId: "G-999" }] },
      ],
    });
    expect(errorCodes(validateDeliverableDocument(danglingTerm))).toContain("UNKNOWN_REFERENCE");

    const privateDocument = reviewDocumentFixture();
    privateDocument.evidence.risks.push(["Author", "ization: Bearer abcdefghijk"].join(""));
    expect(errorCodes(validateDeliverableDocument(privateDocument))).toContain("PRIVACY_VIOLATION");
  });

  it("takes one inert snapshot before privacy and protocol validation", () => {
    const sentinel = "Bearer private-proxy-credential-abcdefgh";
    let trapReads = 0;
    const target = reviewDocumentFixture();
    const hostile = new Proxy(target, {
      ownKeys() {
        trapReads += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(_value, key) {
        trapReads += 1;
        if (key === "continuation") {
          const continuation = structuredClone(target.continuation);
          continuation.evidenceGaps.push(sentinel);
          return { value: continuation, enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = validateDeliverableDocument(hostile);
    expect(result.ok).toBe(false);
    expect(trapReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain(sentinel);

    let getterReads = 0;
    const getter = Object.defineProperty({}, "document", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(sentinel);
      },
    });
    expect(() => validateDeliverableDocument(getter)).not.toThrow();
    expect(getterReads).toBe(0);
  });
});

describe("delivery artifact set and handoff", () => {
  it("validates one shared snapshot and returns exact digests and four uncertainty classes", () => {
    const document = reviewDocumentFixture();
    document.continuation.evidenceGaps = ["Confirm the release owner."];
    document.evidence.risks = ["A rollout can be delayed."];
    document.evidence.openQuestions = ["Which window is selected?"];
    document.evidence.conflicts.push({
      itemRefs: ["SRC-001", "C-001"],
      description: "Two noncritical timestamps differ.",
      severity: "nonblocking",
      status: "unresolved",
    });
    const agentBytes = validAgentBytes(document);
    const approvalBytes = validApprovalBytes(document);
    const artifacts = validateDeliveryArtifactSet({
      document,
      agentBytes,
      approvalBytes,
      approvalTemplateBytes: approvalTemplateBytes(),
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(artifacts.ok).toBe(true);
    const complete = validateDeliveryAndBuildHandoff({
      document,
      agentBytes,
      approvalBytes,
      approvalTemplateBytes: approvalTemplateBytes(),
      expectedGeneratorVersion: GENERATOR_VERSION,
      agent: { relativePath: document.delivery.outputs.agent, byteDigest: sha256Bytes(agentBytes) },
      approval: { relativePath: document.delivery.outputs.approval, byteDigest: sha256Bytes(approvalBytes) },
    });
    expect(complete).toEqual({
      ok: true,
      value: {
        document: expect.objectContaining({
          delivery: expect.objectContaining({ id: document.delivery.id }),
          document: expect.objectContaining({ id: document.document.id }),
        }),
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
            agent: { relativePath: document.delivery.outputs.agent, byteDigest: sha256Bytes(agentBytes) },
            approval: { relativePath: document.delivery.outputs.approval, byteDigest: sha256Bytes(approvalBytes) },
          },
          uncertainties: {
            evidenceGaps: { count: 1, safeSummaries: ["Confirm the release owner."] },
            unresolvedNonblockingConflicts: { count: 1, safeSummaries: ["Two noncritical timestamps differ."] },
            risks: { count: 1, safeSummaries: ["A rollout can be delayed."] },
            openQuestions: { count: 1, safeSummaries: ["Which window is selected?"] },
          },
        }),
      },
    });
  });

  it("fails closed for snapshot/version drift and undeclared or colliding paths", () => {
    const document = reviewDocumentFixture();
    const missing = validateDeliveryArtifactSet({
      document,
      approvalTemplateBytes: approvalTemplateBytes(),
    });
    expect(errorCodes(missing)).toEqual(["ARTIFACT_MISSING", "ARTIFACT_MISSING"]);
    if (!missing.ok) expect(exitCodeForValidationErrors(missing.errors)).toBe(5);
    const mismatched = validateDeliveryArtifactSet({
      document,
      agentBytes: validAgentBytes(document, "0.2.1"),
      approvalBytes: validApprovalBytes(document, GENERATOR_VERSION),
      approvalTemplateBytes: approvalTemplateBytes(),
    });
    expect(errorCodes(mismatched)).toContain("ARTIFACT_IDENTITY_MISMATCH");

    const digest = sha256Bytes(new Uint8Array([1]));
    expect(errorCodes(buildDeliveryHandoff({
      document,
      generatorVersion: GENERATOR_VERSION,
      agent: { relativePath: "different.md", byteDigest: digest },
      approval: { relativePath: document.delivery.outputs.approval, byteDigest: digest },
    }))).toContain("ARTIFACT_IDENTITY_MISMATCH");
    expect(errorCodes(buildDeliveryHandoff({
      document,
      generatorVersion: "bad",
      agent: { relativePath: document.delivery.outputs.agent, byteDigest: "bad" as never },
      approval: { relativePath: document.delivery.outputs.approval, byteDigest: digest },
    }))).toContain("ARTIFACT_IDENTITY_MISMATCH");
    expect(errorCodes(buildDeliveryHandoff({
      document,
      generatorVersion: GENERATOR_VERSION,
      agent: { relativePath: "../escape.md", byteDigest: digest },
      approval: { relativePath: "../escape.md", byteDigest: digest },
    }))).toContain("ARTIFACT_IDENTITY_MISMATCH");

    const agentBytes = validAgentBytes(document);
    const approvalBytes = validApprovalBytes(document);
    expect(errorCodes(validateDeliveryAndBuildHandoff({
      document,
      agentBytes,
      approvalBytes,
      approvalTemplateBytes: approvalTemplateBytes(),
      agent: { relativePath: document.delivery.outputs.agent, byteDigest: digest },
      approval: { relativePath: document.delivery.outputs.approval, byteDigest: digest },
    }))).toContain("ARTIFACT_IDENTITY_MISMATCH");
  });

  it("never copies private uncertainty text from direct handoff-builder input", () => {
    const document = reviewDocumentFixture();
    const sentinel = "handoff-private-token-abcdefgh";
    document.evidence.risks.push(["Author", "ization: Bearer ", sentinel].join(""));
    const digest = sha256Bytes(new Uint8Array([1]));
    const result = buildDeliveryHandoff({
      document,
      generatorVersion: GENERATOR_VERSION,
      agent: { relativePath: document.delivery.outputs.agent, byteDigest: digest },
      approval: { relativePath: document.delivery.outputs.approval, byteDigest: digest },
    });
    expect(errorCodes(result)).toContain("PRIVACY_VIOLATION");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("keeps every public validation facade and staged verifier closed for hostile JS", () => {
    const sentinel = "hostile-facade-secret-abcdefgh";
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error(sentinel);
      },
    });
    const calls = [
      () => validateDeliverableDocument(hostile),
      () => parseAgentArtifact(validAgentBytes(reviewDocumentFixture()), hostile as never),
      () => parseApprovalArtifact(hostile as never),
      () => validateDeliveryArtifactSet(hostile as never),
      () => validateDeliveryAndBuildHandoff(hostile as never),
      () => buildDeliveryHandoff(hostile as never),
      () => buildBatchHandoff(hostile as never),
    ];
    for (const call of calls) {
      expect(call).not.toThrow();
      const result = call();
      expect(result.ok).toBe(false);
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
    const agentVerifier = createAgentArtifactByteVerifier(hostile as never);
    const approvalVerifier = createApprovalArtifactByteVerifier(hostile as never);
    expect(() => agentVerifier(new Proxy(new Uint8Array(), {}) as never)).not.toThrow();
    expect(agentVerifier(new Proxy(new Uint8Array(), {}) as never)).toEqual({ ok: false });
    expect(() => approvalVerifier(new Proxy(new Uint8Array(), {}) as never)).not.toThrow();
    expect(approvalVerifier(new Proxy(new Uint8Array(), {}) as never)).toEqual({ ok: false });
  });
});

function splitPart(part: number): ReviewDocumentV1 {
  const document = reviewDocumentFixture();
  const suffix = part === 1 ? "A" : "B";
  document.delivery.id = `RDL-${suffix.repeat(20)}`;
  document.document.id = `RD-${suffix.repeat(20)}`;
  document.document.title = `Split part ${part}`;
  document.document.summary = `Boundary for part ${part}.`;
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
  return document;
}

function handoffFor(document: ReviewDocumentV1, generatorVersion = GENERATOR_VERSION) {
  const digest = sha256Bytes(new Uint8Array([document.delivery.splitGroup?.part ?? 0]));
  const result = buildDeliveryHandoff({
    document,
    generatorVersion,
    agent: { relativePath: document.delivery.outputs.agent, byteDigest: digest },
    approval: { relativePath: document.delivery.outputs.approval, byteDigest: digest },
  });
  if (!result.ok) throw new Error("handoff setup failed");
  return result.value;
}

describe("closed split batch handoff", () => {
  it("sorts complete parts and preserves each part's closed shape", () => {
    const first = splitPart(1);
    const second = splitPart(2);
    const result = buildBatchHandoff({ deliveries: [
      { document: second, contractRelativePath: "second.review-document.json", handoff: handoffFor(second) },
      { document: first, contractRelativePath: "first.review-document.json", handoff: handoffFor(first) },
    ] });
    expect(result).toEqual({ ok: true, value: expect.objectContaining({
      kind: "batch",
      groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
      total: 2,
      reason: "Independent decision boundaries.",
      parts: [
        expect.objectContaining({ part: 1, title: "Split part 1", documentId: first.document.id }),
        expect.objectContaining({ part: 2, title: "Split part 2", documentId: second.document.id }),
      ],
    }) });
  });

  it("rejects empty, incomplete, inconsistent, duplicate, portable-colliding, and mixed-generator batches", () => {
    expect(errorCodes(buildBatchHandoff({ deliveries: [] }))).toContain("SPLIT_GROUP_INVALID");
    const first = splitPart(1);
    const second = splitPart(2);
    const valid = [
      { document: first, contractRelativePath: "Foo.review-document.json", handoff: handoffFor(first) },
      { document: second, contractRelativePath: "foo.review-document.json", handoff: handoffFor(second, "0.2.1") },
    ];
    expect(errorCodes(buildBatchHandoff({ deliveries: valid }))).toContain("SPLIT_GROUP_INVALID");

    const tamperedHandoff = handoffFor(second);
    tamperedHandoff.round += 1;
    expect(errorCodes(buildBatchHandoff({ deliveries: [
      { document: first, contractRelativePath: "one.json", handoff: handoffFor(first) },
      { document: second, contractRelativePath: "two.json", handoff: tamperedHandoff },
    ] }))).toContain("SPLIT_GROUP_INVALID");

    const duplicate = splitPart(2);
    duplicate.document.id = first.document.id;
    duplicate.delivery.id = first.delivery.id;
    duplicate.delivery.baseName = first.delivery.baseName.toUpperCase();
    duplicate.delivery.splitGroup!.reason = "Different reason.";
    expect(errorCodes(buildBatchHandoff({ deliveries: [
      { document: first, contractRelativePath: "one.json", handoff: handoffFor(first) },
      { document: duplicate, contractRelativePath: "two.json", handoff: handoffFor(duplicate) },
    ] }))).toContain("SPLIT_GROUP_INVALID");
  });
});

describe("stable result and exit mapping", () => {
  it("uses closed VAL categories, passes existing codes through, and emits no success fields", () => {
    expect(exitCodeForValidationErrors([validationError("ARGUMENT_INVALID", "/x")])).toBe(2);
    expect(exitCodeForValidationErrors([validationError("CSP_INVALID", "/x")])).toBe(3);
    expect(exitCodeForValidationErrors([validationError("BLOCKING_CONFLICT", "/x")])).toBe(4);
    expect(exitCodeForValidationErrors([validationError("ARTIFACT_DRIFT", "/x")])).toBe(5);
    expect(exitCodeForValidationErrors([validationError("INTERNAL_ERROR", "/")])).toBe(70);
    expect(exitCodeForValidationErrors([fromCliIoError(cliIoError("SYMLINK_REJECTED", "/target"))])).toBe(3);
    expect(exitCodeForValidationErrors([fromCliIoError(cliIoError("IO_OPERATION_FAILED", "/target"))])).toBe(2);
    expect(exitCodeForValidationErrors([fromProtocolError(protocolError("IDENTITY_CONFIRMATION_REQUIRED", "/doc"))])).toBe(4);
    const hostileField = ["Author", "ization: Bearer hostile-field-abcdefgh"].join("");
    const sanitized = fromProtocolError(protocolError("SCHEMA_ADDITIONAL_PROPERTIES", `/document/${hostileField}`));
    expect(sanitized.path).toBe("/document");
    expect(JSON.stringify(sanitized)).not.toContain(hostileField);
    expect(exitCodeForValidationErrors([])).toBe(70);
    const failure = failureEnvelope([
      validationError("ARTIFACT_DRIFT", "/z"),
      validationError("CSP_INVALID", "/a"),
    ]);
    expect(failure).toEqual({
      status: "failed",
      phase: "validate",
      mutated: false,
      recoveryRequired: false,
      errors: [
        expect.objectContaining({ code: "CSP_INVALID", path: "/a" }),
        expect.objectContaining({ code: "ARTIFACT_DRIFT", path: "/z" }),
      ],
    });
    expect(failure).not.toHaveProperty("handoff");
    expect(failure).not.toHaveProperty("summary");
    expect(failure).not.toHaveProperty("normalized");
  });

  it("keeps generic result helpers deterministic and path-safe", () => {
    expect(validationSuccess(1)).toEqual({ ok: true, value: 1 });
    const errors = validationErrors([
      validationError("CSP_INVALID", "unsafe-path"),
      validationError("ARTIFACT_DRIFT", "/b"),
    ]);
    expect(errors).toEqual({ ok: false, errors: [
      expect.objectContaining({ path: "/" }),
      expect.objectContaining({ path: "/b" }),
    ] });
  });

  it("sanitizes an unclassified hostile throw into INTERNAL_ERROR exit 70", async () => {
    const sentinel = "hostile-internal-text-that-must-not-leak";
    const hostileArguments = new Proxy([] as string[], {
      get() {
        throw new Error(sentinel);
      },
    });
    const outcome = await runValidateCommand(hostileArguments);
    expect(outcome).toEqual({
      exitCode: 70,
      result: {
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
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(sentinel);
    expect(JSON.stringify(outcome)).not.toContain("Error");
  });
});

describe("safe input and strict-text helpers", () => {
  it("resolves only safe relative targets without exposing absolute paths in failures", async () => {
    const empty = await resolveInputRoot("");
    const nul = await resolveInputRoot("bad\0path");
    for (const result of [empty, nul]) {
      expect(result).toEqual({
        ok: false,
        errors: [expect.objectContaining({ code: "ARGUMENT_INVALID", path: "/inputDir" })],
      });
      expect(JSON.stringify(result)).not.toContain("bad");
    }
  });

  it("accepts valid UTF-8 whitespace while rejecting NUL/BOM and duplicate/nonsensical JSON", () => {
    expect(decodeStrictUtf8(new Uint8Array(), "/input")).toEqual({ ok: true, value: "" });
    expect(decodeStrictUtf8(new TextEncoder().encode("line\r\n"), "/input"))
      .toEqual({ ok: true, value: "line\r\n" });
    for (const text of ["nul\0value", "\ufeffvalue"]) {
      const bytes = text.startsWith("\ufeff")
        ? Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text.slice(1))])
        : new TextEncoder().encode(text);
      expect(decodeStrictUtf8(bytes, "/input")).toEqual(expect.objectContaining({ ok: false }));
    }
    expect(parseStrictJson('{"a":1,"a":2}', "/input")).toEqual(expect.objectContaining({ ok: false }));
    expect(parseStrictJson('{\r"a":1,\r"a":2}', "/input")).toEqual(expect.objectContaining({ ok: false }));
    expect(parseStrictJson('{"a":{"b":1,"b":2}}', "/input")).toEqual(expect.objectContaining({ ok: false }));
    expect(parseStrictJson("not-json", "/input")).toEqual(expect.objectContaining({ ok: false }));
    expect(parseStrictJson('[{"a":1}]', "/input")).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(isLegacyStaticContract(null)).toBe(false);
    expect(isLegacyStaticContract([])).toBe(false);
    expect(isLegacyStaticContract({ schema_version: "dual-audience-report-contract-v1" })).toBe(true);
    expect(isLegacyStaticContract({ format: "dual-audience-report-contract-v1" })).toBe(true);
    expect(isSemver("0.2.0-alpha.1+build.01")).toBe(true);
    expect(isSemver("1.0.0-01")).toBe(false);
    expect(isSemver("1.0.0-alpha..1")).toBe(false);
  });
});
