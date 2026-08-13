import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReviewPacketMarkdown,
  parseReviewPacketMarkdownUnbound,
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve("tests/fixtures/protocol", name), "utf8")) as T;
}

function extractOrdinaryMarkdownFences(markdown: string): string[] {
  const lines = markdown.split("\n");
  const payloads: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {0,3}`{4}json review-packet\/1[ \t]*$/u.test(lines[index] ?? "")) continue;
    const payload: string[] = [];
    index += 1;
    while (index < lines.length && !/^ {0,3}`{4}[ \t]*$/u.test(lines[index] ?? "")) {
      payload.push(lines[index] ?? "");
      index += 1;
    }
    if (index < lines.length) payloads.push(payload.join("\n"));
  }
  return payloads;
}

async function maliciousPacketFixture(): Promise<{
  document: ReviewDocumentV1;
  packet: ReviewPacketV1;
  markdown: string;
  json: string;
  maliciousUserText: string;
}> {
  const document = await fixture<ReviewDocumentV1>("review-document.json");
  const packet = await fixture<ReviewPacketV1>("review-packet.json");
  const maliciousUserText = "Literal ``` triple and ```` quadruple; keep </script> inert; bidi ‮; emoji 🧭.";
  const decision = packet.decisions[1];
  if (decision?.action !== "EDIT") throw new Error("packet fixture EDIT decision drifted");
  decision.note = maliciousUserText;
  packet.semanticDigest = packetSemanticDigest(packet);
  packet.packetId = packetIdFromSemanticDigest(packet.semanticDigest as `sha256:${string}`);
  const markdown = serializeReviewPacketMarkdown(packet, document);
  const json = serializeReviewPacketJson(packet, document);
  if (!markdown.ok || !json.ok) throw new Error("malicious packet fixture did not serialize");
  return { document, packet, markdown: markdown.value, json: json.value, maliciousUserText };
}

async function createFreshEvidenceRoot(path: string): Promise<string> {
  const parent = dirname(path);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o777) !== 0o700) {
    throw new Error("packet evidence parent must be a real private 0700 directory");
  }
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return realpath(path);
}

describe("deterministic packet Markdown direct-paste protocol preflight", () => {
  it("preflights malicious user text through one ordinary Markdown payload with the same digest", async () => {
    const { document, packet, markdown, json, maliciousUserText } = await maliciousPacketFixture();

    expect(markdown).toContain("&lt;/script&gt;");
    expect(markdown).toContain("</script>");
    expect(markdown).toContain("‮");
    expect(markdown).toContain("🧭");

    const payloads = extractOrdinaryMarkdownFences(markdown);
    expect(payloads).toHaveLength(1);
    expect(`${payloads[0]}\n`).toBe(json);
    const forwarded = JSON.parse(payloads[0] ?? "") as ReviewPacketV1;
    expect(forwarded.semanticDigest).toBe(packet.semanticDigest);
    expect(forwarded.decisions[1]).toEqual(expect.objectContaining({ note: maliciousUserText }));
    expect(parseReviewPacketMarkdownUnbound(markdown)).toEqual({
      ok: true,
      value: expect.objectContaining({
        semanticDigest: packet.semanticDigest,
        decisions: expect.arrayContaining([expect.objectContaining({ note: maliciousUserText })]),
      }),
    });
    expect(parseReviewPacketMarkdown(markdown, document)).toEqual({
      ok: true,
      value: expect.objectContaining({
        semanticDigest: packet.semanticDigest,
        decisions: expect.arrayContaining([expect.objectContaining({ note: maliciousUserText })]),
      }),
    });
  });

  it("rejects duplicate or truncated pasted containers instead of selecting a plausible payload", async () => {
    const document = await fixture<ReviewDocumentV1>("review-document.json");
    const packet = await fixture<ReviewPacketV1>("review-packet.json");
    const serialized = serializeReviewPacketMarkdown(packet, document);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const container = serialized.value.slice(serialized.value.indexOf("````json review-packet/1"));
    const duplicated = `${serialized.value}${container}`;
    const truncated = serialized.value.replace(/````\n$/u, "");
    expect(extractOrdinaryMarkdownFences(duplicated)).toHaveLength(2);
    expect(parseReviewPacketMarkdownUnbound(duplicated)).toEqual(expect.objectContaining({
      ok: false,
      errors: [expect.objectContaining({ code: "MARKDOWN_CONTAINER_INVALID" })],
    }));
    expect(extractOrdinaryMarkdownFences(truncated)).toHaveLength(0);
    expect(parseReviewPacketMarkdownUnbound(truncated)).toEqual(expect.objectContaining({
      ok: false,
      errors: [expect.objectContaining({ code: "MARKDOWN_CONTAINER_INVALID" })],
    }));
  });

  it.skipIf(process.env.DAR_PACKET_EVIDENCE_ROOT === undefined)(
    "prepares exact malicious packet Markdown for an external isolated Agent run",
    async () => {
      const requested = process.env.DAR_PACKET_EVIDENCE_ROOT;
      if (requested === undefined) throw new Error("DAR_PACKET_EVIDENCE_ROOT is required");
      const root = await createFreshEvidenceRoot(requested);
      const prepared = await maliciousPacketFixture();
      await writeFile(join(root, "packet.md"), prepared.markdown, { mode: 0o600 });
      await chmod(join(root, "packet.md"), 0o600);
    },
  );

  it.skipIf(process.env.DAR_PACKET_CAPTURE_PATH === undefined)(
    "checks an external isolated Agent capture without treating local parsing as Agent evidence",
    async () => {
      const capturePath = process.env.DAR_PACKET_CAPTURE_PATH;
      if (capturePath === undefined) throw new Error("DAR_PACKET_CAPTURE_PATH is required");
      const metadata = await lstat(capturePath);
      const currentUser = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (currentUser !== undefined && metadata.uid !== currentUser)) {
        throw new Error("packet capture must be a real private file");
      }
      const prepared = await maliciousPacketFixture();
      expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual({
        packetCount: 1,
        semanticDigest: prepared.packet.semanticDigest,
      });
    },
  );
});
