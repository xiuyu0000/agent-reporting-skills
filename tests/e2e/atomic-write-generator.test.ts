import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRenderCommand } from "../../src/cli/render.js";
import { runValidateCommand } from "../../src/cli/validate.js";
import { GENERATOR_VERSION, generateArtifactBytes } from "../../src/generators/index.js";
import { reviewDigest, type ReviewDocumentV1 } from "../../src/protocol/index.js";
import {
  createAgentArtifactByteVerifier,
  createApprovalArtifactByteVerifier,
} from "../../src/cli/validate.js";
import {
  resolveOutputRoot,
  validateRelativeTarget,
} from "../../src/cli/io/index.js";
import {
  nativeFileSystemAdapter,
  type PrivateFileSystemAdapter,
} from "../../src/cli/io/fsync.js";
import { commitFileTransactionWithAdapter } from "../../src/cli/io/transaction.js";
import {
  approvalTemplateBytes,
  createPrivateDirectory,
  reviewDocumentFixture,
  writePrivate,
} from "../fixtures/generator/helpers.js";

const GENERATOR_HEAVY_TEST_TIMEOUT_MS = 15_000;

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-gen-atomic-")));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function checkpointAdapter(point: string): PrivateFileSystemAdapter {
  let armed = true;
  return {
    ...nativeFileSystemAdapter,
    checkpoint: async (observed) => {
      if (armed && observed === point) {
        armed = false;
        throw new Error("injected generator transaction failure");
      }
    },
  };
}

function laterDocument(oldDocument: ReviewDocumentV1): ReviewDocumentV1 {
  const current = structuredClone(oldDocument);
  current.document.title = "Protocol replacement: round 2";
  current.document.summary = "Review the regenerated protocol artifacts.";
  current.document.contentVersion = 2;
  current.document.round = 2;
  current.lineage.previousReviewDigest = reviewDigest(oldDocument);
  return current;
}

describe("generator atomic write integration", () => {
  it("preflights every target so an existing Approval never leaves a half-created Agent", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    const approval = join(output, document.delivery.outputs.approval);
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    await writePrivate(approval, "user-owned approval\n");
    const before = await readFile(approval);
    const result = await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: await approvalTemplateBytes(),
    });
    expect(result).toMatchObject({
      exitCode: 3,
      result: { status: "failed", mutated: false, errors: [expect.objectContaining({ code: "TARGET_EXISTS" })] },
    });
    expect(await readFile(approval)).toEqual(before);
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before filesystem mutation when the frozen Approval template is invalid", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const result = await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: new TextEncoder().encode("<html>invalid</html>"),
    });
    expect(result).toMatchObject({ exitCode: 3, result: { status: "failed", mutated: false } });
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, document.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "stage-written:0",
    "target-installed:0",
    "target-installed:1",
  ])("rolls back both generated artifacts after an injected %s fault", async (point) => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    const template = await approvalTemplateBytes();
    const generated = generateArtifactBytes({ document, approvalTemplateBytes: template });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const agentTarget = validateRelativeTarget(document.delivery.outputs.agent);
    const approvalTarget = validateRelativeTarget(document.delivery.outputs.approval);
    const root = await resolveOutputRoot({
      outputDir: output,
      creation: "must-exist",
      freshness: "allow-business-entries",
    });
    expect(agentTarget.ok && approvalTarget.ok && root.ok).toBe(true);
    if (!agentTarget.ok || !approvalTarget.ok || !root.ok) return;
    const result = await commitFileTransactionWithAdapter({
      root: root.value,
      generatorVersion: GENERATOR_VERSION,
      targets: [
        {
          target: agentTarget.value,
          bytes: generated.value.agent,
          disposition: "create",
          verifyStaged: createAgentArtifactByteVerifier({
            document,
            generatorVersion: GENERATOR_VERSION,
          }),
        },
        {
          target: approvalTarget.value,
          bytes: generated.value.approval,
          disposition: "create",
          verifyStaged: createApprovalArtifactByteVerifier({
            document,
            generatorVersion: GENERATOR_VERSION,
            templateBytes: template,
          }),
        },
      ],
    }, checkpointAdapter(point));
    expect(result).toMatchObject({ ok: false, mutated: false, recoveryRequired: false });
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(output, document.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  });

  it("requires current tracked authorization and does not trust repositoryStatus alone", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    document.delivery.repositoryStatus = "tracked-approved";
    const contract = join(output, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const denied = await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: await approvalTemplateBytes(),
    });
    expect(denied).toMatchObject({ exitCode: 2, result: { status: "failed", mutated: false } });
    await expect(lstat(join(output, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    const allowed = await runRenderCommand([
      "--document", contract,
      "--confirm-output-scope", "tracked",
    ], { approvalTemplateBytes: await approvalTemplateBytes() });
    expect(allowed.exitCode).toBe(0);
  });

  it("replaces one matching prior-round artifact pair and validates the new snapshot", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const oldDocument = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    const template = await approvalTemplateBytes();
    await writePrivate(contract, `${JSON.stringify(oldDocument)}\n`);
    expect((await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: template,
    })).exitCode).toBe(0);
    const agentPath = join(output, oldDocument.delivery.outputs.agent);
    const approvalPath = join(output, oldDocument.delivery.outputs.approval);
    const oldAgent = await readFile(agentPath);
    const oldApproval = await readFile(approvalPath);

    const currentDocument = laterDocument(oldDocument);
    const currentContractBytes = new TextEncoder().encode(`${JSON.stringify(currentDocument)}\n`);
    await writePrivate(contract, currentContractBytes);
    const result = await runRenderCommand([
      "--document", contract,
      "--replace-generated",
    ], { approvalTemplateBytes: template });
    expect(result).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mutated: true,
        handoff: {
          documentId: currentDocument.document.id,
          contentVersion: 2,
          round: 2,
        },
      },
    });
    expect(await readFile(agentPath)).not.toEqual(oldAgent);
    expect(await readFile(approvalPath)).not.toEqual(oldApproval);
    expect(Uint8Array.from(await readFile(contract))).toEqual(currentContractBytes);
    expect((await runValidateCommand(["delivery", "--document", contract], {
      approvalTemplateBytes: template,
    })).exitCode).toBe(0);
  }, GENERATOR_HEAVY_TEST_TIMEOUT_MS);

  it("rejects a tampered old pair before transaction mutation", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const oldDocument = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    const template = await approvalTemplateBytes();
    await writePrivate(contract, `${JSON.stringify(oldDocument)}\n`);
    expect((await runRenderCommand(["--document", contract], {
      approvalTemplateBytes: template,
    })).exitCode).toBe(0);
    const agentPath = join(output, oldDocument.delivery.outputs.agent);
    const approvalPath = join(output, oldDocument.delivery.outputs.approval);
    const tamperedAgent = new TextEncoder().encode(
      (await readFile(agentPath, "utf8")).replace(
        oldDocument.document.id,
        "RD-99999999999999999999",
      ),
    );
    await writePrivate(agentPath, tamperedAgent);
    const approvalBefore = await readFile(approvalPath);
    await writePrivate(contract, `${JSON.stringify(laterDocument(oldDocument))}\n`);
    const result = await runRenderCommand([
      "--document", contract,
      "--replace-generated",
    ], { approvalTemplateBytes: template });
    expect(result).toMatchObject({ exitCode: 3, result: { status: "failed", mutated: false } });
    expect(Uint8Array.from(await readFile(agentPath))).toEqual(tamperedAgent);
    expect(await readFile(approvalPath)).toEqual(approvalBefore);
    expect(await readdir(join(output, ".review-txn"))).toEqual([]);
  }, GENERATOR_HEAVY_TEST_TIMEOUT_MS);

  it("requires both old artifacts before resolving the mutable output root", async () => {
    const parent = await temporaryDirectory();
    const output = await createPrivateDirectory(parent, "delivery");
    const document = await reviewDocumentFixture();
    const contract = join(output, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const result = await runRenderCommand([
      "--document", contract,
      "--replace-generated",
    ], { approvalTemplateBytes: await approvalTemplateBytes() });
    expect(result).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({ code: "PATH_INVALID" })],
      },
    });
    expect(await readdir(output)).toEqual(["review-document.json"]);
  });
});
