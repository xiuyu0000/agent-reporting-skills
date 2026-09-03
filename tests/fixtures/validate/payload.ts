import { approvalPayloadBytes } from "../../../src/cli/validate/payload.js";
import type { ReviewDocumentV1 } from "../../../src/protocol/index.js";

// Appends one ASCII paragraph to the continuation state so the canonical
// payload is exactly `targetBytes`. Continuation content sits outside every
// block digest, so the fixture's frozen-block bookkeeping stays valid, and
// ASCII letters serialize as one byte each without escapes.
export function padDocumentTo(document: ReviewDocumentV1, targetBytes: number): ReviewDocumentV1 {
  const padded = structuredClone(document);
  const text = { type: "text" as const, text: "" };
  padded.continuation.currentState = [
    ...padded.continuation.currentState,
    { type: "paragraph", content: [text] },
  ];
  const base = approvalPayloadBytes(padded);
  if (base > targetBytes) throw new Error(`fixture is already ${base} bytes`);
  text.text = "x".repeat(targetBytes - base);
  return padded;
}
