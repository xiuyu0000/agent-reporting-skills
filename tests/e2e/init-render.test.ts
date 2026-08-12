import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "../../src/cli/init.js";
import { runRenderCommand } from "../../src/cli/render.js";
import { validateReviewDocument, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import { runValidateCommand } from "../../src/cli/validate.js";
import {
  approvalTemplateBytes,
  createPrivateDirectory,
  reviewDocumentFixture,
  writePrivate,
} from "../fixtures/generator/helpers.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-gen-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("init and render E2E", () => {
  it("init rejects malformed arguments, unsafe content, and invalid randomness before output creation", async () => {
    const parent = await temporaryDirectory("init-invalid");
    const output = join(parent, "delivery");
    const valid = [
      "--output-dir", output,
      "--base-name", "approval_plan",
      "--title", "Approval plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ];
    for (const argv of [
      [],
      ["--output-dir"],
      [...valid, "--base-name", "duplicate"],
      [...valid, "--unknown", "value"],
    ]) {
      expect(await runInitCommand(argv)).toMatchObject({
        exitCode: 2,
        result: { status: "failed", mutated: false },
      });
    }
    expect(await runInitCommand(valid, {
      randomBytes: (size) => new Uint8Array(Math.max(0, size - 1)),
    })).toMatchObject({ exitCode: 70, result: { status: "failed", mutated: false } });
    const privateTitle = ["Author", "ization: Bearer private-title-abcdefgh"].join("");
    expect(await runInitCommand(valid.map((value) =>
      value === "Approval plan" ? privateTitle : value))).toMatchObject({
      exitCode: 3,
      result: { status: "failed", mutated: false },
    });
    const invalidLanguage = [...valid];
    invalidLanguage[7] = "not_a_language";
    expect(await runInitCommand(invalidLanguage)).toMatchObject({
      exitCode: 3,
      result: { status: "failed", mutated: false },
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("init creates one private canonical draft with deterministic nonsemantic IDs", async () => {
    const parent = await temporaryDirectory("init");
    const output = join(parent, "delivery");
    let call = 0;
    const result = await runInitCommand([
      "init",
      "--output-dir", output,
      "--base-name", "approval_plan",
      "--title", "Approval plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ], {
      randomBytes: (size) => new Uint8Array(size).fill(++call),
    });
    expect(result).toEqual({
      exitCode: 0,
      result: {
        status: "ok",
        phase: "init",
        mutated: true,
        contract: {
          relativePath: "review-document.json",
          byteDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        document: {
          format: "review-document/1",
          deliveryId: "RDL-01010101010101010101",
          documentId: "RD-02020202020202020202",
          contentVersion: 1,
          round: 1,
          status: "draft",
        },
      },
    });
    const path = join(output, "review-document.json");
    const bytes = await readFile(path);
    const document = JSON.parse(bytes.toString("utf8")) as ReviewDocumentV1;
    expect(validateReviewDocument(document).ok).toBe(true);
    expect(document.blocks).toHaveLength(4);
    expect(document.blocks.every((block) => block.tier === "T0")).toBe(true);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(output)).toEqual(expect.arrayContaining([".review-txn", "review-document.json"]));
  });

  it("init rejects publication without matching one-shot confirmation before creating output", async () => {
    const parent = await temporaryDirectory("init-auth");
    const output = join(parent, "delivery");
    const result = await runInitCommand([
      "--output-dir", output,
      "--base-name", "approval_plan",
      "--title", "Approval plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
      "--repository-status", "public-approved",
      "--confirm-output-scope", "tracked",
    ]);
    expect(result).toMatchObject({ exitCode: 2, result: { status: "failed", mutated: false } });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("init refuses a target collision without changing existing bytes", async () => {
    const parent = await temporaryDirectory("init-collision");
    const output = await createPrivateDirectory(parent, "delivery");
    const contract = join(output, "review-document.json");
    await writePrivate(contract, "owned-by-user\n");
    const before = await readFile(contract);
    const result = await runInitCommand([
      "--output-dir", output,
      "--base-name", "approval_plan",
      "--title", "Approval plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ]);
    expect(result).toMatchObject({ exitCode: 3, result: { status: "failed", mutated: false } });
    expect(await readFile(contract)).toEqual(before);
  });

  it("render creates and validates both real artifacts while leaving the contract unchanged", async () => {
    const parent = await temporaryDirectory("render");
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    const contractBytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    await writePrivate(contract, contractBytes);
    const template = await approvalTemplateBytes();
    const result = await runRenderCommand(["render", "--document", contract], {
      approvalTemplateBytes: template,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        phase: "render",
        mode: "delivery",
        mutated: true,
        handoff: {
          kind: "delivery",
          deliveryId: document.delivery.id,
          documentId: document.document.id,
        },
      },
    });
    expect(Uint8Array.from(await readFile(contract))).toEqual(contractBytes);
    const validated = await runValidateCommand(["delivery", "--document", contract], {
      approvalTemplateBytes: template,
    });
    expect(validated.exitCode).toBe(0);
    expect(validated.result).toMatchObject({ status: "ok", mode: "delivery" });
  });

  it("render blocks a promoted init skeleton until every draft slot is replaced", async () => {
    const parent = await temporaryDirectory("draft-block");
    const output = join(parent, "delivery");
    const init = await runInitCommand([
      "--output-dir", output,
      "--base-name", "approval_plan",
      "--title", "Approval plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ], { randomBytes: (size) => new Uint8Array(size).fill(7) });
    expect(init.exitCode).toBe(0);
    const contract = join(output, "review-document.json");
    const document = JSON.parse(await readFile(contract, "utf8")) as ReviewDocumentV1;
    document.document.status = "in-review";
    await writeFile(contract, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await chmod(contract, 0o600);
    const result = await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: await approvalTemplateBytes(),
    });
    expect(result).toMatchObject({
      exitCode: 4,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({ code: "DOCUMENT_NOT_REVIEWABLE", path: "/document/blocks" })],
      },
    });
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, document.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
