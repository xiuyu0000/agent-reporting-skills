import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migratePrototypePacket,
  migratePrototypeState,
  validateReviewDocument,
  type PrototypeMigrationOptions,
  type ReviewDocumentV1,
  type ReviewStateV1,
} from "../../src/protocol/index.js";

async function load<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

describe("prototype-v1 atomic migration", () => {
  it("A09_trim_expand_migration maps both legacy actions to visible EDIT semantics", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/schemas/valid/review-document.json",
    );
    const input = await load<unknown>(
      "tests/fixtures/schemas/legacy/review-packet-trim-expand.json",
    );
    const before = structuredClone(input);
    const result = migratePrototypePacket(input, { profile: "prototype-v1", document });
    expect(input).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toEqual([
      {
        blockId: "B001",
        action: "EDIT",
        note: "【精简】Remove the redundant implementation detail.",
        quote: "The redundant implementation detail",
      },
      {
        blockId: "B002",
        action: "EDIT",
        note: "【扩展】Add one concrete dependency example.",
      },
    ]);
    expect(result.value.stats).toEqual({ PASS: 0, EDIT: 2, TOPIC: 0, HOLD: 0 });
    expect(JSON.stringify(result.value)).not.toMatch(/TRIM|EXPAND/);
  });

  it("A18_legacy_identity_confirmation refuses missing identity until all three values are explicit", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const input = await load<ReviewStateV1>("tests/fixtures/protocol/review-state.json") as unknown as Record<string, unknown>;
    const doc = input.doc as Record<string, unknown>;
    delete doc.contentVersion;
    const decisions = input.decisions as Array<Record<string, unknown>>;
    decisions[1]!.action = "TRIM";
    const before = structuredClone(input);

    const refused = migratePrototypeState(input, { profile: "prototype-v1", document });
    expect(refused.ok ? [] : refused.errors).toContainEqual(
      expect.objectContaining({ code: "IDENTITY_CONFIRMATION_REQUIRED", path: "/doc" }),
    );
    expect(input).toEqual(before);

    const accepted = migratePrototypeState(input, {
      profile: "prototype-v1",
      document,
      confirmation: {
        documentId: document.document.id,
        contentVersion: document.document.contentVersion,
        round: document.document.round,
      },
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.decisions[1]).toEqual(expect.objectContaining({
        action: "EDIT",
        note: expect.stringMatching(/^【精简】/),
      }));
    }
  });

  it("rejects an explicitly mismatched version and any unknown historical action", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    expect(validateReviewDocument(document).ok).toBe(true);
    const state = await load<ReviewStateV1>("tests/fixtures/protocol/review-state.json") as unknown as Record<string, unknown>;
    (state.doc as Record<string, unknown>).contentVersion = 2;
    const mismatch = migratePrototypeState(state, {
      profile: "prototype-v1",
      document,
      confirmation: {
        documentId: document.document.id,
        contentVersion: document.document.contentVersion,
        round: document.document.round,
      },
    });
    expect(mismatch.ok ? [] : mismatch.errors).toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH", path: "/doc/contentVersion" }),
    );

    (state.doc as Record<string, unknown>).contentVersion = 1;
    (state.decisions as Array<Record<string, unknown>>)[0]!.action = "SPLIT";
    const unknown = migratePrototypeState(state, { profile: "prototype-v1", document });
    expect(unknown.ok ? [] : unknown.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_LEGACY_ACTION", path: "/decisions/0/action" }),
    );
  });

  it("fails closed instead of discarding a malformed legacy edit note", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const state = await load<Record<string, unknown>>("tests/fixtures/protocol/review-state.json");
    const decisions = state.decisions as Array<Record<string, unknown>>;
    decisions[0]!.action = "TRIM";
    decisions[0]!.note = { unsafe: "not text" };
    const before = structuredClone(state);
    const result = migratePrototypeState(state, { profile: "prototype-v1", document });
    expect(state).toEqual(before);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/decisions/0/note" }),
    );
  });

  it("rejects explicitly malformed packet and state identity containers", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const confirmation = {
      documentId: document.document.id,
      contentVersion: document.document.contentVersion,
      round: document.document.round,
    };
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    const state = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-state.json",
    );
    packet.doc = "corrupt";
    state.doc = [];

    const packetResult = migratePrototypePacket(packet, {
      profile: "prototype-v1",
      document,
      confirmation,
    });
    const stateResult = migratePrototypeState(state, {
      profile: "prototype-v1",
      document,
      confirmation,
    });
    expect(packetResult.ok ? [] : packetResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc" }),
    );
    expect(stateResult.ok ? [] : stateResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc" }),
    );
  });

  it("rejects present legacy identity fields with the wrong type instead of confirming over them", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const confirmation = {
      documentId: document.document.id,
      contentVersion: document.document.contentVersion,
      round: document.document.round,
    };
    const cases: Array<{ field: "id" | "contentVersion" | "round"; value: unknown }> = [
      { field: "id", value: 42 },
      { field: "contentVersion", value: "1" },
      { field: "round", value: "1" },
    ];
    for (const item of cases) {
      const packet = await load<Record<string, unknown>>(
        "tests/fixtures/protocol/review-packet.json",
      );
      const state = await load<Record<string, unknown>>(
        "tests/fixtures/protocol/review-state.json",
      );
      (packet.doc as Record<string, unknown>)[item.field] = item.value;
      (state.doc as Record<string, unknown>)[item.field] = item.value;

      for (const result of [
        migratePrototypePacket(packet, { profile: "prototype-v1", document, confirmation }),
        migratePrototypeState(state, { profile: "prototype-v1", document, confirmation }),
      ]) {
        expect(result.ok ? [] : result.errors).toContainEqual(
          expect.objectContaining({ code: "SCHEMA_TYPE", path: `/doc/${item.field}` }),
        );
      }
    }
  });

  it("only fills a missing packet title and rejects an explicit wrong title", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    (packet.doc as Record<string, unknown>).title = "Wrong title";
    const mismatch = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(mismatch.ok ? [] : mismatch.errors).toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH", path: "/doc/title" }),
    );
    (packet.doc as Record<string, unknown>).title = 42;
    const wrongType = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(wrongType.ok ? [] : wrongType.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc/title" }),
    );
    delete (packet.doc as Record<string, unknown>).title;
    const filled = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(filled.ok && filled.value.doc.title).toBe(document.document.title);
  });

  it("rejects unknown or missing migration profiles at both public entry points", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    const state = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-state.json",
    );
    for (const profile of ["future-v2", "", null, undefined]) {
      for (const result of [
        migratePrototypePacket(packet, {
          profile: profile as "prototype-v1",
          document,
        }),
        migratePrototypeState(state, {
          profile: profile as "prototype-v1",
          document,
        }),
      ]) {
        expect(result.ok ? [] : result.errors).toContainEqual(
          expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/profile" }),
        );
      }
    }
    for (const result of [
      migratePrototypePacket(packet, undefined as unknown as PrototypeMigrationOptions),
      migratePrototypeState(state, undefined as unknown as PrototypeMigrationOptions),
    ]) {
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/profile" }),
      );
    }
  });

  it("rejects unknown migration option and derived-summary fields before recomputing", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    const unknownOption = migratePrototypePacket(packet, {
      profile: "prototype-v1",
      document,
      future: true,
    } as never);
    expect(unknownOption.ok ? [] : unknownOption.errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_ADDITIONAL_PROPERTIES",
        path: "/options/future",
      }),
    );

    for (const [field, key] of [["progress", "evil"], ["stats", "SPLIT"]] as const) {
      const malformed = structuredClone(packet);
      (malformed[field] as Record<string, unknown>)[key] = 1;
      const result = migratePrototypePacket(malformed, { profile: "prototype-v1", document });
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({
          code: "SCHEMA_ADDITIONAL_PROPERTIES",
          path: `/${field}/${key}`,
        }),
      );
    }
  });

  it("fails closed for hostile runtime inputs and malformed option containers", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const validOptions = { profile: "prototype-v1" as const, document };
    const throwingProxy = new Proxy({}, {
      ownKeys() {
        throw new Error("proxy failure");
      },
    });
    const nestedFunction = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    (nestedFunction.decisions as Array<Record<string, unknown>>)[0]!.extra = () => undefined;
    for (const input of [() => undefined, Symbol("x"), throwingProxy, nestedFunction]) {
      for (const migrate of [migratePrototypePacket, migratePrototypeState]) {
        expect(() => migrate(input, validOptions)).not.toThrow();
        expect(migrate(input, validOptions)).toEqual(
          expect.objectContaining({ ok: false, mutated: false }),
        );
      }
    }

    const arrayOptions = Object.assign([], validOptions);
    const getterOptions = Object.defineProperty({}, "profile", {
      enumerable: true,
      get() {
        throw new Error("getter failure");
      },
    });
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    for (const options of [null, arrayOptions, getterOptions]) {
      for (const migrate of [migratePrototypePacket, migratePrototypeState]) {
        const result = migrate(packet, options as never);
        expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
      }
    }
  });

  it("rejects malformed confirmations and present undefined identity fields", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    (packet.doc as Record<string, unknown>).id = undefined;
    for (const migrate of [migratePrototypePacket, migratePrototypeState]) {
      const undefinedIdentity = migrate(packet, {
        profile: "prototype-v1",
        document,
        confirmation: {
          documentId: document.document.id,
          contentVersion: document.document.contentVersion,
          round: document.document.round,
        },
      });
      expect(undefinedIdentity.ok ? [] : undefinedIdentity.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc/id" }),
      );
    }

    const state = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-state.json",
    );
    const badConfirmation = Object.assign([], {
      documentId: document.document.id,
      contentVersion: document.document.contentVersion,
      round: document.document.round,
    });
    for (const migrate of [migratePrototypePacket, migratePrototypeState]) {
      const result = migrate(state, {
        profile: "prototype-v1",
        document,
        confirmation: badConfirmation as never,
      });
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_TYPE", path: "/confirmation" }),
      );
    }
  });

  it("rejects present malformed reopened and preserves raw legacy error indexes", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    for (const reopened of [null, "B001", { blockId: "B001" }]) {
      const packet = await load<Record<string, unknown>>(
        "tests/fixtures/protocol/review-packet.json",
      );
      packet.reopened = reopened;
      const result = migratePrototypePacket(packet, { profile: "prototype-v1", document });
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_TYPE", path: "/reopened" }),
      );
    }
    for (const frozenCarried of [null, "B001", { blockId: "B001" }]) {
      const packet = await load<Record<string, unknown>>(
        "tests/fixtures/protocol/review-packet.json",
      );
      packet.frozenCarried = frozenCarried;
      const malformed = migratePrototypePacket(packet, { profile: "prototype-v1", document });
      expect(malformed.ok ? [] : malformed.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_TYPE", path: "/frozenCarried" }),
      );
    }

    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    packet.sideNotes = [
      { id: "NOTE-002", blockId: "B003", note: "Valid later note." },
      { id: "NOTE-0001", blockId: "B003", note: "Invalid numeric alias." },
    ];
    (packet.idHighWater as Record<string, unknown>).note = 2;
    const result = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ code: "HIGH_WATER_REGRESSION", path: "/sideNotes/1/id" }),
    );
  });

  it("normalizes already-current actions and reconstructs omitted derived packet fields", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    delete packet.format;
    delete packet.progress;
    delete packet.stats;
    delete packet.frozenCarried;
    const decisions = packet.decisions as Array<Record<string, unknown>>;
    decisions.push({ blockId: "B003", action: "TOPIC", topicId: "TOP-001" });
    decisions.push({ blockId: "B004", action: "HOLD", note: "Wait for evidence." });
    packet.topics = [{ id: "TOP-001", title: "Derived", sourceBlockId: "B003" }];
    (packet.idHighWater as Record<string, unknown>).topic = 1;
    const result = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.progress).toEqual({ decided: 4, total: 4, partial: false });
      expect(result.value.stats).toEqual({ PASS: 1, EDIT: 1, TOPIC: 1, HOLD: 1 });
    }
  });

  it("recomputes legacy progress instead of trusting conflicting summaries", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const packet = await load<Record<string, unknown>>(
      "tests/fixtures/protocol/review-packet.json",
    );
    packet.progress = { decided: 99, total: 99, partial: false };
    packet.stats = { PASS: 99, EDIT: 0, TOPIC: 0, HOLD: 0 };
    const result = migratePrototypePacket(packet, { profile: "prototype-v1", document });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.progress).toEqual({ decided: 2, total: 4, partial: true });
      expect(result.value.stats).toEqual({ PASS: 1, EDIT: 1, TOPIC: 0, HOLD: 0 });
    }
  });

  it("fails atomically for malformed roots, formats, decisions, invalid documents, and post-migration schema errors", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    expect(migratePrototypePacket([], { profile: "prototype-v1", document }).ok).toBe(false);
    expect(migratePrototypeState(null, { profile: "prototype-v1", document }).ok).toBe(false);
    expect(migratePrototypePacket({ format: "future/2" }, { profile: "prototype-v1", document }).ok).toBe(false);
    expect(migratePrototypeState({ format: "future/2" }, { profile: "prototype-v1", document }).ok).toBe(false);
    expect(migratePrototypePacket({ doc: {}, decisions: "wrong" }, {
      profile: "prototype-v1",
      document,
      confirmation: {
        documentId: document.document.id,
        contentVersion: document.document.contentVersion,
        round: document.document.round,
      },
    }).ok).toBe(false);
    expect(migratePrototypeState({ doc: {}, decisions: ["wrong"] }, {
      profile: "prototype-v1",
      document,
      confirmation: {
        documentId: document.document.id,
        contentVersion: document.document.contentVersion,
        round: document.document.round,
      },
    }).ok).toBe(false);
    const invalidDocument = structuredClone(document);
    invalidDocument.blocks.length = 3;
    const packet = await load<Record<string, unknown>>("tests/fixtures/protocol/review-packet.json");
    expect(migratePrototypePacket(packet, { profile: "prototype-v1", document: invalidDocument }).ok).toBe(false);
    expect(migratePrototypeState({ ...packet, format: "review-state/1" }, {
      profile: "prototype-v1",
      document: invalidDocument,
    }).ok).toBe(false);

    const schemaInvalidPacket = structuredClone(packet);
    delete schemaInvalidPacket.reviewedAt;
    expect(migratePrototypePacket(schemaInvalidPacket, { profile: "prototype-v1", document }).ok).toBe(false);
    const state = await load<Record<string, unknown>>("tests/fixtures/protocol/review-state.json");
    delete state.savedAt;
    expect(migratePrototypeState(state, { profile: "prototype-v1", document }).ok).toBe(false);
  });
});
