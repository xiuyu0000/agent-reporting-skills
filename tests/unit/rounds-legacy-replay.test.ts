import { describe, expect, it } from "vitest";
import {
  migratePrototypePacketUnbound,
  validateReviewPacket,
} from "../../src/protocol/index.js";
import { validateTransition } from "../../src/protocol/transition/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "./rounds-fixtures.js";

describe("legacy packet replay across review rounds", () => {
  it("normalizes one raw receipt identically before apply and next-current noop", () => {
    const current = reviewFixture();
    const sourcePacket = makePacket(current, {
      decisions: [{ blockId: "B001", action: "PASS" }],
    });
    const legacyReceipt = structuredClone(sourcePacket) as unknown as Record<string, unknown>;
    delete legacyReceipt.format;
    delete legacyReceipt.reopened;
    const before = structuredClone(legacyReceipt);

    const first = migratePrototypePacketUnbound(legacyReceipt, {
      profile: "prototype-v1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(legacyReceipt).toEqual(before);
    expect(validateReviewPacket(first.value, current).ok).toBe(true);

    const candidate = candidateBase(current, first.value);
    setContentVersion(current, candidate);
    const applied = validateTransition({ current, packet: first.value, candidate });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.value.status !== "apply") return;

    const second = migratePrototypePacketUnbound(legacyReceipt, {
      profile: "prototype-v1",
    });
    expect(second).toEqual(first);
    if (!second.ok) return;

    let candidateGets = 0;
    let derivedGets = 0;
    const replayInput = {
      current: applied.value.candidate,
      packet: second.value,
    } as Record<string, unknown>;
    Object.defineProperty(replayInput, "candidate", {
      enumerable: true,
      get() {
        candidateGets += 1;
        throw new Error("replay must not inspect candidate");
      },
    });
    Object.defineProperty(replayInput, "derived", {
      enumerable: true,
      get() {
        derivedGets += 1;
        throw new Error("replay must not inspect derived");
      },
    });

    expect(validateTransition(replayInput as never)).toEqual({
      ok: true,
      value: {
        status: "noop",
        packetId: first.value.packetId,
        semanticDigest: first.value.semanticDigest,
      },
    });
    expect(candidateGets).toBe(0);
    expect(derivedGets).toBe(0);
  });
});
