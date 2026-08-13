import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsumeCommand } from "../../src/cli/consume.js";
import {
  serializeReviewPacketJson,
  serializeReviewPacketMarkdown,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../src/protocol/index.js";
import {
  candidateBase,
  makePacket,
  reviewFixture,
  setContentVersion,
} from "./rounds-fixtures.js";
import { approvalTemplateBytes } from "../fixtures/generator/helpers.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `dar-consume-${label}-`)));
  await chmod(path, 0o700);
  temporaryDirectories.push(path);
  return path;
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function baseArguments(root: string): string[] {
  return [
    "consume",
    "--current", join(root, "current.review-document.json"),
    "--packet", join(root, "packet.json"),
    "--candidate", join(root, "missing-candidate.review-document.json"),
    "--derived", `TOP-001=${join(root, "missing-derived.review-document.json")}`,
    "--output-dir", join(root, "fresh-output"),
  ];
}

async function writeNoopCase(
  root: string,
  kind: "json" | "markdown" | "legacy",
): Promise<{ current: ReviewDocumentV1; packet: ReviewPacketV1; argv: string[] }> {
  const current = reviewFixture();
  const packet = makePacket(current);
  let packetText: string;
  if (kind === "markdown") {
    const serialized = serializeReviewPacketMarkdown(packet, current);
    if (!serialized.ok) throw new Error("packet fixture did not serialize");
    packetText = serialized.value;
  } else if (kind === "json") {
    const serialized = serializeReviewPacketJson(packet, current);
    if (!serialized.ok) throw new Error("packet fixture did not serialize");
    packetText = serialized.value;
  } else {
    const legacy = structuredClone(packet) as unknown as Record<string, unknown>;
    delete legacy.format;
    delete legacy.reopened;
    packetText = `${JSON.stringify(legacy)}\n`;
  }
  current.lineage.consumedPackets.push({
    packetId: packet.packetId,
    semanticDigest: packet.semanticDigest,
  });
  await writePrivate(join(root, "current.review-document.json"), `${JSON.stringify(current)}\n`);
  await writePrivate(join(root, "packet.json"), packetText);
  const argv = baseArguments(root);
  if (kind === "legacy") argv.push("--legacy-profile", "prototype-v1");
  return { current, packet, argv };
}

async function writeApplyCase(root: string): Promise<{
  current: ReviewDocumentV1;
  packet: ReviewPacketV1;
  candidate: ReviewDocumentV1;
  argv: string[];
}> {
  const current = reviewFixture();
  const packet = makePacket(current);
  const candidate = candidateBase(current, packet);
  setContentVersion(current, candidate);
  const currentPath = join(root, "current.review-document.json");
  const packetPath = join(root, "packet.json");
  const candidatePath = join(root, "candidate.review-document.json");
  await writePrivate(currentPath, `${JSON.stringify(current)}\n`);
  await writePrivate(packetPath, `${JSON.stringify(packet)}\n`);
  await writePrivate(candidatePath, `${JSON.stringify(candidate)}\n`);
  return {
    current,
    packet,
    candidate,
    argv: [
      "consume",
      "--current", currentPath,
      "--packet", packetPath,
      "--candidate", candidatePath,
      "--output-dir", join(root, "fresh-output"),
    ],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    rm(path, { recursive: true, force: true })));
});

describe("consume argument and replay closure", () => {
  it("rejects malformed grammar before reading inputs, output scope, or runtime", async () => {
    const root = await temporaryDirectory("arguments");
    const valid = baseArguments(root).filter((value, index, values) =>
      value !== "--derived" && values[index - 1] !== "--derived");
    const malformed: unknown[] = [
      [],
      ["consume", "--current"],
      [...valid, "--current", "again"],
      [...valid, "--unknown", "value"],
      [...valid, "--derived", "TOP-000=path"],
      [...valid, "--derived", "TOP-001=first", "--derived", "TOP-001=second"],
      [...valid, "--legacy-profile", "future-v2"],
      [...valid, "--confirm-document-id", "RD-11111111111111111111"],
      [...valid, "--legacy-profile", "prototype-v1", "--confirm-round", "1"],
      [...valid, "--legacy-profile", "prototype-v1", "--confirm-document-id", "id",
        "--confirm-content-version", "9007199254740992", "--confirm-round", "1"],
      [...valid, "--confirm-output-scope", "private"],
      [...valid.slice(0, -2)],
      [...valid.slice(0, 2), "", ...valid.slice(3)],
    ];
    const sparse = new Array<string>(2);
    malformed.push(sparse, new Proxy([...valid], {}));
    const accessor = [...valid];
    let argvGetterCalls = 0;
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        argvGetterCalls += 1;
        return "consume";
      },
    });
    malformed.push(accessor);
    const extra = [...valid] as string[] & { hidden?: string };
    Object.defineProperty(extra, "hidden", { value: "not argv", enumerable: false });
    malformed.push(extra);

    let runtimeGetterCalls = 0;
    const runtime = {} as Record<string, unknown>;
    Object.defineProperty(runtime, "loadApprovalTemplateBytes", {
      enumerable: true,
      get() {
        runtimeGetterCalls += 1;
        throw new Error("runtime must not be inspected");
      },
    });
    for (const argv of malformed) {
      const outcome = await runConsumeCommand(argv as readonly string[], runtime as never);
      expect(outcome).toMatchObject({
        exitCode: 2,
        result: {
          status: "failed",
          phase: "consume",
          mutated: false,
          recoveryRequired: false,
          errors: [expect.objectContaining({ code: "ARGUMENT_INVALID" })],
        },
      });
      expect(Object.hasOwn(outcome.result, "summary")).toBe(false);
      expect(Object.hasOwn(outcome.result, "handoff")).toBe(false);
    }
    expect(argvGetterCalls).toBe(0);
    expect(runtimeGetterCalls).toBe(0);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const kind of ["json", "markdown", "legacy"] as const) {
    it(`returns an exact ${kind} ledger noop without candidate, derived, output, auth, or loader access`, async () => {
      const root = await temporaryDirectory(`noop-${kind}`);
      const fixture = await writeNoopCase(root, kind);
      fixture.argv.push("--confirm-output-scope", "public");
      let loaderGetterCalls = 0;
      const runtime = {} as Record<string, unknown>;
      Object.defineProperty(runtime, "loadApprovalTemplateBytes", {
        enumerable: true,
        get() {
          loaderGetterCalls += 1;
          throw new Error("noop must not inspect loader");
        },
      });
      expect(await runConsumeCommand(fixture.argv, runtime as never)).toEqual({
        exitCode: 0,
        result: {
          status: "ok",
          phase: "consume",
          mode: "noop",
          mutated: false,
          summary: {
            packetId: fixture.packet.packetId,
            semanticDigest: fixture.packet.semanticDigest,
          },
        },
      });
      expect(loaderGetterCalls).toBe(0);
      await expect(lstat(join(root, "missing-candidate.review-document.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(root, "missing-derived.review-document.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("fails a replay digest conflict before candidate, output, or loader access", async () => {
    const root = await temporaryDirectory("conflict");
    const current = reviewFixture();
    const packet = makePacket(current);
    const digestPrefix = packet.semanticDigest.slice(0, "sha256:".length + 20);
    const digestTail = packet.semanticDigest.endsWith("f".repeat(44))
      ? "e".repeat(44)
      : "f".repeat(44);
    current.lineage.consumedPackets.push({
      packetId: packet.packetId,
      semanticDigest: `${digestPrefix}${digestTail}`,
    });
    await writePrivate(join(root, "current.review-document.json"), `${JSON.stringify(current)}\n`);
    await writePrivate(join(root, "packet.json"), `${JSON.stringify(packet)}\n`);
    let loaderCalls = 0;
    const outcome = await runConsumeCommand(baseArguments(root), {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        throw new Error("must not load");
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 3,
      result: {
        status: "failed",
        mutated: false,
        errors: [expect.objectContaining({ code: "PACKET_REPLAY_CONFLICT" })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("consume loader seam", () => {
  it("preserves a synchronous loader throw as the runner rejection", async () => {
    const root = await temporaryDirectory("loader-sync");
    const fixture = await writeApplyCase(root);
    const marker = new Error("assembly-owned synchronous loader failure");
    await expect(runConsumeCommand(fixture.argv, {
      loadApprovalTemplateBytes: () => {
        throw marker;
      },
    })).rejects.toBe(marker);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a rejected loader Promise as the runner rejection", async () => {
    const root = await temporaryDirectory("loader-async");
    const fixture = await writeApplyCase(root);
    const marker = new Error("assembly-owned asynchronous loader failure");
    await expect(runConsumeCommand(fixture.argv, {
      loadApprovalTemplateBytes: () => Promise.reject(marker),
    })).rejects.toBe(marker);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes hostile non-Promise loader returns without assimilating thenables", async () => {
    const root = await temporaryDirectory("loader-hostile-return");
    const fixture = await writeApplyCase(root);
    const marker = new Error("hostile return must stay inside the business result");
    let thenGetterCalls = 0;
    let fakeThenCalls = 0;
    const throwingThenable = {} as Record<string, unknown>;
    Object.defineProperty(throwingThenable, "then", {
      get() {
        thenGetterCalls += 1;
        throw marker;
      },
    });
    const fakeThenable = {
      then() {
        fakeThenCalls += 1;
        throw marker;
      },
    };
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() {
        throw marker;
      },
    });

    for (const value of [throwingThenable, fakeThenable, hostileProxy, [0xff]]) {
      const outcome = await runConsumeCommand(fixture.argv, {
        loadApprovalTemplateBytes: () => value,
      } as never);
      expect(outcome).toMatchObject({
        exitCode: 2,
        result: {
          status: "failed",
          phase: "consume",
          mutated: false,
          recoveryRequired: false,
          errors: [expect.objectContaining({ code: "INPUT_UTF8_INVALID" })],
        },
      });
    }
    expect(thenGetterCalls).toBe(0);
    expect(fakeThenCalls).toBe(0);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes missing, accessor, and malformed runtime loaders without invoking getters", async () => {
    const root = await temporaryDirectory("loader-invalid");
    const fixture = await writeApplyCase(root);
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "loadApprovalTemplateBytes", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    for (const runtime of [undefined, {}, { loadApprovalTemplateBytes: "bad" }, accessor, new Proxy({}, {})]) {
      const outcome = runtime === undefined
        ? await runConsumeCommand(fixture.argv)
        : await runConsumeCommand(fixture.argv, runtime as never);
      expect(outcome).toMatchObject({
        exitCode: 2,
        result: {
          status: "failed",
          phase: "consume",
          mutated: false,
          errors: [expect.objectContaining({
            code: "ARGUMENT_INVALID",
            path: "/runtime/loadApprovalTemplateBytes",
          })],
        },
      });
    }
    expect(getterCalls).toBe(0);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("turns successfully returned non-UTF-8 template bytes into an ordinary consume failure", async () => {
    const root = await temporaryDirectory("loader-invalid-bytes");
    const fixture = await writeApplyCase(root);
    let calls = 0;
    const outcome = await runConsumeCommand(fixture.argv, {
      loadApprovalTemplateBytes: () => {
        calls += 1;
        return Uint8Array.of(0xff);
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 2,
      result: {
        status: "failed",
        phase: "consume",
        mutated: false,
        recoveryRequired: false,
        errors: [expect.objectContaining({ code: "INPUT_UTF8_INVALID" })],
      },
    });
    expect(calls).toBe(1);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the complete delivery validator on UTF-8 template drift before output mutation", async () => {
    const root = await temporaryDirectory("loader-template-drift");
    const fixture = await writeApplyCase(root);
    let calls = 0;
    const outcome = await runConsumeCommand(fixture.argv, {
      loadApprovalTemplateBytes: () => {
        calls += 1;
        return new TextEncoder().encode("<html>valid UTF-8 but not the frozen template</html>");
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 3,
      result: {
        status: "failed",
        phase: "consume",
        mutated: false,
        recoveryRequired: false,
      },
    });
    expect(calls).toBe(1);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces authorization and portable target collisions before touching the loader", async () => {
    const authRoot = await temporaryDirectory("auth-before-loader");
    const auth = await writeApplyCase(authRoot);
    auth.candidate.delivery.repositoryStatus = "public-approved";
    await writePrivate(auth.argv[6]!, `${JSON.stringify(auth.candidate)}\n`);

    const collisionRoot = await temporaryDirectory("portable-before-loader");
    const collision = await writeApplyCase(collisionRoot);
    collision.candidate.delivery.outputs.agent = collision.candidate.delivery.baseName.toUpperCase();
    await writePrivate(collision.argv[6]!, `${JSON.stringify(collision.candidate)}\n`);

    let loaderCalls = 0;
    const runtime = {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        throw new Error("preflight must stop first");
      },
    };
    const authOutcome = await runConsumeCommand(auth.argv, runtime);
    expect(authOutcome).toMatchObject({
      exitCode: 2,
      result: { status: "failed", errors: [expect.objectContaining({ code: "ARGUMENT_INVALID" })] },
    });
    const collisionOutcome = await runConsumeCommand(collision.argv, runtime);
    expect(collisionOutcome).toMatchObject({
      exitCode: 3,
      result: {
        status: "failed",
        errors: [expect.objectContaining({ code: "PORTABLE_PATH_COLLISION" })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(join(authRoot, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(collisionRoot, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects candidate splitGroup metadata before authorization, target output, or loader access", async () => {
    const root = await temporaryDirectory("split-before-loader");
    const fixture = await writeApplyCase(root);
    fixture.candidate.delivery.splitGroup = {
      groupId: "RSG-CCCCCCCCCCCCCCCCCCCC",
      part: 1,
      total: 2,
      reason: "Consume candidates are not a split batch.",
    };
    fixture.candidate.delivery.repositoryStatus = "public-approved";
    await writePrivate(fixture.argv[6]!, `${JSON.stringify(fixture.candidate)}\n`);
    let loaderCalls = 0;
    const outcome = await runConsumeCommand(fixture.argv, {
      loadApprovalTemplateBytes: () => {
        loaderCalls += 1;
        throw new Error("split gate must stop first");
      },
    });
    expect(outcome).toMatchObject({
      exitCode: 5,
      result: {
        status: "failed",
        phase: "consume",
        mutated: false,
        errors: [expect.objectContaining({
          code: "SPLIT_GROUP_INVALID",
          path: "/candidate/delivery/splitGroup",
        })],
      },
    });
    expect(loaderCalls).toBe(0);
    await expect(lstat(join(root, "fresh-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purely binds a relative output directory before a side-effecting loader changes cwd", async () => {
    const root = await temporaryDirectory("bound-output");
    const elsewhere = await temporaryDirectory("bound-output-elsewhere");
    const fixture = await writeApplyCase(root);
    fixture.argv.splice(-1, 1, "relative-output");
    const template = await approvalTemplateBytes();
    const priorCwd = process.cwd();
    process.chdir(root);
    let outcome;
    try {
      outcome = await runConsumeCommand(fixture.argv, {
        loadApprovalTemplateBytes: async () => {
          process.chdir(elsewhere);
          return template;
        },
      });
    } finally {
      process.chdir(priorCwd);
    }
    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "ok",
        phase: "consume",
        mode: "apply",
        mutated: true,
      },
    });
    expect(await lstat(join(root, "relative-output"))).toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(join(elsewhere, "relative-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
