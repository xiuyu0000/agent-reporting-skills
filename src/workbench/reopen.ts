import type { ReviewDocumentV1 } from "../protocol/index.js";
import {
  reduceReviewState,
  type ReviewReducerResult,
  type WorkbenchReviewState,
} from "./reducer.js";

export function canReopenBlock(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockId: string,
): boolean {
  return documentValue.approvals.currentFrozen.includes(blockId) && !state.reopened.has(blockId);
}

export function reopenFrozenBlock(
  documentValue: ReviewDocumentV1,
  state: WorkbenchReviewState,
  blockId: string,
): ReviewReducerResult {
  return reduceReviewState(documentValue, state, { type: "REOPEN_BLOCK", blockId });
}
