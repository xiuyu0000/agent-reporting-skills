import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

interface DigestFixture {
  blockContentDigest: string;
  documentContentDigest: string;
  reviewDigest: string;
  packetSemanticDigest: string;
  packetId: string;
  stateDigest: string;
  feedbackDigest: string;
  bytesDigest: string;
}

const root = resolve("tests/fixtures/protocol");
const [document, packet, state, golden] = await Promise.all([
  readFile(resolve(root, "review-document.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "review-packet.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "review-state.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "digests.json"), "utf8").then(JSON.parse) as Promise<DigestFixture>,
]);

const bundle = await build({
  bundle: true,
  format: "iife",
  platform: "browser",
  stdin: {
    contents: `
      import {
        blockContentDigest,
        documentContentDigest,
        feedbackDigest,
        packetIdFromSemanticDigest,
        packetSemanticDigest,
        reviewDigest,
        sha256Bytes,
        stateDigest,
      } from "./src/protocol/digest.ts";
      globalThis.__protocolDigest = (document, packet, state) => {
        const semantic = packetSemanticDigest(packet);
        return {
          blockContentDigest: blockContentDigest(document.blocks[0]),
          documentContentDigest: documentContentDigest(document),
          reviewDigest: reviewDigest(document),
          packetSemanticDigest: semantic,
          packetId: packetIdFromSemanticDigest(semantic),
          stateDigest: stateDigest(state),
          feedbackDigest: feedbackDigest({
            kind: "side-note",
            feedbackId: "NOTE-001",
            blockId: "B003",
            text: "Keep the closure deterministic.",
          }),
          bytesDigest: sha256Bytes(new TextEncoder().encode("abc")),
        };
      };
    `,
    resolveDir: process.cwd(),
    sourcefile: "protocol-digest-browser-entry.ts",
  },
  target: "es2023",
  write: false,
});
const script = bundle.outputFiles[0]?.text;
if (!script) throw new Error("browser digest bundle was not produced");

test("Node and browser share the exact protocol digest golden", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.setContent("<!doctype html><meta charset=utf-8><title>Protocol digest</title>");
  await page.addScriptTag({ content: script });
  const actual = await page.evaluate(
    ({ documentValue, packetValue, stateValue }) => {
      const digest = (globalThis as typeof globalThis & {
        __protocolDigest: (
          documentInput: unknown,
          packetInput: unknown,
          stateInput: unknown,
        ) => DigestFixture;
      }).__protocolDigest;
      return digest(documentValue, packetValue, stateValue);
    },
    { documentValue: document, packetValue: packet, stateValue: state },
  );
  expect(actual).toEqual(golden);
  expect(requests).toEqual([]);
});
