import { canonicalJson } from "./canonical.js";
import { documentContentDigest, reviewDigest } from "./digest.js";
import {
  failure,
  protocolError,
  success,
  type ProtocolError,
  type ProtocolResult,
} from "./errors.js";
import {
  cloneSafeJson,
  validateReviewDocumentSchema,
  validateReviewPacketSchema,
  validateReviewStateSchema,
} from "./schema.js";
import type {
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";

export interface IdHighWater {
  block: number;
  source: number;
  fact: number;
  decision: number;
  glossary: number;
  note: number;
  topic: number;
}

export interface LegacyIdentityConfirmation {
  documentId: string;
  contentVersion: number;
  round: number;
}

type HighWaterKey = keyof IdHighWater;

interface ObservedId {
  key: HighWaterKey;
  id: string;
  path: string;
}

const HIGH_WATER_KEYS: readonly HighWaterKey[] = [
  "block",
  "source",
  "fact",
  "decision",
  "glossary",
  "note",
  "topic",
];

const ID_PREFIXES: Readonly<Record<HighWaterKey, string>> = {
  block: "B",
  source: "SRC-",
  fact: "C-",
  decision: "D-",
  glossary: "G-",
  note: "NOTE-",
  topic: "TOP-",
};

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isSafePointer(value: string): boolean {
  if (!value.startsWith("/")
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    || /~(?![01])/.test(value)) {
    return false;
  }
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function prefixFailure<T>(result: ProtocolResult<T>, prefix: string): ProtocolResult<T> {
  if (result.ok) return result;
  return failure(result.errors.map((error) => ({
    ...error,
    path: `${prefix}${error.path}`,
  })));
}

function validateDocumentArgument(
  value: unknown,
  path: string,
): ProtocolResult<ReviewDocumentV1> {
  return prefixFailure(validateReviewDocumentSchema(value), path);
}

function validateOverlayArgument<T extends ReviewPacketV1 | ReviewStateV1>(
  value: unknown,
  path: string,
): ProtocolResult<T> {
  const cloned = cloneSafeJson(value, path);
  if (!cloned.ok) return cloned;
  if (cloned.value === null || typeof cloned.value !== "object" || Array.isArray(cloned.value)) {
    return failure([protocolError("SCHEMA_TYPE", path)]);
  }
  const format = (cloned.value as Record<string, unknown>).format;
  const result: ProtocolResult<ReviewPacketV1 | ReviewStateV1> = format === "review-packet/1"
    ? validateReviewPacketSchema(cloned.value)
    : format === "review-state/1"
      ? validateReviewStateSchema(cloned.value)
      : failure([protocolError("UNKNOWN_FORMAT", "/format")]);
  return prefixFailure(result, path) as ProtocolResult<T>;
}

function idNumber(id: string): number | undefined {
  const match = /(\d+)$/.exec(id);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function documentIds(document: ReviewDocumentV1): ObservedId[] {
  const values: ObservedId[] = [];
  for (const [index, block] of document.blocks.entries()) {
    values.push({ key: "block", id: block.id, path: `/blocks/${index}/id` });
  }
  for (const [index, source] of document.evidence.sourceHierarchy.entries()) {
    values.push({ key: "source", id: source.id, path: `/evidence/sourceHierarchy/${index}/id` });
  }
  for (const [index, fact] of document.evidence.facts.entries()) {
    values.push({ key: "fact", id: fact.id, path: `/evidence/facts/${index}/id` });
  }
  for (const [index, decision] of document.evidence.decisions.entries()) {
    values.push({ key: "decision", id: decision.id, path: `/evidence/decisions/${index}/id` });
  }
  for (const [index, glossary] of document.glossary.entries()) {
    values.push({ key: "glossary", id: glossary.id, path: `/glossary/${index}/id` });
  }
  for (const [index, mapping] of document.lineage.topicMappings.entries()) {
    values.push({ key: "topic", id: mapping.topicId, path: `/lineage/topicMappings/${index}/topicId` });
  }
  for (const [index, resolution] of document.lineage.feedbackResolutions.entries()) {
    if (resolution.feedbackId.startsWith("NOTE-")) {
      values.push({
        key: "note",
        id: resolution.feedbackId,
        path: `/lineage/feedbackResolutions/${index}/feedbackId`,
      });
    }
  }
  return values;
}

function overlayIds(input: ReviewPacketV1 | ReviewStateV1): ObservedId[] {
  const values: ObservedId[] = [];
  for (const [index, decision] of input.decisions.entries()) {
    values.push({ key: "block", id: decision.blockId, path: `/decisions/${index}/blockId` });
    if (decision.action === "TOPIC") {
      values.push({ key: "topic", id: decision.topicId, path: `/decisions/${index}/topicId` });
    }
  }
  for (const [index, note] of input.sideNotes.entries()) {
    values.push({ key: "note", id: note.id, path: `/sideNotes/${index}/id` });
    values.push({ key: "block", id: note.blockId, path: `/sideNotes/${index}/blockId` });
  }
  for (const [index, topic] of input.topics.entries()) {
    values.push({ key: "topic", id: topic.id, path: `/topics/${index}/id` });
    if (topic.sourceBlockId !== undefined) {
      values.push({ key: "block", id: topic.sourceBlockId, path: `/topics/${index}/sourceBlockId` });
    }
  }
  for (const [index, id] of input.reopened.entries()) {
    values.push({ key: "block", id, path: `/reopened/${index}` });
  }
  if (input.format === "review-packet/1") {
    for (const [index, id] of input.frozenCarried.entries()) {
      values.push({ key: "block", id, path: `/frozenCarried/${index}` });
    }
  }
  return values;
}

function highWaterErrors(
  highWater: IdHighWater,
  observed: readonly ObservedId[],
  basePath: string,
): ProtocolError[] {
  const errors: ProtocolError[] = [];
  for (const key of HIGH_WATER_KEYS) {
    if (!Number.isSafeInteger(highWater[key])) {
      errors.push(protocolError("HIGH_WATER_REGRESSION", `${basePath}/${key}`));
    }
  }
  for (const item of observed) {
    const number = idNumber(item.id);
    const canonicalId = number === undefined
      ? undefined
      : `${ID_PREFIXES[item.key]}${String(number).padStart(3, "0")}`;
    if (number === undefined || item.id !== canonicalId || number > highWater[item.key]) {
      errors.push(protocolError("HIGH_WATER_REGRESSION", item.path));
    }
  }
  return errors;
}

export function validateDocumentHighWater(
  document: ReviewDocumentV1,
): ProtocolResult<ReviewDocumentV1> {
  const validated = validateDocumentArgument(document, "/document");
  if (!validated.ok) return validated;
  const errors = highWaterErrors(
    validated.value.lineage.idHighWater,
    documentIds(validated.value),
    "/lineage/idHighWater",
  );
  return errors.length === 0 ? success(validated.value) : failure(errors);
}

export function validateOverlayHighWater<T extends ReviewPacketV1 | ReviewStateV1>(
  input: T,
  document?: ReviewDocumentV1,
): ProtocolResult<T> {
  const validatedInput = validateOverlayArgument<T>(input, "/input");
  if (!validatedInput.ok) return validatedInput;
  const validatedDocument = document === undefined
    ? undefined
    : validateDocumentArgument(document, "/document");
  if (validatedDocument !== undefined && !validatedDocument.ok) return validatedDocument;
  const value = validatedInput.value;
  const errors = highWaterErrors(value.idHighWater, overlayIds(value), "/idHighWater");
  if (validatedDocument?.value) {
    const documentHighWater = validatedDocument.value.lineage.idHighWater;
    for (const key of HIGH_WATER_KEYS) {
      if (value.idHighWater[key] < documentHighWater[key]) {
        errors.push(protocolError("HIGH_WATER_REGRESSION", `/idHighWater/${key}`));
      }
    }
    for (const [index, note] of value.sideNotes.entries()) {
      const number = idNumber(note.id);
      if (number === undefined || number <= documentHighWater.note) {
        errors.push(protocolError("HIGH_WATER_REGRESSION", `/sideNotes/${index}/id`));
      }
    }
    for (const [index, topic] of value.topics.entries()) {
      const number = idNumber(topic.id);
      if (number === undefined || number <= documentHighWater.topic) {
        errors.push(protocolError("HIGH_WATER_REGRESSION", `/topics/${index}/id`));
      }
    }
    for (const [index, decision] of value.decisions.entries()) {
      if (decision.action !== "TOPIC") continue;
      const number = idNumber(decision.topicId);
      if (number === undefined || number <= documentHighWater.topic) {
        errors.push(protocolError("HIGH_WATER_REGRESSION", `/decisions/${index}/topicId`));
      }
    }
  }
  return errors.length === 0 ? success(value) : failure(errors);
}

export function validatePacketIdentity(
  document: ReviewDocumentV1,
  packet: ReviewPacketV1,
): ProtocolResult<ReviewPacketV1> {
  const validatedDocument = validateDocumentArgument(document, "/document");
  if (!validatedDocument.ok) return validatedDocument;
  const validatedPacket = prefixFailure(validateReviewPacketSchema(packet), "/packet");
  if (!validatedPacket.ok) return validatedPacket;
  document = validatedDocument.value;
  packet = validatedPacket.value;
  const expected = {
    id: document.document.id,
    title: document.document.title,
    contentVersion: document.document.contentVersion,
    round: document.document.round,
    reviewDigest: reviewDigest(document),
  };
  const errors: ProtocolError[] = [];
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (packet.doc[key] !== expected[key]) {
      errors.push(protocolError("IDENTITY_MISMATCH", `/doc/${key}`));
    }
  }
  return errors.length === 0 ? success(packet) : failure(errors);
}

export function validateStateIdentity(
  document: ReviewDocumentV1,
  state: ReviewStateV1,
): ProtocolResult<ReviewStateV1> {
  const validatedDocument = validateDocumentArgument(document, "/document");
  if (!validatedDocument.ok) return validatedDocument;
  const validatedState = prefixFailure(validateReviewStateSchema(state), "/state");
  if (!validatedState.ok) return validatedState;
  document = validatedDocument.value;
  state = validatedState.value;
  const expected = {
    id: document.document.id,
    contentVersion: document.document.contentVersion,
    round: document.document.round,
    reviewDigest: reviewDigest(document),
  };
  const errors: ProtocolError[] = [];
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (state.doc[key] !== expected[key]) {
      errors.push(protocolError("IDENTITY_MISMATCH", `/doc/${key}`));
    }
  }
  return errors.length === 0 ? success(state) : failure(errors);
}

function containsCanonical(items: readonly unknown[], expected: unknown): boolean {
  const serialized = canonicalJson(expected);
  return items.some((item) => canonicalJson(item) === serialized);
}

function appendOnlyErrors(
  previous: readonly unknown[],
  candidate: readonly unknown[],
  path: string,
  prefixRequired: boolean,
): ProtocolError[] {
  const errors: ProtocolError[] = [];
  for (const [index, entry] of previous.entries()) {
    const preserved = prefixRequired
      ? index < candidate.length && canonicalJson(candidate[index]) === canonicalJson(entry)
      : containsCanonical(candidate, entry);
    if (!preserved) errors.push(protocolError("APPEND_ONLY_VIOLATION", `${path}/${index}`));
  }
  return errors;
}

export function validateDocumentContext(
  current: ReviewDocumentV1,
  candidate: ReviewDocumentV1,
): ProtocolResult<ReviewDocumentV1> {
  const validatedCurrent = validateDocumentArgument(current, "/current");
  if (!validatedCurrent.ok) return validatedCurrent;
  const validatedCandidate = validateDocumentArgument(candidate, "/candidate");
  if (!validatedCandidate.ok) return validatedCandidate;
  current = validatedCurrent.value;
  candidate = validatedCandidate.value;
  const errors: ProtocolError[] = [];
  if (candidate.document.id !== current.document.id) {
    errors.push(protocolError("IDENTITY_MISMATCH", "/document/id"));
  }
  if (candidate.delivery.id !== current.delivery.id) {
    errors.push(protocolError("IDENTITY_MISMATCH", "/delivery/id"));
  }
  if (candidate.document.round <= 1 || candidate.document.round <= current.document.round) {
    errors.push(protocolError("IDENTITY_MISMATCH", "/document/round"));
  }
  if (candidate.lineage.previousReviewDigest !== reviewDigest(current)) {
    errors.push(protocolError("IDENTITY_MISMATCH", "/lineage/previousReviewDigest"));
  }

  const currentContent = documentContentDigest(current);
  const candidateContent = documentContentDigest(candidate);
  const expectedVersion = currentContent === candidateContent
    ? current.document.contentVersion
    : current.document.contentVersion + 1;
  if (candidate.document.contentVersion !== expectedVersion) {
    errors.push(protocolError("CONTENT_VERSION_MISMATCH", "/document/contentVersion"));
  }

  for (const key of HIGH_WATER_KEYS) {
    if (candidate.lineage.idHighWater[key] < current.lineage.idHighWater[key]) {
      errors.push(protocolError("HIGH_WATER_REGRESSION", `/lineage/idHighWater/${key}`));
    }
  }
  const currentIds = new Set(documentIds(current).map((item) => `${item.key}:${item.id}`));
  for (const item of documentIds(candidate)) {
    if (!currentIds.has(`${item.key}:${item.id}`)) {
      const number = idNumber(item.id);
      if (number === undefined || number <= current.lineage.idHighWater[item.key]) {
        errors.push(protocolError("HIGH_WATER_REGRESSION", item.path));
      }
    }
  }

  errors.push(
    ...appendOnlyErrors(
      current.lineage.consumedPackets,
      candidate.lineage.consumedPackets,
      "/lineage/consumedPackets",
      true,
    ),
    ...appendOnlyErrors(
      current.lineage.feedbackResolutions,
      candidate.lineage.feedbackResolutions,
      "/lineage/feedbackResolutions",
      false,
    ),
    ...appendOnlyErrors(
      current.lineage.topicMappings,
      candidate.lineage.topicMappings,
      "/lineage/topicMappings",
      false,
    ),
    ...appendOnlyErrors(
      current.lineage.impactAssessments,
      candidate.lineage.impactAssessments,
      "/lineage/impactAssessments",
      false,
    ),
    ...appendOnlyErrors(
      current.approvals.history,
      candidate.approvals.history,
      "/approvals/history",
      false,
    ),
  );

  return errors.length === 0 ? success(candidate) : failure(errors);
}

export function confirmLegacyIdentity(
  input: { id?: unknown; contentVersion?: unknown; round?: unknown },
  confirmation: LegacyIdentityConfirmation | undefined,
  document: ReviewDocumentV1,
  path = "/doc",
): ProtocolResult<{ id: string; contentVersion: number; round: number }> {
  if (typeof path !== "string" || !isSafePointer(path)) {
    return failure([protocolError("SCHEMA_TYPE", "/path")]);
  }
  const clonedInput = cloneSafeJson(input, path);
  if (!clonedInput.ok) return clonedInput;
  if (clonedInput.value === null || typeof clonedInput.value !== "object"
    || Array.isArray(clonedInput.value)) {
    return failure([protocolError("SCHEMA_TYPE", path)]);
  }
  input = clonedInput.value as Record<string, unknown>;

  const validatedDocument = validateDocumentArgument(document, "/document");
  if (!validatedDocument.ok) return validatedDocument;
  document = validatedDocument.value;

  if (confirmation !== undefined) {
    const clonedConfirmation = cloneSafeJson(confirmation, "/confirmation");
    if (!clonedConfirmation.ok) return clonedConfirmation;
    if (clonedConfirmation.value === null || typeof clonedConfirmation.value !== "object"
      || Array.isArray(clonedConfirmation.value)) {
      return failure([protocolError("SCHEMA_TYPE", "/confirmation")]);
    }
    const record = clonedConfirmation.value as Record<string, unknown>;
    const expectedKeys = new Set(["documentId", "contentVersion", "round"]);
    const confirmationErrors: ProtocolError[] = [];
    for (const key of Object.keys(record)) {
      if (!expectedKeys.has(key)) {
        confirmationErrors.push(protocolError(
          "SCHEMA_ADDITIONAL_PROPERTIES",
          `/confirmation/${escapePointerSegment(key)}`,
        ));
      }
    }
    if (typeof record.documentId !== "string") {
      confirmationErrors.push(protocolError("SCHEMA_TYPE", "/confirmation/documentId"));
    }
    if (!Number.isSafeInteger(record.contentVersion)) {
      confirmationErrors.push(protocolError("SCHEMA_TYPE", "/confirmation/contentVersion"));
    }
    if (!Number.isSafeInteger(record.round)) {
      confirmationErrors.push(protocolError("SCHEMA_TYPE", "/confirmation/round"));
    }
    if (confirmationErrors.length > 0) return failure(confirmationErrors);
    confirmation = record as unknown as LegacyIdentityConfirmation;
  }

  const typeErrors: ProtocolError[] = [];
  const hasId = Object.hasOwn(input, "id");
  const hasContentVersion = Object.hasOwn(input, "contentVersion");
  const hasRound = Object.hasOwn(input, "round");
  if (hasId && typeof input.id !== "string") {
    typeErrors.push(protocolError("SCHEMA_TYPE", `${path}/id`));
  }
  if (hasContentVersion && !Number.isSafeInteger(input.contentVersion)) {
    typeErrors.push(protocolError("SCHEMA_TYPE", `${path}/contentVersion`));
  }
  if (hasRound && !Number.isSafeInteger(input.round)) {
    typeErrors.push(protocolError("SCHEMA_TYPE", `${path}/round`));
  }
  if (typeErrors.length > 0) return failure(typeErrors);

  const incomplete =
    !hasId
    || !hasContentVersion
    || !hasRound;
  if (incomplete && confirmation === undefined) {
    return failure([protocolError("IDENTITY_CONFIRMATION_REQUIRED", path)]);
  }
  const identity = {
    id: hasId ? input.id : confirmation?.documentId,
    contentVersion:
      hasContentVersion ? input.contentVersion : confirmation?.contentVersion,
    round: hasRound ? input.round : confirmation?.round,
  };
  const expected = {
    id: document.document.id,
    contentVersion: document.document.contentVersion,
    round: document.document.round,
  };
  const errors: ProtocolError[] = [];
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (identity[key] !== expected[key]) {
      errors.push(protocolError("IDENTITY_MISMATCH", `${path}/${key}`));
    }
    if (confirmation) {
      const confirmationKey = key === "id" ? "documentId" : key;
      if (confirmation[confirmationKey] !== expected[key]) {
        errors.push(protocolError("IDENTITY_MISMATCH", `${path}/${key}`));
      }
    }
  }
  if (errors.length > 0) return failure(errors);
  return success(expected);
}
