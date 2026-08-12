import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blockContentDigest,
  validateReviewDocument,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";

export function reviewDocumentFixture(): ReviewDocumentV1 {
  const raw = JSON.parse(readFileSync(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
  const result = validateReviewDocument(raw);
  if (!result.ok) throw new Error(result.errors.map((error) => error.code).join(","));
  return result.value;
}

export function frozenReviewDocumentFixture(blockId = "B004"): ReviewDocumentV1 {
  const documentValue = reviewDocumentFixture();
  const block = documentValue.blocks.find((item) => item.id === blockId);
  if (block === undefined) throw new Error("fixture block missing");
  documentValue.approvals.history = [{
    blockId,
    approvedRound: documentValue.document.round,
    approvedContentDigest: blockContentDigest(block),
  }];
  documentValue.approvals.currentFrozen = [blockId];
  const validated = validateReviewDocument(documentValue);
  if (!validated.ok) throw new Error(validated.errors.map((error) => error.code).join(","));
  return validated.value;
}
