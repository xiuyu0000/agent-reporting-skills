import { describe, expect, it } from "vitest";
import {
  createAgentArtifactByteVerifier,
  createApprovalArtifactByteVerifier,
  createGeneratedReplacementByteVerifiers,
  encodeAgentMarkdownHeadingText,
  parseAgentArtifact,
  parseApprovalArtifact,
} from "../../src/cli/validate.js";
import { reviewDigest, validateReviewDocument, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  GENERATOR_VERSION,
  approvalTemplateBytes,
  approvalTemplateText,
  reviewDocumentFixture,
  validAgentBytes,
  validAgentText,
  validApprovalBytes,
  validApprovalText,
} from "../fixtures/validate/helpers.js";

const encoder = new TextEncoder();
// This 30-case shell-lock matrix intentionally reparses complete actual/template
// artifacts. Coverage instrumentation plus CI contention can exceed Vitest's 5s
// default without changing parser behavior or any assertion in the matrix.
const APPROVAL_SHELL_LOCK_TEST_TIMEOUT_MS = 15_000;

function codes(result: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  return result.errors?.map((error) => error.code) ?? [];
}

function encodedTitle(title: string): string {
  const result = encodeAgentMarkdownHeadingText(title);
  if (!result.ok) throw new Error("title setup failed");
  return result.value;
}

function validEncodedAgentBytes(document: ReviewDocumentV1, generatorVersion = GENERATOR_VERSION): Uint8Array {
  const source = validAgentText(document, generatorVersion);
  return encoder.encode(source.replace(
    `# ${document.document.title} — Agent Continuation`,
    `# ${encodedTitle(document.document.title)} — Agent Continuation`,
  ));
}

function laterCurrentDocument(oldDocument: ReviewDocumentV1): ReviewDocumentV1 {
  const current = structuredClone(oldDocument);
  current.document.title = "Current replacement title: v2";
  current.document.contentVersion = 2;
  current.document.round = 2;
  current.lineage.previousReviewDigest = reviewDigest(oldDocument);
  return current;
}

describe("canonical Agent Markdown heading encoder", () => {
  it("encodes punctuation, controls, invisible scalars, edge spaces, and supplementary format scalars", () => {
    const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    expect(encodeAgentMarkdownHeadingText(punctuation)).toEqual({
      ok: true,
      value: [...punctuation].map((value) => `\\${value}`).join(""),
    });
    expect(encodeAgentMarkdownHeadingText("  Alpha beta  ")).toEqual({
      ok: true,
      value: String.raw`\u0020\u0020Alpha beta\u0020\u0020`,
    });
    expect(encodeAgentMarkdownHeadingText("A\n\r\u0085\u202E\u2028\u2029B")).toEqual({
      ok: true,
      value: String.raw`A\u000A\u000D\u0085\u202E\u2028\u2029B`,
    });
    expect(encodeAgentMarkdownHeadingText(`emoji 🧪${String.fromCodePoint(0xe0001)}`)).toEqual({
      ok: true,
      value: String.raw`emoji 🧪\u{E0001}`,
    });
    expect(encodeAgentMarkdownHeadingText(String.raw`\u000A`)).toEqual({
      ok: true,
      value: String.raw`\\u000A`,
    });
  });

  it("fails closed without coercing hostile or non-scalar input", () => {
    for (const title of ["bad\ud800title", "bad\udc00title"]) {
      expect(codes(encodeAgentMarkdownHeadingText(title))).toContain("ARTIFACT_FORMAT_INVALID");
    }
    const sentinel = "heading-hostile-secret-abcdefgh";
    const hostile = new Proxy({}, {
      get() {
        throw new Error(sentinel);
      },
    });
    expect(() => encodeAgentMarkdownHeadingText(hostile as never)).not.toThrow();
    const result = encodeAgentMarkdownHeadingText(hostile as never);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("requires canonical encoded H1 titles in both bound and unbound parsing", () => {
    const acceptedTitles = [
      "Tail#",
      "<script>alert('x')</script>",
      " line one\r\nline two ",
      `bidi\u202E emoji 🧪`,
      String.raw`literal \u000A`,
    ];
    for (const title of acceptedTitles) {
      const document = reviewDocumentFixture();
      document.document.title = title;
      const bytes = validEncodedAgentBytes(document);
      expect(parseAgentArtifact(bytes).ok, title).toBe(true);
      expect(parseAgentArtifact(bytes, document, GENERATOR_VERSION).ok, title).toBe(true);
    }

    const document = reviewDocumentFixture();
    document.document.title = "Tail# bidi\u202E";
    const canonical = new TextDecoder().decode(validEncodedAgentBytes(document));
    const invalid = [
      canonical.replace(String.raw`Tail\#`, "Tail#"),
      canonical.replace(String.raw`\u202E`, String.raw`\u202e`),
      canonical.replace("Tail", String.raw`\u0054ail`),
      canonical.replace(String.raw`Tail\#`, String.raw`Tail\u0023`),
      canonical.replace(String.raw`\u202E`, String.raw`\u{0202E}`),
    ];
    for (const text of invalid) {
      expect(codes(parseAgentArtifact(encoder.encode(text)))).toContain("ARTIFACT_FORMAT_INVALID");
      expect(codes(parseAgentArtifact(encoder.encode(text), document, GENERATOR_VERSION)))
        .toContain("ARTIFACT_FORMAT_INVALID");
    }
  });
});

describe("frozen Agent Markdown parser", () => {
  it("accepts one exact snapshot and exposes staged/replacement verification", () => {
    const document = reviewDocumentFixture();
    const bytes = validAgentBytes(document);
    const parsed = parseAgentArtifact(bytes, document, GENERATOR_VERSION);
    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({
        generatorVersion: GENERATOR_VERSION,
        deliveryId: document.delivery.id,
        documentId: document.document.id,
        contentVersion: document.document.contentVersion,
        round: document.document.round,
      }),
    });
    expect(parseAgentArtifact(bytes).ok).toBe(true);
    const withNestedHeading = encoder.encode(validAgentText(document)
      .replace("Review every active decision block.", "#### B001 review\n\n[Open block](#b001-review)"));
    expect(parseAgentArtifact(withNestedHeading, document, GENERATOR_VERSION).ok).toBe(true);
    expect(codes(parseAgentArtifact(bytes, undefined, "0.2.1")))
      .toContain("ARTIFACT_IDENTITY_MISMATCH");
    const verify = createAgentArtifactByteVerifier({ document, generatorVersion: GENERATOR_VERSION });
    expect(verify(bytes)).toEqual({ ok: true });
    expect(verify(encoder.encode(validAgentText(document).replace(document.delivery.id, "RDL-AAAAAAAAAAAAAAAAAAAA"))))
      .toEqual({ ok: false });
  });

  it("rejects marker, heading topology, fragment, placeholder, privacy, and UTF-8 failures", () => {
    const document = reviewDocumentFixture();
    const source = validAgentText(document);
    const cases: Array<[string, Uint8Array, string]> = [
      ["duplicate marker", encoder.encode(`${source}<!-- dar-round: 1 -->\n`), "ARTIFACT_FORMAT_INVALID"],
      ["unknown marker", encoder.encode(`${source}<!-- dar-extra1: value -->\n`), "ARTIFACT_FORMAT_INVALID"],
      ["bad marker value", encoder.encode(source.replace("dar-round: 1", "dar-round: 01")), "ARTIFACT_FORMAT_INVALID"],
      ["bad semver", encoder.encode(source.replace("dar-generator-version: 0.2.0", "dar-generator-version: 1.0.0-01")), "ARTIFACT_FORMAT_INVALID"],
      ["wrong heading placement", encoder.encode(source
        .replace("### Objective\n\nContinue from the reviewed objective.\n\n### In scope", "### In scope\n\nContinue from the reviewed objective.\n\n### Objective")), "ARTIFACT_FORMAT_INVALID"],
      ["content before h1", encoder.encode(source.replace(`# ${document.document.title}`, `preamble\n# ${document.document.title}`)), "ARTIFACT_FORMAT_INVALID"],
      ["bad fragment", encoder.encode(source.replace("#objective)", "#missing)")), "INTERNAL_LINK_INVALID"],
      ["bad reference fragment", encoder.encode(source.replace("See the canonical document glossary.", "[bad]: #missing")), "INTERNAL_LINK_INVALID"],
      ["bad HTML fragment", encoder.encode(source.replace("See the canonical document glossary.", '<a href="#missing">bad</a>')), "INTERNAL_LINK_INVALID"],
      ["malformed fragment", encoder.encode(source.replace("#objective)", "#123)")), "INTERNAL_LINK_INVALID"],
      ["placeholder", encoder.encode(source.replace("Review every", "{{UNFILLED}} Review every")), "PLACEHOLDER_REMAINS"],
      ["unfinished marker", encoder.encode(source.replace("Review every", "TBD Review every")), "PLACEHOLDER_REMAINS"],
      ["private token", encoder.encode(source.replace(
        "Review every",
        ["Author", "ization: Bearer abcdefghijk Review every"].join(""),
      )), "PRIVACY_VIOLATION"],
      ["BOM", Uint8Array.from([0xef, 0xbb, 0xbf, ...validAgentBytes(document)]), "INPUT_UTF8_INVALID"],
      ["malformed UTF-8", Uint8Array.from([0xc3, 0x28]), "INPUT_UTF8_INVALID"],
    ];
    for (const [label, bytes, expected] of cases) {
      const result = parseAgentArtifact(bytes, document, GENERATOR_VERSION);
      expect(codes(result), label).toContain(expected);
    }
  });

  it("resolves titled, angle, reference-definition, and raw-HTML fragments outside fences", () => {
    const document = reviewDocumentFixture();
    const source = validAgentText(document);
    const replaceGlossary = (value: string) => encoder.encode(source.replace(
      "See the canonical document glossary.",
      value,
    ));
    const known = [
      '[Objective](#objective "Objective heading")',
      "[Objective](<#objective> 'Objective heading')",
      "[Objective][objective-ref]\n\n[objective-ref]: #objective (Objective heading)",
      '<a class="internal" href="#objective" title="Objective heading">Objective</a>',
    ];
    for (const text of known) {
      expect(parseAgentArtifact(replaceGlossary(text), document, GENERATOR_VERSION).ok, text).toBe(true);
    }

    const invalid = [
      '[Missing](#missing "Missing heading")',
      '[Missing](&#35;missing "Missing heading")',
      '[Missing](\\#missing "Missing heading")',
      "[Missing](<#missing> 'Missing heading')",
      "[Missing][missing-ref]\n\n[missing-ref]: #missing (Missing heading)",
      "[Missing][missing-ref]\n\n[missing-ref]: &#35;missing (Missing heading)",
      '[Malformed](#objective "unterminated)',
      '[Malformed](<#objective "unterminated")',
      '<a href="#missing" title="Missing heading">Missing</a>',
      '<a href="&#35;missing">Missing</a>',
      "<a href='&num;missing'>Missing</a>",
      '<a href="#objective" href="#missing">Ambiguous</a>',
      '<a href href="#objective">Bare duplicate is ambiguous</a>',
    ];
    for (const text of invalid) {
      expect(codes(parseAgentArtifact(replaceGlossary(text), document, GENERATOR_VERSION)), text)
        .toContain("INTERNAL_LINK_INVALID");
    }

    const fenced = replaceGlossary([
      "```markdown",
      '[Missing](#missing "ignored")',
      '[missing-ref]: #missing "ignored"',
      '<a href="#missing">ignored</a>',
      "```",
    ].join("\n"));
    expect(parseAgentArtifact(fenced, document, GENERATOR_VERSION).ok).toBe(true);
  });
});

describe("fixed Approval HTML parser", () => {
  it("accepts only the exact template snapshot and exposes staged/replacement verification", () => {
    const document = reviewDocumentFixture();
    const templateBytes = approvalTemplateBytes();
    const bytes = validApprovalBytes(document);
    const parsed = parseApprovalArtifact({
      bytes,
      templateBytes,
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({ generatorVersion: GENERATOR_VERSION, document }),
    });
    const verify = createApprovalArtifactByteVerifier({
      document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
    });
    expect(verify(bytes)).toEqual({ ok: true });
    expect(verify(encoder.encode(validApprovalText(document).replace("Approval workspace", "Changed workspace"))))
      .toEqual({ ok: false });
  });

  it("keeps the public parser bound to one closed expected-document envelope", () => {
    const document = reviewDocumentFixture();
    const bytes = validApprovalBytes(document);
    const templateBytes = approvalTemplateBytes();
    expect(parseApprovalArtifact({ bytes, templateBytes } as never).ok).toBe(false);
    expect(parseApprovalArtifact({
      bytes,
      templateBytes,
      expectedDocument: undefined,
    } as never).ok).toBe(false);
    expect(parseApprovalArtifact({ expectedDocument: document } as never).ok).toBe(false);
    expect(parseApprovalArtifact({
      bytes,
      templateBytes,
      expectedDocument: document,
      unexpected: true,
    } as never).ok).toBe(false);
    expect(parseApprovalArtifact({ bytes, templateBytes, expectedDocument: document }).ok).toBe(true);
  });

  it("classifies identity, payload, CSP, external-resource, shell-link, drift, and template failures", () => {
    const document = reviewDocumentFixture();
    const template = approvalTemplateText();
    const source = validApprovalText(document);
    const parse = (text: string, templateText = template) => parseApprovalArtifact({
      bytes: encoder.encode(text),
      templateBytes: encoder.encode(templateText),
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    const identity = parse(source.replace(document.document.id, "RD-AAAAAAAAAAAAAAAAAAAA"));
    expect(codes(identity)).toContain("ARTIFACT_IDENTITY_MISMATCH");
    const noncanonicalRound = parse(source.replace('name="dar-round" content="1"', 'name="dar-round" content="01"'));
    expect(codes(noncanonicalRound)).toContain("ARTIFACT_FORMAT_INVALID");
    const duplicateMeta = parse(source.replace(
      '<meta name="dar-round" content="1">',
      '<meta name="dar-round" content="1"><meta name="dar-round" content="1">',
    ));
    expect(codes(duplicateMeta)).toContain("ARTIFACT_FORMAT_INVALID");
    const payload = parse(source.replace(/<template id="review-document-data" data-encoding="base64">[^<]+/u,
      '<template id="review-document-data" data-encoding="base64">!!!!'));
    expect(codes(payload)).toContain("ARTIFACT_FORMAT_INVALID");
    const csp = parse(source.replace("default-src 'none'", "default-src 'self'"));
    expect(codes(csp)).toContain("CSP_INVALID");
    const internallyConsistentTamper = parse(
      source.replace("<script>", "<script>/* tampered */"),
      template.replace("<script>", "<script>/* tampered */"),
    );
    expect(codes(internallyConsistentTamper)).toContain("CSP_INVALID");
    const external = parse(source.replace("<body>", '<body><img src="https://example.invalid/x.png">'));
    expect(codes(external)).toContain("EXTERNAL_RESOURCE_FORBIDDEN");
    const styleExternal = parse(source.replace("</style>", ".x{background:url(https://example.invalid/x)}\n</style>"));
    expect(codes(styleExternal)).toContain("EXTERNAL_RESOURCE_FORBIDDEN");
    const shellLink = parse(source.replace("<body>", '<body><a href="#missing-shell">bad</a>'));
    expect(codes(shellLink)).toContain("INTERNAL_LINK_INVALID");
    const drift = parse(source.replace("Approval workspace", "Approval workbench"));
    expect(codes(drift)).toContain("ARTIFACT_DRIFT");
    const noArtifactTemplate = template.replace('<meta name="dar-artifact" content="review-approval-html/1">\n', "");
    expect(codes(parse(source, noArtifactTemplate))).toContain("ARTIFACT_FORMAT_INVALID");
  });

  it("validates embedded runtime targets without pretending raw HTML contains runtime anchors", () => {
    const document = reviewDocumentFixture();
    const paragraph = document.blocks[0]?.body[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture drift");
    paragraph.content.push({ type: "link", text: "missing", href: "#missing" });
    const result = parseApprovalArtifact({
      bytes: validApprovalBytes(document),
      templateBytes: approvalTemplateBytes(),
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(codes(result)).toContain("INTERNAL_LINK_INVALID");
  });

  it("locks the skip link and main landmark in both actual and template HTML", () => {
    const document = reviewDocumentFixture();
    const template = approvalTemplateText();
    const source = validApprovalText(document);
    const skip = '<a class="skip-link" href="#review-main">Skip to decision blocks</a>';
    const main = '<main id="review-main" tabindex="-1"></main>';
    const parse = (text: string, templateText = template) => parseApprovalArtifact({
      bytes: encoder.encode(text),
      templateBytes: encoder.encode(templateText),
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    const mutations = [
      ["actual skip deleted", source.replace(skip, ""), template],
      ["actual skip duplicated", source.replace(skip, `${skip}${skip}`), template],
      ["actual skip retargeted", source.replace('href="#review-main"', 'href="#missing"'), template],
      ["actual main deleted", source.replace(main, ""), template],
      ["actual main duplicated", source.replace(main, `${main}${main}`), template],
      ["actual main renamed", source.replace('id="review-main"', 'id="missing"'), template],
      ["template skip deleted", source, template.replace(skip, "")],
      ["template skip duplicated", source, template.replace(skip, `${skip}${skip}`)],
      ["template skip retargeted", source, template.replace('href="#review-main"', 'href="#missing"')],
      ["template main deleted", source, template.replace(main, "")],
      ["template main duplicated", source, template.replace(main, `${main}${main}`)],
      ["template main renamed", source, template.replace('id="review-main"', 'id="missing"')],
    ] as const;
    for (const [label, actual, templateText] of mutations) {
      expect(codes(parse(actual, templateText)), label).toContain("INTERNAL_LINK_INVALID");
    }
    for (const id of [
      "review-header",
      "review-main",
      "decision-rail",
      "review-footer",
      "workbench-status",
      "review-document-data",
    ]) {
      const renamed = `missing-${id}`;
      expect(codes(parse(source.replace(`id="${id}"`, `id="${renamed}"`))), `actual ${id}`)
        .toContain("INTERNAL_LINK_INVALID");
      expect(codes(parse(source, template.replace(`id="${id}"`, `id="${renamed}"`))), `template ${id}`)
        .toContain("INTERNAL_LINK_INVALID");
      expect(codes(parse(source.replace(`id="${id}"`, `id="${id}" id="${id}"`))), `duplicate actual ${id}`)
        .toContain("INTERNAL_LINK_INVALID");
    }
  }, APPROVAL_SHELL_LOCK_TEST_TIMEOUT_MS);

  it("keeps document links within runtime content targets and rejects shell or unknown targets", () => {
    const missingDocument = reviewDocumentFixture();
    const missingParagraph = missingDocument.blocks[0]?.body[0];
    if (missingParagraph?.type !== "paragraph") throw new Error("fixture drift");
    for (const href of ["#review-main", "#missing"]) {
      const document = structuredClone(missingDocument);
      const paragraph = document.blocks[0]?.body[0];
      if (paragraph?.type !== "paragraph") throw new Error("fixture drift");
      paragraph.content.push({ type: "link", text: "invalid target", href });
      expect(codes(parseApprovalArtifact({
        bytes: validApprovalBytes(document),
        templateBytes: approvalTemplateBytes(),
        expectedDocument: document,
        expectedGeneratorVersion: GENERATOR_VERSION,
      })), href).toContain("INTERNAL_LINK_INVALID");
    }
  });

  it("rejects unresolved placeholders, private text, and malformed bytes", () => {
    const document = reviewDocumentFixture();
    const source = validApprovalText(document);
    const parse = (bytes: Uint8Array, templateBytes = approvalTemplateBytes()) => parseApprovalArtifact({
      bytes,
      templateBytes,
      expectedDocument: document,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(codes(parse(encoder.encode(source.replace("<body>", "<body>{{UNFILLED}}")))))
      .toContain("PLACEHOLDER_REMAINS");
    expect(codes(parse(encoder.encode(source.replace("<body>", "<body>api_key=abcdefghijk")))))
      .toContain("PRIVACY_VIOLATION");
    expect(codes(parse(Uint8Array.from([0xff])))).toContain("INPUT_UTF8_INVALID");
    expect(codes(parse(validApprovalBytes(document), Uint8Array.from([0xff])))).toContain("INPUT_UTF8_INVALID");

    const privateDocument = reviewDocumentFixture();
    privateDocument.evidence.risks.push(
      ["Author", "ization: Bearer embedded-private-abcdefgh"].join(""),
    );
    const embeddedPrivate = parseApprovalArtifact({
      bytes: validApprovalBytes(privateDocument),
      templateBytes: approvalTemplateBytes(),
      expectedDocument: privateDocument,
      expectedGeneratorVersion: GENERATOR_VERSION,
    });
    expect(codes(embeddedPrivate)).toContain("PRIVACY_VIOLATION");
    expect(codes(parseAgentArtifact(
      validAgentBytes(privateDocument),
      privateDocument,
      GENERATOR_VERSION,
    ))).toContain("PRIVACY_VIOLATION");
  });
});

describe("paired generated-artifact replacement verifier", () => {
  function preflight(input: {
    oldDocument?: ReviewDocumentV1;
    currentDocument?: ReviewDocumentV1;
    generatorVersion?: string;
    agentBytes?: Uint8Array;
    approvalBytes?: Uint8Array;
    templateBytes?: Uint8Array;
  } = {}) {
    const oldDocument = input.oldDocument ?? reviewDocumentFixture();
    const currentDocument = input.currentDocument ?? laterCurrentDocument(oldDocument);
    return createGeneratedReplacementByteVerifiers({
      currentDocument,
      generatorVersion: input.generatorVersion ?? GENERATOR_VERSION,
      templateBytes: input.templateBytes ?? approvalTemplateBytes(),
      existingAgentBytes: input.agentBytes ?? validAgentBytes(oldDocument),
      existingApprovalBytes: input.approvalBytes ?? validApprovalBytes(oldDocument),
    });
  }

  it("accepts one same-identity old round and freezes both exact preflight byte strings", () => {
    const oldDocument = reviewDocumentFixture();
    const currentDocument = laterCurrentDocument(oldDocument);
    expect(validateReviewDocument(oldDocument).ok).toBe(true);
    expect(validateReviewDocument(currentDocument).ok).toBe(true);
    expect(currentDocument.document.contentVersion).not.toBe(oldDocument.document.contentVersion);
    expect(currentDocument.document.round).not.toBe(oldDocument.document.round);
    expect(reviewDigest(currentDocument)).not.toBe(reviewDigest(oldDocument));

    const agentBytes = validAgentBytes(oldDocument);
    const approvalBytes = validApprovalBytes(oldDocument);
    const originalAgent = new Uint8Array(agentBytes);
    const originalApproval = new Uint8Array(approvalBytes);
    const result = preflight({ oldDocument, currentDocument, agentBytes, approvalBytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    agentBytes[0] = (agentBytes[0] ?? 0) ^ 1;
    approvalBytes[0] = (approvalBytes[0] ?? 0) ^ 1;
    expect(result.value.agent(originalAgent)).toEqual({ ok: true });
    expect(result.value.approval(originalApproval)).toEqual({ ok: true });
    expect(result.value.agent(agentBytes)).toEqual({ ok: false });
    expect(result.value.approval(approvalBytes)).toEqual({ ok: false });
    expect(result.value.agent(originalApproval)).toEqual({ ok: false });
    expect(result.value.approval(originalAgent)).toEqual({ ok: false });
    const driftedAgent = new Uint8Array(originalAgent);
    driftedAgent[driftedAgent.length - 1] = (driftedAgent.at(-1) ?? 0) ^ 1;
    expect(result.value.agent(driftedAgent)).toEqual({ ok: false });
  });

  it("validates an old embedded document structurally without reapplying the current delivery business gate", () => {
    const oldDocument = reviewDocumentFixture();
    oldDocument.document.status = "draft";
    const result = preflight({
      oldDocument,
      currentDocument: structuredClone(oldDocument),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects every identity, pair, generator, template, privacy, and marker mismatch", () => {
    const oldDocument = reviewDocumentFixture();
    const currentDocument = laterCurrentDocument(oldDocument);
    const unresolvedInternalLink = structuredClone(oldDocument);
    const firstBodyNode = unresolvedInternalLink.blocks[0]?.body[0];
    if (firstBodyNode?.type !== "paragraph") throw new Error("link test setup failed");
    firstBodyNode.content.push({
      type: "link",
      text: "Missing target",
      href: "#missing-target",
    });
    const unresolvedLinkResult = preflight({
      oldDocument,
      currentDocument,
      approvalBytes: validApprovalBytes(unresolvedInternalLink),
    });
    expect(codes(unresolvedLinkResult)).toContain("INTERNAL_LINK_INVALID");

    const otherDelivery = structuredClone(currentDocument);
    otherDelivery.delivery.id = "RDL-AAAAAAAAAAAAAAAAAAAA";
    const otherDocument = structuredClone(currentDocument);
    otherDocument.document.id = "RD-BBBBBBBBBBBBBBBBBBBB";

    const otherSnapshot = structuredClone(oldDocument);
    otherSnapshot.document.contentVersion = 2;
    otherSnapshot.document.round = 2;
    otherSnapshot.document.title = "Older-but-different paired snapshot";
    otherSnapshot.lineage.previousReviewDigest = reviewDigest(oldDocument);

    const damagedTemplate = encoder.encode(approvalTemplateText().replace(
      "default-src 'none'",
      "default-src 'self'",
    ));
    const privateApproval = encoder.encode(validApprovalText(oldDocument).replace(
      "<body>",
      `<body>${["Author", "ization: Bearer replacement-private-abcdefgh"].join("")}`,
    ));
    const privateCurrent = structuredClone(currentDocument);
    const currentPrivateSentinel = "current-private-abcdefgh";
    privateCurrent.evidence.risks.push(
      ["Author", "ization: Bearer ", currentPrivateSentinel].join(""),
    );
    const privateCurrentResult = preflight({ oldDocument, currentDocument: privateCurrent });
    expect(privateCurrentResult.ok).toBe(false);
    expect(JSON.stringify(privateCurrentResult)).not.toContain(currentPrivateSentinel);
    const cases: Array<[string, ReturnType<typeof preflight>]> = [
      ["current delivery ID", preflight({ oldDocument, currentDocument: otherDelivery })],
      ["current document ID", preflight({ oldDocument, currentDocument: otherDocument })],
      ["supported generator", preflight({ oldDocument, currentDocument, generatorVersion: "0.2.1" })],
      ["self-consistent unsupported generator pair", preflight({
        oldDocument,
        currentDocument,
        generatorVersion: "0.2.1",
        agentBytes: validAgentBytes(oldDocument, "0.2.1"),
        approvalBytes: validApprovalBytes(oldDocument, "0.2.1"),
      })],
      ["invalid generator", preflight({ oldDocument, currentDocument, generatorVersion: "1.0.0-01" })],
      ["old pair snapshot", preflight({
        oldDocument,
        currentDocument,
        agentBytes: validEncodedAgentBytes(otherSnapshot),
      })],
      ["Approval generator", preflight({
        oldDocument,
        currentDocument,
        approvalBytes: validApprovalBytes(oldDocument, "0.2.1"),
      })],
      ["template CSP", preflight({ oldDocument, currentDocument, templateBytes: damagedTemplate })],
      ["Agent delivery ID", preflight({
        oldDocument,
        currentDocument,
        agentBytes: encoder.encode(validAgentText(oldDocument).replace(
          oldDocument.delivery.id,
          "RDL-AAAAAAAAAAAAAAAAAAAA",
        )),
      })],
      ["Agent document ID", preflight({
        oldDocument,
        currentDocument,
        agentBytes: encoder.encode(validAgentText(oldDocument).replace(
          oldDocument.document.id,
          "RD-BBBBBBBBBBBBBBBBBBBB",
        )),
      })],
      ["Approval privacy", preflight({ oldDocument, currentDocument, approvalBytes: privateApproval })],
      ["Agent marker", preflight({
        oldDocument,
        currentDocument,
        agentBytes: encoder.encode(validAgentText(oldDocument).replace(
          "dar-document-id",
          "dar-wrong-id",
        )),
      })],
      ["Approval drift", preflight({
        oldDocument,
        currentDocument,
        approvalBytes: encoder.encode(validApprovalText(oldDocument).replace(
          "Approval workspace",
          "Changed workspace",
        )),
      })],
      ["Approval landmark", preflight({
        oldDocument,
        currentDocument,
        approvalBytes: encoder.encode(validApprovalText(oldDocument).replace(
          '<main id="review-main" tabindex="-1"></main>',
          "",
        )),
      })],
    ];
    for (const [label, result] of cases) {
      expect(result.ok, label).toBe(false);
    }
  });

  it("never throws or leaks hostile preflight or callback values", () => {
    const sentinel = "replacement-hostile-secret-abcdefgh";
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error(sentinel);
      },
    });
    expect(() => createGeneratedReplacementByteVerifiers(hostile as never)).not.toThrow();
    const hostileResult = createGeneratedReplacementByteVerifiers(hostile as never);
    expect(hostileResult.ok).toBe(false);
    expect(JSON.stringify(hostileResult)).not.toContain(sentinel);

    const cycle: Record<string, unknown> = {};
    cycle.currentDocument = cycle;
    expect(() => createGeneratedReplacementByteVerifiers(cycle as never)).not.toThrow();
    expect(createGeneratedReplacementByteVerifiers(cycle as never).ok).toBe(false);

    const result = preflight();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hostileBytes = new Proxy(new Uint8Array(), {
      get() {
        throw new Error(sentinel);
      },
    });
    expect(() => result.value.agent(hostileBytes as never)).not.toThrow();
    expect(result.value.agent(hostileBytes as never)).toEqual({ ok: false });
    expect(() => result.value.approval(hostileBytes as never)).not.toThrow();
    expect(result.value.approval(hostileBytes as never)).toEqual({ ok: false });
  });
});
