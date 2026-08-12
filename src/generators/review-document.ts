import {
  canonicalJson,
  canonicalReviewDocument,
  type ReviewDocumentV1,
} from "../protocol/index.js";
import {
  decodeStrictUtf8,
  parseStrictJson,
  validatePrivateData,
} from "../cli/validate.js";
import { validateReviewDocument } from "../protocol/index.js";
import { generatorError, generatorFailure, generatorSuccess } from "./errors.js";
import type { GeneratorResult } from "./types.js";

const encoder = new TextEncoder();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function serializeReviewDocument(input: unknown): GeneratorResult<Uint8Array> {
  try {
    const validated = validateReviewDocument(input);
    if (!validated.ok) {
      // Protocol paths and block IDs are derived from caller-controlled JSON
      // keys/values. This public serializer must not echo either before the
      // protocol has produced the one trusted snapshot used by privacy below.
      return generatorFailure(validated.errors.map((error) => ({
        ...error,
        path: "/document",
        blockId: null,
      })));
    }
    // Privacy and serialization must consume the protocol-owned snapshot. The
    // caller-controlled object is never read a second time after validation.
    const privacy = validatePrivateData(validated.value, "/document");
    if (!privacy.ok) return generatorFailure(privacy.errors);
    const text = `${canonicalJson(canonicalReviewDocument(validated.value))}\n`;
    return generatorSuccess(encoder.encode(text));
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/document")]);
  }
}

export function createReviewDocumentByteVerifier(
  input: unknown,
): (bytes: Uint8Array) => { ok: true } | { ok: false } {
  const expected = serializeReviewDocument(input);
  if (!expected.ok) return () => ({ ok: false });
  const expectedBytes = Uint8Array.from(expected.value);
  return (bytes) => {
    try {
      if (!(bytes instanceof Uint8Array) || !sameBytes(bytes, expectedBytes)) return { ok: false };
      const decoded = decodeStrictUtf8(Uint8Array.from(bytes), "/document");
      if (!decoded.ok) return { ok: false };
      const parsed = parseStrictJson(decoded.value, "/document");
      if (!parsed.ok) return { ok: false };
      const privacy = validatePrivateData(parsed.value, "/document");
      if (!privacy.ok) return { ok: false };
      const validated = validateReviewDocument(parsed.value);
      if (!validated.ok) return { ok: false };
      const roundTrip = serializeReviewDocument(validated.value);
      return roundTrip.ok && sameBytes(roundTrip.value, expectedBytes) ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function parseCanonicalReviewDocumentBytes(
  bytes: Uint8Array,
): GeneratorResult<ReviewDocumentV1> {
  try {
    const decoded = decodeStrictUtf8(bytes, "/document");
    if (!decoded.ok) return generatorFailure(decoded.errors);
    const parsed = parseStrictJson(decoded.value, "/document");
    if (!parsed.ok) return generatorFailure(parsed.errors);
    const privacy = validatePrivateData(parsed.value, "/document");
    if (!privacy.ok) return generatorFailure(privacy.errors);
    const validated = validateReviewDocument(parsed.value);
    if (!validated.ok) return generatorFailure(validated.errors);
    const expected = serializeReviewDocument(validated.value);
    if (!expected.ok || !sameBytes(bytes, expected.value)) {
      return generatorFailure([generatorError("ARTIFACT_FORMAT_INVALID", "/document")]);
    }
    return generatorSuccess(validated.value);
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/document")]);
  }
}
