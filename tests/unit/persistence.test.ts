import { describe, expect, it } from "vitest";
import {
  bindPersistenceLifecycle,
  createPersistenceSession,
  LocalStorageAdapter,
  type PersistenceSession,
  type StorageAdapter,
  type StorageCapability,
} from "../../src/workbench/persistence/index.js";
import { reduceReviewState } from "../../src/workbench/reducer.js";
import type { createInitialReviewState } from "../../src/workbench/reducer.js";
import { computeWorkbenchStateDigest } from "../../src/workbench/state.js";
import { frozenReviewDocumentFixture, reviewDocumentFixture } from "./persistence-fixtures.js";

class MemoryAdapter implements StorageAdapter {
  readonly values = new Map<string, string>();
  available = true;
  failLoad = false;
  failSave = false;
  saveCalls = 0;

  probe(): StorageCapability {
    return this.available ? { available: true } : { available: false, reason: "unavailable" };
  }

  load(key: string): string | null {
    if (this.failLoad) throw new Error("load failed");
    return this.values.get(key) ?? null;
  }

  save(key: string, value: string): void {
    this.saveCalls += 1;
    if (this.failSave) throw new Error("save failed");
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

function apply(
  documentValue: ReturnType<typeof reviewDocumentFixture>,
  state: ReturnType<typeof createInitialReviewState>,
  action: Parameters<typeof reduceReviewState>[2],
) {
  const result = reduceReviewState(documentValue, state, action);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

describe("workbench persistence session", () => {
  it("synchronously persists every accepted state and restores savedAt plus the exact record count", () => {
    const documentValue = frozenReviewDocumentFixture();
    const adapter = new MemoryAdapter();
    let tick = 0;
    const now = (): Date => new Date(`2026-08-13T01:00:0${tick++}.000Z`);
    const first = createPersistenceSession({ documentValue, adapter, now });
    let state = first.getState();
    state = apply(documentValue, state, { type: "REOPEN_BLOCK", blockId: "B004" });
    state = apply(documentValue, state, {
      type: "SET_DECISION",
      blockId: "B004",
      decision: { action: "PASS" },
    });
    state = apply(documentValue, state, {
      type: "SET_SIDE_NOTE",
      blockId: "B004",
      note: "Restored note",
    });
    state = apply(documentValue, state, { type: "ADD_TOPIC", title: "Restored topic" });
    state = apply(documentValue, state, { type: "SET_OVERALL", overall: "Overall" });
    expect(first.apply(state)).toEqual({ accepted: true, persisted: true });
    expect(adapter.values.get(first.snapshot().key)).toContain('"format":"review-state/1"');

    const restored = createPersistenceSession({ documentValue, adapter, now });
    expect(restored.snapshot()).toMatchObject({
      available: true,
      notice: "recovered",
      recoveredRecords: 5,
    });
    expect(restored.snapshot().recoveredAt).toMatch(/^2026-08-13T01:00:/u);
    expect(restored.getState().decisionsByBlock.get("B004")).toEqual({
      blockId: "B004",
      action: "PASS",
    });
  });

  it("@A10 keeps accepted review data in memory after runtime storage failure", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    const session = createPersistenceSession({ documentValue, adapter });
    adapter.failSave = true;
    const next = apply(documentValue, session.getState(), {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "HOLD", note: "Storage failure must not lose this." },
    });
    expect(session.apply(next)).toEqual({ accepted: true, persisted: false });
    expect(session.snapshot().notice).toBe("unsaved");
    expect(session.getState().decisionsByBlock.get("B001")).toMatchObject({ action: "HOLD" });
  });

  it("flushes a dirty in-memory state when storage becomes available again", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    const session = createPersistenceSession({ documentValue, adapter });
    adapter.failSave = true;
    const next = apply(documentValue, session.getState(), {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    expect(session.apply(next)).toEqual({ accepted: true, persisted: false });
    adapter.failSave = false;
    expect(session.flush()).toBe(true);
    expect(session.snapshot()).toMatchObject({
      available: true,
      notice: "saved",
      lastPersistedDigest: session.snapshot().currentDigest,
    });
    const stored = adapter.values.get(session.snapshot().key);
    expect(stored?.endsWith("\n")).toBe(true);
    expect(JSON.parse(stored ?? "").decisions).toEqual([{ blockId: "B001", action: "PASS" }]);
  });

  it("@A22 marks a manual export only for the captured current digest and becomes dirty again", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    adapter.available = false;
    adapter.failSave = true;
    const session = createPersistenceSession({ documentValue, adapter });
    expect(session.snapshot().notice).toBe("unsaved");
    const captured = session.snapshot().currentDigest;
    expect(session.confirmExport(captured)).toBe(true);
    expect(session.snapshot().notice).toBe("manual-exported");

    const changed = apply(documentValue, session.getState(), {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    expect(session.apply(changed)).toEqual({ accepted: true, persisted: false });
    expect(session.snapshot().notice).toBe("unsaved");
    expect(session.confirmExport(captured)).toBe(false);
    expect(session.snapshot().lastExportedDigest).toBe(captured);
  });

  it("clear uses one replacement save, preserves high-water, and does not mutate memory on failure", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    const session = createPersistenceSession({ documentValue, adapter });
    let state = apply(documentValue, session.getState(), {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      note: "Allocated note",
    });
    expect(session.apply(state).accepted).toBe(true);
    state = apply(documentValue, state, { type: "CLEAR_REVIEW" });
    adapter.failSave = true;
    const before = session.getState();
    const callsBeforeFailedClear = adapter.saveCalls;
    expect(session.clear(state)).toEqual({ accepted: false, persisted: false });
    expect(adapter.saveCalls - callsBeforeFailedClear).toBe(1);
    expect(session.getState().sideNotesById.size).toBe(before.sideNotesById.size);
    expect(session.getState().idHighWater.note).toBe(1);
    const callsBeforeRetriedClear = adapter.saveCalls;
    expect(session.clear(state)).toEqual({ accepted: false, persisted: false });
    expect(adapter.saveCalls - callsBeforeRetriedClear).toBe(1);
    expect(session.getState().sideNotesById.size).toBe(before.sideNotesById.size);

    adapter.failSave = false;
    // A direct successful retry proves capability recovery and commits exactly once.
    const callsBeforeSuccessfulClear = adapter.saveCalls;
    expect(session.clear(state)).toEqual({ accepted: true, persisted: true });
    expect(adapter.saveCalls - callsBeforeSuccessfulClear).toBe(1);
    expect(session.snapshot()).toMatchObject({ available: true, notice: "saved" });
    expect(session.getState().sideNotesById.size).toBe(0);
    expect(session.getState().idHighWater.note).toBe(1);
    const expectedDigest = computeWorkbenchStateDigest(documentValue, state);
    expect(expectedDigest.ok).toBe(true);
    if (expectedDigest.ok) expect(session.snapshot().currentDigest).toBe(expectedDigest.value);
  });

  it("never advances the export digest merely because CLEAR persisted", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    const session = createPersistenceSession({ documentValue, adapter });
    const exported = session.snapshot().currentDigest;
    expect(session.confirmExport(exported)).toBe(true);
    const changed = apply(documentValue, session.getState(), {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      note: "Allocated note",
    });
    expect(session.apply(changed).persisted).toBe(true);
    const cleared = apply(documentValue, changed, { type: "CLEAR_REVIEW" });
    expect(session.clear(cleared)).toEqual({ accepted: true, persisted: true });
    expect(session.snapshot().lastExportedDigest).toBe(exported);
    expect(session.snapshot().lastExportedDigest).not.toBe(session.snapshot().currentDigest);
  });

  it("retains historical export knowledge across an initially degraded in-memory clear", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    adapter.available = false;
    adapter.failSave = true;
    const session = createPersistenceSession({ documentValue, adapter });
    const exported = session.snapshot().currentDigest;
    expect(session.confirmExport(exported)).toBe(true);
    const changed = apply(documentValue, session.getState(), {
      type: "SET_SIDE_NOTE",
      blockId: "B001",
      note: "Allocate a retained high-water mark",
    });
    expect(session.apply(changed)).toEqual({ accepted: true, persisted: false });
    const persistedBeforeClear = session.snapshot().lastPersistedDigest;
    const cleared = apply(documentValue, changed, { type: "CLEAR_REVIEW" });
    expect(session.clear(cleared)).toEqual({ accepted: true, persisted: false });
    expect(session.snapshot().lastPersistedDigest).toBe(persistedBeforeClear);
    expect(session.snapshot().lastExportedDigest).toBe(exported);
    expect(session.snapshot().notice).toBe("unsaved");
  });

  it("rejects corrupt automatic recovery atomically", () => {
    const documentValue = reviewDocumentFixture();
    const adapter = new MemoryAdapter();
    const initial = createPersistenceSession({ documentValue, adapter });
    adapter.values.set(initial.snapshot().key, '{"format":"review-packet/1"}');
    const recovered = createPersistenceSession({ documentValue, adapter });
    expect(recovered.snapshot()).toMatchObject({
      available: true,
      notice: "recovery-invalid",
      recoveryInvalid: true,
    });
    expect(recovered.getState().decisionsByBlock.size).toBe(0);
    const corrupt = adapter.values.get(recovered.snapshot().key);
    expect(recovered.confirmExport(recovered.snapshot().currentDigest)).toBe(true);
    expect(recovered.snapshot().notice).toBe("recovery-invalid");
    expect(recovered.flush()).toBe(false);
    expect(adapter.values.get(recovered.snapshot().key)).toBe(corrupt);

    const next = apply(documentValue, recovered.getState(), {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    expect(recovered.apply(next)).toEqual({ accepted: true, persisted: true });
    expect(recovered.snapshot()).toMatchObject({
      available: true,
      notice: "saved",
      recoveryInvalid: false,
    });
  });

  it.each(["apply", "clear"] as const)(
    "keeps rejected recovery visible while current progress is %s-recovered from a save failure",
    (recoveryAction) => {
      const documentValue = reviewDocumentFixture();
      const adapter = new MemoryAdapter();
      const initial = createPersistenceSession({ documentValue, adapter });
      adapter.values.set(initial.snapshot().key, '{"format":"review-packet/1"}');
      const session = createPersistenceSession({ documentValue, adapter });
      adapter.failSave = true;
      const changed = apply(documentValue, session.getState(), {
        type: "SET_DECISION",
        blockId: "B001",
        decision: { action: "PASS" },
      });

      expect(session.apply(changed)).toEqual({ accepted: true, persisted: false });
      expect(session.getState().decisionsByBlock.get("B001")).toMatchObject({ action: "PASS" });
      expect(session.snapshot()).toMatchObject({
        available: false,
        notice: "unsaved",
        recoveryInvalid: true,
      });
      const exported = session.snapshot().currentDigest;
      expect(session.confirmExport(exported)).toBe(true);
      expect(session.snapshot()).toMatchObject({
        available: false,
        notice: "manual-exported",
        recoveryInvalid: true,
        lastExportedDigest: exported,
      });

      adapter.failSave = false;
      if (recoveryAction === "apply") {
        const saved = apply(documentValue, session.getState(), {
          type: "SET_DECISION",
          blockId: "B002",
          decision: { action: "PASS" },
        });
        expect(session.apply(saved)).toEqual({ accepted: true, persisted: true });
        expect(session.getState().decisionsByBlock.size).toBe(2);
      } else {
        const cleared = apply(documentValue, session.getState(), { type: "CLEAR_REVIEW" });
        expect(session.clear(cleared)).toEqual({ accepted: true, persisted: true });
        expect(session.getState().decisionsByBlock.size).toBe(0);
      }
      expect(session.snapshot()).toMatchObject({
        available: true,
        notice: "saved",
        recoveryInvalid: false,
        lastPersistedDigest: session.snapshot().currentDigest,
      });
      expect(adapter.values.get(session.snapshot().key)).toContain('"format":"review-state/1"');
    },
  );
});

describe("LocalStorageAdapter", () => {
  it("probes synchronously without destroying an existing probe value", () => {
    const values = new Map<string, string>([["review-workbench/1:capability-probe", "old"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const adapter = new LocalStorageAdapter(storage);
    expect(adapter.probe()).toEqual({ available: true });
    expect(values.get("review-workbench/1:capability-probe")).toBe("old");
  });

  it("reports unavailable storage and keeps load/save/remove failure explicit", () => {
    const adapter = new LocalStorageAdapter(undefined);
    expect(adapter.probe()).toEqual({ available: false, reason: "unavailable" });
    expect(() => adapter.load("key")).toThrow("STORAGE_UNAVAILABLE");
    expect(() => adapter.save("key", "value")).toThrow("STORAGE_UNAVAILABLE");
    expect(() => adapter.remove("key")).toThrow("STORAGE_UNAVAILABLE");
  });

  it("removes a new probe value and exposes synchronous storage operations", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const adapter = new LocalStorageAdapter(storage);
    expect(adapter.probe()).toEqual({ available: true });
    expect(values.has("review-workbench/1:capability-probe")).toBe(false);
    adapter.save("state", "saved");
    expect(adapter.load("state")).toBe("saved");
    adapter.remove("state");
    expect(adapter.load("state")).toBeNull();
  });

  it("fails closed when a probe is not observable or storage throws", () => {
    const invisible = new LocalStorageAdapter({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage);
    expect(invisible.probe()).toEqual({ available: false, reason: "unavailable" });

    const throwing = new LocalStorageAdapter({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage);
    expect(throwing.probe()).toEqual({ available: false, reason: "unavailable" });
  });
});

describe("persistence lifecycle", () => {
  it("flushes on pagehide and only on hidden visibility, then removes both listeners", () => {
    const windowListeners = new Map<string, EventListener>();
    const documentListeners = new Map<string, EventListener>();
    let visibilityState: DocumentVisibilityState = "visible";
    const ownerWindow = {
      addEventListener: (type: string, listener: EventListener) => { windowListeners.set(type, listener); },
      removeEventListener: (type: string) => { windowListeners.delete(type); },
    } as unknown as Window;
    const ownerDocument = {
      get visibilityState() { return visibilityState; },
      addEventListener: (type: string, listener: EventListener) => { documentListeners.set(type, listener); },
      removeEventListener: (type: string) => { documentListeners.delete(type); },
    } as unknown as Document;
    let flushes = 0;
    const session = { flush: () => { flushes += 1; return true; } } as unknown as PersistenceSession;
    const unbind = bindPersistenceLifecycle(session, ownerWindow, ownerDocument);

    windowListeners.get("pagehide")?.(new Event("pagehide"));
    documentListeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(flushes).toBe(1);
    visibilityState = "hidden";
    documentListeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(flushes).toBe(2);

    unbind();
    expect(windowListeners.size).toBe(0);
    expect(documentListeners.size).toBe(0);
  });
});
