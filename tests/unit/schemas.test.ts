import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

type SchemaName = "review-document" | "review-packet" | "review-state";

interface Mutation {
  op: "add" | "copy" | "remove" | "replace";
  path: string;
  from?: string;
  value?: unknown;
}

interface ExpectedError {
  code: string;
  path: string;
}

interface NegativeFixture {
  name: string;
  schema: SchemaName;
  base: string;
  mutations: Mutation[];
  context?: FixtureContext[];
  expected: ExpectedError;
}

interface FixtureContext {
  role: string;
  schema: SchemaName;
  base: string;
  mutations: Mutation[];
}

interface LegacyNormalizationFixture {
  name: string;
  profile: "prototype-v1";
  input: string;
  expected: string;
  preservedPrefixes: Record<"TRIM" | "EXPAND", string>;
}

interface Manifest {
  valid: Array<{ schema: SchemaName; file: string }>;
  schemaNegative: NegativeFixture[];
  protocolNegative: NegativeFixture[];
  legacyNormalization: LegacyNormalizationFixture[];
}

const fixtureRoot = resolve("tests/fixtures/schemas");
const schemaPaths: Record<SchemaName, string> = {
  "review-document": resolve(
    "skills/deliver-dual-audience-report/references/review-document.schema.json",
  ),
  "review-packet": resolve(
    "skills/deliver-dual-audience-report/references/review-packet.schema.json",
  ),
  "review-state": resolve(
    "skills/deliver-dual-audience-report/references/review-state.schema.json",
  ),
};

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").map(decodePointerSegment);
}

function getAtPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== "object") {
      throw new Error(`pointer traverses a scalar: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mutate(document: unknown, mutation: Mutation): void {
  const segments = pointerSegments(mutation.path);
  const finalSegment = segments.pop();
  if (finalSegment === undefined) throw new Error("root mutations are not supported");

  let parent = document;
  for (const segment of segments) {
    if (parent === null || typeof parent !== "object") {
      throw new Error(`pointer traverses a scalar: ${mutation.path}`);
    }
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (parent === null || typeof parent !== "object") {
    throw new Error(`mutation parent is not an object: ${mutation.path}`);
  }

  const value =
    mutation.op === "copy"
      ? structuredClone(getAtPointer(document, mutation.from ?? ""))
      : structuredClone(mutation.value);

  if (Array.isArray(parent)) {
    const index = finalSegment === "-" ? parent.length : Number.parseInt(finalSegment, 10);
    if (!Number.isInteger(index)) throw new Error(`invalid array index: ${mutation.path}`);
    if (mutation.op === "remove") parent.splice(index, 1);
    else if (mutation.op === "add" || mutation.op === "copy") parent.splice(index, 0, value);
    else parent[index] = value;
    return;
  }

  const record = parent as Record<string, unknown>;
  if (mutation.op === "remove") delete record[finalSegment];
  else record[finalSegment] = value;
}

function schemaErrorCode(keyword: string): string {
  const snakeCase = keyword.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `SCHEMA_${snakeCase}`;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function locateError(error: ErrorObject): ExpectedError {
  let path = error.instancePath;
  if (error.keyword === "required") {
    path += `/${escapePointerSegment(String(error.params.missingProperty))}`;
  } else if (error.keyword === "additionalProperties") {
    path += `/${escapePointerSegment(String(error.params.additionalProperty))}`;
  }
  return { code: schemaErrorCode(error.keyword), path };
}

function expectSpecificSchemaError(
  validate: ValidateFunction,
  value: unknown,
  expected: ExpectedError,
): void {
  expect(validate(value)).toBe(false);
  const located = (validate.errors ?? []).map(locateError);
  expect(located).toContainEqual(expected);
}

function assertClosedDefinitions(schema: Record<string, unknown>): void {
  expect(schema.additionalProperties).toBe(false);
  const definitions = schema.$defs as Record<string, Record<string, unknown>>;
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.type === "object") {
      expect(definition.additionalProperties, `${name} must fail closed`).toBe(false);
    }
  }
}

async function loadMutatedFixture(fixture: {
  base: string;
  mutations: Mutation[];
}): Promise<unknown> {
  const value = await loadJson(resolve(fixtureRoot, fixture.base));
  for (const mutation of fixture.mutations) mutate(value, mutation);
  return value;
}

const manifest = await loadJson<Manifest>(resolve(fixtureRoot, "manifest.json"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormatsModule.default(ajv);

const schemas = Object.fromEntries(
  await Promise.all(
    Object.entries(schemaPaths).map(async ([name, path]) => [name, await loadJson(path)]),
  ),
) as Record<SchemaName, Record<string, unknown>>;

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<SchemaName, ValidateFunction>;

describe("public review schemas", () => {
  it("uses the fixed Draft 2020-12 identities and closed object definitions", () => {
    expect(schemas["review-document"].$id).toBe(
      "urn:deliver-dual-audience-report:schema:review-document:1",
    );
    expect(schemas["review-packet"].$id).toBe(
      "urn:deliver-dual-audience-report:schema:review-packet:1",
    );
    expect(schemas["review-state"].$id).toBe(
      "urn:deliver-dual-audience-report:schema:review-state:1",
    );
    for (const schema of Object.values(schemas)) assertClosedDefinitions(schema);
  });

  for (const fixture of manifest.valid) {
    it(`accepts ${fixture.file}`, async () => {
      const value = await loadJson(resolve(fixtureRoot, fixture.file));
      expect(validators[fixture.schema](value), validators[fixture.schema].errors?.toString()).toBe(
        true,
      );
    });
  }

  it("keeps document, packet, and state valid fixtures cross-file coherent", async () => {
    const document = await loadJson<Record<string, unknown>>(
      resolve(fixtureRoot, "valid/review-document.json"),
    );
    const packet = await loadJson<Record<string, unknown>>(
      resolve(fixtureRoot, "valid/review-packet.json"),
    );
    const state = await loadJson<Record<string, unknown>>(
      resolve(fixtureRoot, "valid/review-state.json"),
    );
    const documentIdentity = document.document as Record<string, unknown>;
    const packetIdentity = packet.doc as Record<string, unknown>;
    const stateIdentity = state.doc as Record<string, unknown>;
    for (const key of ["id", "contentVersion", "round"] as const) {
      expect(packetIdentity[key]).toBe(documentIdentity[key]);
      expect(stateIdentity[key]).toBe(documentIdentity[key]);
    }
    expect(stateIdentity.reviewDigest).toBe(packetIdentity.reviewDigest);

    const approvals = document.approvals as Record<string, unknown[]>;
    expect(approvals.history).toEqual([]);
    expect(approvals.currentFrozen).toEqual([]);
    expect(packet.frozenCarried).toEqual([]);
    expect(packet.reopened).toEqual([]);
    expect(state.reopened).toEqual([]);

    const blocks = document.blocks as Array<Record<string, unknown>>;
    const blockIds = new Set(blocks.map((block) => block.id));
    const decisions = packet.decisions as Array<Record<string, unknown>>;
    const stateDecisions = state.decisions as Array<Record<string, unknown>>;
    const progress = packet.progress as Record<string, unknown>;
    expect(decisions.every((decision) => blockIds.has(decision.blockId))).toBe(true);
    expect(
      stateDecisions.every((stateDecision) =>
        decisions.some(
          (packetDecision) => JSON.stringify(packetDecision) === JSON.stringify(stateDecision),
        ),
      ),
    ).toBe(true);
    expect(progress.total).toBe(blocks.length);
    expect(progress.decided).toBe(decisions.length);
    expect(progress.partial).toBe(decisions.length < blocks.length);

    const expectedStats = { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 };
    for (const decision of decisions) {
      expectedStats[decision.action as keyof typeof expectedStats] += 1;
    }
    expect(packet.stats).toEqual(expectedStats);
    expect(packet.packetId).toBe(
      `RP-${String(packet.semanticDigest).slice(7, 27).toUpperCase()}`,
    );

    const documentHighWater = (document.lineage as Record<string, unknown>)
      .idHighWater as Record<string, number>;
    const stateHighWater = state.idHighWater as Record<string, number>;
    const packetHighWater = packet.idHighWater as Record<string, number>;
    for (const key of Object.keys(packetHighWater)) {
      expect(stateHighWater[key]).toBeGreaterThanOrEqual(documentHighWater[key] ?? 0);
      expect(packetHighWater[key]).toBeGreaterThanOrEqual(stateHighWater[key] ?? 0);
    }
  });

  it("preserves a complete quote without a protocol character limit", async () => {
    const packet = await loadJson<Record<string, unknown>>(
      resolve(fixtureRoot, "valid/review-packet.json"),
    );
    mutate(packet, {
      op: "replace",
      path: "/decisions/1/quote",
      value: `start-${"引".repeat(20_000)}-end`,
    });
    expect(validators["review-packet"](packet)).toBe(true);
  });

  for (const fixture of manifest.schemaNegative) {
    it(fixture.name, async () => {
      const value = await loadMutatedFixture(fixture);
      expectSpecificSchemaError(validators[fixture.schema], value, fixture.expected);
    });
  }

  it("reserves structurally valid semantic negatives for CTR-002", async () => {
    for (const fixture of manifest.protocolNegative) {
      const value = await loadMutatedFixture(fixture);
      expect(validators[fixture.schema](value), fixture.name).toBe(true);
      for (const context of fixture.context ?? []) {
        const contextValue = await loadMutatedFixture(context);
        expect(validators[context.schema](contextValue), `${fixture.name}: ${context.role}`).toBe(
          true,
        );
      }
      expect(fixture.expected.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(fixture.expected.path).toMatch(/^\//);
    }
  });

  for (const fixture of manifest.legacyNormalization) {
    it(fixture.name, async () => {
      const input = await loadJson<Record<string, unknown>>(resolve(fixtureRoot, fixture.input));
      const normalized = await loadJson<Record<string, unknown>>(
        resolve(fixtureRoot, fixture.expected),
      );
      expect(validators["review-packet"](input)).toBe(false);
      expect(validators["review-packet"](normalized)).toBe(true);

      const legacyDecisions = input.decisions as Array<Record<string, string>>;
      const normalizedDecisions = normalized.decisions as Array<Record<string, string>>;
      expect(normalizedDecisions).toHaveLength(legacyDecisions.length);
      for (const [index, legacyDecision] of legacyDecisions.entries()) {
        const normalizedDecision = normalizedDecisions[index];
        expect(normalizedDecision).toBeDefined();
        expect(normalizedDecision?.blockId).toBe(legacyDecision.blockId);
        expect(normalizedDecision?.action).toBe("EDIT");
        expect(normalizedDecision?.note).toBe(
          `${fixture.preservedPrefixes[legacyDecision.action as "TRIM" | "EXPAND"]}${legacyDecision.note}`,
        );
        expect(normalizedDecision?.quote).toBe(legacyDecision.quote);
      }

      const semanticDigest = String(normalized.semanticDigest);
      expect(normalized.packetId).toBe(`RP-${semanticDigest.slice(7, 27).toUpperCase()}`);
      expect(normalized.stats).toEqual({ PASS: 0, EDIT: 2, TOPIC: 0, HOLD: 0 });
    });
  }
});
