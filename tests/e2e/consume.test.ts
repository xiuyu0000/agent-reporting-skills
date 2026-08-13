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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsumeCommand, type ConsumeCommandOutcome } from "../../src/cli/consume.js";
import { runValidateCommand } from "../../src/cli/validate.js";
import {
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
  sha256Bytes,
  validateReviewDocument,
  type ReviewDecision,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";
import { approvalTemplateBytes } from "../fixtures/generator/helpers.js";
import {
  candidateBase,
  freezeBlocks,
  makePacket,
  reviewFixture,
  setContentVersion,
  topicDerivedDocument,
} from "../unit/rounds-fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-consume-e2e-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

interface DerivedCase {
  topicId: string;
  document: ReviewDocumentV1;
}

interface StagedCase {
  root: string;
  outputDir: string;
  currentPath: string;
  packetPath: string;
  candidatePath: string;
  current: ReviewDocumentV1;
  packet: ReviewPacketV1;
  candidate: ReviewDocumentV1;
  derived: readonly DerivedCase[];
  argv: string[];
}

async function stageCase(
  label: string,
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
  options: {
    derived?: readonly DerivedCase[];
    packetKind?: "json" | "markdown" | "legacy";
  } = {},
): Promise<StagedCase> {
  const root = await temporaryDirectory(label);
  const currentPath = join(root, "current.review-document.json");
  const packetPath = join(root, options.packetKind === "markdown" ? "packet.md" : "packet.json");
  const candidatePath = join(root, "candidate.review-document.json");
  const outputDir = join(root, "output");
  await writePrivate(currentPath, `${JSON.stringify(current)}\n`);
  await writePrivate(candidatePath, `${JSON.stringify(candidate)}\n`);
  let packetText: string;
  if (options.packetKind === "markdown") {
    const serialized = serializeReviewPacketMarkdown(packet, current);
    if (!serialized.ok) throw new Error("packet fixture did not serialize");
    packetText = serialized.value;
  } else if (options.packetKind === "legacy") {
    const legacy = structuredClone(packet) as unknown as Record<string, unknown>;
    delete legacy.format;
    delete legacy.reopened;
    packetText = `${JSON.stringify(legacy)}\n`;
  } else {
    const serialized = serializeReviewPacketJson(packet, current);
    if (!serialized.ok) throw new Error("packet fixture did not serialize");
    packetText = serialized.value;
  }
  await writePrivate(packetPath, packetText);
  const derived = options.derived ?? [];
  const argv = [
    "consume",
    "--current", currentPath,
    "--packet", packetPath,
    "--candidate", candidatePath,
    "--output-dir", outputDir,
  ];
  for (const [index, item] of derived.entries()) {
    const path = join(root, `derived-${index}.review-document.json`);
    await writePrivate(path, `${JSON.stringify(item.document)}\n`);
    argv.push("--derived", `${item.topicId}=${path}`);
  }
  if (options.packetKind === "legacy") argv.push("--legacy-profile", "prototype-v1");
  return {
    root,
    outputDir,
    currentPath,
    packetPath,
    candidatePath,
    current,
    packet,
    candidate,
    derived,
    argv,
  };
}

async function apply(staged: StagedCase, extraArguments: readonly string[] = []): Promise<ConsumeCommandOutcome> {
  const template = await approvalTemplateBytes();
  return runConsumeCommand([...staged.argv, ...extraArguments], {
    loadApprovalTemplateBytes: () => template,
  });
}

async function assertCommittedDelivery(
  outputDir: string,
  document: ReviewDocumentV1,
  expectedContractDigest?: string,
): Promise<void> {
  const contractPath = join(outputDir, `${document.delivery.baseName}.review-document.json`);
  const contractBytes = Uint8Array.from(await readFile(contractPath));
  if (expectedContractDigest !== undefined) {
    expect(sha256Bytes(contractBytes)).toBe(expectedContractDigest);
  }
  const parsed = JSON.parse(new TextDecoder().decode(contractBytes)) as unknown;
  const validated = validateReviewDocument(parsed);
  expect(validated.ok).toBe(true);
  if (validated.ok) {
    expect(validated.value.document.id).toBe(document.document.id);
    expect(validated.value.document.round).toBe(document.document.round);
  }
  expect((await lstat(contractPath)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(outputDir, document.delivery.outputs.agent))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(outputDir, document.delivery.outputs.approval))).mode & 0o777).toBe(0o600);
  const validation = await runValidateCommand(["delivery", "--document", contractPath], {
    approvalTemplateBytes: await approvalTemplateBytes(),
  });
  expect(validation).toMatchObject({
    exitCode: 0,
    result: {
      status: "ok",
      phase: "validate",
      mode: "delivery",
      mutated: false,
    },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("consume cross-round E2E", () => {
  it("A04_edit_incremental atomically commits only the validated next-round delivery", async () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B002", action: "EDIT", note: "Clarify the canonical rule." }],
    });
    const candidate = candidateBase(current, packet);
    candidate.blocks[1]!.summary = "Normalize every set-like array with the frozen canonical rule.";
    candidate.blocks[1]!.changed = { round: 2, summary: "Clarified the canonical rule." };
    candidate.lineage.impactAssessments.push({
      upstreamBlockId: "B002",
      changedAtRound: 2,
      affectedDownstreamIds: ["B003"],
      reason: "B003 depends transitively on the canonical-array behavior.",
      usedConservativeClosure: true,
    });
    setContentVersion(current, candidate);
    const staged = await stageCase("edit", current, packet, candidate);
    const currentBefore = await readFile(staged.currentPath);
    const candidateBefore = await readFile(staged.candidatePath);

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({
      exitCode: 0,
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
            contract: {
              relativePath: `${candidate.delivery.baseName}.review-document.json`,
              byteDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            },
            delivery: {
              kind: "delivery",
              documentId: candidate.document.id,
              contentVersion: 2,
              round: 2,
            },
          },
          derived: [],
        },
      },
    });
    expect(Object.hasOwn(outcome.result, "summary")).toBe(false);
    expect(await readFile(staged.currentPath)).toEqual(currentBefore);
    expect(await readFile(staged.candidatePath)).toEqual(candidateBefore);
    if (outcome.result.status === "ok" && outcome.result.mode === "apply") {
      await assertCommittedDelivery(
        staged.outputDir,
        candidate,
        outcome.result.handoff.candidate.contract.byteDigest,
      );
    }
    expect((await readdir(staged.outputDir)).sort()).toEqual([
      ".review-txn",
      `${candidate.delivery.baseName}.review-document.json`,
      candidate.delivery.outputs.agent,
      candidate.delivery.outputs.approval,
    ].sort());
  });

  it("A05_hold_answer commits the answered active block with incremented content version", async () => {
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "HOLD", note: "Which legacy actions remain accepted?" }],
    });
    const candidate = candidateBase(current, packet);
    candidate.blocks[3]!.body = [{
      type: "paragraph",
      content: [{ type: "text", text: "Only TRIM and EXPAND migrate into EDIT." }],
    }];
    candidate.blocks[3]!.tier = "T1";
    candidate.blocks[3]!.changed = { round: 2, summary: "Answered and re-triaged legacy actions." };
    setContentVersion(current, candidate);
    const staged = await stageCase("hold", current, packet, candidate);

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "apply",
        handoff: { candidate: { delivery: { contentVersion: 2, round: 2 } } },
      },
    });
    await assertCommittedDelivery(staged.outputDir, candidate);
  });

  it("A06_topic_derivation binds Markdown once and commits candidate plus one derived delivery", async () => {
    const current = reviewFixture();
    const topic = {
      id: "TOP-001",
      title: "Explore a migration assistant",
      sourceBlockId: "B004",
    };
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "TOPIC", topicId: topic.id }],
      topics: [topic],
    });
    const candidate = candidateBase(current, packet);
    const derivedDocument = topicDerivedDocument(current, "A");
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derivedDocument.document.id,
      derivedDeliveryId: derivedDocument.delivery.id,
    });
    setContentVersion(current, candidate);
    const staged = await stageCase("topic", current, packet, candidate, {
      packetKind: "markdown",
      derived: [{ topicId: topic.id, document: derivedDocument }],
    });

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "apply",
        handoff: {
          candidate: { delivery: { documentId: candidate.document.id } },
          derived: [{
            topicId: topic.id,
            contract: { relativePath: `${derivedDocument.delivery.baseName}.review-document.json` },
            delivery: { kind: "delivery", documentId: derivedDocument.document.id },
          }],
        },
      },
    });
    await assertCommittedDelivery(staged.outputDir, candidate);
    await assertCommittedDelivery(staged.outputDir, derivedDocument);
    expect((await readdir(staged.outputDir)).filter((name) => name !== ".review-txn")).toHaveLength(6);
  });

  it("A07_finalize_unchanged publishes an unchanged-body finalized JSON round", async () => {
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const packet = makePacket(current, { decisions });
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const staged = await stageCase("finalize", current, packet, candidate);

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "apply",
        handoff: { candidate: { delivery: { contentVersion: 1, round: 2 } } },
      },
    });
    await assertCommittedDelivery(staged.outputDir, candidate);
  });

  it("A17_reapprove_reopened retains approval history and commits the re-finalized round", async () => {
    const current = reviewFixture();
    freezeBlocks(current, current.blocks.map((block) => block.id));
    current.document.round = 2;
    current.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
    const packet = makePacket(current, {
      reopened: ["B004"],
      decisions: [{ blockId: "B004", action: "PASS" }],
    });
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const staged = await stageCase("reapprove", current, packet, candidate);

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({ exitCode: 0, result: { status: "ok", mode: "apply" } });
    const committed = JSON.parse(await readFile(
      join(staged.outputDir, `${candidate.delivery.baseName}.review-document.json`),
      "utf8",
    )) as ReviewDocumentV1;
    expect(committed.approvals.history).toHaveLength(5);
    expect(committed.approvals.history.at(-1)).toMatchObject({ blockId: "B004", approvedRound: 2 });
    await assertCommittedDelivery(staged.outputDir, candidate);
  });

  it("A21_global_topic_idempotent applies one legacy-derived topic then replays raw bytes as noop", async () => {
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const topic = { id: "TOP-001", title: "Independent global follow-up" };
    const packet = makePacket(current, { decisions, topics: [topic] });
    const candidate = candidateBase(current, packet);
    const derivedDocument = topicDerivedDocument(current, "B");
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derivedDocument.document.id,
      derivedDeliveryId: derivedDocument.delivery.id,
    });
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const staged = await stageCase("global-topic", current, packet, candidate, {
      packetKind: "legacy",
      derived: [{ topicId: topic.id, document: derivedDocument }],
    });

    const applied = await apply(staged);
    expect(applied).toMatchObject({ exitCode: 0, result: { status: "ok", mode: "apply" } });
    const nextCurrent = join(staged.outputDir, `${candidate.delivery.baseName}.review-document.json`);
    const replayOutput = join(staged.root, "replay-output");
    let loaderGetterCalls = 0;
    const runtime = {} as Record<string, unknown>;
    Object.defineProperty(runtime, "loadApprovalTemplateBytes", {
      enumerable: true,
      get() {
        loaderGetterCalls += 1;
        throw new Error("legacy replay must not inspect loader");
      },
    });
    const replay = await runConsumeCommand([
      "consume",
      "--current", nextCurrent,
      "--packet", staged.packetPath,
      "--candidate", join(staged.root, "missing-candidate.json"),
      "--output-dir", replayOutput,
      "--legacy-profile", "prototype-v1",
    ], runtime as never);
    expect(replay).toEqual({
      exitCode: 0,
      result: {
        status: "ok",
        phase: "consume",
        mode: "noop",
        mutated: false,
        summary: {
          packetId: packet.packetId,
          semanticDigest: packet.semanticDigest,
        },
      },
    });
    expect(loaderGetterCalls).toBe(0);
    await expect(lstat(replayOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sorts derived handoffs and requires the strictest derived publication confirmation before loader access", async () => {
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const topics = [
      { id: "TOP-002", title: "Second global follow-up" },
      { id: "TOP-001", title: "First global follow-up" },
    ];
    const packet = makePacket(current, { decisions, topics });
    const candidate = candidateBase(current, packet);
    const first = topicDerivedDocument(current, "C");
    const second = topicDerivedDocument(current, "D");
    second.delivery.repositoryStatus = "public-approved";
    candidate.lineage.topicMappings.push(
      {
        topicId: "TOP-001",
        derivedDocumentId: first.document.id,
        derivedDeliveryId: first.delivery.id,
      },
      {
        topicId: "TOP-002",
        derivedDocumentId: second.document.id,
        derivedDeliveryId: second.delivery.id,
      },
    );
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const staged = await stageCase("derived-order", current, packet, candidate, {
      derived: [
        { topicId: "TOP-002", document: second },
        { topicId: "TOP-001", document: first },
      ],
    });
    let loaderCalls = 0;
    const template = await approvalTemplateBytes();
    const denied = await runConsumeCommand(staged.argv, {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        return template;
      },
    });
    expect(denied).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({
          code: "ARGUMENT_INVALID",
          path: "/arguments/confirm-output-scope",
        })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(staged.outputDir)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await runConsumeCommand([
      ...staged.argv,
      "--confirm-output-scope", "public",
    ], {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        return template;
      },
    });
    expect(applied).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        mode: "apply",
        handoff: {
          derived: [
            { topicId: "TOP-001", delivery: { documentId: first.document.id } },
            { topicId: "TOP-002", delivery: { documentId: second.document.id } },
          ],
        },
      },
    });
    expect(loaderCalls).toBe(1);
    await assertCommittedDelivery(staged.outputDir, candidate);
    await assertCommittedDelivery(staged.outputDir, first);
    await assertCommittedDelivery(staged.outputDir, second);
  }, 15_000);

  it("rejects splitGroup metadata on a normalized derived document before loader or output", async () => {
    const current = reviewFixture();
    const topic = { id: "TOP-001", title: "Split-derived follow-up" };
    const packet = makePacket(current, { topics: [topic] });
    const candidate = candidateBase(current, packet);
    const derived = topicDerivedDocument(current, "E");
    derived.delivery.splitGroup = {
      groupId: "RSG-EEEEEEEEEEEEEEEEEEEE",
      part: 1,
      total: 2,
      reason: "Derived consume outputs cannot masquerade as a split batch.",
    };
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derived.document.id,
      derivedDeliveryId: derived.delivery.id,
    });
    setContentVersion(current, candidate);
    const staged = await stageCase("derived-split", current, packet, candidate, {
      derived: [{ topicId: topic.id, document: derived }],
    });
    let loaderCalls = 0;
    const outcome = await runConsumeCommand(staged.argv, {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        throw new Error("split derived must stop before loader");
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 5,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({
          code: "SPLIT_GROUP_INVALID",
          path: "/derived/0/document/delivery/splitGroup",
        })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(staged.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects portable collisions across candidate contracts and derived artifacts before loader", async () => {
    const current = reviewFixture();
    const topic = { id: "TOP-001", title: "Portable collision follow-up" };
    const packet = makePacket(current, { topics: [topic] });
    const candidate = candidateBase(current, packet);
    const derived = topicDerivedDocument(current, "F");
    derived.delivery.outputs.agent = `${candidate.delivery.baseName}.review-document.json`.toUpperCase();
    candidate.lineage.topicMappings.push({
      topicId: topic.id,
      derivedDocumentId: derived.document.id,
      derivedDeliveryId: derived.delivery.id,
    });
    setContentVersion(current, candidate);
    const staged = await stageCase("cross-portable", current, packet, candidate, {
      derived: [{ topicId: topic.id, document: derived }],
    });
    let loaderCalls = 0;
    const outcome = await runConsumeCommand(staged.argv, {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        throw new Error("portable set must stop before loader");
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 3,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({ code: "PORTABLE_PATH_COLLISION" })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(staged.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a real pre-existing contract target without creating any partial artifacts", async () => {
    const current = reviewFixture();
    const packet = makePacket(current);
    const candidate = candidateBase(current, packet);
    setContentVersion(current, candidate);
    const staged = await stageCase("nonfresh", current, packet, candidate);
    await mkdir(staged.outputDir, { mode: 0o700 });
    await chmod(staged.outputDir, 0o700);
    const businessFile = join(
      staged.outputDir,
      `${candidate.delivery.baseName}.review-document.json`,
    );
    await writePrivate(businessFile, "owned by user\n");
    const before = await readFile(businessFile);

    const outcome = await apply(staged);
    expect(outcome).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        phase: "consume",
        mutated: false,
        recoveryRequired: false,
      },
    });
    expect(Object.hasOwn(outcome.result, "handoff")).toBe(false);
    expect(await readFile(businessFile)).toEqual(before);
    expect(await readdir(staged.outputDir)).toEqual([
      `${candidate.delivery.baseName}.review-document.json`,
    ]);
  });
});
