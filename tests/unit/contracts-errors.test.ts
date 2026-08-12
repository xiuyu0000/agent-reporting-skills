import { describe, expect, it } from "vitest";
import {
  protocolError,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolResult,
} from "../../src/protocol/index.js";
import {
  failure,
  sortProtocolErrors,
  success,
} from "../../src/protocol/errors.js";

describe("pure protocol result and stable errors", () => {
  it("uses the frozen success/failure discriminated union", () => {
    const accepted: ProtocolResult<number> = success(7);
    const rejected: ProtocolResult<number> = failure([
      protocolError("IDENTITY_MISMATCH", "/doc/round"),
    ]);
    expect(accepted).toEqual({ ok: true, value: 7 });
    expect(rejected).toEqual({
      ok: false,
      mutated: false,
      errors: [expect.objectContaining({
        code: "IDENTITY_MISMATCH",
        path: "/doc/round",
        blockId: null,
      })],
    });
  });

  it("sorts by path then code and removes duplicate tuples", () => {
    const errors: ProtocolError[] = [
      protocolError("UNKNOWN_REFERENCE", "/z"),
      protocolError("DUPLICATE_ID", "/a"),
      protocolError("APPEND_ONLY_VIOLATION", "/a"),
      protocolError("UNKNOWN_REFERENCE", "/z"),
    ];
    expect(sortProtocolErrors(errors).map(({ path, code }) => `${path}:${code}`)).toEqual([
      "/a:APPEND_ONLY_VIOLATION",
      "/a:DUPLICATE_ID",
      "/z:UNKNOWN_REFERENCE",
    ]);
  });

  it("keeps messages content-free and locatable", () => {
    const error = protocolError("UNKNOWN_REFERENCE", "/blocks/2/dependencies/0", "B003");
    expect(error.message).toBe("A protocol reference does not resolve in the current document.");
    expect(error.hint).toContain("reference");
    expect(error).toEqual(expect.objectContaining({ path: "/blocks/2/dependencies/0", blockId: "B003" }));
  });

  it("pre-registers every transition error without implementing transitions", () => {
    const codes = [
      "PACKET_REPLAY_CONFLICT",
      "TRANSITION_ROUND_INVALID",
      "TRANSITION_BLOCK_REMOVED",
      "TRANSITION_BLOCK_REORDERED",
      "UNTOUCHED_BLOCK_CHANGED",
      "FROZEN_BLOCK_CHANGED",
      "DECISION_APPLICATION_INVALID",
      "IMPACT_ASSESSMENT_INVALID",
      "FEEDBACK_RESOLUTION_INVALID",
      "DERIVED_TOPIC_INVALID",
      "EXECUTION_ELIGIBILITY_MISMATCH",
      "FINALIZATION_INVALID",
    ] satisfies ProtocolErrorCode[];
    expect(codes.map((code) => protocolError(code, "/transition"))).toEqual(
      codes.map((code) => expect.objectContaining({ code, path: "/transition" })),
    );
  });
});
