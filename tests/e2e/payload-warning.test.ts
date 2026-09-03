import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRenderCommand } from "../../src/cli/render.js";
import {
  APPROVAL_PAYLOAD_LIMIT_BYTES,
  APPROVAL_PAYLOAD_WARNING_BYTES,
  runValidateCommand,
} from "../../src/cli/validate.js";
import type { ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  approvalTemplateBytes,
  createPrivateDirectory,
  reviewDocumentFixture,
  writePrivate,
} from "../fixtures/generator/helpers.js";
import { padDocumentTo } from "../fixtures/validate/payload.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-payload-warning-")));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function embeddedBase64Length(html: Uint8Array): number {
  const match = /<template id="review-document-data" data-encoding="base64">([A-Za-z0-9+/=]*)<\/template>/u
    .exec(Buffer.from(html).toString("utf8"));
  if (match?.[1] === undefined) throw new Error("payload template missing");
  return match[1].length;
}

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

async function writeContract(output: string, name: string, document: ReviewDocumentV1): Promise<string> {
  const path = join(output, name);
  await writePrivate(path, `${JSON.stringify(document)}\n`);
  return path;
}

describe("approval payload warnings", () => {
  it("reports a near-limit contract on render and validate without changing the exit code", async () => {
    const output = await createPrivateDirectory(await temporaryDirectory(), "delivery");
    const document = padDocumentTo(await reviewDocumentFixture(), APPROVAL_PAYLOAD_WARNING_BYTES);
    const contract = await writeContract(output, "review-document.json", document);
    const template = await approvalTemplateBytes();
    const expected = {
      code: "APPROVAL_PAYLOAD_NEAR_LIMIT",
      path: "/document",
      blockId: null,
      payloadBytes: APPROVAL_PAYLOAD_WARNING_BYTES,
      limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
    };
    const rendered = await runRenderCommand(["--document", contract], { approvalTemplateBytes: template });
    expect(rendered).toMatchObject({
      exitCode: 0,
      result: { status: "ok", phase: "render", mode: "delivery", mutated: true, warnings: [expected] },
    });
    const approval = await readFile(join(output, document.delivery.outputs.approval));
    expect(embeddedBase64Length(approval)).toBeLessThanOrEqual(65_536);
    const validated = await runValidateCommand(["delivery", "--document", contract], {
      approvalTemplateBytes: template,
    });
    expect(validated).toMatchObject({
      exitCode: 0,
      result: { status: "ok", phase: "validate", mode: "delivery", mutated: false, warnings: [expected] },
    });
    expect(JSON.parse(JSON.stringify(validated.result))).toMatchObject({ warnings: [expected] });
  });

  it("omits the key below the reserve and escalates past the single-node limit", async () => {
    const template = await approvalTemplateBytes();
    const quiet = await createPrivateDirectory(await temporaryDirectory(), "delivery");
    const quietDocument = padDocumentTo(await reviewDocumentFixture(), APPROVAL_PAYLOAD_WARNING_BYTES - 1);
    const quietContract = await writeContract(quiet, "review-document.json", quietDocument);
    const quietRender = await runRenderCommand(["--document", quietContract], { approvalTemplateBytes: template });
    expect(quietRender.exitCode).toBe(0);
    expect("warnings" in quietRender.result).toBe(false);
    const quietValidate = await runValidateCommand(["delivery", "--document", quietContract], {
      approvalTemplateBytes: template,
    });
    expect(quietValidate.exitCode).toBe(0);
    expect("warnings" in quietValidate.result).toBe(false);

    const loud = await createPrivateDirectory(await temporaryDirectory(), "delivery");
    const loudDocument = padDocumentTo(await reviewDocumentFixture(), APPROVAL_PAYLOAD_LIMIT_BYTES + 1);
    const loudContract = await writeContract(loud, "review-document.json", loudDocument);
    const expected = {
      code: "APPROVAL_PAYLOAD_OVER_LIMIT",
      path: "/document",
      payloadBytes: APPROVAL_PAYLOAD_LIMIT_BYTES + 1,
      limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
    };
    const loudRender = await runRenderCommand(["--document", loudContract], { approvalTemplateBytes: template });
    expect(loudRender).toMatchObject({ exitCode: 0, result: { status: "ok", warnings: [expected] } });
    const approval = await readFile(join(loud, loudDocument.delivery.outputs.approval));
    expect(embeddedBase64Length(approval)).toBe(65_540);
    const loudValidate = await runValidateCommand(["delivery", "--document", loudContract], {
      approvalTemplateBytes: template,
    });
    expect(loudValidate).toMatchObject({ exitCode: 0, result: { status: "ok", warnings: [expected] } });
  });

  it("addresses each split part by its batch index in part order", async () => {
    const output = await createPrivateDirectory(await temporaryDirectory(), "delivery");
    const base = await reviewDocumentFixture();
    const first = part(base, 1);
    const second = padDocumentTo(part(base, 2), APPROVAL_PAYLOAD_LIMIT_BYTES);
    const firstPath = await writeContract(output, "split_1.review-document.json", first);
    const secondPath = await writeContract(output, "split_2.review-document.json", second);
    const template = await approvalTemplateBytes();
    const expected = [{
      code: "APPROVAL_PAYLOAD_NEAR_LIMIT",
      path: "/batch/parts/1",
      payloadBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
      limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
    }];
    const rendered = await runRenderCommand([
      "--document", secondPath,
      "--document", firstPath,
    ], { approvalTemplateBytes: template });
    expect(rendered).toMatchObject({
      exitCode: 0,
      result: { status: "ok", mode: "batch", handoff: { kind: "batch", parts: [{ part: 1 }, { part: 2 }] }, warnings: expected },
    });
    const validated = await runValidateCommand([
      "batch",
      "--document", secondPath,
      "--document", firstPath,
    ], { approvalTemplateBytes: template });
    expect(validated).toMatchObject({
      exitCode: 0,
      result: { status: "ok", mode: "batch", handoff: { kind: "batch" }, warnings: expected },
    });
    const warnings = validated.result.status === "ok" && "warnings" in validated.result
      ? validated.result.warnings
      : undefined;
    expect(warnings).toHaveLength(1);
  });
});
