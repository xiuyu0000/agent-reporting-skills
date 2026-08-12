import type {
  IdHighWater,
  ReviewDecision,
  ReviewDocumentV1,
} from "../protocol/index.js";

export interface WorkbenchSideNote {
  readonly id: string;
  readonly blockId: string;
  readonly note: string;
}

export interface WorkbenchTopic {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly sourceBlockId?: string;
}

export interface WorkbenchReviewState {
  readonly idHighWater: Readonly<IdHighWater>;
  readonly decisionsByBlock: ReadonlyMap<string, ReviewDecision>;
  readonly sideNotesById: ReadonlyMap<string, WorkbenchSideNote>;
  readonly topicsById: ReadonlyMap<string, WorkbenchTopic>;
  readonly overall: string;
  readonly reopened: ReadonlySet<string>;
}

export type DecisionInput =
  | { readonly action: "PASS"; readonly quote?: string }
  | { readonly action: "EDIT"; readonly note: string; readonly quote?: string }
  | {
    readonly action: "TOPIC";
    readonly title: string;
    readonly note?: string;
    readonly quote?: string;
    readonly topicId?: string;
  }
  | { readonly action: "HOLD"; readonly note: string; readonly quote?: string };

export type ReviewAction =
  | {
    readonly type: "SET_DECISION";
    readonly blockId: string;
    readonly decision: DecisionInput;
  }
  | { readonly type: "UNSET_DECISION"; readonly blockId: string }
  | {
    readonly type: "SET_SIDE_NOTE";
    readonly blockId: string;
    readonly note: string;
    readonly noteId?: string;
  }
  | { readonly type: "DELETE_SIDE_NOTE"; readonly noteId: string }
  | {
    readonly type: "ADD_TOPIC";
    readonly title: string;
    readonly note?: string;
  }
  | {
    readonly type: "UPDATE_TOPIC";
    readonly topicId: string;
    readonly title: string;
    readonly note?: string;
  }
  | { readonly type: "DELETE_TOPIC"; readonly topicId: string }
  | { readonly type: "SET_OVERALL"; readonly overall: string }
  | { readonly type: "BULK_PASS"; readonly blockIds: readonly string[] };

export type ReviewReducerErrorCode =
  | "BLOCK_NOT_FOUND"
  | "BLOCK_FROZEN"
  | "DECISION_REQUIRED"
  | "DECISION_NOTE_REQUIRED"
  | "TOPIC_TITLE_REQUIRED"
  | "TOPIC_ID_INVALID"
  | "TOPIC_ID_COLLISION"
  | "TOPIC_PAIR_INVALID"
  | "NOTE_REQUIRED"
  | "NOTE_ID_INVALID"
  | "NOTE_NOT_FOUND"
  | "TOPIC_NOT_FOUND"
  | "ID_HIGH_WATER_EXHAUSTED"
  | "BULK_SELECTION_INVALID";

export type ReviewReducerResult =
  | { readonly ok: true; readonly state: WorkbenchReviewState }
  | {
    readonly ok: false;
    readonly state: WorkbenchReviewState;
    readonly code: ReviewReducerErrorCode;
  };

function success(state: WorkbenchReviewState): ReviewReducerResult {
  return { ok: true, state };
}

function failure(
  state: WorkbenchReviewState,
  code: ReviewReducerErrorCode,
): ReviewReducerResult {
  return { ok: false, state, code };
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function requiredText(value: string): string | undefined {
  return optionalText(value);
}

export function normalizeQuote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized === "" ? undefined : normalized;
}

function cloneHighWater(
  value: Readonly<IdHighWater>,
  overrides: Partial<IdHighWater> = {},
): IdHighWater {
  return {
    block: overrides.block ?? value.block,
    source: overrides.source ?? value.source,
    fact: overrides.fact ?? value.fact,
    decision: overrides.decision ?? value.decision,
    glossary: overrides.glossary ?? value.glossary,
    note: overrides.note ?? value.note,
    topic: overrides.topic ?? value.topic,
  };
}

function blockIsActive(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockId: string,
): boolean {
  return !documentValue.approvals.currentFrozen.includes(blockId) || state.reopened.has(blockId);
}

function findBlock(
  documentValue: ReviewDocumentV1,
  blockId: string,
): ReviewDocumentV1["blocks"][number] | undefined {
  return documentValue.blocks.find((block) => block.id === blockId);
}

function formatMonotonicId(prefix: "NOTE-" | "TOP-", value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return `${prefix}${String(value).padStart(3, "0")}`;
}

function idNumber(value: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(value);
  if (match?.[1] === undefined || !/^\d{3,}$/u.test(match[1])) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed)
    && parsed > 0
    && String(parsed).padStart(3, "0") === match[1]
    ? parsed
    : undefined;
}

function nextId(
  state: WorkbenchReviewState,
  kind: "note" | "topic",
): { readonly id: string; readonly highWater: number } | undefined {
  const highWater = state.idHighWater[kind];
  if (!Number.isSafeInteger(highWater) || highWater >= Number.MAX_SAFE_INTEGER) return undefined;
  const next = highWater + 1;
  const id = formatMonotonicId(kind === "note" ? "NOTE-" : "TOP-", next);
  return id === undefined ? undefined : { id, highWater: next };
}

function topicPairForDecision(
  state: WorkbenchReviewState,
  decision: ReviewDecision | undefined,
): WorkbenchTopic | undefined {
  if (decision?.action !== "TOPIC") return undefined;
  const topic = state.topicsById.get(decision.topicId);
  if (topic?.sourceBlockId !== decision.blockId) return undefined;
  return topic;
}

function withDecision(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockId: string,
  input: DecisionInput,
): ReviewReducerResult {
  if (findBlock(documentValue, blockId) === undefined) return failure(state, "BLOCK_NOT_FOUND");
  if (!blockIsActive(documentValue, state, blockId)) return failure(state, "BLOCK_FROZEN");

  const previous = state.decisionsByBlock.get(blockId);
  const previousTopic = topicPairForDecision(state, previous);
  if (previous?.action === "TOPIC" && previousTopic === undefined) {
    return failure(state, "TOPIC_PAIR_INVALID");
  }

  const quote = normalizeQuote(input.quote);
  const decisions = new Map(state.decisionsByBlock);
  const topics = new Map(state.topicsById);
  let idHighWater = cloneHighWater(state.idHighWater);

  if (input.action === "TOPIC") {
    const title = requiredText(input.title);
    if (title === undefined) return failure(state, "TOPIC_TITLE_REQUIRED");
    const note = optionalText(input.note);
    let topicId = input.topicId;
    if (topicId === undefined && previous?.action === "TOPIC") topicId = previous.topicId;
    if (topicId === undefined) {
      const allocated = nextId(state, "topic");
      if (allocated === undefined) return failure(state, "ID_HIGH_WATER_EXHAUSTED");
      topicId = allocated.id;
      idHighWater = cloneHighWater(idHighWater, { topic: allocated.highWater });
    } else {
      const numericId = idNumber(topicId, /^TOP-(\d+)$/u);
      if (numericId === undefined) return failure(state, "TOPIC_ID_INVALID");
      const isCurrent = previous?.action === "TOPIC" && previous.topicId === topicId;
      if (!isCurrent && (numericId <= state.idHighWater.topic || topics.has(topicId))) {
        return failure(state, "TOPIC_ID_COLLISION");
      }
      if (!isCurrent) idHighWater = cloneHighWater(idHighWater, { topic: numericId });
    }
    if (previousTopic !== undefined && previousTopic.id !== topicId) topics.delete(previousTopic.id);
    const topic: WorkbenchTopic = note === undefined
      ? { id: topicId, title, sourceBlockId: blockId }
      : { id: topicId, title, note, sourceBlockId: blockId };
    topics.set(topicId, topic);
    const decision: ReviewDecision = quote === undefined
      ? { blockId, action: "TOPIC", topicId }
      : { blockId, action: "TOPIC", topicId, quote };
    decisions.set(blockId, decision);
  } else {
    if (previousTopic !== undefined) topics.delete(previousTopic.id);
    if (input.action === "PASS") {
      const decision: ReviewDecision = quote === undefined
        ? { blockId, action: "PASS" }
        : { blockId, action: "PASS", quote };
      decisions.set(blockId, decision);
    } else {
      const note = requiredText(input.note);
      if (note === undefined) return failure(state, "DECISION_NOTE_REQUIRED");
      const decision: ReviewDecision = quote === undefined
        ? { blockId, action: input.action, note }
        : { blockId, action: input.action, note, quote };
      decisions.set(blockId, decision);
    }
  }

  return success({
    ...state,
    idHighWater,
    decisionsByBlock: decisions,
    topicsById: topics,
  });
}

function withoutDecision(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockId: string,
): ReviewReducerResult {
  if (findBlock(documentValue, blockId) === undefined) return failure(state, "BLOCK_NOT_FOUND");
  if (!blockIsActive(documentValue, state, blockId)) return failure(state, "BLOCK_FROZEN");
  const previous = state.decisionsByBlock.get(blockId);
  if (previous === undefined) return failure(state, "DECISION_REQUIRED");
  const previousTopic = topicPairForDecision(state, previous);
  if (previous.action === "TOPIC" && previousTopic === undefined) {
    return failure(state, "TOPIC_PAIR_INVALID");
  }
  const decisions = new Map(state.decisionsByBlock);
  const topics = new Map(state.topicsById);
  decisions.delete(blockId);
  if (previousTopic !== undefined) topics.delete(previousTopic.id);
  return success({ ...state, decisionsByBlock: decisions, topicsById: topics });
}

function setSideNote(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  action: Extract<ReviewAction, { type: "SET_SIDE_NOTE" }>,
): ReviewReducerResult {
  if (findBlock(documentValue, action.blockId) === undefined) {
    return failure(state, "BLOCK_NOT_FOUND");
  }
  const note = requiredText(action.note);
  if (note === undefined) return failure(state, "NOTE_REQUIRED");
  const sideNotes = new Map(state.sideNotesById);
  let idHighWater = cloneHighWater(state.idHighWater);
  let noteId = action.noteId;
  if (noteId === undefined) {
    const allocated = nextId(state, "note");
    if (allocated === undefined) return failure(state, "ID_HIGH_WATER_EXHAUSTED");
    noteId = allocated.id;
    idHighWater = cloneHighWater(idHighWater, { note: allocated.highWater });
  } else {
    const numericId = idNumber(noteId, /^NOTE-(\d+)$/u);
    const existing = sideNotes.get(noteId);
    if (numericId === undefined || existing?.blockId !== action.blockId) {
      return failure(state, "NOTE_ID_INVALID");
    }
  }
  sideNotes.set(noteId, { id: noteId, blockId: action.blockId, note });
  return success({ ...state, idHighWater, sideNotesById: sideNotes });
}

function deleteSideNote(
  state: WorkbenchReviewState,
  noteId: string,
): ReviewReducerResult {
  if (!state.sideNotesById.has(noteId)) return failure(state, "NOTE_NOT_FOUND");
  const sideNotes = new Map(state.sideNotesById);
  sideNotes.delete(noteId);
  return success({ ...state, sideNotesById: sideNotes });
}

function addGlobalTopic(
  state: WorkbenchReviewState,
  titleValue: string,
  noteValue: string | undefined,
): ReviewReducerResult {
  const title = requiredText(titleValue);
  if (title === undefined) return failure(state, "TOPIC_TITLE_REQUIRED");
  const allocated = nextId(state, "topic");
  if (allocated === undefined) return failure(state, "ID_HIGH_WATER_EXHAUSTED");
  const note = optionalText(noteValue);
  const topic: WorkbenchTopic = note === undefined
    ? { id: allocated.id, title }
    : { id: allocated.id, title, note };
  const topics = new Map(state.topicsById);
  topics.set(topic.id, topic);
  return success({
    ...state,
    idHighWater: cloneHighWater(state.idHighWater, { topic: allocated.highWater }),
    topicsById: topics,
  });
}

function updateTopic(
  state: WorkbenchReviewState,
  action: Extract<ReviewAction, { type: "UPDATE_TOPIC" }>,
): ReviewReducerResult {
  const existing = state.topicsById.get(action.topicId);
  if (existing === undefined) return failure(state, "TOPIC_NOT_FOUND");
  const title = requiredText(action.title);
  if (title === undefined) return failure(state, "TOPIC_TITLE_REQUIRED");
  if (existing.sourceBlockId !== undefined) {
    const decision = state.decisionsByBlock.get(existing.sourceBlockId);
    if (decision?.action !== "TOPIC" || decision.topicId !== existing.id) {
      return failure(state, "TOPIC_PAIR_INVALID");
    }
  }
  const note = optionalText(action.note);
  const updated: WorkbenchTopic = existing.sourceBlockId === undefined
    ? note === undefined ? { id: existing.id, title } : { id: existing.id, title, note }
    : note === undefined
      ? { id: existing.id, title, sourceBlockId: existing.sourceBlockId }
      : { id: existing.id, title, note, sourceBlockId: existing.sourceBlockId };
  const topics = new Map(state.topicsById);
  topics.set(existing.id, updated);
  return success({ ...state, topicsById: topics });
}

function deleteTopic(
  state: WorkbenchReviewState,
  topicId: string,
): ReviewReducerResult {
  const topic = state.topicsById.get(topicId);
  if (topic === undefined) return failure(state, "TOPIC_NOT_FOUND");
  const topics = new Map(state.topicsById);
  const decisions = new Map(state.decisionsByBlock);
  if (topic.sourceBlockId !== undefined) {
    const decision = decisions.get(topic.sourceBlockId);
    if (decision?.action !== "TOPIC" || decision.topicId !== topicId) {
      return failure(state, "TOPIC_PAIR_INVALID");
    }
    decisions.delete(topic.sourceBlockId);
  }
  topics.delete(topicId);
  return success({ ...state, decisionsByBlock: decisions, topicsById: topics });
}

function bulkPass(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockIds: readonly string[],
): ReviewReducerResult {
  if (blockIds.length === 0 || new Set(blockIds).size !== blockIds.length) {
    return failure(state, "BULK_SELECTION_INVALID");
  }
  for (const blockId of blockIds) {
    const block = findBlock(documentValue, blockId);
    if (
      block === undefined
      || block.tier === "T2"
      || !blockIsActive(documentValue, state, blockId)
      || state.decisionsByBlock.has(blockId)
    ) {
      return failure(state, "BULK_SELECTION_INVALID");
    }
  }
  const decisions = new Map(state.decisionsByBlock);
  for (const blockId of blockIds) decisions.set(blockId, { blockId, action: "PASS" });
  return success({ ...state, decisionsByBlock: decisions });
}

export function createInitialReviewState(documentValue: ReviewDocumentV1): WorkbenchReviewState {
  return {
    idHighWater: cloneHighWater(documentValue.lineage.idHighWater),
    decisionsByBlock: new Map(),
    sideNotesById: new Map(),
    topicsById: new Map(),
    overall: "",
    reopened: new Set(),
  };
}

export function reduceReviewState(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  action: ReviewAction,
): ReviewReducerResult {
  switch (action.type) {
    case "SET_DECISION":
      return withDecision(documentValue, state, action.blockId, action.decision);
    case "UNSET_DECISION":
      return withoutDecision(documentValue, state, action.blockId);
    case "SET_SIDE_NOTE":
      return setSideNote(documentValue, state, action);
    case "DELETE_SIDE_NOTE":
      return deleteSideNote(state, action.noteId);
    case "ADD_TOPIC":
      return addGlobalTopic(state, action.title, action.note);
    case "UPDATE_TOPIC":
      return updateTopic(state, action);
    case "DELETE_TOPIC":
      return deleteTopic(state, action.topicId);
    case "SET_OVERALL":
      return success({ ...state, overall: action.overall.trim() });
    case "BULK_PASS":
      return bulkPass(documentValue, state, action.blockIds);
  }
}
