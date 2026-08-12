import {
  canonicalJsonLine,
  computeReviewDigest,
  migratePrototypePacket,
  migratePrototypeState,
  protocolError,
  stateDigest,
  validateReviewPacket,
  validateReviewState,
  type ProtocolResult,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type ReviewStateV1,
  type Sha256Digest,
} from "../protocol/index.js";
import {
  cloneWorkbenchReviewState,
  type WorkbenchReviewState,
  type WorkbenchSideNote,
  type WorkbenchTopic,
} from "./reducer.js";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}` as Sha256Digest;

export interface ImportedWorkbenchState {
  readonly reviewState: ReviewStateV1;
  readonly workbenchState: WorkbenchReviewState;
  readonly migrated: boolean;
  readonly sourceFormat: "review-packet/1" | "review-state/1";
}

export interface ReviewStateImportOptions {
  readonly legacyProfile?: "prototype-v1";
  readonly confirmIdentity?: boolean;
  readonly currentState?: WorkbenchReviewState;
  readonly allowPacket?: boolean;
}

function failure<T>(code: "SCHEMA_TYPE" | "UNKNOWN_FORMAT", path: string): ProtocolResult<T> {
  return { ok: false, mutated: false, errors: [protocolError(code, path)] };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function docIdentity(documentValue: ReviewDocumentV1): ProtocolResult<ReviewStateV1["doc"]> {
  const digest = computeReviewDigest(documentValue);
  return digest.ok
    ? {
      ok: true,
      value: {
        id: documentValue.document.id,
        contentVersion: documentValue.document.contentVersion,
        round: documentValue.document.round,
        reviewDigest: digest.value,
      },
    }
    : digest;
}

export function buildReviewState(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  savedAt: string,
): ProtocolResult<ReviewStateV1> {
  const identity = docIdentity(documentValue);
  if (!identity.ok) return identity;
  const candidate: ReviewStateV1 = {
    format: "review-state/1",
    doc: identity.value,
    savedAt,
    stateDigest: EMPTY_DIGEST,
    idHighWater: { ...state.idHighWater },
    decisions: [...state.decisionsByBlock.values()],
    sideNotes: [...state.sideNotesById.values()],
    topics: [...state.topicsById.values()],
    ...(state.overall === "" ? {} : { overall: state.overall }),
    reopened: [...state.reopened],
  };
  candidate.stateDigest = stateDigest(candidate);
  return validateReviewState(candidate, documentValue);
}

export function computeWorkbenchStateDigest(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): ProtocolResult<Sha256Digest> {
  const built = buildReviewState(documentValue, state, "1970-01-01T00:00:00.000Z");
  return built.ok ? { ok: true, value: built.value.stateDigest as Sha256Digest } : built;
}

export function serializeReviewStateJson(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  savedAt: string,
): ProtocolResult<string> {
  const built = buildReviewState(documentValue, state, savedAt);
  return built.ok ? { ok: true, value: canonicalJsonLine(built.value) } : built;
}

function toWorkbenchState(validated: ReviewStateV1): WorkbenchReviewState {
  const decisions = new Map(validated.decisions.map((decision) => [decision.blockId, decision]));
  const sideNotes = new Map<string, WorkbenchSideNote>(
    validated.sideNotes.map((note) => [note.id, { ...note }]),
  );
  const topics = new Map<string, WorkbenchTopic>(
    validated.topics.map((topic) => [topic.id, { ...topic }]),
  );
  return cloneWorkbenchReviewState({
    idHighWater: { ...validated.idHighWater },
    decisionsByBlock: decisions,
    sideNotesById: sideNotes,
    topicsById: topics,
    overall: validated.overall ?? "",
    reopened: new Set(validated.reopened),
  });
}

function packetToReviewState(packet: ReviewPacketV1): ReviewStateV1 {
  const candidate: ReviewStateV1 = {
    format: "review-state/1",
    doc: {
      id: packet.doc.id,
      contentVersion: packet.doc.contentVersion,
      round: packet.doc.round,
      reviewDigest: packet.doc.reviewDigest,
    },
    savedAt: packet.reviewedAt,
    stateDigest: EMPTY_DIGEST,
    idHighWater: { ...packet.idHighWater },
    decisions: structuredClone(packet.decisions),
    sideNotes: structuredClone(packet.sideNotes),
    topics: structuredClone(packet.topics),
    ...(packet.overall === undefined ? {} : { overall: packet.overall }),
    reopened: [...packet.reopened],
  };
  candidate.stateDigest = stateDigest(candidate);
  return candidate;
}

function rejectHighWaterRegression(
  imported: ReviewStateV1,
  current: WorkbenchReviewState | undefined,
): ProtocolResult<ReviewStateV1> {
  if (current === undefined) return { ok: true, value: imported };
  const errors = (Object.keys(current.idHighWater) as Array<keyof WorkbenchReviewState["idHighWater"]>)
    .filter((key) => imported.idHighWater[key] < current.idHighWater[key])
    .map((key) => protocolError("HIGH_WATER_REGRESSION", `/idHighWater/${key}`));
  return errors.length === 0
    ? { ok: true, value: imported }
    : { ok: false, mutated: false, errors };
}

export function importReviewStateText(
  text: string,
  documentValue: ReviewDocumentV1,
  options: ReviewStateImportOptions = {},
): ProtocolResult<ImportedWorkbenchState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure("SCHEMA_TYPE", "");
  }
  const record = asRecord(parsed);
  if (record === undefined) return failure("SCHEMA_TYPE", "");

  let normalized: ProtocolResult<ReviewStateV1>;
  let migrated = false;
  let sourceFormat: ImportedWorkbenchState["sourceFormat"];
  if (record.format === "review-state/1") {
    normalized = validateReviewState(record, documentValue);
    sourceFormat = "review-state/1";
  } else if (record.format === "review-packet/1") {
    if (options.allowPacket === false) return failure("UNKNOWN_FORMAT", "/format");
    const packet = validateReviewPacket(record, documentValue);
    normalized = packet.ok
      ? validateReviewState(packetToReviewState(packet.value), documentValue)
      : packet;
    sourceFormat = "review-packet/1";
  } else if (record.format !== undefined) {
    return failure("UNKNOWN_FORMAT", "/format");
  } else if (options.legacyProfile === "prototype-v1") {
    if (options.confirmIdentity !== true) {
      return {
        ok: false,
        mutated: false,
        errors: [protocolError("IDENTITY_CONFIRMATION_REQUIRED", "/doc")],
      };
    }
    const confirmation = {
      documentId: documentValue.document.id,
      contentVersion: documentValue.document.contentVersion,
      round: documentValue.document.round,
    };
    const packetShaped = ["packetId", "semanticDigest", "reviewedAt", "progress", "stats", "frozenCarried"]
      .some((field) => Object.hasOwn(record, field));
    if (packetShaped) {
      const packet = migratePrototypePacket(record, {
        profile: "prototype-v1",
        document: documentValue,
        confirmation,
      });
      normalized = packet.ok
        ? validateReviewState(packetToReviewState(packet.value), documentValue)
        : packet;
      sourceFormat = "review-packet/1";
    } else {
      normalized = migratePrototypeState(record, {
        profile: "prototype-v1",
        document: documentValue,
        confirmation,
      });
      sourceFormat = "review-state/1";
    }
    migrated = normalized.ok;
  } else {
    return failure("UNKNOWN_FORMAT", "/format");
  }
  if (!normalized.ok) return normalized;
  const monotonic = rejectHighWaterRegression(normalized.value, options.currentState);
  if (!monotonic.ok) return monotonic;

  // Map/Set conversion happens only after schema, identity, digest, topic pairing,
  // reopened, and seven-dimensional high-water validation has fully succeeded.
  return {
    ok: true,
    value: {
      reviewState: monotonic.value,
      workbenchState: toWorkbenchState(monotonic.value),
      migrated,
      sourceFormat,
    },
  };
}

export function reviewStateRecordCount(state: ReviewStateV1): number {
  return state.decisions.length
    + state.sideNotes.length
    + state.topics.length
    + state.reopened.length
    + (state.overall === undefined ? 0 : 1);
}
