import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReviewPacketMarkdown,
  blockContentDigest,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  computeReviewDigest,
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";

async function load<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8")) as T;
}

describe("unique packet JSON and four-backtick Markdown serializer", () => {
  it("round-trips the malicious-boundary golden through one complete payload", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const serialized = serializeReviewPacketMarkdown(packet, document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.match(/^````json review-packet\/1$/gm)).toHaveLength(1);
    expect(serialized.value).toContain("&lt;/script&gt;");
    expect(serialized.value).toContain("</script>");
    const parsed = parseReviewPacketMarkdown(serialized.value, document);
    expect(parsed).toEqual({ ok: true, value: expect.objectContaining({
      packetId: packet.packetId,
      semanticDigest: packet.semanticDigest,
    }) });
    expect(parsed.ok && parsed.value.decisions[1]).toEqual(packet.decisions[1]);
  });

  it("emits one JCS JSON line with exactly one trailing LF", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const serialized = serializeReviewPacketJson(packet, document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.endsWith("\n")).toBe(true);
    expect(serialized.value.endsWith("\n\n")).toBe(false);
    expect(serialized.value.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(serialized.value)).toEqual(expect.objectContaining({ packetId: packet.packetId }));
  });

  it("rejects readable drift, duplicate payloads, truncation, and CRLF containers", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const serialized = serializeReviewPacketMarkdown(packet, document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const drifted = serialized.value.replace("Canonical arrays", "Canonical list drift");
    expect(parseReviewPacketMarkdown(drifted, document)).toEqual(expect.objectContaining({
      ok: false,
      mutated: false,
      errors: [expect.objectContaining({ code: "MARKDOWN_SUMMARY_MISMATCH" })],
    }));
    const payload = serialized.value.slice(serialized.value.indexOf("````json review-packet/1"));
    expect(parseReviewPacketMarkdown(`${serialized.value}${payload}`, document)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: [expect.objectContaining({ code: "MARKDOWN_CONTAINER_INVALID" })],
      }),
    );
    expect(parseReviewPacketMarkdown(serialized.value.replace(/````\n$/, ""), document).ok).toBe(false);
    expect(parseReviewPacketMarkdown(serialized.value.replaceAll("\n", "\r\n"), document).ok).toBe(false);
    expect(parseReviewPacketMarkdown(serialized.value.replace(/^\{.*\}$/m, "{"), document)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: [expect.objectContaining({ code: "MARKDOWN_CONTAINER_INVALID" })],
      }),
    );
    const corrupted = serialized.value.replace(packet.semanticDigest, `sha256:${"f".repeat(64)}`);
    expect(parseReviewPacketMarkdown(corrupted, document)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "DIGEST_MISMATCH" })]),
    }));
  });

  it("renders all four actions, global and block topics, optional notes, and complete-state wording", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    packet.decisions.push(
      { blockId: "B003", action: "TOPIC", topicId: "TOP-001" },
      { blockId: "B004", action: "HOLD", note: "Wait for confirmation." },
    );
    packet.topics = [
      { id: "TOP-001", title: "Block topic", note: "Separate scope.", sourceBlockId: "B003" },
      { id: "TOP-002", title: "Global topic" },
    ];
    packet.idHighWater.topic = 2;
    packet.progress = { decided: 4, total: 4, partial: false };
    packet.stats = { PASS: 1, EDIT: 1, TOPIC: 1, HOLD: 1 };
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    const rendered = serializeReviewPacketMarkdown(packet, document);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.value).toContain("- Partial: no");
      expect(rendered.value).toContain("## HOLD");
      expect(rendered.value).toContain("source B003");
      expect(rendered.value).toContain("(global)");
    }
  });

  it("renders nonempty frozen/reopened sets and no-overall/empty-list fallbacks", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    document.approvals.history.push({
      blockId: "B004",
      approvedRound: 1,
      approvedContentDigest: blockContentDigest(document.blocks[3]!),
    });
    document.approvals.currentFrozen = ["B004"];
    const computed = computeReviewDigest(document);
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    packet.doc.reviewDigest = computed.value;
    packet.frozenCarried = ["B004"];
    packet.progress.total = 3;
    packet.progress.partial = true;
    packet.sideNotes = [];
    delete packet.overall;
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    const frozen = serializeReviewPacketMarkdown(packet, document);
    expect(frozen.ok).toBe(true);
    if (frozen.ok) {
      expect(frozen.value).toContain("Frozen carried: `B004`");
      expect(frozen.value).toContain("## Overall\n\nNone");
    }

    packet.frozenCarried = [];
    packet.reopened = ["B004"];
    packet.progress.total = 4;
    packet.semanticDigest = packetSemanticDigest(packet);
    packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
    const reopened = serializeReviewPacketMarkdown(packet, document);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value).toContain("Reopened: `B004`");
  });

  it("refuses serialization when either the document or packet is invalid", async () => {
    const document = await load<ReviewDocumentV1>("review-document.json");
    const packet = await load<ReviewPacketV1>("review-packet.json");
    const invalidDocument = structuredClone(document);
    invalidDocument.blocks.length = 3;
    expect(serializeReviewPacketMarkdown(packet, invalidDocument).ok).toBe(false);
    expect(serializeReviewPacketJson(packet, invalidDocument).ok).toBe(false);
    expect(parseReviewPacketMarkdown("", invalidDocument).ok).toBe(false);
    const invalidPacket = structuredClone(packet);
    invalidPacket.semanticDigest = `sha256:${"f".repeat(64)}`;
    expect(serializeReviewPacketMarkdown(invalidPacket, document).ok).toBe(false);
    expect(serializeReviewPacketJson(invalidPacket, document).ok).toBe(false);
    const nonString = parseReviewPacketMarkdown(null as never, document);
    expect(nonString.ok ? [] : nonString.errors).toContainEqual(
      expect.objectContaining({ code: "MARKDOWN_CONTAINER_INVALID", path: "" }),
    );
  });
});
