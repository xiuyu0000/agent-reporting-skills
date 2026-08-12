import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  validateReviewDocument,
  validateReviewDocumentSchema,
  validateReviewPacket,
  validateReviewPacketSchema,
  validateReviewState,
  validateReviewStateSchema,
} from "../../src/protocol/index.js";
import type { ProtocolResult } from "../../src/protocol/index.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8"));
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
});
