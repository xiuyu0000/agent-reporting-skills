import { describe, expect, it } from "vitest";
import {
  APPROVAL_PAYLOAD_LIMIT_BYTES,
  APPROVAL_PAYLOAD_RESERVE_BYTES,
  APPROVAL_PAYLOAD_WARNING_BYTES,
  approvalPayloadBytes,
  approvalPayloadWarning,
  approvalPayloadWarnings,
} from "../../src/cli/validate.js";
import {
  canonicalJson,
  canonicalReviewDocument,
  validateReviewDocument,
} from "../../src/protocol/index.js";
import { reviewDocumentFixture } from "../fixtures/validate/helpers.js";
import { padDocumentTo } from "../fixtures/validate/payload.js";

function embeddedBase64(document: ReturnType<typeof reviewDocumentFixture>): string {
  return Buffer.from(canonicalJson(canonicalReviewDocument(document)), "utf8").toString("base64");
}

describe("approval payload budget", () => {
  it("derives the single-text-node limit from 65,536 Base64 characters", () => {
    expect(APPROVAL_PAYLOAD_LIMIT_BYTES).toBe(49_152);
    expect(APPROVAL_PAYLOAD_WARNING_BYTES).toBe(APPROVAL_PAYLOAD_LIMIT_BYTES - APPROVAL_PAYLOAD_RESERVE_BYTES);
    expect(APPROVAL_PAYLOAD_RESERVE_BYTES).toBeGreaterThanOrEqual(800);
    const fixture = reviewDocumentFixture();
    expect(embeddedBase64(padDocumentTo(fixture, APPROVAL_PAYLOAD_LIMIT_BYTES))).toHaveLength(65_536);
    expect(embeddedBase64(padDocumentTo(fixture, APPROVAL_PAYLOAD_LIMIT_BYTES + 1))).toHaveLength(65_540);
  });

  it("measures the exact canonical bytes the approval generator embeds", () => {
    const document = reviewDocumentFixture();
    expect(approvalPayloadBytes(document)).toBe(
      Buffer.byteLength(canonicalJson(canonicalReviewDocument(document)), "utf8"),
    );
    expect(approvalPayloadBytes(padDocumentTo(document, 40_000))).toBe(40_000);
    expect(validateReviewDocument(padDocumentTo(document, APPROVAL_PAYLOAD_LIMIT_BYTES + 1)).ok).toBe(true);
  });

  it("warns from the reserve boundary and escalates past the limit", () => {
    const document = reviewDocumentFixture();
    expect(approvalPayloadWarning(document, "/document")).toBeUndefined();
    expect(approvalPayloadWarning(
      padDocumentTo(document, APPROVAL_PAYLOAD_WARNING_BYTES - 1),
      "/document",
    )).toBeUndefined();
    const near = approvalPayloadWarning(padDocumentTo(document, APPROVAL_PAYLOAD_WARNING_BYTES), "/document");
    expect(near).toMatchObject({
      code: "APPROVAL_PAYLOAD_NEAR_LIMIT",
      path: "/document",
      blockId: null,
      payloadBytes: APPROVAL_PAYLOAD_WARNING_BYTES,
      limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
    });
    expect(approvalPayloadWarning(padDocumentTo(document, APPROVAL_PAYLOAD_LIMIT_BYTES), "/document")?.code)
      .toBe("APPROVAL_PAYLOAD_NEAR_LIMIT");
    const over = approvalPayloadWarning(padDocumentTo(document, APPROVAL_PAYLOAD_LIMIT_BYTES + 1), "/document");
    expect(over).toMatchObject({
      code: "APPROVAL_PAYLOAD_OVER_LIMIT",
      payloadBytes: APPROVAL_PAYLOAD_LIMIT_BYTES + 1,
      limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
    });
    for (const warning of [near, over]) {
      expect(warning?.message.length).toBeGreaterThan(0);
      expect(warning?.hint.length).toBeGreaterThan(0);
      expect(Object.keys(warning ?? {}).sort()).toEqual([
        "blockId",
        "code",
        "hint",
        "limitBytes",
        "message",
        "path",
        "payloadBytes",
      ]);
    }
    expect(near?.message).not.toBe(over?.message);
  });

  it("addresses one document at /document and split parts by batch index", () => {
    const document = reviewDocumentFixture();
    const padded = padDocumentTo(document, APPROVAL_PAYLOAD_LIMIT_BYTES);
    expect(approvalPayloadWarnings([document])).toEqual([]);
    expect(approvalPayloadWarnings([padded]).map((warning) => warning.path)).toEqual(["/document"]);
    expect(approvalPayloadWarnings([document, padded, padded]).map((warning) => warning.path))
      .toEqual(["/batch/parts/1", "/batch/parts/2"]);
  });
});
