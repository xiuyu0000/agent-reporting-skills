import {
  canonicalJson,
  canonicalReviewDocument,
  type ReviewDocumentV1,
} from "../../protocol/index.js";
import type { DeliveryWarning, DeliveryWarningCode } from "./types.js";

// WebKit's HTML parser (Safari and every iOS browser) stores at most 65,536
// UTF-16 code units in one parser-created text node and continues the run in
// sibling nodes; Chromium and Firefox keep one node. Workbenches generated
// before the multi-node reader refuse the split payload with
// DOCUMENT_ENCODING_INVALID. Base64 grows 4/3, so that boundary is 49,152
// canonical UTF-8 bytes of review document.
export const APPROVAL_PAYLOAD_LIMIT_BYTES = 49_152;
// Later rounds append approval history, lineage and change markers to the same
// contract (roughly 700–800 bytes per finalization), so the warning starts
// early enough for a round-1 author to trim or split before that growth lands.
export const APPROVAL_PAYLOAD_RESERVE_BYTES = 1_536;
export const APPROVAL_PAYLOAD_WARNING_BYTES = APPROVAL_PAYLOAD_LIMIT_BYTES - APPROVAL_PAYLOAD_RESERVE_BYTES;

const WARNING_TEXT: Readonly<Record<DeliveryWarningCode, readonly [message: string, hint: string]>> = {
  APPROVAL_PAYLOAD_NEAR_LIMIT: [
    "The embedded review document is within the reserve of the single-text-node payload limit.",
    "Trim non-semantic fields or split the delivery before later rounds add approval bookkeeping; workbenches generated before the multi-node reader stop loading past 49152 canonical bytes in WebKit browsers.",
  ],
  APPROVAL_PAYLOAD_OVER_LIMIT: [
    "The embedded review document exceeds the single-text-node payload limit.",
    "This workbench build loads the split payload, but workbenches generated before the multi-node reader fail with DOCUMENT_ENCODING_INVALID in WebKit browsers; split the delivery or trim non-semantic fields.",
  ],
};

const encoder = new TextEncoder();

export function approvalPayloadBytes(document: ReviewDocumentV1): number {
  return encoder.encode(canonicalJson(canonicalReviewDocument(document))).byteLength;
}

export function approvalPayloadWarning(
  document: ReviewDocumentV1,
  path: string,
): DeliveryWarning | undefined {
  const payloadBytes = approvalPayloadBytes(document);
  if (payloadBytes < APPROVAL_PAYLOAD_WARNING_BYTES) return undefined;
  const code: DeliveryWarningCode = payloadBytes > APPROVAL_PAYLOAD_LIMIT_BYTES
    ? "APPROVAL_PAYLOAD_OVER_LIMIT"
    : "APPROVAL_PAYLOAD_NEAR_LIMIT";
  const [message, hint] = WARNING_TEXT[code];
  return {
    code,
    path,
    blockId: null,
    message,
    hint,
    payloadBytes,
    limitBytes: APPROVAL_PAYLOAD_LIMIT_BYTES,
  };
}

// One document reports at `/document`; a split group reports each part at the
// same `/batch/parts/N` index space that batch handoff errors use.
export function approvalPayloadWarnings(documents: readonly ReviewDocumentV1[]): DeliveryWarning[] {
  return documents.flatMap((document, index) => {
    const path = documents.length === 1 ? "/document" : `/batch/parts/${index}`;
    const warning = approvalPayloadWarning(document, path);
    return warning === undefined ? [] : [warning];
  });
}
