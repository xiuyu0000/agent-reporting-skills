import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  serializeReviewPacketMarkdown,
  type ReviewDecision,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "../unit/rounds-fixtures.js";

const CLI = resolve("skills/deliver-dual-audience-report/scripts/review-delivery.mjs");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dar-full-loop-")));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function runDistributed(arguments_: readonly string[], cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  result: Record<string, unknown>;
} {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [CLI, ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = child.stdout;
  expect(child.stderr).toBe("");
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  return {
    status: child.status,
    stdout,
    stderr: child.stderr,
    result: JSON.parse(stdout) as Record<string, unknown>,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("distributed candidate CLI full-loop integration", () => {
  it("proves init local-only default and one-shot publication authorization", async () => {
    const root = await temporaryDirectory();
    const common = [
      "--base-name", "authorization_plan",
      "--title", "Authorization plan",
      "--language", "en",
      "--ui-locale", "en",
      "--as-of", "2026-08-13T10:00:00+08:00",
    ] as const;

    const localOutput = join(root, "local");
    const local = runDistributed([
      "init", "--output-dir", localOutput, ...common,
    ], root);
    expect(local).toMatchObject({
      status: 0,
      result: { status: "ok", phase: "init", mutated: true },
    });
    const localDocument = JSON.parse(await readFile(
      join(localOutput, "review-document.json"),
      "utf8",
    )) as ReviewDocumentV1;
    expect(localDocument.delivery.repositoryStatus).toBe("local-only");

    const deniedOutput = join(root, "denied-public");
    const denied = runDistributed([
      "init", "--output-dir", deniedOutput, ...common,
      "--repository-status", "public-approved",
      "--confirm-output-scope", "tracked",
    ], root);
    expect(denied).toMatchObject({
      status: 2,
      result: {
        status: "failed",
        phase: "init",
        mutated: false,
        errors: [expect.objectContaining({
          code: "ARGUMENT_INVALID",
          path: "/arguments",
        })],
      },
    });
    await expect(lstat(deniedOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const trackedOutput = join(root, "tracked");
    const tracked = runDistributed([
      "init", "--output-dir", trackedOutput, ...common,
      "--repository-status", "tracked-approved",
      "--confirm-output-scope", "tracked",
    ], root);
    expect(tracked).toMatchObject({
      status: 0,
      result: { status: "ok", phase: "init", mutated: true },
    });
    const trackedDocument = JSON.parse(await readFile(
      join(trackedOutput, "review-document.json"),
      "utf8",
    )) as ReviewDocumentV1;
    expect(trackedDocument.delivery.repositoryStatus).toBe("tracked-approved");
  });

  it("runs render, validate, Markdown consume, and next-round validation through the distributed candidate CLI", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input");
    await mkdir(input, { mode: 0o700 });
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const packet = makePacket(current, { decisions });
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const packetMarkdown = serializeReviewPacketMarkdown(packet, current);
    if (!packetMarkdown.ok) throw new Error("full-loop packet fixture did not serialize");

    const currentPath = join(input, "current.review-document.json");
    const packetPath = join(input, "packet.md");
    const candidatePath = join(input, "candidate.review-document.json");
    const output = join(root, "next");
    await writePrivate(currentPath, `${JSON.stringify(current)}\n`);
    await writePrivate(packetPath, packetMarkdown.value);
    await writePrivate(candidatePath, `${JSON.stringify(candidate)}\n`);

    const rendered = runDistributed(["render", "--document", currentPath], root);
    expect(rendered).toMatchObject({
      status: 0,
      stderr: "",
      result: { status: "ok", phase: "render", mode: "delivery", mutated: true },
    });
    const validatedCurrent = runDistributed(["validate", "delivery", "--document", currentPath], root);
    expect(validatedCurrent).toMatchObject({
      status: 0,
      result: {
        status: "ok",
        phase: "validate",
        mode: "delivery",
        mutated: false,
        handoff: {
          kind: "delivery",
          documentId: current.document.id,
          contentVersion: 1,
          round: 1,
          asOf: current.document.asOf,
        },
      },
    });

    const consumed = runDistributed([
      "consume",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", candidatePath,
      "--output-dir", output,
    ], root);
    expect(consumed).toMatchObject({
      status: 0,
      result: {
        status: "ok",
        phase: "consume",
        mode: "apply",
        mutated: true,
        handoff: {
          kind: "consume",
          packetId: packet.packetId,
          semanticDigest: packet.semanticDigest,
          candidate: {
            contract: { relativePath: `${candidate.delivery.baseName}.review-document.json` },
            delivery: {
              kind: "delivery",
              documentId: candidate.document.id,
              contentVersion: candidate.document.contentVersion,
              round: 2,
              asOf: candidate.document.asOf,
            },
          },
          derived: [],
        },
      },
    });
    const committedContract = join(output, `${candidate.delivery.baseName}.review-document.json`);
    const validatedCandidate = runDistributed([
      "validate", "delivery", "--document", committedContract,
    ], root);
    expect(validatedCandidate).toMatchObject({
      status: 0,
      result: {
        status: "ok",
        phase: "validate",
        mode: "delivery",
        mutated: false,
        handoff: {
          documentId: candidate.document.id,
          contentVersion: candidate.document.contentVersion,
          round: 2,
          asOf: candidate.document.asOf,
        },
      },
    });
  });

  it("A15_artifact_drift rejects a changed generated artifact without a handoff", async () => {
    const root = await temporaryDirectory();
    const document = JSON.parse(await readFile(
      resolve("tests/fixtures/protocol/review-document.json"),
      "utf8",
    )) as ReviewDocumentV1;
    const contract = join(root, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);

    const rendered = runDistributed(["render", "--document", contract], root);
    expect(rendered).toMatchObject({
      status: 0,
      stderr: "",
      result: { status: "ok", phase: "render", mode: "delivery", mutated: true },
    });
    const approval = join(root, document.delivery.outputs.approval);
    const original = await readFile(approval, "utf8");
    expect(original).toContain("</body>");
    await writePrivate(approval, original.replace(
      "</body>",
      "\n</body>",
    ));
    const agent = join(root, document.delivery.outputs.agent);
    const beforeValidation = {
      agent: await readFile(agent),
      approval: await readFile(approval),
    };
    expect(beforeValidation.approval).not.toEqual(Buffer.from(original));

    const validated = runDistributed(["validate", "delivery", "--document", contract], root);
    expect(validated.status).toBe(5);
    expect(validated.stderr).toBe("");
    expect(validated.result).toMatchObject({
      status: "failed",
      phase: "validate",
      mutated: false,
      recoveryRequired: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "ARTIFACT_DRIFT" })]),
    });
    expect(validated.result).not.toHaveProperty("handoff");
    expect(validated.result).not.toHaveProperty("summary");
    expect(await readFile(agent)).toEqual(beforeValidation.agent);
    expect(await readFile(approval)).toEqual(beforeValidation.approval);
  });

  it("requires current authorization for tracked output and accepts the matching confirmation", async () => {
    const root = await temporaryDirectory();
    const document = reviewFixture();
    document.delivery.repositoryStatus = "tracked-approved";
    const contract = join(root, "review-document.json");
    await writePrivate(contract, `${JSON.stringify(document)}\n`);
    const contractBefore = await readFile(contract);

    const denied = runDistributed(["render", "--document", contract], root);
    expect(denied).toMatchObject({
      status: 2,
      result: {
        status: "failed",
        phase: "render",
        mutated: false,
        errors: [expect.objectContaining({
          code: "ARGUMENT_INVALID",
          path: "/arguments/confirm-output-scope",
        })],
      },
    });
    expect(await readFile(contract)).toEqual(contractBefore);
    await expect(lstat(join(root, document.delivery.outputs.agent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, document.delivery.outputs.approval))).rejects.toMatchObject({ code: "ENOENT" });

    const allowed = runDistributed([
      "render",
      "--document", contract,
      "--confirm-output-scope", "tracked",
    ], root);
    expect(allowed).toMatchObject({
      status: 0,
      result: { status: "ok", phase: "render", mutated: true },
    });
    expect(await readFile(contract)).toEqual(contractBefore);
  });

  it("rejects portable output collisions before any distributed candidate render mutation", async () => {
    const root = await temporaryDirectory();
    const first = reviewFixture();
    const second = reviewFixture();
    first.document.id = `RD-${"A".repeat(20)}`;
    first.delivery.id = `RDL-${"A".repeat(20)}`;
    first.delivery.baseName = "loop_split_1";
    first.delivery.outputs = {
      agent: "loop_split_1_AGENT.md",
      approval: "loop_split_1_APPROVAL.html",
    };
    first.delivery.splitGroup = {
      groupId: `RSG-${"C".repeat(20)}`,
      part: 1,
      total: 2,
      reason: "Independent decision boundaries.",
    };
    second.document.id = `RD-${"B".repeat(20)}`;
    second.delivery.id = `RDL-${"B".repeat(20)}`;
    second.delivery.baseName = "loop_split_2";
    second.delivery.outputs = {
      agent: first.delivery.outputs.agent.toUpperCase(),
      approval: "loop_split_2_APPROVAL.html",
    };
    second.delivery.splitGroup = {
      ...first.delivery.splitGroup,
      part: 2,
    };
    const firstPath = join(root, "split_1.review-document.json");
    const secondPath = join(root, "split_2.review-document.json");
    await writePrivate(firstPath, `${JSON.stringify(first)}\n`);
    await writePrivate(secondPath, `${JSON.stringify(second)}\n`);
    const before = {
      first: await readFile(firstPath),
      second: await readFile(secondPath),
    };

    const rejected = runDistributed([
      "render", "--document", firstPath, "--document", secondPath,
    ], root);
    expect(rejected).toMatchObject({
      status: 3,
      result: {
        status: "failed",
        phase: "render",
        mutated: false,
        errors: [expect.objectContaining({ code: "PORTABLE_PATH_COLLISION" })],
      },
    });
    expect(await readFile(firstPath)).toEqual(before.first);
    expect(await readFile(secondPath)).toEqual(before.second);
    expect((await readdir(root)).sort()).toEqual([
      "split_1.review-document.json",
      "split_2.review-document.json",
    ]);
  });
});
