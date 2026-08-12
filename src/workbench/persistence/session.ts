import {
  canonicalJsonLine,
  computeReviewDigest,
  type ReviewDocumentV1,
  type Sha256Digest,
} from "../../protocol/index.js";
import {
  cloneWorkbenchReviewState,
  createInitialReviewState,
  type WorkbenchReviewState,
} from "../reducer.js";
import {
  buildReviewState,
  importReviewStateText,
  reviewStateRecordCount,
} from "../state.js";
import type { StorageAdapter } from "./storage.js";

export type PersistenceNotice =
  | "saved"
  | "recovered"
  | "manual-exported"
  | "unsaved"
  | "recovery-invalid";

export interface PersistenceSnapshot {
  readonly key: string;
  readonly available: boolean;
  readonly notice: PersistenceNotice;
  readonly recoveryInvalid: boolean;
  readonly currentDigest: Sha256Digest;
  readonly lastPersistedDigest?: Sha256Digest;
  readonly lastExportedDigest?: Sha256Digest;
  readonly recoveredAt?: string;
  readonly recoveredRecords?: number;
}

export interface PersistenceApplyResult {
  readonly accepted: boolean;
  readonly persisted: boolean;
}

export interface PersistenceSession {
  getState(): WorkbenchReviewState;
  snapshot(): PersistenceSnapshot;
  apply(next: WorkbenchReviewState): PersistenceApplyResult;
  clear(next: WorkbenchReviewState): PersistenceApplyResult;
  confirmExport(capturedDigest: Sha256Digest): boolean;
  flush(): boolean;
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function storageKey(documentValue: ReviewDocumentV1): string {
  const digest = computeReviewDigest(documentValue);
  if (!digest.ok) throw new Error("REVIEW_DIGEST_INVALID");
  return `review-workbench/1:${documentValue.document.id}:${documentValue.document.contentVersion}:${documentValue.document.round}:${digest.value}`;
}

export function createPersistenceSession(input: {
  readonly documentValue: ReviewDocumentV1;
  readonly adapter: StorageAdapter;
  readonly now?: () => Date;
}): PersistenceSession {
  const { documentValue, adapter } = input;
  const now = input.now ?? (() => new Date());
  const key = storageKey(documentValue);
  let state = createInitialReviewState(documentValue);
  let available = adapter.probe().available;
  let clearRequiresPersistence = available;
  let notice: PersistenceNotice = available ? "saved" : "unsaved";
  let recoveredAt: string | undefined;
  let recoveredRecords: number | undefined;
  let recoveryInvalid = false;
  let lastPersistedDigest: Sha256Digest | undefined;
  let lastExportedDigest: Sha256Digest | undefined;

  const initial = buildReviewState(documentValue, state, isoNow(now));
  if (!initial.ok) throw new Error("INITIAL_STATE_INVALID");
  let currentDigest = initial.value.stateDigest as Sha256Digest;

  if (available) {
    try {
      const stored = adapter.load(key);
      if (stored === null) {
        adapter.save(key, canonicalJsonLine(initial.value));
        lastPersistedDigest = currentDigest;
      } else {
        const imported = importReviewStateText(stored, documentValue, { allowPacket: false });
        if (!imported.ok) {
          recoveryInvalid = true;
          notice = "recovery-invalid";
        } else {
          state = cloneWorkbenchReviewState(imported.value.workbenchState);
          currentDigest = imported.value.reviewState.stateDigest as Sha256Digest;
          lastPersistedDigest = currentDigest;
          recoveredAt = imported.value.reviewState.savedAt;
          recoveredRecords = reviewStateRecordCount(imported.value.reviewState);
          notice = "recovered";
        }
      }
    } catch {
      available = false;
      notice = "unsaved";
    }
  }

  function refreshNotice(): void {
    if (!available) {
      notice = lastExportedDigest === currentDigest ? "manual-exported" : "unsaved";
      return;
    }
    notice = recoveryInvalid
      ? "recovery-invalid"
      : recoveredAt === undefined ? "saved" : "recovered";
  }

  function build(next: WorkbenchReviewState) {
    return buildReviewState(documentValue, next, isoNow(now));
  }

  function saveBuilt(serialized: string, digest: Sha256Digest): boolean {
    try {
      adapter.save(key, serialized);
      available = true;
      clearRequiresPersistence = true;
      recoveryInvalid = false;
      lastPersistedDigest = digest;
      recoveredAt = undefined;
      recoveredRecords = undefined;
      refreshNotice();
      return true;
    } catch {
      available = false;
      refreshNotice();
      return false;
    }
  }

  return {
    getState: () => cloneWorkbenchReviewState(state),
    snapshot: () => ({
      key,
      available,
      notice,
      recoveryInvalid,
      currentDigest,
      ...(lastPersistedDigest === undefined ? {} : { lastPersistedDigest }),
      ...(lastExportedDigest === undefined ? {} : { lastExportedDigest }),
      ...(recoveredAt === undefined ? {} : { recoveredAt }),
      ...(recoveredRecords === undefined ? {} : { recoveredRecords }),
    }),
    apply(next) {
      const built = build(next);
      if (!built.ok) return { accepted: false, persisted: false };
      state = cloneWorkbenchReviewState(next);
      currentDigest = built.value.stateDigest as Sha256Digest;
      const persisted = saveBuilt(canonicalJsonLine(built.value), currentDigest);
      return { accepted: true, persisted };
    },
    clear(next) {
      const built = build(next);
      if (!built.ok) return { accepted: false, persisted: false };
      const nextDigest = built.value.stateDigest as Sha256Digest;
      if (clearRequiresPersistence) {
        try {
          adapter.save(key, canonicalJsonLine(built.value));
        } catch {
          available = false;
          refreshNotice();
          return { accepted: false, persisted: false };
        }
        state = cloneWorkbenchReviewState(next);
        currentDigest = nextDigest;
        available = true;
        lastPersistedDigest = nextDigest;
        recoveryInvalid = false;
        recoveredAt = undefined;
        recoveredRecords = undefined;
        notice = "saved";
        return { accepted: true, persisted: true };
      }
      state = cloneWorkbenchReviewState(next);
      currentDigest = nextDigest;
      recoveryInvalid = false;
      refreshNotice();
      return { accepted: true, persisted: false };
    },
    confirmExport(capturedDigest) {
      if (capturedDigest !== currentDigest) return false;
      lastExportedDigest = capturedDigest;
      refreshNotice();
      return true;
    },
    flush() {
      if (recoveryInvalid) return false;
      if (lastPersistedDigest === currentDigest) return true;
      const built = build(state);
      return built.ok && saveBuilt(canonicalJsonLine(built.value), currentDigest);
    },
  };
}

export function bindPersistenceLifecycle(
  session: PersistenceSession,
  ownerWindow: Window,
  ownerDocument: Document,
): () => void {
  const windowEvents = ownerWindow as Window & {
    addEventListener?: Window["addEventListener"];
    removeEventListener?: Window["removeEventListener"];
  };
  const documentEvents = ownerDocument as Document & {
    addEventListener?: Document["addEventListener"];
    removeEventListener?: Document["removeEventListener"];
  };
  if (
    typeof windowEvents.addEventListener !== "function"
    || typeof windowEvents.removeEventListener !== "function"
    || typeof documentEvents.addEventListener !== "function"
    || typeof documentEvents.removeEventListener !== "function"
  ) return () => {};
  const pagehide = (): void => { session.flush(); };
  const visibility = (): void => {
    if (ownerDocument.visibilityState === "hidden") session.flush();
  };
  windowEvents.addEventListener("pagehide", pagehide);
  documentEvents.addEventListener("visibilitychange", visibility);
  return () => {
    windowEvents.removeEventListener("pagehide", pagehide);
    documentEvents.removeEventListener("visibilitychange", visibility);
  };
}
