import {
  packetIdFromSemanticDigest,
  packetSemanticDigest,
  reviewDigest,
  stateDigest,
  type Sha256Digest,
} from "./digest.js";
import {
  failure,
  protocolError,
  success,
  type ProtocolError,
  type ProtocolResult,
} from "./errors.js";
import { confirmLegacyIdentity, type LegacyIdentityConfirmation } from "./identity.js";
import { validateReviewDocument, validateReviewPacket, validateReviewState } from "./invariants.js";
import { cloneSafeJson } from "./schema.js";
import { validateReviewPacketSchema, validateReviewStateSchema } from "./schema.js";
import type { ReviewDocumentV1, ReviewPacketV1, ReviewStateV1 } from "./types.generated.js";

export interface PrototypeMigrationOptions {
  profile: "prototype-v1";
  document: ReviewDocumentV1;
  confirmation?: LegacyIdentityConfirmation;
}

interface MigrationContext {
  document: ReviewDocumentV1;
  confirmation?: LegacyIdentityConfirmation;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateMigrationDocument(document: ReviewDocumentV1): ProtocolResult<ReviewDocumentV1> {
  return validateReviewDocument(document);
}

function prefixErrors<T>(result: ProtocolResult<T>, prefix: string): ProtocolResult<T> {
  if (result.ok) return result;
  return failure(result.errors.map((error) => ({
    ...error,
    path: `${prefix}${error.path}`,
  })));
}

function prepareOptions(options: unknown): ProtocolResult<MigrationContext> {
  if (options === undefined) {
    return failure([protocolError("UNKNOWN_FORMAT", "/profile")]);
  }
  const cloned = cloneSafeJson(options);
  if (!cloned.ok) {
    if (cloned.errors.some((error) => error.path === "/profile")) {
      return failure([protocolError("UNKNOWN_FORMAT", "/profile")]);
    }
    return failure(cloned.errors.map((error) => ({
      ...error,
      path: error.path === "" ? "/options" : error.path,
    })));
  }
  const value = asRecord(cloned.value);
  if (!value) return failure([protocolError("SCHEMA_TYPE", "/options")]);
  const optionKeys = new Set(["profile", "document", "confirmation"]);
  const optionErrors = Object.keys(value)
    .filter((key) => !optionKeys.has(key))
    .map((key) => protocolError(
      "SCHEMA_ADDITIONAL_PROPERTIES",
      `/options/${escapePointerSegment(key)}`,
    ));
  if (optionErrors.length > 0) return failure(optionErrors);
  if (value.profile !== "prototype-v1") {
    return failure([protocolError("UNKNOWN_FORMAT", "/profile")]);
  }

  const document = prefixErrors(
    validateMigrationDocument(value.document as ReviewDocumentV1),
    "/document",
  );
  if (!document.ok) return document;

  let confirmation: LegacyIdentityConfirmation | undefined;
  if (Object.hasOwn(value, "confirmation")) {
    const rawConfirmation = asRecord(value.confirmation);
    if (!rawConfirmation) {
      return failure([protocolError("SCHEMA_TYPE", "/confirmation")]);
    }
    const expectedKeys = new Set(["documentId", "contentVersion", "round"]);
    const errors: ProtocolError[] = [];
    for (const key of Object.keys(rawConfirmation)) {
      if (!expectedKeys.has(key)) {
        errors.push(protocolError(
          "SCHEMA_ADDITIONAL_PROPERTIES",
          `/confirmation/${escapePointerSegment(key)}`,
        ));
      }
    }
    if (typeof rawConfirmation.documentId !== "string") {
      errors.push(protocolError("SCHEMA_TYPE", "/confirmation/documentId"));
    }
    if (!Number.isSafeInteger(rawConfirmation.contentVersion)) {
      errors.push(protocolError("SCHEMA_TYPE", "/confirmation/contentVersion"));
    }
    if (!Number.isSafeInteger(rawConfirmation.round)) {
      errors.push(protocolError("SCHEMA_TYPE", "/confirmation/round"));
    }
    if (errors.length > 0) return failure(errors);
    confirmation = rawConfirmation as unknown as LegacyIdentityConfirmation;
  }
  return success({ document: document.value, ...(confirmation ? { confirmation } : {}) });
}

function normalizeActions(
  value: Record<string, unknown>,
): ProtocolResult<Record<string, unknown>[]> {
  if (!Array.isArray(value.decisions)) {
    return failure([protocolError("SCHEMA_TYPE", "/decisions")]);
  }
  const errors: ProtocolError[] = [];
  const decisions = value.decisions.map((rawDecision, index) => {
    const decision = asRecord(structuredClone(rawDecision));
    if (!decision) {
      errors.push(protocolError("SCHEMA_TYPE", `/decisions/${index}`));
      return {};
    }
    const action = decision.action;
    if (action === "TRIM" || action === "EXPAND") {
      if (typeof decision.note !== "string" || decision.note.length === 0) {
        errors.push(protocolError("SCHEMA_TYPE", `/decisions/${index}/note`));
        return decision;
      }
      const prefix = action === "TRIM" ? "【精简】" : "【扩展】";
      decision.action = "EDIT";
      decision.note = `${prefix}${decision.note}`;
    } else if (!(["PASS", "EDIT", "TOPIC", "HOLD"] as unknown[]).includes(action)) {
      errors.push(protocolError("UNKNOWN_LEGACY_ACTION", `/decisions/${index}/action`));
    }
    return decision;
  });
  return errors.length === 0 ? { ok: true, value: decisions } : failure(errors);
}

function validateDerivedContainers(value: Record<string, unknown>): ProtocolResult<true> {
  const errors: ProtocolError[] = [];
  const checkKeys = (field: "progress" | "stats", allowed: ReadonlySet<string>): void => {
    if (!Object.hasOwn(value, field)) return;
    const record = asRecord(value[field]);
    if (!record) {
      errors.push(protocolError("SCHEMA_TYPE", `/${field}`));
      return;
    }
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        errors.push(protocolError(
          "SCHEMA_ADDITIONAL_PROPERTIES",
          `/${field}/${escapePointerSegment(key)}`,
        ));
      }
    }
  };
  checkKeys("progress", new Set(["decided", "total", "partial"]));
  checkKeys("stats", new Set(["PASS", "EDIT", "TOPIC", "HOLD", "TRIM", "EXPAND"]));
  return errors.length === 0 ? success(true) : failure(errors);
}

function completeIdentity(
  value: Record<string, unknown>,
  options: MigrationContext,
  packet: boolean,
): ProtocolResult<Record<string, unknown>> {
  const rawDoc = asRecord(value.doc);
  if (value.doc !== undefined && rawDoc === undefined) {
    return failure([protocolError("SCHEMA_TYPE", "/doc")]);
  }
  const identityFields = rawDoc ?? {};
  if (packet && Object.hasOwn(identityFields, "title")) {
    if (typeof identityFields.title !== "string") {
      return failure([protocolError("SCHEMA_TYPE", "/doc/title")]);
    }
    if (identityFields.title !== options.document.document.title) {
      return failure([protocolError("IDENTITY_MISMATCH", "/doc/title")]);
    }
  }
  const confirmed = confirmLegacyIdentity(identityFields, options.confirmation, options.document);
  if (!confirmed.ok) return confirmed;
  return {
    ok: true,
    value: {
      ...identityFields,
      id: confirmed.value.id,
      ...(packet ? { title: options.document.document.title } : {}),
      contentVersion: confirmed.value.contentVersion,
      round: confirmed.value.round,
      reviewDigest: reviewDigest(options.document),
    },
  };
}

export function migratePrototypePacket(
  input: unknown,
  options: PrototypeMigrationOptions,
): ProtocolResult<ReviewPacketV1> {
  const preparedOptions = prepareOptions(options);
  if (!preparedOptions.ok) return preparedOptions;
  const clonedInput = cloneSafeJson(input);
  if (!clonedInput.ok) return clonedInput;
  const raw = asRecord(clonedInput.value);
  if (!raw) return failure([protocolError("SCHEMA_TYPE", "")]);
  if (raw.format !== undefined && raw.format !== "review-packet/1") {
    return failure([protocolError("UNKNOWN_FORMAT", "/format")]);
  }
  const identity = completeIdentity(raw, preparedOptions.value, true);
  if (!identity.ok) return identity;
  const decisions = normalizeActions(raw);
  if (!decisions.ok) return decisions;
  const derivedContainers = validateDerivedContainers(raw);
  if (!derivedContainers.ok) return derivedContainers;

  if (Object.hasOwn(raw, "reopened") && !Array.isArray(raw.reopened)) {
    return failure([protocolError("SCHEMA_TYPE", "/reopened")]);
  }
  if (Object.hasOwn(raw, "frozenCarried") && !Array.isArray(raw.frozenCarried)) {
    return failure([protocolError("SCHEMA_TYPE", "/frozenCarried")]);
  }
  const reopened = Array.isArray(raw.reopened) ? raw.reopened : [];
  const frozenCarried = Array.isArray(raw.frozenCarried)
    ? raw.frozenCarried
    : preparedOptions.value.document.approvals.currentFrozen
      .filter((blockId) => !reopened.includes(blockId));
  const total = preparedOptions.value.document.blocks.length - frozenCarried.length;
  const decided = decisions.value.length;
  const stats = { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 };
  for (const decision of decisions.value) {
    const action = decision.action;
    if (action === "PASS" || action === "EDIT" || action === "TOPIC" || action === "HOLD") {
      stats[action] += 1;
    }
  }
  const placeholderDigest = `sha256:${"0".repeat(64)}` as Sha256Digest;
  const candidate = {
    ...raw,
    format: "review-packet/1",
    packetId: packetIdFromSemanticDigest(placeholderDigest),
    semanticDigest: placeholderDigest,
    doc: identity.value,
    decisions: decisions.value,
    progress: { decided, total, partial: decided < total },
    frozenCarried,
    stats,
  };
  const schema = validateReviewPacketSchema(candidate);
  if (!schema.ok) return schema;
  const prepared = schema.value;
  prepared.semanticDigest = packetSemanticDigest(prepared);
  prepared.packetId = packetIdFromSemanticDigest(prepared.semanticDigest as Sha256Digest);
  return validateReviewPacket(prepared, preparedOptions.value.document);
}

export function migratePrototypeState(
  input: unknown,
  options: PrototypeMigrationOptions,
): ProtocolResult<ReviewStateV1> {
  const preparedOptions = prepareOptions(options);
  if (!preparedOptions.ok) return preparedOptions;
  const clonedInput = cloneSafeJson(input);
  if (!clonedInput.ok) return clonedInput;
  const raw = asRecord(clonedInput.value);
  if (!raw) return failure([protocolError("SCHEMA_TYPE", "")]);
  if (raw.format !== undefined && raw.format !== "review-state/1") {
    return failure([protocolError("UNKNOWN_FORMAT", "/format")]);
  }
  const identity = completeIdentity(raw, preparedOptions.value, false);
  if (!identity.ok) return identity;
  const decisions = normalizeActions(raw);
  if (!decisions.ok) return decisions;

  const placeholderDigest = `sha256:${"0".repeat(64)}` as Sha256Digest;
  const candidate = {
    ...raw,
    format: "review-state/1",
    stateDigest: placeholderDigest,
    doc: identity.value,
    decisions: decisions.value,
  };
  const schema = validateReviewStateSchema(candidate);
  if (!schema.ok) return schema;
  const prepared = schema.value;
  prepared.stateDigest = stateDigest(prepared);
  return validateReviewState(prepared, preparedOptions.value.document);
}
