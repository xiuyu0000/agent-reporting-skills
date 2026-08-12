import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRenderCommand } from "../../src/cli/render.js";
import { reviewDigest, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  approvalTemplateBytes,
  createPrivateDirectory,
  reviewDocumentFixture,
  writePrivate,
} from "../fixtures/generator/helpers.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-gen-split-")));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function part(base: ReviewDocumentV1, number: number): ReviewDocumentV1 {
  const value = structuredClone(base);
  const character = number === 1 ? "A" : "B";
  value.delivery.id = `RDL-${character.repeat(20)}`;
  value.delivery.baseName = `split_${number}`;
  value.delivery.outputs = {
    agent: `split_${number}_AGENT.md`,
    approval: `split_${number}_APPROVAL.html`,
  };
  value.delivery.splitGroup = {
    groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
    part: number,
    total: 2,
    reason: "Independent decision boundaries.",
  };
  value.document.id = `RD-${character.repeat(20)}`;
  value.document.title = `Split part ${number}`;
  value.document.summary = `Review boundary ${number}.`;
  return value;
}

function nextRound(document: ReviewDocumentV1): ReviewDocumentV1 {
  const value = structuredClone(document);
  value.document.title = `${document.document.title}: regenerated`;
  value.document.summary = `${document.document.summary} Regenerated.`;
  value.document.contentVersion = 2;
  value.document.round = 2;
  value.lineage.previousReviewDigest = reviewDigest(document);
  return value;
}

describe("split-group render", () => {
  it("A13_split_or_block commits every consecutive part and returns the closed batch handoff", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const base = await reviewDocumentFixture();
    const first = part(base, 1);
    const second = part(base, 2);
    const firstPath = join(output, "split_1.review-document.json");
    const secondPath = join(output, "split_2.review-document.json");
    await writePrivate(firstPath, `${JSON.stringify(first)}\n`);
    await writePrivate(secondPath, `${JSON.stringify(second)}\n`);
    const result = await runRenderCommand([
      "--document", secondPath,
      "--document", firstPath,
    ], { approvalTemplateBytes: await approvalTemplateBytes() });
    expect(result).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "batch",
        handoff: {
          kind: "batch",
          groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
          total: 2,
          reason: "Independent decision boundaries.",
          parts: [{ part: 1 }, { part: 2 }],
        },
      },
    });
    for (const document of [first, second]) {
      expect((await lstat(join(output, document.delivery.outputs.agent))).isFile()).toBe(true);
      expect((await lstat(join(output, document.delivery.outputs.approval))).isFile()).toBe(true);
    }
  });

  it("rejects an incomplete group without creating any artifact", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = part(await reviewDocumentFixture(), 1);
    const contract = join(output, "split_1.review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const result = await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: await approvalTemplateBytes(),
    });
    expect(result).toMatchObject({ exitCode: 5, result: { status: "failed", mutated: false } });
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, document.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces every part from its own matching prior snapshot in one batch", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const base = await reviewDocumentFixture();
    const first = part(base, 1);
    const second = part(base, 2);
    const firstPath = join(output, "split_1.review-document.json");
    const secondPath = join(output, "split_2.review-document.json");
    await writePrivate(firstPath, `${JSON.stringify(first)}\n`);
    await writePrivate(secondPath, `${JSON.stringify(second)}\n`);
    const template = await approvalTemplateBytes();
    expect((await runRenderCommand([
      "--document", firstPath,
      "--document", secondPath,
    ], { approvalTemplateBytes: template })).exitCode).toBe(0);
    const oldBytes = await Promise.all([first, second].flatMap((document) => [
      readFile(join(output, document.delivery.outputs.agent)),
      readFile(join(output, document.delivery.outputs.approval)),
    ]));

    await writePrivate(firstPath, `${JSON.stringify(nextRound(first))}\n`);
    await writePrivate(secondPath, `${JSON.stringify(nextRound(second))}\n`);
    const result = await runRenderCommand([
      "--document", secondPath,
      "--document", firstPath,
      "--replace-generated",
    ], { approvalTemplateBytes: template });
    expect(result).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "batch",
        handoff: { parts: [{ part: 1, round: 2 }, { part: 2, round: 2 }] },
      },
    });
    const newBytes = await Promise.all([first, second].flatMap((document) => [
      readFile(join(output, document.delivery.outputs.agent)),
      readFile(join(output, document.delivery.outputs.approval)),
    ]));
    for (const [index, bytes] of newBytes.entries()) expect(bytes).not.toEqual(oldBytes[index]);
  }, 15_000);

  it("rejects portable contract/output collisions before committing the group", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const base = await reviewDocumentFixture();
    const first = part(base, 1);
    const second = part(base, 2);
    second.delivery.outputs.agent = first.delivery.outputs.agent.toUpperCase();
    const firstPath = join(output, "split_1.review-document.json");
    const secondPath = join(output, "split_2.review-document.json");
    await writePrivate(firstPath, `${JSON.stringify(first)}\n`);
    await writePrivate(secondPath, `${JSON.stringify(second)}\n`);
    const before = await readFile(firstPath);
    const result = await runRenderCommand([
      "--document", firstPath,
      "--document", secondPath,
    ], { approvalTemplateBytes: await approvalTemplateBytes() });
    expect(result).toMatchObject({
      exitCode: 3,
      result: { status: "failed", errors: [expect.objectContaining({ code: "PORTABLE_PATH_COLLISION" })] },
    });
    expect(await readFile(firstPath)).toEqual(before);
    await expect(lstat(join(output, first.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a baseName/output portable collision before creating transaction state", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const base = await reviewDocumentFixture();
    const first = part(base, 1);
    const second = part(base, 2);
    second.delivery.outputs.agent = first.delivery.baseName.toUpperCase();
    const firstPath = join(output, "split_1.review-document.json");
    const secondPath = join(output, "split_2.review-document.json");
    await writePrivate(firstPath, `${JSON.stringify(first)}\n`);
    await writePrivate(secondPath, `${JSON.stringify(second)}\n`);
    const beforeFirst = await readFile(firstPath);
    const beforeSecond = await readFile(secondPath);
    const result = await runRenderCommand([
      "--document", firstPath,
      "--document", secondPath,
    ], { approvalTemplateBytes: await approvalTemplateBytes() });
    expect(result).toMatchObject({
      exitCode: 3,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({ code: "PORTABLE_PATH_COLLISION" })],
      },
    });
    expect(await readFile(firstPath)).toEqual(beforeFirst);
    expect(await readFile(secondPath)).toEqual(beforeSecond);
    expect((await readdir(output)).sort()).toEqual([
      "split_1.review-document.json",
      "split_2.review-document.json",
    ]);
    await expect(lstat(join(output, first.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, first.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, second.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
