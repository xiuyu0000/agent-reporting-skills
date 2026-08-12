import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migratePrototypePacket,
  migratePrototypePacketUnbound,
  validateReviewPacket,
  type PrototypePacketUnboundMigrationOptions,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";

async function load<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function packetFixture(): Promise<Record<string, unknown>> {
  return load<Record<string, unknown>>("tests/fixtures/protocol/review-packet.json");
}

const unboundOptions: PrototypePacketUnboundMigrationOptions = {
  profile: "prototype-v1",
};

describe("prototype-v1 unbound packet migration", () => {
  it("matches the bound migration exactly when the receipt carries matching context", async () => {
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const input = await packetFixture();
    const decisions = input.decisions as Array<Record<string, unknown>>;
    decisions[1]!.action = "TRIM";
    decisions[1]!.note = "Remove one redundant sentence.";
    const before = structuredClone(input);

    const unbound = migratePrototypePacketUnbound(input, unboundOptions);
    const bound = migratePrototypePacket(input, { profile: "prototype-v1", document });

    expect(input).toEqual(before);
    expect(unbound).toEqual(bound);
    expect(unbound.ok).toBe(true);
    if (!unbound.ok) return;
    expect(unbound.value.decisions[1]).toEqual(expect.objectContaining({
      action: "EDIT",
      note: "【精简】Remove one redundant sentence.",
    }));
    expect(validateReviewPacket(unbound.value, document)).toEqual({
      ok: true,
      value: unbound.value,
    });
  });

  it("fills only the identity triple from one explicit confirmation", async () => {
    const complete = await packetFixture();
    const completeResult = migratePrototypePacketUnbound(complete, unboundOptions);
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;

    const incomplete = structuredClone(complete);
    const doc = incomplete.doc as Record<string, unknown>;
    delete doc.id;
    delete doc.contentVersion;
    delete doc.round;
    const before = structuredClone(incomplete);
    const withoutConfirmation = migratePrototypePacketUnbound(incomplete, unboundOptions);
    expect(withoutConfirmation.ok ? [] : withoutConfirmation.errors).toContainEqual(
      expect.objectContaining({
        code: "IDENTITY_CONFIRMATION_REQUIRED",
        path: "/doc",
      }),
    );

    const sourceDoc = complete.doc as Record<string, unknown>;
    const withConfirmation = migratePrototypePacketUnbound(incomplete, {
      profile: "prototype-v1",
      confirmation: {
        documentId: sourceDoc.id as string,
        contentVersion: sourceDoc.contentVersion as number,
        round: sourceDoc.round as number,
      },
    });
    expect(incomplete).toEqual(before);
    expect(withConfirmation).toEqual(completeResult);
  });

  it("rejects every explicit identity-confirmation conflict at its packet path", async () => {
    const packet = await packetFixture();
    const doc = packet.doc as Record<string, unknown>;
    const baseConfirmation = {
      documentId: doc.id as string,
      contentVersion: doc.contentVersion as number,
      round: doc.round as number,
    };
    const cases = [
      {
        path: "/doc/id",
        confirmation: { ...baseConfirmation, documentId: "RD-AAAAAAAAAAAAAAAAAAAA" },
      },
      {
        path: "/doc/contentVersion",
        confirmation: { ...baseConfirmation, contentVersion: baseConfirmation.contentVersion + 1 },
      },
      {
        path: "/doc/round",
        confirmation: { ...baseConfirmation, round: baseConfirmation.round + 1 },
      },
    ];
    for (const item of cases) {
      const result = migratePrototypePacketUnbound(packet, {
        profile: "prototype-v1",
        confirmation: item.confirmation,
      });
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "IDENTITY_MISMATCH", path: item.path }),
      );
    }

    const malformed = migratePrototypePacketUnbound(packet, {
      profile: "prototype-v1",
      confirmation: {
        documentId: baseConfirmation.documentId,
        contentVersion: baseConfirmation.contentVersion,
      },
    } as never);
    expect(malformed.ok ? [] : malformed.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/confirmation/round" }),
    );
  });

  it("requires every context field that cannot be reconstructed without current", async () => {
    const cases: Array<{
      path: "/doc/title" | "/doc/reviewDigest" | "/progress/total" | "/frozenCarried";
      remove(packet: Record<string, unknown>): void;
    }> = [
      {
        path: "/doc/title",
        remove(packet) {
          delete (packet.doc as Record<string, unknown>).title;
        },
      },
      {
        path: "/doc/reviewDigest",
        remove(packet) {
          delete (packet.doc as Record<string, unknown>).reviewDigest;
        },
      },
      {
        path: "/progress/total",
        remove(packet) {
          delete (packet.progress as Record<string, unknown>).total;
        },
      },
      {
        path: "/frozenCarried",
        remove(packet) {
          delete packet.frozenCarried;
        },
      },
    ];
    for (const item of cases) {
      const packet = await packetFixture();
      item.remove(packet);
      const before = structuredClone(packet);
      const result = migratePrototypePacketUnbound(packet, unboundOptions);
      expect(packet).toEqual(before);
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_REQUIRED", path: item.path }),
      );
    }
  });

  it("defaults reopened only and recomputes all permitted derived summaries", async () => {
    const packet = await packetFixture();
    delete packet.reopened;
    packet.progress = { decided: 99, total: 4, partial: false };
    packet.stats = { PASS: 99, EDIT: 0, TOPIC: 0, HOLD: 0 };
    const result = migratePrototypePacketUnbound(packet, unboundOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reopened).toEqual([]);
    expect(result.value.progress).toEqual({ decided: 2, total: 4, partial: true });
    expect(result.value.stats).toEqual({ PASS: 1, EDIT: 1, TOPIC: 0, HOLD: 0 });
  });

  it("rejects a current document option and preserves option-first validation", async () => {
    const packet = await packetFixture();
    const document = await load<ReviewDocumentV1>(
      "tests/fixtures/protocol/review-document.json",
    );
    const extraDocument = migratePrototypePacketUnbound(packet, {
      profile: "prototype-v1",
      document,
    } as never);
    expect(extraDocument.ok ? [] : extraDocument.errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_ADDITIONAL_PROPERTIES",
        path: "/options/document",
      }),
    );

    const wrongProfile = migratePrototypePacketUnbound(packet, {
      profile: "future-v2",
    } as never);
    expect(wrongProfile.ok ? [] : wrongProfile.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/profile" }),
    );

    const missingOptions = migratePrototypePacketUnbound(packet, undefined as never);
    expect(missingOptions.ok ? [] : missingOptions.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/profile" }),
    );
    const nullOptions = migratePrototypePacketUnbound(packet, null as never);
    expect(nullOptions.ok ? [] : nullOptions.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/options" }),
    );
    const unknownConfirmationField = migratePrototypePacketUnbound(packet, {
      profile: "prototype-v1",
      confirmation: {
        documentId: "RD-22222222222222222222",
        contentVersion: 1,
        round: 1,
        future: true,
      },
    } as never);
    expect(unknownConfirmationField.ok ? [] : unknownConfirmationField.errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_ADDITIONAL_PROPERTIES",
        path: "/confirmation/future",
      }),
    );
  });

  it("keeps format, action, derived-container, array, and schema failures distinct", async () => {
    expect(migratePrototypePacketUnbound([], unboundOptions).ok).toBe(false);

    const future = await packetFixture();
    future.format = "review-packet/2";
    const futureResult = migratePrototypePacketUnbound(future, unboundOptions);
    expect(futureResult.ok ? [] : futureResult.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FORMAT", path: "/format" }),
    );

    const badIdentityContainer = await packetFixture();
    badIdentityContainer.doc = "not-an-object";
    const badIdentityContainerResult = migratePrototypePacketUnbound(
      badIdentityContainer,
      unboundOptions,
    );
    expect(badIdentityContainerResult.ok ? [] : badIdentityContainerResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc" }),
    );

    const badIdentityField = await packetFixture();
    (badIdentityField.doc as Record<string, unknown>).round = "1";
    const badIdentityFieldResult = migratePrototypePacketUnbound(
      badIdentityField,
      unboundOptions,
    );
    expect(badIdentityFieldResult.ok ? [] : badIdentityFieldResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/doc/round" }),
    );

    const unknownAction = await packetFixture();
    (unknownAction.decisions as Array<Record<string, unknown>>)[0]!.action = "SPLIT";
    const unknownActionResult = migratePrototypePacketUnbound(unknownAction, unboundOptions);
    expect(unknownActionResult.ok ? [] : unknownActionResult.errors).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_LEGACY_ACTION",
        path: "/decisions/0/action",
      }),
    );

    const badDerived = await packetFixture();
    (badDerived.progress as Record<string, unknown>).future = 1;
    const badDerivedResult = migratePrototypePacketUnbound(badDerived, unboundOptions);
    expect(badDerivedResult.ok ? [] : badDerivedResult.errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_ADDITIONAL_PROPERTIES",
        path: "/progress/future",
      }),
    );

    for (const [field, value] of [
      ["reopened", "B001"],
      ["frozenCarried", { blockId: "B001" }],
    ] as const) {
      const badArray = await packetFixture();
      badArray[field] = value;
      const result = migratePrototypePacketUnbound(badArray, unboundOptions);
      expect(result.ok ? [] : result.errors).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_TYPE", path: `/${field}` }),
      );
    }

    const schemaInvalid = await packetFixture();
    delete schemaInvalid.reviewedAt;
    const schemaInvalidResult = migratePrototypePacketUnbound(schemaInvalid, unboundOptions);
    expect(schemaInvalidResult.ok ? [] : schemaInvalidResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_REQUIRED", path: "/reviewedAt" }),
    );
  });

  it("fails closed without invoking getters or throwing on hostile JS values", async () => {
    const packet = await packetFixture();
    let getterCalls = 0;
    const getterInput = Object.defineProperty({}, "doc", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must remain inert");
      },
    });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse = structuredClone(packet);
    sparse.decisions = new Array(1);
    const unusualPrototype = Object.assign(Object.create({ inherited: true }), packet);
    const throwingProxy = new Proxy({}, {
      ownKeys() {
        throw new Error("proxy trap");
      },
    });
    const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
    revoke();

    for (const input of [
      getterInput,
      cycle,
      sparse,
      unusualPrototype,
      throwingProxy,
      revokedProxy,
    ]) {
      expect(() => migratePrototypePacketUnbound(input, unboundOptions)).not.toThrow();
      expect(migratePrototypePacketUnbound(input, unboundOptions)).toEqual(
        expect.objectContaining({ ok: false, mutated: false }),
      );
    }
    expect(getterCalls).toBe(0);

    const hostileTotal = await packetFixture();
    (hostileTotal.progress as Record<string, unknown>).total = Object.create(null);
    expect(() => migratePrototypePacketUnbound(hostileTotal, unboundOptions)).not.toThrow();
    const hostileTotalResult = migratePrototypePacketUnbound(hostileTotal, unboundOptions);
    expect(hostileTotalResult.ok ? [] : hostileTotalResult.errors).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TYPE", path: "/progress/total" }),
    );

    const optionGetter = Object.defineProperty({}, "profile", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must remain inert");
      },
    });
    expect(() => migratePrototypePacketUnbound(packet, optionGetter as never)).not.toThrow();
    expect(migratePrototypePacketUnbound(packet, optionGetter as never)).toEqual(
      expect.objectContaining({ ok: false, mutated: false }),
    );
    expect(getterCalls).toBe(0);
  });
});
