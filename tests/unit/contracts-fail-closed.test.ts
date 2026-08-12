import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeReviewDigest,
  confirmLegacyIdentity,
  canonicalJson,
  validateReviewDocument,
  canonicalReviewDocument,
  portablePathKey,
  validateDocumentHighWater,
  validateDocumentContext,
  validateOverlayHighWater,
  validatePacketIdentity,
  validateReviewPacket,
  validateReviewPacketSchema,
  validateReviewState,
  validateReviewDocumentSchema,
  validateReviewStateSchema,
  validateStateIdentity,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";

type SchemaName = "review-document" | "review-packet" | "review-state";

interface Mutation {
  op: "add" | "copy" | "remove" | "replace";
  path: string;
  from?: string;
  value?: unknown;
}

interface FixtureContext {
  role: string;
  schema: SchemaName;
  base: string;
  mutations: Mutation[];
}

interface ProtocolNegativeFixture {
  name: string;
  schema: SchemaName;
  base: string;
  mutations: Mutation[];
  context?: FixtureContext[];
  expected: { code: string; path: string };
}

interface Manifest {
  protocolNegative: ProtocolNegativeFixture[];
}

const root = resolve("tests/fixtures/schemas");

async function load(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function decodePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function segments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map(decodePointer);
}

function at(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of segments(pointer)) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mutate(document: unknown, mutation: Mutation): void {
  const parts = segments(mutation.path);
  const key = parts.pop();
  if (key === undefined) throw new Error("root mutation is unsupported");
  let parent = document;
  for (const part of parts) parent = (parent as Record<string, unknown>)[part];
  const value = mutation.op === "copy"
    ? structuredClone(at(document, mutation.from ?? ""))
    : structuredClone(mutation.value);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (mutation.op === "remove") parent.splice(index, 1);
    else if (mutation.op === "add" || mutation.op === "copy") parent.splice(index, 0, value);
    else parent[index] = value;
  } else {
    const record = parent as Record<string, unknown>;
    if (mutation.op === "remove") delete record[key];
    else record[key] = value;
  }
}

async function mutated(fixture: { base: string; mutations: Mutation[] }): Promise<unknown> {
  const value = await load(fixture.base);
  for (const mutation of fixture.mutations) mutate(value, mutation);
  return value;
}

const manifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
) as Manifest;
const defaultDocument = await load("valid/review-document.json") as ReviewDocumentV1;

describe("frozen protocol-negative corpus", () => {
  for (const fixture of manifest.protocolNegative) {
    it(`A12_protocol_negative: ${fixture.name}`, async () => {
      const input = await mutated(fixture);
      const before = structuredClone(input);
      let result;
      if (fixture.schema === "review-document") {
        const currentFixture = fixture.context?.find((item) => item.role === "current");
        if (currentFixture) {
          const currentSchema = validateReviewDocumentSchema(await mutated(currentFixture));
          const candidateSchema = validateReviewDocumentSchema(input);
          result = currentSchema.ok && candidateSchema.ok
            ? validateDocumentContext(
                canonicalReviewDocument(currentSchema.value),
                canonicalReviewDocument(candidateSchema.value),
              )
            : currentSchema.ok ? candidateSchema : currentSchema;
        } else {
          result = validateReviewDocument(input);
        }
      } else {
        const contextFixture = fixture.context?.find((item) => item.role === "document");
        const document = contextFixture
          ? await mutated(contextFixture) as ReviewDocumentV1
          : defaultDocument;
        result = fixture.schema === "review-packet"
          ? validateReviewPacket(input, document)
          : validateReviewState(input, document);
      }
      expect(input).toEqual(before);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.mutated).toBe(false);
        expect(result.errors).toContainEqual(expect.objectContaining(fixture.expected));
      }
    });
  }

  it("rejects the old static report contract without guessing a migration", () => {
    const result = validateReviewDocument({
      format: "dual-audience-report-contract-v1",
      facts: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mutated).toBe(false);
      expect(result.errors.some((error) => error.path === "/format")).toBe(true);
    }
  });

  it("fails closed at public ProtocolResult boundaries for hostile JavaScript values", () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile proxy");
      },
    });
    const inherited = Object.create(defaultDocument) as unknown;
    const calls: Array<() => { ok: boolean; mutated?: boolean }> = [
      () => validateReviewDocumentSchema(hostile),
      () => validateReviewPacketSchema(hostile),
      () => validateReviewStateSchema(hostile),
      () => validateReviewDocument(hostile),
      () => validateReviewPacket(hostile),
      () => validateReviewState(hostile),
      () => validateReviewDocument(inherited),
      () => computeReviewDigest(hostile as never),
      () => validateDocumentHighWater(null as never),
      () => validateOverlayHighWater(null as never),
      () => validatePacketIdentity(null as never, null as never),
      () => validateStateIdentity(null as never, null as never),
      () => validateDocumentContext(null as never, null as never),
      () => confirmLegacyIdentity(null as never, undefined, null as never),
      () => portablePathKey(null as never),
    ];
    for (const call of calls) {
      expect(call).not.toThrow();
      expect(call()).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }
  });

  it("rejects accessors, cycles, non-JSON values, and inherited protocol data", () => {
    const accessor = Object.defineProperty({}, "format", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [accessor, cyclic, { value: Symbol("x") }, { value: 1n }]) {
      const result = validateReviewDocumentSchema(input);
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }
    const invalidUnicode = structuredClone(defaultDocument);
    invalidUnicode.document.title = "bad\ud800title";
    const invalidTitle = validateReviewDocument(invalidUnicode);
    expect(invalidTitle.ok ? [] : invalidTitle.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/document/title" }),
    );
    const invalidKey = { "bad\udc00key": "value" };
    const invalidKeyResult = validateReviewDocumentSchema(invalidKey);
    expect(invalidKeyResult).toEqual(expect.objectContaining({ ok: false, mutated: false }));
  });

  it("does not let Object prototype pollution satisfy missing wire fields", async () => {
    const packet = await load("valid/review-packet.json") as Record<string, unknown>;
    delete packet.format;
    const prototype = Object.prototype as Record<string, unknown>;
    const previous = Object.getOwnPropertyDescriptor(prototype, "format");
    try {
      Object.defineProperty(prototype, "format", {
        value: "review-packet/1",
        configurable: true,
      });
      const result = validateReviewPacketSchema(packet);
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_REQUIRED", path: "/format" }),
      );
    } finally {
      if (previous) Object.defineProperty(prototype, "format", previous);
      else delete prototype.format;
    }
  });

  it("keeps runtime error paths valid JSON and avoids duplicate prefixes", () => {
    const overlay = validateOverlayHighWater({ format: "future" } as never);
    expect(overlay.ok ? [] : overlay.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/input/format" }),
    );
    const invalidKey = validateReviewDocumentSchema({ "bad\ud800key": "x" });
    expect(invalidKey.ok).toBe(false);
    expect(() => canonicalJson(invalidKey)).not.toThrow();
  });
});
