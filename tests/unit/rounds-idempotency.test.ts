import { describe, expect, it } from "vitest";
import { validateTransition } from "../../src/protocol/transition/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "./rounds-fixtures.js";

function consumedPair() {
  const current = reviewFixture();
  const packet = makePacket(current);
  current.lineage.consumedPackets.push({
    packetId: packet.packetId,
    semanticDigest: packet.semanticDigest,
  });
  return { current, packet };
}

describe("round replay ordering and idempotency", () => {
  it("returns noop for a validated ledger hit before reading any candidate or derived input", () => {
    const { current, packet } = consumedPair();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let candidateGets = 0;
    let derivedGets = 0;
    const withAccessors = { current, packet } as Record<string, unknown>;
    Object.defineProperty(withAccessors, "candidate", {
      enumerable: true,
      get() {
        candidateGets += 1;
        throw new Error("candidate must not be read");
      },
    });
    Object.defineProperty(withAccessors, "derived", {
      enumerable: true,
      get() {
        derivedGets += 1;
        throw new Error("derived must not be read");
      },
    });
    const withNonEnumerableInputs = { current, packet } as Record<string, unknown>;
    Object.defineProperty(withNonEnumerableInputs, "candidate", {
      enumerable: false,
      value: cyclic,
    });
    Object.defineProperty(withNonEnumerableInputs, "derived", {
      enumerable: false,
      value: [cyclic],
    });
    const expected = {
      ok: true,
      value: {
        status: "noop",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
      },
    };
    expect(validateTransition({ current, packet })).toEqual(expected);
    expect(validateTransition({ current, packet, candidate: "stale", derived: "stale" as never })).toEqual(expected);
    expect(validateTransition({ current, packet, candidate: cyclic, derived: [cyclic] as never })).toEqual(expected);
    expect(validateTransition({ current, packet, candidate: () => undefined, derived: [Symbol()] as never })).toEqual(expected);
    expect(validateTransition(withAccessors as never)).toEqual(expected);
    expect(validateTransition(withNonEnumerableInputs as never)).toEqual(expected);
    expect(candidateGets).toBe(0);
    expect(derivedGets).toBe(0);
  });

  it("returns PACKET_REPLAY_CONFLICT before inspecting candidate when the full digest differs", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const prefix = packet.semanticDigest.slice(0, "sha256:".length + 20);
    const tail = packet.semanticDigest.endsWith("f".repeat(44)) ? "e".repeat(44) : "f".repeat(44);
    current.lineage.consumedPackets.push({
      packetId: packet.packetId,
      semanticDigest: `${prefix}${tail}`,
    });
    let gets = 0;
    const input = { current, packet } as Record<string, unknown>;
    Object.defineProperty(input, "candidate", {
      enumerable: true,
      get() {
        gets += 1;
        throw new Error("candidate must not be read on conflict");
      },
    });
    const result = validateTransition(input as never);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ code: "PACKET_REPLAY_CONFLICT", path: "/packet/semanticDigest" }),
    );
    expect(gets).toBe(0);
  });

  it("validates candidate and derived strictly only for an unconsumed packet", () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const candidate = candidateBase(current, packet);
    setContentVersion(current, candidate);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const input of [
      { current, packet },
      { current, packet, candidate: "bad" },
      { current, packet, candidate: cyclic },
      { current, packet, candidate, derived: [cyclic] },
      { current, packet, candidate, derived: "bad" },
    ]) {
      const result = validateTransition(input as never);
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }
    let gets = 0;
    const accessor = { current, packet } as Record<string, unknown>;
    Object.defineProperty(accessor, "candidate", {
      enumerable: true,
      get() {
        gets += 1;
        throw new Error("do not invoke candidate getter");
      },
    });
    expect(validateTransition(accessor as never)).toEqual(
      expect.objectContaining({ ok: false, mutated: false }),
    );
    expect(gets).toBe(0);
  });

  it("validates current and packet completely before trusting the ledger", () => {
    const pair = consumedPair();
    const invalidCurrent = structuredClone(pair.current);
    invalidCurrent.blocks.length = 3;
    expect(validateTransition({ current: invalidCurrent, packet: pair.packet })).toEqual(
      expect.objectContaining({ ok: false, mutated: false }),
    );
    const invalidPacket = structuredClone(pair.packet);
    invalidPacket.progress.decided = 1;
    expect(validateTransition({ current: pair.current, packet: invalidPacket })).toEqual(
      expect.objectContaining({ ok: false, mutated: false }),
    );
  });
});
