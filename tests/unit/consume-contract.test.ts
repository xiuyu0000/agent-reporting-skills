import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runConsumeCommand } from "../../src/cli/consume.js";

const source = readFileSync(resolve("src/cli/consume/index.ts"), "utf8");

describe("consume public composition contract", () => {
  it("exports the runner through the dedicated public consume entry", () => {
    expect(typeof runConsumeCommand).toBe("function");
  });

  it("imports every product dependency only through its frozen public facade", () => {
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)";/gu)]
      .map((match) => match[1])
      .sort();
    expect(importSpecifiers).toEqual([
      "../../generators/index.js",
      "../../protocol/index.js",
      "../../protocol/transition/index.js",
      "../exit-codes.js",
      "../io/index.js",
      "../validate.js",
      "./types.js",
      "node:path",
      "node:util/types",
    ].sort());
    expect(source).not.toMatch(/(?:protocol|generators|cli\/io|cli\/validate)\/(?:errors|text|read|parsers|transaction|recovery|paths|fsync)\.js/gu);
  });

  it("uses one fresh transaction call and never assembles lower-level output recovery", () => {
    expect(source.match(/commitFreshFileTransaction\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:resolveOutputRoot|recoverTransactions|commitFileTransaction)\b/gu);
    expect(source).not.toMatch(/from\s+"node:fs/gu);
  });

  it("retains the frozen generation, exact-pair, delivery, and loader seams", () => {
    for (const call of [
      "serializeReviewDocument",
      "createReviewDocumentByteVerifier",
      "generateArtifactBytes",
      "createExactGeneratedArtifactByteVerifiers",
      "validateDeliveryAndBuildHandoff",
    ]) {
      expect(source.match(new RegExp(`${call}\\(`, "gu"))).toHaveLength(1);
    }
    expect(source).toContain("const loaded = loadApprovalTemplateBytes();");
    expect(source).toContain("const templateBytes = isPromise(loaded) ? await loaded : loaded;");
    expect(source.indexOf("const loaded = loadApprovalTemplateBytes();"))
      .toBeLessThan(source.indexOf("return finish(prepared.value, templateBytes);"));
  });

  it("prebuilds the closed apply success before the sole durable commit", () => {
    const successIndex = source.indexOf("const success: ConsumeCommandOutcome = {");
    const commitIndex = source.indexOf("const committed = await commitFreshFileTransaction({");
    expect(successIndex).toBeGreaterThan(0);
    expect(commitIndex).toBeGreaterThan(successIndex);
    expect(source.slice(commitIndex)).toContain("if (!committed.ok) return ioFailure(committed);");
    expect(source.slice(commitIndex)).toContain("return success;");
    expect(source.slice(commitIndex)).not.toMatch(/committed\.value/gu);
  });
});
