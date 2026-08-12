import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendUsageMetrics,
  runRecordUsageCommand,
  summarizeUsageMetrics,
  usageStorageNames,
  type ContentFreeMetrics,
} from "../../src/cli/record-usage.js";

const temporaryDirectories: string[] = [];
// Two 24-writer batches cover immediate and held-lock contention. This test-only
// budget absorbs coverage instrumentation without changing the production 3.4s
// contender bound or weakening the 24/24 integrity assertions below.
const CONCURRENT_APPEND_TEST_TIMEOUT_MS = 15_000;

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(resolve(".test-temporary-unit-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function baseMetrics(overrides: Partial<ContentFreeMetrics> = {}): ContentFreeMetrics {
  return {
    eligible: true,
    triggered: true,
    correct: true,
    validation: "passed",
    result: "success",
    corrections: 0,
    interruptions: 0,
    ...overrides,
  };
}

function pilotMetrics(sequence: number, overrides: Partial<ContentFreeMetrics> = {}): ContentFreeMetrics {
  return baseMetrics({
    caseKey: `opaque_case_key_${String(sequence).padStart(4, "0")}`,
    sampleSequence: sequence,
    t0T1DecidedCount: 4,
    t0T1ActiveReviewMs: 20_000,
    totalActiveReviewMs: 900_000,
    sourceRevisionRounds: 1,
    closedLoop: true,
    burdenScore: -1,
    ...overrides,
  });
}

async function storedLines(stateDirectory: string): Promise<Array<Record<string, unknown>>> {
  const payload = await readFile(join(stateDirectory, usageStorageNames.records), "utf8");
  return payload.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("content-free usage append", () => {
  it("stores only allowlisted metrics behind a local HMAC identity with private permissions", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const secretCaseKey = "opaque_case_key_9001";
    const result = await appendUsageMetrics(pilotMetrics(1, { caseKey: secretCaseKey }), {
      stateDirectory,
      randomBytes: (size) => Buffer.alloc(size, 0x2a),
    });

    expect(result).toEqual({ status: "recorded" });
    const [record] = await storedLines(stateDirectory);
    expect(record).toMatchObject({
      format: "review-usage/1",
      sampleSequence: 1,
    });
    expect(record).not.toHaveProperty("occurredAt");
    expect(record?.caseId).toMatch(/^CASE-[A-F0-9]{32}$/u);
    expect(JSON.stringify(record)).not.toContain(secretCaseKey);
    expect(record).not.toHaveProperty("caseKey");
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDirectory, usageStorageNames.key))).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateDirectory, usageStorageNames.records))).mode & 0o777).toBe(0o600);
  });

  it("uses a machine-local key so the same opaque seed is not a portable identifier", async () => {
    const first = await makeTemporaryDirectory();
    const second = await makeTemporaryDirectory();
    const input = pilotMetrics(1, { caseKey: "opaque_case_key_local" });
    expect(await appendUsageMetrics(input, { stateDirectory: first, randomBytes: (size) => Buffer.alloc(size, 0x11) })).toEqual({ status: "recorded" });
    expect(await appendUsageMetrics(input, { stateDirectory: second, randomBytes: (size) => Buffer.alloc(size, 0x22) })).toEqual({ status: "recorded" });
    const [firstRecord] = await storedLines(first);
    const [secondRecord] = await storedLines(second);
    expect(firstRecord?.caseId).not.toBe(secondRecord?.caseId);
  });

  it("rejects forbidden or partial fields without echoing input and without touching storage", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "unused-state");
    const sensitive = ["", "Users", "private", "project", "report.md"].join("/");
    const result = await appendUsageMetrics({ ...baseMetrics(), path: sensitive }, { stateDirectory });
    expect(result).toEqual({ status: "not-recorded", reason: "invalid-input" });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await appendUsageMetrics({ ...pilotMetrics(1), burdenScore: undefined }, { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "invalid-input",
    });
    for (const invalid of [
      null,
      [],
      { ...baseMetrics(), validation: "invalid" },
      { ...baseMetrics(), result: "invalid" },
      { ...baseMetrics(), corrections: -1 },
      { ...baseMetrics(), interruptions: 1001 },
      { ...baseMetrics(), caseKey: "short" },
      { ...pilotMetrics(1), t0T1ActiveReviewMs: 30_000, totalActiveReviewMs: 20_000 },
      { ...pilotMetrics(1), sourceRevisionRounds: 101 },
      { ...pilotMetrics(1), burdenScore: 3 },
      { ...pilotMetrics(1), closedLoop: "yes" },
    ]) {
      expect(await appendUsageMetrics(invalid, { stateDirectory })).toEqual({ status: "not-recorded", reason: "invalid-input" });
    }
  });

  it("serializes concurrent appends as intact private JSONL records", async () => {
    for (const lockHoldMs of [0, 40]) {
      const stateDirectory = await makeTemporaryDirectory();
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) => appendUsageMetrics(
          baseMetrics({ caseKey: `concurrent_case_${String(index).padStart(4, "0")}` }),
          {
            stateDirectory,
            randomBytes: (size) => Buffer.alloc(size, index + 1),
            ...(lockHoldMs === 0
              ? {}
              : { boundaryHooks: { afterLockAcquired: async () => delay(lockHoldMs) } }),
          },
        )),
      );
      expect(results).toHaveLength(24);
      expect(results.every((result) => result.status === "recorded")).toBe(true);
      const records = await storedLines(stateDirectory);
      expect(records).toHaveLength(24);
      expect(new Set(records.map((record) => record.caseId)).size).toBe(24);
      expect((await readdir(stateDirectory)).filter((entry) =>
        entry.startsWith(".usage-") || entry === usageStorageNames.appendIntent,
      )).toEqual([]);
    }
  }, CONCURRENT_APPEND_TEST_TIMEOUT_MS);

  it("returns a sanitized non-blocking result when storage is unavailable", async () => {
    const root = await makeTemporaryDirectory();
    const unusable = join(root, "private-project-name");
    await writeFile(unusable, "not a directory", { mode: 0o600 });
    const result = await appendUsageMetrics(pilotMetrics(1), { stateDirectory: unusable });
    expect(result).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect(JSON.stringify(result)).not.toContain(unusable);
  });

  it("treats short record writes and directory sync failures as non-blocking storage failures", async () => {
    const root = await makeTemporaryDirectory();
    const shortWriteState = join(root, "short-write-state");
    expect(await appendUsageMetrics(baseMetrics(), {
      stateDirectory: shortWriteState,
      fileOps: {
        write: async () => 0,
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });

    const syncFailureState = join(root, "sync-failure-state");
    expect(await appendUsageMetrics(baseMetrics(), {
      stateDirectory: syncFailureState,
      fileOps: {
        syncDirectory: async () => {
          throw new Error("private path must not escape");
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
  });

  it("does not report success when the opened record inode is moved outside state during write", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    const recordPath = join(stateDirectory, usageStorageNames.records);
    const escapedRecord = join(root, "escaped-usage.jsonl");
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "record_guard_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    let writes = 0;
    const displaced = await appendUsageMetrics(baseMetrics({ caseKey: "record_guard_case_0002" }), {
      stateDirectory,
      fileOps: {
        write: async (handle, data) => {
          writes += 1;
          if (writes === 2) {
            await rename(recordPath, escapedRecord);
            await writeFile(recordPath, "", { mode: 0o600 });
          }
          return (await handle.write(data, 0, data.length, null)).bytesWritten;
        },
      },
    });
    expect(displaced).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect((await readFile(escapedRecord, "utf8")).trim().split("\n")).toHaveLength(1);

    await rm(recordPath);
    await rename(escapedRecord, recordPath);
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "record_guard_case_0003" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await storedLines(stateDirectory)).toHaveLength(2);
  });

  it("does not report success when another writer adds bytes to the same record inode", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "same_inode_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    let writes = 0;
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "same_inode_case_0002" }), {
      stateDirectory,
      fileOps: {
        write: async (handle, data) => {
          writes += 1;
          if (writes === 2) await handle.write(Buffer.from("x\n"), 0, 2, null);
          return (await handle.write(data, 0, data.length, null)).bytesWritten;
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect(await storedLines(stateDirectory)).toHaveLength(1);
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "same_inode_case_0003" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await storedLines(stateDirectory)).toHaveLength(2);
  });

  it("refuses an append that would exceed the private log capacity", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "capacity_seed_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    const recordPath = join(stateDirectory, usageStorageNames.records);
    const seed = await readFile(recordPath);
    const maximumBytes = 64 * 1024 * 1024;
    const repeats = Math.floor((maximumBytes - 64) / seed.length);
    const nearLimit = Buffer.alloc(repeats * seed.length);
    for (let offset = 0; offset < nearLimit.length; offset += seed.length) seed.copy(nearLimit, offset);
    await writeFile(recordPath, nearLimit, { mode: 0o600 });
    const before = (await stat(recordPath)).size;
    expect(before).toBeLessThanOrEqual(maximumBytes);
    expect(maximumBytes - before).toBeLessThan(seed.length);

    expect(await appendUsageMetrics(baseMetrics({ caseKey: "capacity_overflow_case_0002" }), { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });
    expect((await stat(recordPath)).size).toBe(before);
  });

  it("cleans a short intent staging write so a retry and summarize can succeed", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    expect(await appendUsageMetrics(pilotMetrics(1), {
      stateDirectory,
      fileOps: { write: async () => 0 },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    await expect(stat(join(stateDirectory, usageStorageNames.appendIntent))).rejects.toMatchObject({ code: "ENOENT" });
    await expect((await import("node:fs/promises")).readdir(stateDirectory).then((entries) => entries.some((entry) => entry.includes("append-intent") && entry.endsWith(".tmp")))).resolves.toBe(false);

    expect(await appendUsageMetrics(pilotMetrics(1), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "summarized", sampleCount: 1, conclusion: "尚未验证" });
  });

  it("recovers after a crash immediately after atomic intent publication without duplicating a record", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    let directorySyncs = 0;
    expect(await appendUsageMetrics(pilotMetrics(1), {
      stateDirectory,
      fileOps: {
        syncDirectory: async () => {
          directorySyncs += 1;
          if (directorySyncs === 2) throw new Error("simulated crash after intent publication");
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    const publishedIntent = await stat(join(stateDirectory, usageStorageNames.appendIntent));
    expect(publishedIntent.nlink).toBe(2);
    expect(publishedIntent.mode & 0o777).toBe(0o600);

    expect(await appendUsageMetrics(pilotMetrics(1), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await storedLines(stateDirectory)).toHaveLength(1);
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({
      status: "summarized",
      sampleCount: 1,
      conclusion: "尚未验证",
    });
  });

  it("refuses symlinked record storage rather than following it", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    const external = join(root, "external.jsonl");
    await appendUsageMetrics(baseMetrics(), { stateDirectory });
    await rm(join(stateDirectory, usageStorageNames.records));
    await writeFile(external, "do-not-touch\n");
    await import("node:fs/promises").then(async ({ symlink }) => symlink(external, join(stateDirectory, usageStorageNames.records)));
    const result = await appendUsageMetrics(baseMetrics(), { stateDirectory });
    expect(result).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect(await readFile(external, "utf8")).toBe("do-not-touch\n");
  });

  it("rejects a symlink in any parent component and a permissive record file", async () => {
    const root = await makeTemporaryDirectory();
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory: join(linkedParent, "state") })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });

    const stateDirectory = join(root, "private-state");
    await appendUsageMetrics(baseMetrics(), { stateDirectory });
    await chmod(join(stateDirectory, usageStorageNames.records), 0o644);
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });
  });

  it("recovers a truncated key from its private backup and rejects unsafe key aliases", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    const input = pilotMetrics(1, { caseKey: "stable_case_key_0001" });
    await appendUsageMetrics(input, { stateDirectory });
    const [before] = await storedLines(stateDirectory);
    await writeFile(join(stateDirectory, usageStorageNames.key), Buffer.alloc(3), { mode: 0o600 });
    expect(await appendUsageMetrics(input, { stateDirectory })).toEqual({ status: "recorded" });
    const records = await storedLines(stateDirectory);
    expect(records.at(-1)?.caseId).toBe(before?.caseId);

    await rm(join(stateDirectory, usageStorageNames.key));
    await symlink(join(stateDirectory, usageStorageNames.keyBackup), join(stateDirectory, usageStorageNames.key));
    expect(await appendUsageMetrics(input, { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });
  });

  it("repairs either missing private key copy and rejects inconsistent copies", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    await appendUsageMetrics(baseMetrics(), { stateDirectory });
    await rm(join(stateDirectory, usageStorageNames.keyBackup));
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory })).toEqual({ status: "recorded" });
    await rm(join(stateDirectory, usageStorageNames.key));
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory })).toEqual({ status: "recorded" });
    await writeFile(join(stateDirectory, usageStorageNames.keyBackup), Buffer.alloc(32, 0x55), { mode: 0o600 });
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
  });

  it("rejects input symlinks and detects input replacement through its opened handle", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "target.json");
    const input = join(root, "input.json");
    await writeFile(target, JSON.stringify(baseMetrics()));
    await symlink(target, input);
    expect(await runRecordUsageCommand(["append", "--input", input], { stateDirectory: join(root, "state") })).toEqual({
      status: "not-recorded",
      reason: "invalid-input",
    });

    await rm(input);
    await writeFile(input, JSON.stringify(baseMetrics()));
    const original = join(root, "opened-original.json");
    expect(await runRecordUsageCommand(["append", "--input", input], {
      stateDirectory: join(root, "state"),
      boundaryHooks: {
        afterInputOpen: async () => {
          await rename(input, original);
          await writeFile(input, JSON.stringify(baseMetrics({ result: "failure" })));
        },
      },
    })).toEqual({ status: "not-recorded", reason: "invalid-input" });
  });

  it("rejects an input parent symlink and a parent directory replaced during read", async () => {
    const root = await makeTemporaryDirectory();
    const realParent = join(root, "real-input-parent");
    const linkedParent = join(root, "linked-input-parent");
    await mkdir(realParent);
    await writeFile(join(realParent, "metrics.json"), JSON.stringify(baseMetrics()));
    await symlink(realParent, linkedParent);
    expect(await runRecordUsageCommand(["append", "--input", join(linkedParent, "metrics.json")], { stateDirectory: join(root, "state") })).toEqual({
      status: "not-recorded",
      reason: "invalid-input",
    });

    const stableParent = join(root, "stable-input-parent");
    const displacedParent = join(root, "displaced-input-parent");
    const inputPath = join(stableParent, "metrics.json");
    await mkdir(stableParent);
    await writeFile(inputPath, JSON.stringify(baseMetrics()));
    expect(await runRecordUsageCommand(["append", "--input", inputPath], {
      stateDirectory: join(root, "state"),
      boundaryHooks: {
        afterInputOpen: async () => {
          await rename(stableParent, displacedParent);
          await mkdir(stableParent);
          await writeFile(inputPath, JSON.stringify(baseMetrics({ result: "failure" })));
        },
      },
    })).toEqual({ status: "not-recorded", reason: "invalid-input" });
  });

  it("detects key replacement after O_NOFOLLOW open", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    await appendUsageMetrics(baseMetrics(), { stateDirectory });
    const keyPath = join(stateDirectory, usageStorageNames.key);
    const oldKeyPath = join(stateDirectory, "opened-key.old");
    let replaced = false;
    expect(await appendUsageMetrics(baseMetrics(), {
      stateDirectory,
      boundaryHooks: {
        afterKeyOpen: async () => {
          if (replaced) return;
          replaced = true;
          await rename(keyPath, oldKeyPath);
          await writeFile(keyPath, Buffer.alloc(32, 0x7f), { mode: 0o600 });
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
  });

  it("recovers only an evidenced partial JSON tail", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(baseMetrics({ caseKey: "partial_tail_case_0001" }), { stateDirectory });
    const recordPath = join(stateDirectory, usageStorageNames.records);
    const previousSize = (await stat(recordPath)).size;
    const completeRecord = Buffer.from(`${JSON.stringify({
      format: "review-usage/1",
      caseId: `CASE-${"A".repeat(32)}`,
      eligible: true,
      triggered: true,
      correct: true,
      validation: "passed",
      result: "success",
      corrections: 0,
      interruptions: 0,
    })}\n`);
    const key = await readFile(join(stateDirectory, usageStorageNames.key));
    await writeFile(join(stateDirectory, usageStorageNames.appendIntent), `${JSON.stringify({
      format: usageStorageNames.appendIntentFormat,
      owner: "c".repeat(32),
      previousSize,
      recordBytes: completeRecord.length,
      recordHmac: createHmac("sha256", key).update(completeRecord).digest("hex"),
    })}\n`, { mode: 0o600 });
    await writeFile(recordPath, completeRecord.subarray(0, 31), { flag: "a" });
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "partial_tail_case_0002" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await storedLines(stateDirectory)).toHaveLength(2);
  });

  it("finishes a fully written append intent without duplicating the record", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(baseMetrics({ caseKey: "complete_intent_case_0001" }), { stateDirectory });
    const recordPath = join(stateDirectory, usageStorageNames.records);
    const previousSize = (await stat(recordPath)).size;
    const key = await readFile(join(stateDirectory, usageStorageNames.key));
    const completeRecord = Buffer.from(`${JSON.stringify({
      format: "review-usage/1",
      caseId: `CASE-${"E".repeat(32)}`,
      eligible: true,
      triggered: true,
      correct: true,
      validation: "passed",
      result: "success",
      corrections: 0,
      interruptions: 0,
    })}\n`);
    await writeFile(join(stateDirectory, usageStorageNames.appendIntent), `${JSON.stringify({
      format: usageStorageNames.appendIntentFormat,
      owner: "e".repeat(32),
      previousSize,
      recordBytes: completeRecord.length,
      recordHmac: createHmac("sha256", key).update(completeRecord).digest("hex"),
    })}\n`, { mode: 0o600 });
    await writeFile(recordPath, completeRecord, { flag: "a" });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "summarized" });
    expect(await storedLines(stateDirectory)).toHaveLength(2);
    await expect(stat(join(stateDirectory, usageStorageNames.appendIntent))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let one lock owner release another owner or recover a live owner", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const lockDirectory = join(stateDirectory, usageStorageNames.lockDirectory);
    await mkdir(lockDirectory, { mode: 0o700 });
    const owner = "a".repeat(32);
    const manifest = {
      format: usageStorageNames.lockFormat,
      owner,
      pid: process.pid,
      createdAtMs: 0,
      heartbeatAtMs: 0,
    };
    await writeFile(join(lockDirectory, usageStorageNames.lockManifest), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const startedAt = performance.now();
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory, clock: () => 60_000 })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });
    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(JSON.parse(await readFile(join(lockDirectory, usageStorageNames.lockManifest), "utf8"))).toEqual(manifest);
  }, 7_000);

  it("recovers a stale dead owner by an identity-checked claim", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const lockDirectory = join(stateDirectory, usageStorageNames.lockDirectory);
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, usageStorageNames.lockManifest), `${JSON.stringify({
      format: usageStorageNames.lockFormat,
      owner: "b".repeat(32),
      pid: 2_147_483_647,
      createdAtMs: 0,
      heartbeatAtMs: 0,
    })}\n`, { mode: 0o600 });
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory, clock: () => 60_000 })).toEqual({ status: "recorded" });
    await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically publishes over an empty canonical lock left by a pre-manifest crash", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const lockDirectory = join(stateDirectory, usageStorageNames.lockDirectory);
    await mkdir(lockDirectory, { mode: 0o700 });
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "empty_lock_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "empty_lock_case_0002" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect(await storedLines(stateDirectory)).toHaveLength(2);
    await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement lock during an ABA-style owner change", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const replacementOwner = "d".repeat(32);
    const replacementManifest = {
      format: usageStorageNames.lockFormat,
      owner: replacementOwner,
      pid: process.pid,
      createdAtMs: 1,
      heartbeatAtMs: 1,
    };
    expect(await appendUsageMetrics(baseMetrics(), {
      stateDirectory,
      boundaryHooks: {
        afterLockAcquired: async (lockDirectory) => {
          const displaced = `${lockDirectory}.displaced`;
          await rename(lockDirectory, displaced);
          await mkdir(lockDirectory, { mode: 0o700 });
          await writeFile(join(lockDirectory, usageStorageNames.lockManifest), `${JSON.stringify(replacementManifest)}\n`, { mode: 0o600 });
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect(JSON.parse(await readFile(join(stateDirectory, usageStorageNames.lockDirectory, usageStorageNames.lockManifest), "utf8"))).toEqual(replacementManifest);
  });

  it("rejects state-directory replacement and restores private mode after a lock-boundary mutation", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "state_guard_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    const displaced = join(root, "displaced-state");
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "state_guard_case_0002" }), {
      stateDirectory,
      boundaryHooks: {
        afterLockAcquired: async (lockDirectory) => {
          const manifest = await readFile(join(lockDirectory, usageStorageNames.lockManifest));
          await rename(stateDirectory, displaced);
          await mkdir(stateDirectory, { mode: 0o700 });
          await mkdir(join(stateDirectory, usageStorageNames.lockDirectory), { mode: 0o700 });
          await writeFile(join(stateDirectory, usageStorageNames.lockDirectory, usageStorageNames.lockManifest), manifest, { mode: 0o600 });
        },
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    await expect(stat(join(stateDirectory, usageStorageNames.records))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await storedLines(displaced)).toHaveLength(1);

    await rm(stateDirectory, { recursive: true });
    await rm(join(displaced, usageStorageNames.lockDirectory), { recursive: true });
    await rename(displaced, stateDirectory);
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "state_guard_case_0003" }), {
      stateDirectory,
      boundaryHooks: {
        afterLockAcquired: async () => chmod(stateDirectory, 0o755),
      },
    })).toEqual({ status: "not-recorded", reason: "storage-unavailable" });
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect(await storedLines(stateDirectory)).toHaveLength(1);
  });

  it("converges an initially permissive state root before recording", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await chmod(stateDirectory, 0o755);
    expect(await appendUsageMetrics(baseMetrics({ caseKey: "permission_converge_case_0001" }), { stateDirectory })).toEqual({ status: "recorded" });
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
  });
});

describe("real-use summary", () => {
  it("keeps fewer than three compliant cases at 尚未验证 and never exposes case IDs", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(pilotMetrics(1), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(2), { stateDirectory });
    const summary = await summarizeUsageMetrics(3, 5, { stateDirectory });
    expect(summary).toMatchObject({ status: "summarized", conclusion: "尚未验证", sampleCount: 2 });
    expect(JSON.stringify(summary)).not.toMatch(/CASE-[A-F0-9]{32}/u);
  });

  it("computes the fixed aggregate and per-case thresholds for three to five cases", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(pilotMetrics(1, { burdenScore: -2 }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(2, { t0T1ActiveReviewMs: 36_000, burdenScore: -1 }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(3, { burdenScore: 0 }), { stateDirectory });
    const summary = await summarizeUsageMetrics(3, 5, { stateDirectory });
    expect(summary).toMatchObject({
      status: "summarized",
      conclusion: "通过",
      sampleCount: 3,
      aggregate: {
        t0T1DecidedCount: 12,
        t0T1ActiveReviewMs: 76_000,
        t0T1AverageDecisionMs: 76_000 / 12,
        totalActiveReviewMs: 2_700_000,
        medianBurdenScore: -1,
      },
    });
    if (summary.status === "summarized") {
      expect(summary.cases.map((sample) => sample.sampleSequence)).toEqual([1, 2, 3]);
      expect(Object.keys(summary.cases[0] ?? {}).sort()).toEqual([
        "burdenLowerThanOld",
        "revisionRoundsAtMost2",
        "sampleSequence",
        "t0T1Under10Seconds",
        "totalUnder30Minutes",
      ]);
      expect(summary.cases[0]).not.toHaveProperty("t0T1AverageDecisionMs");
      expect(summary.cases[2]?.burdenLowerThanOld).toBe(false);
    }
  });

  it("reports 未达标 for measured cohorts that cross a fixed guardrail", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await appendUsageMetrics(pilotMetrics(sequence, { totalActiveReviewMs: 1_800_001 }), { stateDirectory });
    }
    const summary = await summarizeUsageMetrics(3, 5, { stateDirectory });
    expect(summary).toMatchObject({ status: "summarized", conclusion: "未达标", sampleCount: 3 });
  });

  it("deduplicates repeat records by local case and rejects ambiguous sample sequencing", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(pilotMetrics(1), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(1, { corrections: 1 }), { stateDirectory });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ sampleCount: 1, conclusion: "尚未验证" });

    await appendUsageMetrics(pilotMetrics(1, { caseKey: "different_case_key_0001" }), { stateDirectory });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ sampleCount: 0, conclusion: "尚未验证" });
  });

  it("counts one real case once even when it has several increasing pilot sequences", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const caseKey = "one_case_many_sequences_0001";
    await appendUsageMetrics(pilotMetrics(1, { caseKey }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(2, { caseKey }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(3, { caseKey }), { stateDirectory });
    const summary = await summarizeUsageMetrics(3, 5, { stateDirectory });
    expect(summary).toMatchObject({ status: "summarized", sampleCount: 1, conclusion: "尚未验证" });
    if (summary.status === "summarized") expect(summary.cases.map((sample) => sample.sampleSequence)).toEqual([3]);
  });

  it("fails closed when a case pilot sequence moves backwards", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const caseKey = "backwards_case_sequence_0001";
    await appendUsageMetrics(pilotMetrics(3, { caseKey }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(2, { caseKey }), { stateDirectory });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({
      status: "summarized",
      sampleCount: 0,
      conclusion: "尚未验证",
    });
  });

  it("retains the latest eligible pilot when a later base-only/no-op receipt shares the case", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const caseKey = "pilot_then_base_case_0001";
    await appendUsageMetrics(pilotMetrics(1, { caseKey }), { stateDirectory });
    await appendUsageMetrics(baseMetrics({ caseKey, result: "unknown" }), { stateDirectory });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ sampleCount: 1, conclusion: "尚未验证" });
  });

  it("lets the latest complete pilot for a case and sequence revoke stale eligibility", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await appendUsageMetrics(pilotMetrics(1, { caseKey: "revoke_correct_case_0001" }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(2, { caseKey: "revoke_eligible_case_0002" }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(3, { caseKey: "revoke_validation_case_0003" }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(4, { caseKey: "revoke_correct_case_0001", correct: false }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(5, { caseKey: "revoke_eligible_case_0002", eligible: false }), { stateDirectory });
    await appendUsageMetrics(pilotMetrics(6, { caseKey: "revoke_validation_case_0003", validation: "failed" }), { stateDirectory });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "summarized", sampleCount: 0, conclusion: "尚未验证" });
  });

  it("rejects out-of-range values and fails closed on tampered arithmetic overflow", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    expect(await appendUsageMetrics(pilotMetrics(1, { t0T1ActiveReviewMs: 86_400_001, totalActiveReviewMs: 86_400_001 }), { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "invalid-input",
    });
    await appendUsageMetrics(pilotMetrics(1), { stateDirectory });
    const recordPath = join(stateDirectory, usageStorageNames.records);
    const record = (await storedLines(stateDirectory))[0];
    await writeFile(recordPath, `${JSON.stringify({ ...record, t0T1ActiveReviewMs: Number.MAX_SAFE_INTEGER, totalActiveReviewMs: Number.MAX_SAFE_INTEGER })}\n`, { mode: 0o600 });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
  });

  it("keeps malformed options and damaged logs fail-closed and content-free", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    expect(await summarizeUsageMetrics(2, 5, { stateDirectory })).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
    await appendUsageMetrics(pilotMetrics(1), { stateDirectory });
    await chmod(join(stateDirectory, usageStorageNames.records), 0o600);
    await writeFile(join(stateDirectory, usageStorageNames.records), "private report title\n", { flag: "a" });
    const result = await summarizeUsageMetrics(3, 5, { stateDirectory });
    expect(result).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
    expect(JSON.stringify(result)).not.toContain("private report title");
    expect(await appendUsageMetrics(baseMetrics(), { stateDirectory })).toEqual({
      status: "not-recorded",
      reason: "storage-unavailable",
    });

    await writeFile(join(stateDirectory, usageStorageNames.records), `${JSON.stringify({ format: "review-usage/1", caseId: "invalid" })}\n`, { mode: 0o600 });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
  });

  it("rejects permissive and symlinked logs during summarize", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    await appendUsageMetrics(pilotMetrics(1), { stateDirectory });
    const recordPath = join(stateDirectory, usageStorageNames.records);
    await chmod(recordPath, 0o644);
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });

    await chmod(recordPath, 0o600);
    const external = join(root, "outside.jsonl");
    await rename(recordPath, external);
    await symlink(external, recordPath);
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory })).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
  });

  it("parses the public command shape without including an input path in results", async () => {
    const root = await makeTemporaryDirectory();
    const stateDirectory = join(root, "state");
    const input = join(root, "content-free.json");
    await writeFile(input, JSON.stringify(pilotMetrics(1)));
    expect(await runRecordUsageCommand(["append", "--input", input], { stateDirectory })).toEqual({ status: "recorded" });
    const result = await runRecordUsageCommand(["summarize", "--min-samples", "3", "--max-samples", "5"], { stateDirectory });
    expect(result).toMatchObject({ conclusion: "尚未验证", sampleCount: 1 });
    expect(JSON.stringify(result)).not.toContain(input);
  });

  it("keeps empty stores and command invocation errors at a sanitized unverified result", async () => {
    const root = await makeTemporaryDirectory();
    const missingState = join(root, "missing-state");
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory: missingState })).toMatchObject({
      status: "summarized",
      conclusion: "尚未验证",
      sampleCount: 0,
    });

    const generalState = join(root, "general-state");
    await appendUsageMetrics(baseMetrics(), { stateDirectory: generalState });
    expect(await summarizeUsageMetrics(3, 5, { stateDirectory: generalState })).toMatchObject({ sampleCount: 0, conclusion: "尚未验证" });

    expect(await runRecordUsageCommand([])).toEqual({ status: "not-recorded", reason: "invalid-input" });
    expect(await runRecordUsageCommand(["append"])).toEqual({ status: "not-recorded", reason: "invalid-input" });
    expect(await runRecordUsageCommand(["append", "--input", join(root, "absent.json")])).toEqual({ status: "not-recorded", reason: "invalid-input" });

    const directoryInput = join(root, "directory-input");
    await import("node:fs/promises").then(async ({ mkdir }) => mkdir(directoryInput));
    expect(await runRecordUsageCommand(["append", "--input", directoryInput])).toEqual({ status: "not-recorded", reason: "invalid-input" });

    const oversizedInput = join(root, "oversized.json");
    await writeFile(oversizedInput, "x".repeat(32 * 1024 + 1));
    expect(await runRecordUsageCommand(["append", "--input", oversizedInput])).toEqual({ status: "not-recorded", reason: "invalid-input" });
    expect(await runRecordUsageCommand(["summarize", "--min-samples"])).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
    expect(await runRecordUsageCommand(["summarize", "--unknown", "3"])).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
    expect(await runRecordUsageCommand(["summarize", "--min-samples", "3", "--min-samples", "4"])).toMatchObject({ status: "unavailable", conclusion: "尚未验证" });
    expect(await runRecordUsageCommand(["summarize", "--min-samples", "3", "--max-samples", "5"], { stateDirectory: join(root, "state") })).toMatchObject({ status: "summarized" });
  });
});
