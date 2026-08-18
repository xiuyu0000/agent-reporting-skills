import { protocolError, validateReviewDocument, type ReviewDocumentV1 } from "../../protocol/index.js";
import {
  fromProtocolError,
  validationError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import { visitReviewDocumentContent } from "./document-content.js";
import { validatePrivateSnapshot } from "./privacy.js";
import { snapshotSafeJson } from "./safe-input.js";
import { hasUnreplacedPlaceholder } from "./text.js";
import type { ValidationError, ValidationResult } from "./types.js";

export function validateDeliverableSnapshot(input: unknown): ValidationResult<ReviewDocumentV1> {
  const inputPrivacy = validatePrivateSnapshot(input);
  if (!inputPrivacy.ok) return inputPrivacy;
  const protocol = validateReviewDocument(input);
  if (!protocol.ok) return validationErrors(protocol.errors.map(fromProtocolError));
  const document = protocol.value;
  const errors: ValidationError[] = [];
  // Spec 14.1 / 7.4: a delivery is complete only with no unreplaced
  // placeholder. Both generated artifacts escape or base64-encode authored
  // text, so `@@DAR_*@@` and `{{UPPER}}` survive only in the review document
  // itself; the authored source is therefore the one place they can be seen.
  visitReviewDocumentContent(document, {
    text: (value, path) => {
      if (hasUnreplacedPlaceholder(value)) errors.push(validationError("PLACEHOLDER_REMAINS", path));
    },
  });
  if (document.document.status === "draft") {
    errors.push(validationError("DOCUMENT_NOT_REVIEWABLE", "/document/status"));
  }
  for (const [index, conflict] of document.evidence.conflicts.entries()) {
    if (conflict.severity === "blocking" && conflict.status === "unresolved") {
      errors.push(validationError("BLOCKING_CONFLICT", `/evidence/conflicts/${index}`));
    }
  }
  const frozen = new Set(document.approvals.currentFrozen);
  const allFrozen = document.blocks.every((block) => frozen.has(block.id));
  const anyChanged = document.blocks.some((block) => block.changed !== undefined);
  if (document.document.status === "finalized" && (!allFrozen || anyChanged)) {
    errors.push(validationError("DOCUMENT_NOT_REVIEWABLE", "/document/status"));
  }
  if (document.document.status === "in-review" && allFrozen) {
    errors.push(validationError("DOCUMENT_NOT_REVIEWABLE", "/document/status"));
  }
  return errors.length === 0 ? validationSuccess(document) : validationErrors(errors);
}

export function validateDeliverableDocument(input: unknown): ValidationResult<ReviewDocumentV1> {
  const snapshot = snapshotSafeJson(input);
  if (!snapshot.ok) return snapshot;
  try {
    return validateDeliverableSnapshot(snapshot.value);
  } catch {
    return validationErrors([fromProtocolError(protocolError("SCHEMA_TYPE", ""))]);
  }
}
