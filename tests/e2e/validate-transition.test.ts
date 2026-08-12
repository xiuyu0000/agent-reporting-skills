import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  serializeReviewPacketMarkdown,
  type ReviewDecision,
} from "../../src/protocol/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
  topicDerivedDocument,
} from "../unit/rounds-fixtures.js";
import {
  cleanupTemporaryDirectories,
  makeInputRoot,
  runValidate,
  snapshotTree,
  temporaryDirectory,
  writePrivateFile,
} from "../fixtures/validate/e2e.js";

afterAll(cleanupTemporaryDirectories);

describe("validate transition subprocess", () => {
  it("validates an apply candidate without modifying current, packet, candidate, or directories", async () => {
    const parent = await temporaryDirectory("validate-transition-apply");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const packet = makePacket(current, { decisions });
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const currentPath = join(root, "current.json");
    const packetPath = join(root, "packet.json");
    const candidatePath = join(root, "candidate.json");
    await writePrivateFile(currentPath, `${JSON.stringify(current)}\n`);
    await writePrivateFile(packetPath, `${JSON.stringify(packet)}\n`);
    await writePrivateFile(candidatePath, `${JSON.stringify(candidate)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", candidatePath,
    ]);

    expect(outcome.status, JSON.stringify(outcome.result)).toBe(0);
    expect(outcome.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "transition",
      mutated: false,
      summary: {
        status: "apply",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
        derivedTopicIds: [],
      },
    });
    expect(JSON.stringify(outcome.result)).not.toContain(candidate.document.summary);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("returns a real stale-round no-op before reading the missing candidate", async () => {
    const parent = await temporaryDirectory("validate-transition-noop");
    const root = await makeInputRoot(parent);
    const original = reviewFixture();
    const packet = makePacket(original, {
      decisions: [{ blockId: "B001", action: "PASS" }],
    });
    const current = candidateBase(original, packet);
    setContentVersion(original, current);
    const currentPath = join(root, "current.json");
    const packetPath = join(root, "stale-packet.json");
    const missingCandidate = join(root, "must-not-be-read.json");
    await writePrivateFile(currentPath, `${JSON.stringify(current)}\n`);
    await writePrivateFile(packetPath, `${JSON.stringify(packet)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", missingCandidate,
    ]);

    expect(outcome.status, JSON.stringify(outcome.result)).toBe(0);
    expect(outcome.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "transition",
      mutated: false,
      summary: {
        status: "noop",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
        derivedTopicIds: [],
      },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("parses historical Markdown unbound and does not read hostile candidate or derived paths on no-op", async () => {
    const parent = await temporaryDirectory("validate-transition-markdown-noop");
    const root = await makeInputRoot(parent);
    const original = reviewFixture();
    const packet = makePacket(original, {
      decisions: [{ blockId: "B001", action: "PASS" }],
    });
    const markdown = serializeReviewPacketMarkdown(packet, original);
    if (!markdown.ok) throw new Error("packet Markdown fixture drift");
    const current = candidateBase(original, packet);
    setContentVersion(original, current);
    const currentPath = join(root, "current.json");
    const packetPath = join(root, "historical-packet.md");
    const hostileCandidate = join(root, "candidate-symlink.json");
    const missingDerived = join(root, "missing-derived.json");
    await writePrivateFile(currentPath, `${JSON.stringify(current)}\n`);
    await writePrivateFile(packetPath, markdown.value);
    await symlink("missing-target.json", hostileCandidate);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", hostileCandidate,
      "--derived", `TOP-001=${root}`,
      "--derived", `TOP-002=${missingDerived}`,
    ]);

    expect(outcome.status, JSON.stringify(outcome.result)).toBe(0);
    expect(outcome.result).toEqual({
      status: "ok",
      phase: "validate",
      mode: "transition",
      mutated: false,
      summary: {
        status: "noop",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
        derivedTopicIds: [],
      },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("requires the bound readable-title snapshot for an unconsumed Markdown packet before candidate I/O", async () => {
    const parent = await temporaryDirectory("validate-transition-markdown-bound");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const packet = makePacket(current, {
      decisions: [{ blockId: "B001", action: "PASS" }],
    });
    const markdown = serializeReviewPacketMarkdown(packet, current);
    if (!markdown.ok) throw new Error("packet Markdown fixture drift");
    const title = current.blocks.find((block) => block.id === "B001")?.title;
    if (title === undefined) throw new Error("block fixture drift");
    const drifted = markdown.value.replace(
      `- \`B001\` ${JSON.stringify(title)}`,
      `- \`B001\` ${JSON.stringify("Different readable title")}`,
    );
    if (drifted === markdown.value) throw new Error("readable title fixture drift");
    const currentPath = join(root, "current.json");
    const packetPath = join(root, "active-packet.md");
    const missingCandidate = join(root, "must-not-be-read.json");
    await writePrivateFile(currentPath, `${JSON.stringify(current)}\n`);
    await writePrivateFile(packetPath, drifted);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition", "--current", currentPath, "--packet", packetPath,
      "--candidate", missingCandidate,
    ]);

    expect(outcome.status).toBe(3);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      errors: [expect.objectContaining({ code: "MARKDOWN_SUMMARY_MISMATCH" })],
    }));
    expect(JSON.stringify(outcome.result)).not.toContain("PATH_INVALID");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("validates one unconsumed Markdown packet against current before applying its candidate", async () => {
    const parent = await temporaryDirectory("validate-transition-markdown-apply");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const decisions: ReviewDecision[] = current.blocks.map((block) => ({
      blockId: block.id,
      action: "PASS",
    }));
    const packet = makePacket(current, { decisions });
    const markdown = serializeReviewPacketMarkdown(packet, current);
    if (!markdown.ok) throw new Error("packet Markdown fixture drift");
    const candidate = candidateBase(current, packet);
    candidate.document.status = "finalized";
    setContentVersion(current, candidate);
    const paths = {
      current: join(root, "current.json"),
      packet: join(root, "active-packet.md"),
      candidate: join(root, "candidate.json"),
    };
    await writePrivateFile(paths.current, `${JSON.stringify(current)}\n`);
    await writePrivateFile(paths.packet, markdown.value);
    await writePrivateFile(paths.candidate, `${JSON.stringify(candidate)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition", "--current", paths.current, "--packet", paths.packet,
      "--candidate", paths.candidate,
    ]);

    expect(outcome.status, JSON.stringify(outcome.result)).toBe(0);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "ok",
      mode: "transition",
      mutated: false,
      summary: {
        status: "apply",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest,
        derivedTopicIds: [],
      },
    }));
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("validates derived topic inputs and returns only sorted topic IDs", async () => {
    const parent = await temporaryDirectory("validate-transition-derived");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const topics = [
      { id: "TOP-002", title: "Second global topic" },
      { id: "TOP-001", title: "First global topic" },
    ];
    const packet = makePacket(current, { topics });
    const candidate = candidateBase(current, packet);
    const first = topicDerivedDocument(current, "A");
    const second = topicDerivedDocument(current, "B");
    candidate.lineage.topicMappings.push(
      {
        topicId: "TOP-002",
        derivedDocumentId: second.document.id,
        derivedDeliveryId: second.delivery.id,
      },
      {
        topicId: "TOP-001",
        derivedDocumentId: first.document.id,
        derivedDeliveryId: first.delivery.id,
      },
    );
    setContentVersion(current, candidate);
    const paths = {
      current: join(root, "current.json"),
      packet: join(root, "packet.json"),
      candidate: join(root, "candidate.json"),
      first: join(root, "first.json"),
      second: join(root, "second.json"),
    };
    await Promise.all([
      writePrivateFile(paths.current, `${JSON.stringify(current)}\n`),
      writePrivateFile(paths.packet, `${JSON.stringify(packet)}\n`),
      writePrivateFile(paths.candidate, `${JSON.stringify(candidate)}\n`),
      writePrivateFile(paths.first, `${JSON.stringify(first)}\n`),
      writePrivateFile(paths.second, `${JSON.stringify(second)}\n`),
    ]);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition",
      "--current", paths.current,
      "--packet", paths.packet,
      "--candidate", paths.candidate,
      "--derived", `TOP-002=${paths.second}`,
      "--derived", `TOP-001=${paths.first}`,
    ]);

    expect(outcome.status, JSON.stringify(outcome.result)).toBe(0);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "ok",
      mode: "transition",
      mutated: false,
      summary: expect.objectContaining({
        status: "apply",
        packetId: packet.packetId,
        derivedTopicIds: ["TOP-001", "TOP-002"],
      }),
    }));
    expect(JSON.stringify(outcome.result)).not.toContain(first.document.title);
    expect(JSON.stringify(outcome.result)).not.toContain(second.document.title);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("rejects an invalid candidate with no summary, no body echo, and no mutation", async () => {
    const parent = await temporaryDirectory("validate-transition-failure");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const privateSentinel = "candidate-private-secret-abcdefgh";
    const packet = makePacket(current, {
      decisions: [{ blockId: "B004", action: "HOLD", note: "Clarify the rule." }],
    });
    const candidate = candidateBase(current, packet);
    candidate.evidence.risks.push(["Author", "ization: Bearer ", privateSentinel].join(""));
    const paths = {
      current: join(root, "current.json"),
      packet: join(root, "packet.json"),
      candidate: join(root, "candidate.json"),
    };
    await writePrivateFile(paths.current, `${JSON.stringify(current)}\n`);
    await writePrivateFile(paths.packet, `${JSON.stringify(packet)}\n`);
    await writePrivateFile(paths.candidate, `${JSON.stringify(candidate)}\n`);
    const before = await snapshotTree(root);

    const outcome = await runValidate([
      "transition", "--current", paths.current, "--packet", paths.packet,
      "--candidate", paths.candidate,
    ]);

    expect(outcome.status).toBe(3);
    expect(outcome.result).toEqual(expect.objectContaining({
      status: "failed",
      phase: "validate",
      mutated: false,
      recoveryRequired: false,
      errors: [expect.objectContaining({ code: "PRIVACY_VIOLATION" })],
    }));
    expect(outcome.result).not.toHaveProperty("summary");
    expect(JSON.stringify(outcome.result)).not.toContain(privateSentinel);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("uses the dedicated incompatibility error for active legacy candidate and derived contracts", async () => {
    const parent = await temporaryDirectory("validate-transition-legacy-inputs");
    const root = await makeInputRoot(parent);
    const current = reviewFixture();
    const packet = makePacket(current, {
      topics: [{ id: "TOP-001", title: "Legacy derived topic" }],
    });
    const validCandidate = candidateBase(current, packet);
    const derivedDocument = topicDerivedDocument(current, "A");
    validCandidate.lineage.topicMappings.push({
      topicId: "TOP-001",
      derivedDocumentId: derivedDocument.document.id,
      derivedDeliveryId: derivedDocument.delivery.id,
    });
    setContentVersion(current, validCandidate);
    const paths = {
      current: join(root, "current.json"),
      packet: join(root, "packet.json"),
      candidate: join(root, "candidate.json"),
      derived: join(root, "derived.json"),
    };
    await writePrivateFile(paths.current, `${JSON.stringify(current)}\n`);
    await writePrivateFile(paths.packet, `${JSON.stringify(packet)}\n`);
    await writePrivateFile(paths.candidate, '{"schema_version":"dual-audience-report-contract-v1"}\n');
    await writePrivateFile(paths.derived, `${JSON.stringify(derivedDocument)}\n`);

    const legacyCandidate = await runValidate([
      "transition", "--current", paths.current, "--packet", paths.packet,
      "--candidate", paths.candidate, "--derived", `TOP-001=${paths.derived}`,
    ]);
    expect(legacyCandidate.status).toBe(3);
    expect(legacyCandidate.result).toEqual(expect.objectContaining({
      errors: [expect.objectContaining({ code: "LEGACY_CONTRACT_INCOMPATIBLE", path: "/format" })],
    }));

    await writePrivateFile(paths.candidate, `${JSON.stringify(validCandidate)}\n`);
    await writePrivateFile(paths.derived, '{"format":"dual-audience-report-contract-v1"}\n');
    const legacyDerived = await runValidate([
      "transition", "--current", paths.current, "--packet", paths.packet,
      "--candidate", paths.candidate, "--derived", `TOP-001=${paths.derived}`,
    ]);
    expect(legacyDerived.status).toBe(3);
    expect(legacyDerived.result).toEqual(expect.objectContaining({
      errors: [expect.objectContaining({ code: "LEGACY_CONTRACT_INCOMPATIBLE", path: "/format" })],
    }));
  });

  it("rejects duplicate/invalid derived mappings before filesystem access", async () => {
    const cases = [
      ["--derived", "bad"],
      ["--derived", "TOP-001=a", "--derived", "TOP-001=b"],
      ["--derived", "TOP-0=a"],
    ];
    for (const extra of cases) {
      const outcome = await runValidate([
        "transition", "--current", "a", "--packet", "b", "--candidate", "c", ...extra,
      ]);
      expect(outcome.status).toBe(2);
      expect(outcome.result).toEqual(expect.objectContaining({
        status: "failed",
        errors: [expect.objectContaining({ code: "ARGUMENT_INVALID" })],
      }));
    }
  });
});
