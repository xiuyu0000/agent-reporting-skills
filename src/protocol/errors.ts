export type SchemaErrorCode =
  | "SCHEMA_ADDITIONAL_PROPERTIES"
  | "SCHEMA_CONST"
  | "SCHEMA_CONTAINS"
  | "SCHEMA_ENUM"
  | "SCHEMA_FORMAT"
  | "SCHEMA_MAX_CONTAINS"
  | "SCHEMA_MAX_ITEMS"
  | "SCHEMA_MAXIMUM"
  | "SCHEMA_MIN_ITEMS"
  | "SCHEMA_MIN_LENGTH"
  | "SCHEMA_MINIMUM"
  | "SCHEMA_ONE_OF"
  | "SCHEMA_PATTERN"
  | "SCHEMA_REQUIRED"
  | "SCHEMA_TYPE"
  | "SCHEMA_UNIQUE_ITEMS";

export type ProtocolErrorCode =
  | SchemaErrorCode
  | "APPEND_ONLY_VIOLATION"
  | "APPROVAL_DIGEST_MISMATCH"
  | "CONTENT_VERSION_MISMATCH"
  | "DECISION_APPLICATION_INVALID"
  | "DEPENDENCY_CYCLE"
  | "DERIVED_TOPIC_INVALID"
  | "DERIVED_VALUE_MISMATCH"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_DECISION"
  | "DUPLICATE_ID"
  | "DUPLICATE_LINEAGE_ENTRY"
  | "FRESHNESS_INVALID"
  | "FROZEN_REOPENED_OVERLAP"
  | "FROZEN_BLOCK_CHANGED"
  | "FROZEN_WITHOUT_APPROVAL"
  | "FUTURE_APPROVAL"
  | "FEEDBACK_RESOLUTION_INVALID"
  | "FINALIZATION_INVALID"
  | "HIGH_WATER_REGRESSION"
  | "IDENTITY_CONFIRMATION_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "INVALID_LANGUAGE_TAG"
  | "IMPACT_ASSESSMENT_INVALID"
  | "MARKDOWN_CONTAINER_INVALID"
  | "MARKDOWN_SUMMARY_MISMATCH"
  | "PACKET_ID_DIGEST_MISMATCH"
  | "PACKET_REPLAY_CONFLICT"
  | "PORTABLE_PATH_INVALID"
  | "TABLE_WIDTH_MISMATCH"
  | "TEXT_WIDTH_EXCEEDED"
  | "TOPIC_MAPPING_MISMATCH"
  | "TRANSITION_BLOCK_REMOVED"
  | "TRANSITION_BLOCK_REORDERED"
  | "TRANSITION_ROUND_INVALID"
  | "UNTOUCHED_BLOCK_CHANGED"
  | "UNKNOWN_FORMAT"
  | "UNKNOWN_LEGACY_ACTION"
  | "UNKNOWN_PACKET_REFERENCE"
  | "UNKNOWN_REFERENCE"
  | "EXECUTION_ELIGIBILITY_MISMATCH";

export interface ProtocolError {
  code: ProtocolErrorCode;
  path: string;
  blockId: string | null;
  message: string;
  hint: string;
}

export type ProtocolResult<T> =
  | { ok: true; value: T }
  | { ok: false; mutated: false; errors: ProtocolError[] };

const DEFAULTS: Record<ProtocolErrorCode, readonly [message: string, hint: string]> = {
  APPEND_ONLY_VIOLATION: [
    "An append-only history entry was removed or changed.",
    "Preserve every previously validated history entry unchanged.",
  ],
  APPROVAL_DIGEST_MISMATCH: [
    "The latest approval digest does not match the current block content.",
    "Reopen the block or restore the exact approved content.",
  ],
  CONTENT_VERSION_MISMATCH: [
    "The content version does not match the mechanical content-digest rule.",
    "Increment by one only when semantic document content changes.",
  ],
  DECISION_APPLICATION_INVALID: [
    "A review decision was not applied according to its action contract.",
    "Correct the candidate block state, approval record, or action-specific result.",
  ],
  DEPENDENCY_CYCLE: [
    "The decision-block dependency graph contains a cycle.",
    "Remove the reported dependency edge before review.",
  ],
  DERIVED_TOPIC_INVALID: [
    "A derived topic proposal does not match its packet topic and lineage mapping.",
    "Provide exactly one correctly identified derived proposal for the topic.",
  ],
  DERIVED_VALUE_MISMATCH: [
    "A supplied summary value disagrees with its detailed records.",
    "Recompute the value from the decision details.",
  ],
  DIGEST_MISMATCH: [
    "A supplied semantic digest does not match the canonical content.",
    "Use the shared protocol digest function to regenerate it.",
  ],
  DUPLICATE_DECISION: [
    "A block has more than one current decision.",
    "Keep only the latest decision for that block.",
  ],
  DUPLICATE_ID: [
    "A stable identifier is duplicated.",
    "Assign a unique identifier without reusing a prior number.",
  ],
  DUPLICATE_LINEAGE_ENTRY: [
    "A lineage tuple is duplicated.",
    "Keep exactly one canonical record for the tuple.",
  ],
  FRESHNESS_INVALID: [
    "Evidence freshness timestamps do not cover the document as-of time.",
    "Refresh the source or remove the unsupported assertion.",
  ],
  FROZEN_REOPENED_OVERLAP: [
    "A block cannot be both carried frozen and reopened.",
    "Remove the block from one of the two sets.",
  ],
  FROZEN_BLOCK_CHANGED: [
    "A currently frozen block changed without an explicit valid reopen action.",
    "Restore the approved content or explicitly reopen and reapprove the block.",
  ],
  FROZEN_WITHOUT_APPROVAL: [
    "A frozen block has no approval history.",
    "Add a valid approval record or keep the block active.",
  ],
  FUTURE_APPROVAL: [
    "An approval record cites a future review round.",
    "Use the round in which the approval actually occurred.",
  ],
  FEEDBACK_RESOLUTION_INVALID: [
    "Packet feedback is missing, duplicated, or bound to an invalid resolution.",
    "Resolve each feedback item exactly once with the correct digest and target.",
  ],
  FINALIZATION_INVALID: [
    "The candidate does not satisfy the complete frozen finalization contract.",
    "Keep the document in review until every finalization invariant is satisfied.",
  ],
  HIGH_WATER_REGRESSION: [
    "An identifier high-water mark regressed or is below an observed identifier.",
    "Carry forward the maximum previously allocated value.",
  ],
  IDENTITY_CONFIRMATION_REQUIRED: [
    "Legacy data lacks enough identity to restore automatically.",
    "Explicitly confirm document ID, content version, and round.",
  ],
  IDENTITY_MISMATCH: [
    "The input is not bound to the exact review document identity.",
    "Use data exported from this document version and round.",
  ],
  INVALID_LANGUAGE_TAG: [
    "The document language is not a structurally valid BCP-47 tag.",
    "Provide a tag accepted by Intl.getCanonicalLocales.",
  ],
  IMPACT_ASSESSMENT_INVALID: [
    "A semantic upstream change lacks a valid downstream impact assessment.",
    "Record the exact affected closure or an explicit supported no-impact decision.",
  ],
  MARKDOWN_CONTAINER_INVALID: [
    "The Markdown receipt does not contain exactly one complete packet payload.",
    "Use the deterministic four-backtick review-packet/1 container.",
  ],
  MARKDOWN_SUMMARY_MISMATCH: [
    "The readable Markdown summary disagrees with the machine payload.",
    "Regenerate the complete receipt from the canonical packet.",
  ],
  PACKET_ID_DIGEST_MISMATCH: [
    "The packet ID does not match the semantic digest prefix.",
    "Derive the packet ID from the full semantic digest.",
  ],
  PACKET_REPLAY_CONFLICT: [
    "A consumed packet ID is associated with a different semantic digest.",
    "Stop replay and use the original packet bytes bound to that ID.",
  ],
  PORTABLE_PATH_INVALID: [
    "The relative path is not safe for portable path comparison.",
    "Use non-empty forward-slash segments without roots, dot segments, or controls.",
  ],
  SCHEMA_ADDITIONAL_PROPERTIES: ["The protocol contains an unknown field.", "Remove the field or use a supported protocol version."],
  SCHEMA_CONST: ["A protocol discriminator has an unsupported value.", "Use the exact value required by the protocol."],
  SCHEMA_CONTAINS: ["An array does not contain the required item shape.", "Provide items allowed by the public schema."],
  SCHEMA_ENUM: ["A field contains an unsupported enumerated value.", "Use one of the values defined by the public schema."],
  SCHEMA_FORMAT: ["A field does not match its required format.", "Provide a value in the required public format."],
  SCHEMA_MAX_CONTAINS: ["An array contains too many matching items.", "Split the review before delivery."],
  SCHEMA_MAX_ITEMS: ["An array exceeds its protocol limit.", "Split the review before delivery."],
  SCHEMA_MAXIMUM: ["A number is above its protocol maximum.", "Use a value within the public protocol range."],
  SCHEMA_MIN_ITEMS: ["An array does not contain enough items.", "Provide the minimum complete protocol content."],
  SCHEMA_MIN_LENGTH: ["A required string is empty.", "Provide the required non-empty text."],
  SCHEMA_MINIMUM: ["A number is below its protocol minimum.", "Use a value within the public protocol range."],
  SCHEMA_ONE_OF: ["A value does not match exactly one supported shape.", "Use one closed variant from the public schema."],
  SCHEMA_PATTERN: ["A string does not match its protocol pattern.", "Use the documented identifier or string form."],
  SCHEMA_REQUIRED: ["A required protocol field is missing.", "Provide the required field before continuing."],
  SCHEMA_TYPE: ["A protocol field has the wrong JSON type.", "Use the JSON type required by the public schema."],
  SCHEMA_UNIQUE_ITEMS: ["An array contains a duplicate item.", "Remove duplicate entries before continuing."],
  TABLE_WIDTH_MISMATCH: [
    "A table row has a different number of cells than its header.",
    "Make every row match the header width.",
  ],
  TEXT_WIDTH_EXCEEDED: [
    "A decision-block title or summary exceeds its display-width limit.",
    "Shorten the text without removing judgment-critical information.",
  ],
  TOPIC_MAPPING_MISMATCH: [
    "A TOPIC decision is not paired one-to-one with a same-source topic.",
    "Create exactly one matching topic or correct the topic ID.",
  ],
  TRANSITION_BLOCK_REMOVED: [
    "An existing decision block was removed across a published review round.",
    "Retain the stable block and revise its internal content instead.",
  ],
  TRANSITION_BLOCK_REORDERED: [
    "Existing decision blocks changed their relative narrative order.",
    "Preserve the prior relative order while inserting any new blocks.",
  ],
  TRANSITION_ROUND_INVALID: [
    "The candidate review round is not the next permitted round.",
    "Advance the review round exactly once for a non-replay transition.",
  ],
  UNTOUCHED_BLOCK_CHANGED: [
    "A block outside the packet's permitted impact set changed.",
    "Restore the untouched block or include a valid decision and impact record.",
  ],
  UNKNOWN_FORMAT: [
    "The protocol format is unknown or incompatible.",
    "Use review-document/1, review-packet/1, review-state/1, or an explicit legacy profile.",
  ],
  UNKNOWN_LEGACY_ACTION: [
    "The legacy action cannot be migrated safely.",
    "Only PASS, EDIT, TOPIC, HOLD, TRIM, and EXPAND are recognized.",
  ],
  UNKNOWN_PACKET_REFERENCE: [
    "A lineage entry references a packet that was not consumed.",
    "Bind the entry to an existing consumed packet.",
  ],
  UNKNOWN_REFERENCE: [
    "A protocol reference does not resolve in the current document.",
    "Correct or remove the dangling reference.",
  ],
  EXECUTION_ELIGIBILITY_MISMATCH: [
    "Supplied execution eligibility disagrees with the dependency-derived result.",
    "Recompute eligibility from current decisions, reopened blocks, and the dependency graph.",
  ],
};

export function protocolError(
  code: ProtocolErrorCode,
  path: string,
  blockId: string | null = null,
): ProtocolError {
  const [message, hint] = DEFAULTS[code];
  return { code, path, blockId, message, hint };
}

export function sortProtocolErrors(errors: readonly ProtocolError[]): ProtocolError[] {
  const unique = new Map<string, ProtocolError>();
  for (const error of errors) {
    unique.set(`${error.path}\u0000${error.code}\u0000${error.blockId ?? ""}`, error);
  }
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return [...unique.values()].sort(
    (left, right) =>
      compare(left.path, right.path)
      || compare(left.code, right.code)
      || compare(left.blockId ?? "", right.blockId ?? ""),
  );
}

export function success<T>(value: T): ProtocolResult<T> {
  return { ok: true, value };
}

export function failure<T = never>(errors: readonly ProtocolError[]): ProtocolResult<T> {
  return { ok: false, mutated: false, errors: sortProtocolErrors(errors) };
}
