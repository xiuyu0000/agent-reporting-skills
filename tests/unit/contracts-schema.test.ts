import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { build, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  validateReviewDocument as browserValidateReviewDocument,
  validateReviewPacket as browserValidateReviewPacket,
  validateReviewState as browserValidateReviewState,
} from "../../src/protocol/schema.browser.generated.js";
import {
  validateReviewDocument as defaultValidateReviewDocument,
  validateReviewPacket as defaultValidateReviewPacket,
  validateReviewState as defaultValidateReviewState,
} from "../../src/protocol/schema.generated.js";
import { isAllowedLinkHref } from "../../src/protocol/invariants.js";
import {
  validateReviewDocument,
  validateReviewDocumentSchema,
  validateReviewPacket,
  validateReviewPacketSchema,
  validateReviewState,
  validateReviewStateSchema,
} from "../../src/protocol/index.js";
import type { ProtocolResult } from "../../src/protocol/index.js";

type SchemaName = "review-document" | "review-packet" | "review-state";

interface CorpusMutation {
  op: "add" | "copy" | "remove" | "replace";
  path: string;
  from?: string;
  value?: unknown;
}

interface CorpusFixture {
  schema: SchemaName;
  base: string;
  mutations: CorpusMutation[];
}

interface ValidatorPair {
  defaultValidator: StandaloneValidator;
  browserValidator: StandaloneValidator;
}

interface StandaloneError {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
}

interface StandaloneValidator {
  (value: unknown): boolean;
  errors?: StandaloneError[] | null;
}

interface BrowserSchemaFacade {
  validateReviewDocumentSchema(value: unknown): ProtocolResult<unknown>;
  validateReviewPacketSchema(value: unknown): ProtocolResult<unknown>;
  validateReviewStateSchema(value: unknown): ProtocolResult<unknown>;
}

interface BrowserSchemaBuildModule {
  createBrowserSchemaValidatorPlugin(): Plugin;
}

const validatorPairs: Record<SchemaName, ValidatorPair> = {
  "review-document": {
    defaultValidator: defaultValidateReviewDocument as StandaloneValidator,
    browserValidator: browserValidateReviewDocument as StandaloneValidator,
  },
  "review-packet": {
    defaultValidator: defaultValidateReviewPacket as StandaloneValidator,
    browserValidator: browserValidateReviewPacket as StandaloneValidator,
  },
  "review-state": {
    defaultValidator: defaultValidateReviewState as StandaloneValidator,
    browserValidator: browserValidateReviewState as StandaloneValidator,
  },
};

const { createBrowserSchemaValidatorPlugin } = await import(
  // @ts-expect-error Build-only MJS modules intentionally have no public type declarations.
  "../../tools/build-workbench.mjs"
) as BrowserSchemaBuildModule;
const browserFacadeBuild = await build({
  bundle: true,
  format: "esm",
  metafile: true,
  minify: true,
  platform: "browser",
  plugins: [createBrowserSchemaValidatorPlugin()],
  stdin: {
    contents: [
      "export {",
      "  validateReviewDocumentSchema,",
      "  validateReviewPacketSchema,",
      "  validateReviewStateSchema,",
      '} from "./src/protocol/schema.ts";',
    ].join("\n"),
    loader: "ts",
    resolveDir: process.cwd(),
    sourcefile: "browser-schema-facade-entry.ts",
  },
  target: "es2023",
  treeShaking: true,
  write: false,
});
const browserFacadeSource = browserFacadeBuild.outputFiles[0]?.contents;
if (browserFacadeSource === undefined) throw new Error("browser schema facade was not built");
const browserFacade = await import(
  `data:text/javascript;base64,${Buffer.from(browserFacadeSource).toString("base64")}`
) as BrowserSchemaFacade;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8"));
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerSegments(path: string): string[] {
  return path === "" ? [] : path.slice(1).split("/").map(decodePointerSegment);
}

function valueAt(input: unknown, path: string): unknown {
  let current = input;
  for (const segment of pointerSegments(path)) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function applyCorpusMutation(input: unknown, mutation: CorpusMutation): void {
  const parts = pointerSegments(mutation.path);
  const key = parts.pop();
  if (key === undefined) throw new Error("root corpus mutation is unsupported");
  let parent = input;
  for (const part of parts) parent = (parent as Record<string, unknown>)[part];
  const replacement = mutation.op === "copy"
    ? structuredClone(valueAt(input, mutation.from ?? ""))
    : structuredClone(mutation.value);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (mutation.op === "remove") parent.splice(index, 1);
    else if (mutation.op === "add" || mutation.op === "copy") parent.splice(index, 0, replacement);
    else parent[index] = replacement;
  } else {
    const record = parent as Record<string, unknown>;
    if (mutation.op === "remove") delete record[key];
    else record[key] = replacement;
  }
}

function rawErrors(errors: StandaloneError[] | null | undefined): unknown[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    params: error.params,
  }));
}

function rawSnapshot(validator: StandaloneValidator, value: unknown) {
  const ok = validator(value);
  return { ok, errors: rawErrors(validator.errors) };
}

function expectValidatorParity(schema: SchemaName, value: unknown): void {
  const pair = validatorPairs[schema];
  const defaultSnapshot = rawSnapshot(pair.defaultValidator, structuredClone(value));
  const browserSnapshot = rawSnapshot(pair.browserValidator, structuredClone(value));
  expect(browserSnapshot).toEqual(defaultSnapshot);
  const defaultFacade = {
    "review-document": validateReviewDocumentSchema,
    "review-packet": validateReviewPacketSchema,
    "review-state": validateReviewStateSchema,
  }[schema];
  const companionFacade = {
    "review-document": browserFacade.validateReviewDocumentSchema,
    "review-packet": browserFacade.validateReviewPacketSchema,
    "review-state": browserFacade.validateReviewStateSchema,
  }[schema];
  expect(companionFacade(value)).toEqual(defaultFacade(value));
}

describe("standalone public-schema facade", () => {
  it("accepts all three protocol golden shapes without mutating them", async () => {
    const values = await Promise.all([
      fixture("review-document.json"),
      fixture("review-packet.json"),
      fixture("review-state.json"),
    ]);
    const before = structuredClone(values);
    expect(validateReviewDocumentSchema(values[0]).ok).toBe(true);
    expect(validateReviewPacketSchema(values[1]).ok).toBe(true);
    expect(validateReviewStateSchema(values[2]).ok).toBe(true);
    expect(values).toEqual(before);
  });

  it("A12_protocol_fail_closed locates required and unknown fields", async () => {
    const document = await fixture("review-document.json") as Record<string, unknown>;
    delete (document.document as Record<string, unknown>).title;
    document.unexpected = true;
    const result = validateReviewDocumentSchema(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mutated).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_REQUIRED", path: "/document/title" }),
        expect.objectContaining({ code: "SCHEMA_ADDITIONAL_PROPERTIES", path: "/unexpected" }),
      ]));
    }
  });

  it("allows only strict internal anchors and credential-free absolute HTTP links", async () => {
    const base = await fixture("review-document.json") as Record<string, unknown>;
    const hrefPath = "/continuation/currentState/0/content/0/href";
    const withHref = (href: string) => {
      const value = structuredClone(base);
      (value.continuation as Record<string, unknown>).currentState = [{
        type: "paragraph",
        content: [{ type: "link", text: "reference", href }],
      }];
      return value;
    };
    for (const href of [
      "#Anchor",
      "#a.b:c_d-1",
      "http://example.com",
      "https://example.com/path?q=1#result",
    ]) {
      expect(validateReviewDocument(withHref(href)), href).toEqual(expect.objectContaining({
        ok: true,
      }));
    }
    for (const href of [
      "",
      "#",
      "#1bad",
      "#has space",
      "relative/path",
      "/relative/path",
      "//example.com/path",
      "javascript:alert(1)",
      "data:text/html,unsafe",
      ["file:", "", "", "tmp", "report"].join("/"),
      "blob:https://example.com/id",
      "ftp://example.com/report",
      "https://user@example.com/report",
      "https://user:secret@example.com/report",
      "https://[",
    ]) {
      const result = validateReviewDocument(withHref(href));
      expect(result.ok, href).toBe(false);
      expect(result.ok ? [] : result.errors, href).toContainEqual(expect.objectContaining({
        code: "SCHEMA_FORMAT",
        path: hrefPath,
      }));
    }
  });

  it("uses the same URL-parser normalization boundary as the defensive renderer", () => {
    for (const href of [
      "https:example.com",
      "https:/example.com",
      "http:example.com/path",
    ]) {
      expect(isAllowedLinkHref(href), href).toBe(true);
    }
    for (const href of [
      "relative/path",
      "/relative/path",
      "//example.com/path",
      "https://user@example.com/path",
    ]) {
      expect(isAllowedLinkHref(href), href).toBe(false);
    }
  });

  it("does not change the existing term-reference ProtocolResult location", async () => {
    const value = await fixture("review-document.json") as Record<string, unknown>;
    const block = (value.blocks as Array<Record<string, unknown>>)[0]!;
    block.body = [{
      type: "paragraph",
      content: [{ type: "termRef", glossaryId: "G-001" }],
    }];
    const result = validateReviewDocument(value);
    expect(result.ok ? [] : result.errors).toContainEqual(expect.objectContaining({
      code: "UNKNOWN_REFERENCE",
      path: "/blocks/0/body/0/content/0/glossaryId",
      blockId: null,
    }));
  });

  it("checks link hrefs in every content root and recursive inline location", async () => {
    const base = await fixture("review-document.json") as Record<string, unknown>;
    const link = { type: "link", text: "unsafe", href: "#1bad" };
    const cases: Array<{
      path: string;
      update: (value: Record<string, unknown>) => void;
    }> = [
      {
        path: "/continuation/currentState/0/content/0/href",
        update(value) {
          (value.continuation as Record<string, unknown>).currentState = [{
            type: "paragraph",
            content: [link],
          }];
        },
      },
      {
        path: "/evidence/facts/0/content/0/items/0/0/href",
        update(value) {
          const facts = (value.evidence as Record<string, unknown>).facts as Array<Record<string, unknown>>;
          facts[0]!.content = [{ type: "list", ordered: false, items: [[link]] }];
        },
      },
      {
        path: "/evidence/decisions/0/content/0/headers/0/0/href",
        update(value) {
          const decisions = (value.evidence as Record<string, unknown>).decisions as Array<Record<string, unknown>>;
          decisions.push({
            id: "D-001",
            content: [{
              type: "table",
              headers: [[link]],
              rows: [[[{ type: "text", text: "cell" }]]],
            }],
            confidence: "high",
            sourceRefs: ["SRC-001"],
          });
          const lineage = value.lineage as Record<string, unknown>;
          (lineage.idHighWater as Record<string, unknown>).decision = 1;
        },
      },
      {
        path: "/blocks/0/body/0/rows/0/0/0/href",
        update(value) {
          const blocks = value.blocks as Array<Record<string, unknown>>;
          blocks[0]!.body = [{
            type: "table",
            headers: [[{ type: "text", text: "header" }]],
            rows: [[[link]]],
          }];
        },
      },
      {
        path: "/blocks/0/body/0/content/0/content/0/href",
        update(value) {
          const blocks = value.blocks as Array<Record<string, unknown>>;
          blocks[0]!.body = [{
            type: "callout",
            tone: "info",
            content: [{ type: "paragraph", content: [link] }],
          }];
        },
      },
      {
        path: "/blocks/0/body/0/items/0/content/0/content/0/href",
        update(value) {
          const blocks = value.blocks as Array<Record<string, unknown>>;
          blocks[0]!.body = [{
            type: "steps",
            items: [{ title: "Inspect", content: [{ type: "paragraph", content: [link] }] }],
          }];
        },
      },
    ];
    for (const item of cases) {
      const value = structuredClone(base);
      item.update(value);
      const result = validateReviewDocument(value);
      expect(result.ok, item.path).toBe(false);
      expect(result.ok ? [] : result.errors, item.path).toContainEqual(expect.objectContaining({
        code: "SCHEMA_FORMAT",
        path: item.path,
      }));
    }
  });

  it("returns a canonical copy while preserving narrative block order", async () => {
    const document = await fixture("review-document.json") as Record<string, unknown>;
    const blocks = document.blocks as Array<Record<string, unknown>>;
    blocks[3]!.dependencies = ["B003", "B001"];
    const before = structuredClone(document);
    const result = validateReviewDocument(document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocks.map((block) => block.id)).toEqual(["B001", "B002", "B003", "B004"]);
      expect(result.value.blocks[3]?.dependencies).toEqual(["B001", "B003"]);
    }
    expect(document).toEqual(before);
  });

  it("maps every public-schema failure family to a stable code", async () => {
    const base = await fixture("review-document.json") as Record<string, unknown>;
    const cases: Array<{ value: unknown; expected: string }> = [];
    const changed = (update: (value: Record<string, unknown>) => void) => {
      const value = structuredClone(base);
      update(value);
      return value;
    };
    cases.push(
      { value: changed((value) => { value.format = "review-document/2"; }), expected: "SCHEMA_CONST" },
      { value: changed((value) => { (value.document as Record<string, unknown>).uiLocale = "fr"; }), expected: "SCHEMA_ENUM" },
      { value: changed((value) => { (value.document as Record<string, unknown>).asOf = "2026-08-12"; }), expected: "SCHEMA_FORMAT" },
      { value: changed((value) => { (value.document as Record<string, unknown>).title = ""; }), expected: "SCHEMA_MIN_LENGTH" },
      { value: changed((value) => { (value.blocks as unknown[]).length = 3; }), expected: "SCHEMA_MIN_ITEMS" },
      {
        value: changed((value) => {
          const blocks = value.blocks as unknown[];
          while (blocks.length < 16) blocks.push(structuredClone(blocks[3]));
        }),
        expected: "SCHEMA_MAX_ITEMS",
      },
      {
        value: changed((value) => {
          (value.delivery as Record<string, unknown>).splitGroup = {
            groupId: "RSG-AAAAAAAAAAAAAAAAAAAA",
            part: 0,
            total: 2,
            reason: "split",
          };
        }),
        expected: "SCHEMA_MINIMUM",
      },
      { value: changed((value) => { (value.document as Record<string, unknown>).id = "wrong"; }), expected: "SCHEMA_PATTERN" },
      { value: changed((value) => { value.document = "wrong"; }), expected: "SCHEMA_TYPE" },
      {
        value: changed((value) => {
          const facts = (value.evidence as Record<string, unknown>).facts as Array<Record<string, unknown>>;
          facts[0]!.sourceRefs = ["SRC-001", "SRC-001"];
        }),
        expected: "SCHEMA_UNIQUE_ITEMS",
      },
      {
        value: changed((value) => {
          const blocks = value.blocks as Array<Record<string, unknown>>;
          blocks[0]!.tier = "T3";
        }),
        expected: "SCHEMA_ONE_OF",
      },
      {
        value: changed((value) => {
          const blocks = value.blocks as Array<Record<string, unknown>>;
          const tierTwo = blocks[0];
          if (!tierTwo) throw new Error("Golden fixture must contain a T2 block.");
          while (blocks.length < 12) blocks.push(structuredClone(tierTwo));
        }),
        expected: "SCHEMA_MAX_CONTAINS",
      },
    );
    for (const { value, expected } of cases) {
      const result = validateReviewDocumentSchema(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.code)).toContain(expected);
    }
  });

  it("attaches a block ID to a located block schema error and handles scalar roots", async () => {
    const document = await fixture("review-document.json") as Record<string, unknown>;
    const block = (document.blocks as Array<Record<string, unknown>>)[0]!;
    delete block.ask;
    const result = validateReviewDocumentSchema(document);
    expect(result.ok ? [] : result.errors).toContainEqual(expect.objectContaining({
      code: "SCHEMA_REQUIRED",
      path: "/blocks/0/ask",
      blockId: "B001",
    }));
    expect(validateReviewDocumentSchema(null).ok).toBe(false);
    expect(validateReviewDocumentSchema("document").ok).toBe(false);
  });

  it("rejects unsafe integers across every wire counter family at the original path", async () => {
    const document = await fixture("review-document.json") as Record<string, unknown>;
    const packet = await fixture("review-packet.json") as Record<string, unknown>;
    const state = await fixture("review-state.json") as Record<string, unknown>;
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const cases: Array<{
      value: Record<string, unknown>;
      path: string;
      validate: (value: unknown) => ProtocolResult<unknown>;
      expectedCode: "HIGH_WATER_REGRESSION" | "SCHEMA_TYPE";
    }> = [];
    const documentCase = (path: string, update: (value: Record<string, unknown>) => void): void => {
      const value = structuredClone(document);
      update(value);
      cases.push({ value, path, validate: validateReviewDocument, expectedCode: "SCHEMA_TYPE" });
    };
    documentCase("/document/contentVersion", (value) => {
      (value.document as Record<string, unknown>).contentVersion = unsafe;
    });
    documentCase("/document/round", (value) => {
      (value.document as Record<string, unknown>).round = unsafe;
    });
    documentCase("/delivery/splitGroup/part", (value) => {
      (value.delivery as Record<string, unknown>).splitGroup = {
        groupId: "RSG-AAAAAAAAAAAAAAAAAAAA",
        part: unsafe,
        total: 2,
        reason: "split",
      };
    });
    documentCase("/evidence/sourceHierarchy/0/rank", (value) => {
      (((value.evidence as Record<string, unknown>).sourceHierarchy as Array<Record<string, unknown>>)[0]!).rank = unsafe;
    });
    documentCase("/blocks/0/changed/round", (value) => {
      ((value.blocks as Array<Record<string, unknown>>)[0]!).changed = { round: unsafe, summary: "Changed." };
    });
    documentCase("/approvals/history/0/approvedRound", (value) => {
      ((value.approvals as Record<string, unknown>).history as unknown[]).push({
        blockId: "B001",
        approvedRound: unsafe,
        approvedContentDigest: `sha256:${"a".repeat(64)}`,
      });
    });
    documentCase("/lineage/impactAssessments/0/changedAtRound", (value) => {
      ((value.lineage as Record<string, unknown>).impactAssessments as unknown[]).push({
        upstreamBlockId: "B001",
        changedAtRound: unsafe,
        affectedDownstreamIds: [],
        reason: "Checked.",
        usedConservativeClosure: false,
      });
    });

    const packetPaths: Array<[
      string,
      (value: Record<string, unknown>) => void,
      "HIGH_WATER_REGRESSION" | "SCHEMA_TYPE",
    ]> = [
      [
        "/doc/contentVersion",
        (value) => { (value.doc as Record<string, unknown>).contentVersion = unsafe; },
        "SCHEMA_TYPE",
      ],
      ["/doc/round", (value) => { (value.doc as Record<string, unknown>).round = unsafe; }, "SCHEMA_TYPE"],
      [
        "/idHighWater/note",
        (value) => { (value.idHighWater as Record<string, unknown>).note = unsafe; },
        "HIGH_WATER_REGRESSION",
      ],
      [
        "/progress/total",
        (value) => { (value.progress as Record<string, unknown>).total = unsafe; },
        "SCHEMA_TYPE",
      ],
      ["/stats/PASS", (value) => { (value.stats as Record<string, unknown>).PASS = unsafe; }, "SCHEMA_TYPE"],
    ];
    for (const [path, update, expectedCode] of packetPaths) {
      const value = structuredClone(packet);
      update(value);
      cases.push({ value, path, validate: validateReviewPacket, expectedCode });
    }
    for (const path of ["/doc/contentVersion", "/doc/round", "/idHighWater/topic"] as const) {
      const value = structuredClone(state);
      const [group, field] = path.slice(1).split("/") as ["doc" | "idHighWater", string];
      (value[group] as Record<string, unknown>)[field] = unsafe;
      cases.push({
        value,
        path,
        validate: validateReviewState,
        expectedCode: path.startsWith("/idHighWater/") ? "HIGH_WATER_REGRESSION" : "SCHEMA_TYPE",
      });
    }

    for (const item of cases) {
      const result = item.validate(item.value);
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: item.expectedCode, path: item.path }),
      );
    }
  });

  it("rejects an impossible split part while accepting a bounded part", async () => {
    const document = await fixture("review-document.json") as Record<string, unknown>;
    (document.delivery as Record<string, unknown>).splitGroup = {
      groupId: "RSG-AAAAAAAAAAAAAAAAAAAA",
      part: 3,
      total: 2,
      reason: "split",
    };
    const invalid = validateReviewDocument(document);
    expect(invalid.ok ? [] : invalid.errors).toContainEqual(
      expect.objectContaining({
        code: "DERIVED_VALUE_MISMATCH",
        path: "/delivery/splitGroup/part",
      }),
    );
    ((document.delivery as Record<string, unknown>).splitGroup as Record<string, unknown>).part = 2;
    expect(validateReviewDocument(document).ok).toBe(true);
  });

  it("keeps build-time Ajv and standalone format decisions in parity", async () => {
    const schemas = await Promise.all([
      "review-document.schema.json",
      "review-packet.schema.json",
      "review-state.schema.json",
    ].map(async (name) => JSON.parse(await readFile(resolve(
      "skills/deliver-dual-audience-report/references",
      name,
    ), "utf8")) as { $id: string }));
    const ajv = new Ajv2020({
      allErrors: true,
      inlineRefs: 1,
      messages: false,
      strict: true,
    });
    const addFormats = formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020;
    addFormats(ajv);
    for (const schema of schemas) ajv.addSchema(schema);

    const document = await fixture("review-document.json") as Record<string, unknown>;
    const packet = await fixture("review-packet.json") as Record<string, unknown>;
    const state = await fixture("review-state.json") as Record<string, unknown>;
    const invalidDocumentTime = structuredClone(document);
    (invalidDocumentTime.document as Record<string, unknown>).asOf = "2026-02-30T09:00:00Z";
    const invalidLink = structuredClone(document);
    const firstBody = ((invalidLink.blocks as Array<Record<string, unknown>>)[0]!.body as Array<Record<string, unknown>>)[0]!;
    firstBody.content = [{ type: "link", text: "unsafe", href: "not a uri" }];
    const invalidPacketTime = structuredClone(packet);
    invalidPacketTime.reviewedAt = "2026-08-12T09:30:00";
    const invalidStateTime = structuredClone(state);
    invalidStateTime.savedAt = "not-a-time";

    const cases = [
      { schema: schemas[0]!.$id, value: document, standalone: validateReviewDocumentSchema },
      { schema: schemas[0]!.$id, value: invalidDocumentTime, standalone: validateReviewDocumentSchema },
      { schema: schemas[0]!.$id, value: invalidLink, standalone: validateReviewDocumentSchema },
      { schema: schemas[1]!.$id, value: packet, standalone: validateReviewPacketSchema },
      { schema: schemas[1]!.$id, value: invalidPacketTime, standalone: validateReviewPacketSchema },
      { schema: schemas[2]!.$id, value: state, standalone: validateReviewStateSchema },
      { schema: schemas[2]!.$id, value: invalidStateTime, standalone: validateReviewStateSchema },
    ];
    for (const item of cases) {
      const buildTimeValidator = ajv.getSchema(item.schema);
      expect(buildTimeValidator, item.schema).toBeDefined();
      expect(item.standalone(item.value).ok).toBe(buildTimeValidator?.(item.value));
    }
  });

  it("keeps default and browser validators in exact raw-error and facade parity", async () => {
    const schemaRoot = resolve("tests/fixtures/schemas");
    const manifest = JSON.parse(await readFile(resolve(schemaRoot, "manifest.json"), "utf8")) as {
      valid: Array<{ schema: SchemaName; file: string }>;
      schemaNegative: CorpusFixture[];
      protocolNegative: CorpusFixture[];
    };
    for (const item of manifest.valid) {
      const value = JSON.parse(await readFile(resolve(schemaRoot, item.file), "utf8"));
      expectValidatorParity(item.schema, value);
    }
    for (const item of [...manifest.schemaNegative, ...manifest.protocolNegative]) {
      const value = JSON.parse(await readFile(resolve(schemaRoot, item.base), "utf8"));
      for (const mutation of item.mutations) applyCorpusMutation(value, mutation);
      expectValidatorParity(item.schema, value);
    }

    const additionalCases: Array<[SchemaName, unknown]> = [];
    for (const [schema, name] of [
      ["review-document", "review-document.json"],
      ["review-packet", "review-packet.json"],
      ["review-state", "review-state.json"],
    ] as const) {
      const value = await fixture(name) as Record<string, unknown>;
      value.unexpected = { nested: true };
      additionalCases.push([schema, value]);
    }
    const invalidFormat = await fixture("review-packet.json") as Record<string, unknown>;
    invalidFormat.reviewedAt = "2026-02-30T25:61:00Z";
    additionalCases.push(["review-packet", invalidFormat]);
    for (const [schema, value] of additionalCases) expectValidatorParity(schema, value);
  });

  it("keeps browser validator parity across deterministic structural disturbances", async () => {
    let randomState = 0x36c0ffee;
    const random = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState >>> 0;
    };
    interface MutableLocation {
      parent: Record<string, unknown> | unknown[];
      key: string | number;
      value: unknown;
    }
    const locations = (root: unknown): MutableLocation[] => {
      const output: MutableLocation[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const [index, child] of value.entries()) {
            output.push({ parent: value, key: index, value: child });
            visit(child);
          }
        } else if (value !== null && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) {
            output.push({ parent: value as Record<string, unknown>, key, value: child });
            visit(child);
          }
        }
      };
      visit(root);
      return output;
    };
    const wrongValue = (value: unknown, iteration: number): unknown => {
      if (typeof value === "string") return iteration % 2 === 0 ? "" : iteration;
      if (typeof value === "number") return `number-${iteration}`;
      if (typeof value === "boolean") return null;
      if (Array.isArray(value)) return { not: "array" };
      if (value !== null && typeof value === "object") return ["not-object"];
      return true;
    };

    for (const [schema, name] of [
      ["review-document", "review-document.json"],
      ["review-packet", "review-packet.json"],
      ["review-state", "review-state.json"],
    ] as const) {
      const golden = await fixture(name);
      for (let iteration = 0; iteration < 96; iteration += 1) {
        const value = structuredClone(golden);
        const candidates = locations(value);
        const selected = candidates[random() % candidates.length]!;
        const operation = random() % 3;
        if (operation === 0 && !Array.isArray(selected.parent)) {
          delete selected.parent[String(selected.key)];
        } else if (operation === 1
          && selected.value !== null
          && typeof selected.value === "object"
          && !Array.isArray(selected.value)) {
          (selected.value as Record<string, unknown>)[`unexpected_${iteration}`] = true;
        } else {
          selected.parent[selected.key as never] = wrongValue(selected.value, iteration) as never;
        }
        expectValidatorParity(schema, value);
      }
    }
  });

  it("blocks annotation pruning when Ajv emits an unknown runtime reference shape", async () => {
    const { pruneStandaloneAnnotations, rewriteSharedReferences } = await import(
      // @ts-expect-error Build-only MJS modules intentionally have no public type declarations.
      "../../tools/generate-schema-validators.mjs"
    );
    expect(() => pruneStandaloneAnnotations([
      'const schema1 = {"title":"annotation"};',
      "globalThis.value = schema1.title;",
    ].join("\n"))).toThrow(/unknown standalone annotation reference/u);
    expect(() => pruneStandaloneAnnotations([
      'const schema1 = {"enum":["A"]};',
      'globalThis.value = schema1["enum"];',
    ].join("\n"))).toThrow(/unknown direct standalone annotation reference/u);
    expect(() => pruneStandaloneAnnotations([
      'const schema1 = {"properties":{"known":{}}};',
      "globalThis.value = schema1.properties;",
    ].join("\n"))).toThrow(/unknown standalone annotation reference/u);
    expect(rewriteSharedReferences({
      const: "#/$defs/NonEmptyString",
      enum: ["#/$defs/NonEmptyString"],
      description: "#/$defs/NonEmptyString",
      exact: { $ref: "#/$defs/NonEmptyString" },
      suffix: { $ref: "#/$defs/NonEmptyString/nested" },
    }, { NonEmptyString: "NonEmptyString" })).toEqual({
      const: "#/$defs/NonEmptyString",
      enum: ["#/$defs/NonEmptyString"],
      description: "#/$defs/NonEmptyString",
      exact: {
        $ref: "urn:deliver-dual-audience-report:schema:browser-shared:1#/$defs/NonEmptyString",
      },
      suffix: { $ref: "#/$defs/NonEmptyString/nested" },
    });
  });

  it("keeps the browser facade fail-closed result identical for hostile values", async () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile proxy");
      },
    });
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "format", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const document = await fixture("review-document.json") as object;
    const inherited = Object.create(document) as unknown;
    const invalidSurrogate = await fixture("review-document.json") as Record<string, unknown>;
    (invalidSurrogate.document as Record<string, unknown>).title = "bad\ud800title";
    for (const value of [
      hostile,
      accessor,
      cyclic,
      inherited,
      { value: 1n },
      { value: Symbol("x") },
      { "bad\udc00key": "value" },
      invalidSurrogate,
    ]) {
      expect(browserFacade.validateReviewDocumentSchema(value)).toEqual(
        validateReviewDocumentSchema(value),
      );
      expect(browserFacade.validateReviewPacketSchema(value)).toEqual(
        validateReviewPacketSchema(value),
      );
      expect(browserFacade.validateReviewStateSchema(value)).toEqual(
        validateReviewStateSchema(value),
      );
    }
    expect(getterCalls).toBe(0);
  });
});
