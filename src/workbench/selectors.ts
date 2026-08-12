import type {
  ProtocolResult,
  ReviewDecision,
  ReviewDocumentV1,
} from "../protocol/index.js";
import {
  deriveExecutionEligibility,
  type ExecutionEligibility,
} from "../protocol/transition/index.js";
import type {
  WorkbenchReviewState,
  WorkbenchSideNote,
  WorkbenchTopic,
} from "./reducer.js";

export type ReviewFilter = "all" | "pending" | "t2" | "annotated";

export interface ReviewProgress {
  readonly decided: number;
  readonly total: number;
  readonly partial: boolean;
}

export interface ReviewStats {
  readonly PASS: number;
  readonly EDIT: number;
  readonly TOPIC: number;
  readonly HOLD: number;
}

export interface BulkPassPreview {
  readonly blockIds: readonly string[];
  readonly t0: number;
  readonly t1: number;
  readonly excludedT2: number;
}

export function executionEligibility(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): ProtocolResult<ExecutionEligibility> {
  return deriveExecutionEligibility({
    document: documentValue,
    decisions: [...state.decisionsByBlock.values()],
    reopened: [...state.reopened],
  });
}

export function effectiveFrozenBlockIds(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): ReadonlySet<string> {
  return new Set(
    documentValue.approvals.currentFrozen.filter((blockId) => !state.reopened.has(blockId)),
  );
}

export function activeBlockIds(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): readonly string[] {
  const frozen = effectiveFrozenBlockIds(documentValue, state);
  return documentValue.blocks.filter((block) => !frozen.has(block.id)).map((block) => block.id);
}

export function reviewProgress(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): ReviewProgress {
  const active = activeBlockIds(documentValue, state);
  const decided = active.reduce(
    (count, blockId) => count + (state.decisionsByBlock.has(blockId) ? 1 : 0),
    0,
  );
  return { decided, total: active.length, partial: decided !== active.length };
}

export function reviewStats(state: WorkbenchReviewState): ReviewStats {
  const stats = { PASS: 0, EDIT: 0, TOPIC: 0, HOLD: 0 };
  for (const decision of state.decisionsByBlock.values()) {
    stats[decision.action] += 1;
  }
  return stats;
}

export function pendingBlockIds(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
): readonly string[] {
  return activeBlockIds(documentValue, state).filter(
    (blockId) => !state.decisionsByBlock.has(blockId),
  );
}

function notesForBlock(
  state: WorkbenchReviewState,
  blockId: string,
): readonly WorkbenchSideNote[] {
  return [...state.sideNotesById.values()].filter((note) => note.blockId === blockId);
}

function topicsForBlock(
  state: WorkbenchReviewState,
  blockId: string,
): readonly WorkbenchTopic[] {
  return [...state.topicsById.values()].filter((topic) => topic.sourceBlockId === blockId);
}

function decisionText(decision: ReviewDecision | undefined): string {
  if (decision === undefined) return "";
  if (decision.action === "EDIT" || decision.action === "HOLD") return decision.note;
  return decision.action;
}

function normalizedSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isAnnotated(state: WorkbenchReviewState, blockId: string): boolean {
  return state.decisionsByBlock.has(blockId)
    || notesForBlock(state, blockId).length > 0
    || topicsForBlock(state, blockId).length > 0;
}

export function visibleBlockIds(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  filter: ReviewFilter,
  search: string,
): readonly string[] {
  const query = normalizedSearch(search);
  const frozen = effectiveFrozenBlockIds(documentValue, state);
  return documentValue.blocks.filter((block) => {
    const decision = state.decisionsByBlock.get(block.id);
    const filterMatch = filter === "all"
      || (filter === "pending" && !frozen.has(block.id) && decision === undefined)
      || (filter === "t2" && block.tier === "T2")
      || (filter === "annotated" && isAnnotated(state, block.id));
    if (!filterMatch) return false;
    if (query === "") return true;
    const topicText = topicsForBlock(state, block.id)
      .flatMap((topic) => [topic.title, topic.note ?? ""])
      .join(" ");
    const noteText = notesForBlock(state, block.id).map((note) => note.note).join(" ");
    return [block.id, block.title, decisionText(decision), topicText, noteText]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  }).map((block) => block.id);
}

export function bulkPassPreview(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  scopeBlockIds: readonly string[],
): BulkPassPreview {
  const scope = new Set(scopeBlockIds);
  const frozen = effectiveFrozenBlockIds(documentValue, state);
  const eligible = documentValue.blocks.filter((block) => (
    scope.has(block.id)
    && !frozen.has(block.id)
    && block.tier !== "T2"
    && !state.decisionsByBlock.has(block.id)
  ));
  return {
    blockIds: eligible.map((block) => block.id),
    t0: eligible.filter((block) => block.tier === "T0").length,
    t1: eligible.filter((block) => block.tier === "T1").length,
    excludedT2: documentValue.blocks.filter((block) => scope.has(block.id) && block.tier === "T2").length,
  };
}

export function nextBlockId(
  orderedIds: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (orderedIds.length === 0) return undefined;
  const currentIndex = currentId === undefined ? -1 : orderedIds.indexOf(currentId);
  if (currentIndex === -1) return direction === 1 ? orderedIds[0] : orderedIds.at(-1);
  return orderedIds[(currentIndex + direction + orderedIds.length) % orderedIds.length];
}

export function nextPendingBlockId(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  currentId: string | undefined,
): string | undefined {
  const active = activeBlockIds(documentValue, state);
  const pending = new Set(pendingBlockIds(documentValue, state));
  if (pending.size === 0) return undefined;
  const currentIndex = currentId === undefined ? -1 : active.indexOf(currentId);
  for (let offset = 1; offset <= active.length; offset += 1) {
    const candidate = active[(currentIndex + offset + active.length) % active.length];
    if (candidate !== undefined && pending.has(candidate)) return candidate;
  }
  return undefined;
}
