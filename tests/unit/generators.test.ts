import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalReviewDocument,
  validateReviewDocument,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import {
  GENERATOR_VERSION,
  createReviewDocumentByteVerifier,
  generateAgentMarkdownBytes,
  generateAgentMarkdown,
  generateApprovalHtml,
  generateApprovalHtmlBytes,
  generateArtifactBytes,
  generateArtifactText,
  parseCanonicalReviewDocumentBytes,
  serializeReviewDocument,
} from "../../src/generators/index.js";
import {
  DRAFT_SLOT_MARKER,
  containsDraftDecisionSlot,
  createDraftReviewDocument,
} from "../../src/generators/draft.js";
import {
  encodeAgentMarkdownHeadingText,
  parseAgentArtifact,
  parseApprovalArtifact,
  validateDeliveryArtifactSet,
} from "../../src/cli/validate.js";

const GENERATOR_HEAVY_TEST_TIMEOUT_MS = 15_000;

async function fixture(): Promise<ReviewDocumentV1> {
  return JSON.parse(await readFile(
    resolve("tests/fixtures/schemas/valid/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

async function templateBytes(): Promise<Uint8Array> {
  return readFile(resolve(
    "skills/deliver-dual-audience-report/assets/review-workbench.template.html",
  ));
}

describe("deterministic review artifact generators", () => {
  it("A01_complete_review generates parser-valid Agent and Approval bytes from one snapshot", async () => {
    const document = await fixture();
    const template = await templateBytes();
    const generated = generateArtifactBytes({ document, approvalTemplateBytes: template });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const agent = parseAgentArtifact(generated.value.agent, document, GENERATOR_VERSION);
    const approval = parseApprovalArtifact({
      bytes: generated.value.approval,
      templateBytes: template,
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    const delivery = validateDeliveryArtifactSet({
      document,
      agentBytes: generated.value.agent,
      approvalBytes: generated.value.approval,
      approvalTemplateBytes: template,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(agent.ok).toBe(true);
    expect(approval.ok).toBe(true);
    expect(delivery.ok).toBe(true);
    expect(new TextDecoder().decode(generated.value.agent)).toContain("evidence synthesis, not a source of truth");
    expect(new TextDecoder().decode(generated.value.agent)).toContain(document.document.asOf);
  });

  it("produces identical owned bytes without mutating the document or template", async () => {
    const document = await fixture();
    const original = structuredClone(document);
    const template = await templateBytes();
    const templateCopy = Uint8Array.from(template);
    const first = generateArtifactBytes({ document, approvalTemplateBytes: template });
    const second = generateArtifactBytes({ document, approvalTemplateBytes: template });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.agent).toEqual(second.value.agent);
    expect(first.value.approval).toEqual(second.value.approval);
    expect(first.value.agent).not.toBe(second.value.agent);
    expect(first.value.approval).not.toBe(second.value.approval);
    expect(document).toEqual(original);
    expect(Uint8Array.from(template)).toEqual(templateCopy);
  }, GENERATOR_HEAVY_TEST_TIMEOUT_MS);

  it("renders hostile structured content as inert data without adding frozen headings", async () => {
    const document = await fixture();
    document.continuation.currentState.push({
      type: "paragraph",
      content: [{
        type: "text",
        text: "\n## Injected\n<script>globalThis.pwned=true</script> [x](#missing)",
      }],
    });
    document.continuation.currentState.push({
      type: "paragraph",
      content: [{
        type: "inlineCode",
        text: "</code><script>globalThis.pwned=true</script>&`\r\n",
      }],
    });
    const generated = generateAgentMarkdownBytes(document, GENERATOR_VERSION);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const text = new TextDecoder().decode(generated.value);
    expect(text).not.toContain("\n## Injected\n");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("</code><script>");
    expect(text).toContain("&lt;/code&gt;&lt;script&gt;globalThis.pwned=true&lt;/script&gt;&amp;&#96;&#13;&#10;");
    expect(parseAgentArtifact(generated.value, document, GENERATOR_VERSION).ok).toBe(true);
  });

  it("uses the public reversible heading encoder for hostile but representable titles", async () => {
    for (const title of [
      "Tail#",
      "<script>alert('x')</script>",
      " line one\r\nline two ",
      `bidi\u202E emoji 🧪`,
      String.raw`literal \u000A`,
    ]) {
      const document = await fixture();
      document.document.title = title;
      const encoded = encodeAgentMarkdownHeadingText(title);
      expect(encoded.ok).toBe(true);
      const generated = generateAgentMarkdownBytes(document, GENERATOR_VERSION);
      expect(generated.ok, title).toBe(true);
      if (!encoded.ok || !generated.ok) continue;
      expect(new TextDecoder().decode(generated.value)).toContain(
        `# ${encoded.value} — Agent Continuation`,
      );
      expect(parseAgentArtifact(generated.value, document, GENERATOR_VERSION).ok).toBe(true);
    }

    const document = await fixture();
    document.document.title = "bad\ud800title";
    expect(() => generateAgentMarkdown(document, GENERATOR_VERSION)).not.toThrow();
    expect(generateAgentMarkdown(document, GENERATOR_VERSION).ok).toBe(false);
  });

  it("keeps the combined text facade no-throw for hostile outer envelopes", async () => {
    let trapCalls = 0;
    const result = generateArtifactText(new Proxy({} as {
      document: unknown;
      approvalTemplateBytes: Uint8Array;
    }, {
      get() {
        trapCalls += 1;
        throw new Error("must not escape");
      },
    }));
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "ARGUMENT_INVALID", path: "/artifacts" })],
    });
    expect(trapCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("must not escape");
  });

  it("rejects changing outer getters without observing either snapshot", async () => {
    const document = await fixture();
    const template = await templateBytes();
    let documentReads = 0;
    let templateReads = 0;
    const hostile = {} as {
      document: unknown;
      approvalTemplateBytes: Uint8Array;
    };
    Object.defineProperties(hostile, {
      document: {
        enumerable: true,
        get() {
          documentReads += 1;
          return document;
        },
      },
      approvalTemplateBytes: {
        enumerable: true,
        get() {
          templateReads += 1;
          return template;
        },
      },
    });
    expect(generateArtifactBytes(hostile)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "ARGUMENT_INVALID", path: "/artifacts" })],
    });
    expect(documentReads).toBe(0);
    expect(templateReads).toBe(0);
  });

  it("rejects malformed combined envelopes and delegates deep inputs to public VAL snapshots", async () => {
    const document = await fixture();
    const template = await templateBytes();
    const inherited = Object.create({ document, approvalTemplateBytes: template }) as {
      document: unknown;
      approvalTemplateBytes: Uint8Array;
    };
    const extra = { document, approvalTemplateBytes: template, unexpected: true } as unknown as {
      document: unknown;
      approvalTemplateBytes: Uint8Array;
    };
    const hidden = {} as { document: unknown; approvalTemplateBytes: Uint8Array };
    Object.defineProperties(hidden, {
      document: { value: document, enumerable: false },
      approvalTemplateBytes: { value: template, enumerable: true },
    });
    const invalidDocument = structuredClone(document) as ReviewDocumentV1 & Record<string, unknown>;
    invalidDocument.unexpected = true;
    for (const result of [
      generateArtifactBytes(null as never),
      generateArtifactBytes([] as never),
      generateArtifactBytes(inherited),
      generateArtifactBytes(extra),
      generateArtifactBytes(hidden),
      generateArtifactBytes({ document: invalidDocument, approvalTemplateBytes: template }),
      generateArtifactBytes({ document, approvalTemplateBytes: new Uint8Array([0xff]) }),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  it("fails closed for a drifted Approval template and never mutates it", async () => {
    const document = await fixture();
    const template = await templateBytes();
    const drifted = new TextEncoder().encode(
      new TextDecoder().decode(template).replace("@@DAR_ROUND@@", "1"),
    );
    const before = Uint8Array.from(drifted);
    const result = generateApprovalHtmlBytes(document, GENERATOR_VERSION, drifted);
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "ARTIFACT_FORMAT_INVALID" })],
    });
    expect(drifted).toEqual(before);
  });

  it("fails closed for duplicate, unknown, misplaced, and oversized Approval template data", async () => {
    const document = await fixture();
    const template = new TextDecoder().decode(await templateBytes());
    const payloadMarker = "@@DAR_DOCUMENT_BASE64@@";
    const invalidTemplates = [
      template.replace(payloadMarker, `${payloadMarker}${payloadMarker}`),
      template.replace("</body>", "@@DAR_UNKNOWN@@</body>"),
      template.replace(`>${payloadMarker}</template>`, `>x${payloadMarker}</template>`),
      template.replace("</body>", `${"x".repeat(360_000)}</body>`),
    ];
    for (const value of invalidTemplates) {
      const result = generateApprovalHtml(document, GENERATOR_VERSION, new TextEncoder().encode(value));
      expect(result.ok).toBe(false);
    }
    const proxied = new Proxy(await templateBytes(), {});
    expect(() => generateApprovalHtml(document, GENERATOR_VERSION, proxied)).not.toThrow();
    expect(generateApprovalHtml(document, GENERATOR_VERSION, proxied).ok).toBe(false);
  });

  it("rejects unsupported and hostile versions at all four individual entry points", async () => {
    const document = await fixture();
    const template = await templateBytes();
    for (const result of [
      generateAgentMarkdown(document, "0.2.1"),
      generateAgentMarkdownBytes(document, "0.2.1"),
      generateApprovalHtml(document, "0.2.1", template),
      generateApprovalHtmlBytes(document, "0.2.1", template),
      generateAgentMarkdown(document, new String(GENERATOR_VERSION) as unknown as string),
      generateAgentMarkdownBytes(document, new String(GENERATOR_VERSION) as unknown as string),
      generateApprovalHtml(document, new String(GENERATOR_VERSION) as unknown as string, template),
      generateApprovalHtmlBytes(document, new String(GENERATOR_VERSION) as unknown as string, template),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: "ARGUMENT_INVALID" })],
      });
    }
  });

  it("rejects promoted initialization slots at every pure generation entry point", async () => {
    const document = createDraftReviewDocument({
      deliveryId: "RDL-AAAAAAAAAAAAAAAAAAAA",
      documentId: "RD-BBBBBBBBBBBBBBBBBBBB",
      baseName: "draft_plan",
      repositoryStatus: "local-only",
      title: "Draft plan",
      language: "en",
      uiLocale: "en",
      asOf: "2026-08-13T10:00:00+08:00",
    });
    document.document.status = "in-review";
    const template = await templateBytes();
    for (const result of [
      generateAgentMarkdown(document, GENERATOR_VERSION),
      generateAgentMarkdownBytes(document, GENERATOR_VERSION),
      generateApprovalHtml(document, GENERATOR_VERSION, template),
      generateApprovalHtmlBytes(document, GENERATOR_VERSION, template),
      generateArtifactText({ document, approvalTemplateBytes: template }),
      generateArtifactBytes({ document, approvalTemplateBytes: template }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({
          code: "DOCUMENT_NOT_REVIEWABLE",
          path: "/document/blocks",
        })],
      });
    }
  });
});

describe("canonical review-document serialization", () => {
  it("serializes one canonical LF-terminated byte representation and verifies exact bytes", async () => {
    const document = await fixture();
    const serialized = serializeReviewDocument(document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const expected = `${canonicalJson(canonicalReviewDocument(document))}\n`;
    expect(new TextDecoder().decode(serialized.value)).toBe(expected);
    expect(createReviewDocumentByteVerifier(document)(serialized.value)).toEqual({ ok: true });
    expect(parseCanonicalReviewDocumentBytes(serialized.value)).toEqual({
      ok: true,
      value: canonicalReviewDocument(document),
    });
  });

  it("binds the verifier to full canonical bytes and catches hostile inputs", async () => {
    const document = await fixture();
    const serialized = serializeReviewDocument(document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const verifier = createReviewDocumentByteVerifier(document);
    const pretty = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    const changed = Uint8Array.from(serialized.value);
    changed[10] = changed[10] === 65 ? 66 : 65;
    expect(verifier(pretty)).toEqual({ ok: false });
    expect(verifier(changed)).toEqual({ ok: false });
    expect(verifier(new Proxy(serialized.value, {}))).toEqual({ ok: false });
    expect(createReviewDocumentByteVerifier({})(serialized.value)).toEqual({ ok: false });
    expect(verifier(null as never)).toEqual({ ok: false });
  });

  it("rejects malformed, private, invalid, and noncanonical document byte encodings", async () => {
    const document = await fixture();
    const privateDocument = structuredClone(document);
    privateDocument.evidence.risks.push(
      ["Author", "ization: Bearer private-document-abcdefgh"].join(""),
    );
    const inputs = [
      new Uint8Array([0xff]),
      new TextEncoder().encode("{\"format\":\"review-document/1\",}"),
      new TextEncoder().encode(`${JSON.stringify(privateDocument)}\n`),
      new TextEncoder().encode("{}\n"),
      new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    ];
    for (const bytes of inputs) expect(parseCanonicalReviewDocumentBytes(bytes).ok).toBe(false);
  });

  it("never serializes secrets or throws when a hostile document Proxy changes", async () => {
    const document = await fixture();
    let calls = 0;
    const hostile = new Proxy(document, {
      ownKeys(target) {
        calls += 1;
        if (calls > 1) throw new Error(["Bearer", "SECRET-DO-NOT-LEAK"].join(" "));
        return Reflect.ownKeys(target);
      },
    });
    let result: ReturnType<typeof serializeReviewDocument> | undefined;
    expect(() => {
      result = serializeReviewDocument(hostile);
    }).not.toThrow();
    expect(calls).toBe(1);
    expect(result?.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-DO-NOT-LEAK");
    if (result?.ok) {
      expect(new TextDecoder().decode(result.value)).not.toContain("SECRET-DO-NOT-LEAK");
    }
  });

  it("does not echo hostile protocol keys or block IDs from pre-snapshot failures", async () => {
    const document = await fixture() as ReviewDocumentV1 & Record<string, unknown>;
    const hostileKey = ["Bearer", "AAAAAAAAAAAA"].join(" ");
    document[hostileKey] = true;
    document.blocks[0]!.id = hostileKey;
    const result = serializeReviewDocument(document);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(hostileKey);
    if (!result.ok) {
      expect(result.errors.every((error) => error.path === "/document" && error.blockId === null)).toBe(true);
    }
  });
});

describe("safe initialization draft", () => {
  it("creates exactly four T0 slots without evidence, decisions, approvals, or ledger entries", () => {
    const document = createDraftReviewDocument({
      deliveryId: "RDL-AAAAAAAAAAAAAAAAAAAA",
      documentId: "RD-BBBBBBBBBBBBBBBBBBBB",
      baseName: "draft_plan",
      repositoryStatus: "local-only",
      title: "Draft plan",
      language: "en",
      uiLocale: "en",
      asOf: "2026-08-13T10:00:00+08:00",
    });
    const validated = validateReviewDocument(document);
    expect(validated.ok).toBe(true);
    expect(document.document).toMatchObject({ contentVersion: 1, round: 1, status: "draft" });
    expect(document.blocks.map((block) => [block.id, block.tier])).toEqual([
      ["B001", "T0"], ["B002", "T0"], ["B003", "T0"], ["B004", "T0"],
    ]);
    expect(document.blocks.every((block) => JSON.stringify(block).includes(DRAFT_SLOT_MARKER))).toBe(true);
    expect(containsDraftDecisionSlot(document)).toBe(true);
    expect(document.evidence).toEqual({
      sourceHierarchy: [], facts: [], decisions: [], constraints: [], risks: [], openQuestions: [], conflicts: [],
    });
    expect(document.approvals).toEqual({ history: [], currentFrozen: [] });
    expect(document.lineage).toEqual({
      previousReviewDigest: null,
      idHighWater: { block: 4, source: 0, fact: 0, decision: 0, glossary: 0, note: 0, topic: 0 },
      consumedPackets: [], topicMappings: [], impactAssessments: [], feedbackResolutions: [],
    });
  });
});
