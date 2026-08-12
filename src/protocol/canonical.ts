import { canonicalize } from "json-canonicalize";
import type {
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const INVALID_JSON = "Value is not valid JSON";

function assertValidJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(INVALID_JSON);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(INVALID_JSON);
    }
  }
}

function snapshotCanonicalInput(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(INVALID_JSON);
    return value;
  }
  if (typeof value === "string") {
    assertValidJsonString(value);
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(INVALID_JSON);
  }
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError(INVALID_JSON);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || typeof lengthDescriptor.value !== "number") throw new TypeError(INVALID_JSON);
      const length = lengthDescriptor.value;
      const elementKeys = keys.filter((key) => key !== "length");
      if (elementKeys.length !== length || elementKeys.some((key) =>
        typeof key !== "string"
        || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= length)) throw new TypeError(INVALID_JSON);
      const output = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(INVALID_JSON);
        }
        Object.defineProperty(output, String(index), {
          value: snapshotCanonicalInput(descriptor.value, ancestors),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      let toJsonProbePending = true;
      const proxy: unknown[] = new Proxy(output, {
        get(target, property, receiver) {
          if (property === "toJSON" && toJsonProbePending) {
            toJsonProbePending = false;
            return undefined;
          }
          if (property === "forEach") {
            return (callback: (element: unknown, index: number, array: unknown[]) => void): void => {
              for (let index = 0; index < output.length; index += 1) {
                callback(output[index], index, proxy);
              }
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      return proxy;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(INVALID_JSON);
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError(INVALID_JSON);
      assertValidJsonString(key);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(INVALID_JSON);
      }
      Object.defineProperty(output, key, {
        value: snapshotCanonicalInput(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    let toJsonProbePending = true;
    return new Proxy(output, {
      get(target, property, receiver) {
        if (property === "toJSON" && toJsonProbePending) {
          toJsonProbePending = false;
          return undefined;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  } catch {
    throw new TypeError(INVALID_JSON);
  } finally {
    ancestors.delete(value);
  }
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return compareUnicodeCodePoints(left.id, right.id);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareUnicodeCodePoints);
}

export function canonicalReviewDocument(input: ReviewDocumentV1): ReviewDocumentV1 {
  const value = structuredClone(input);

  value.evidence.sourceHierarchy.sort(
    (left, right) => left.rank - right.rank || compareUnicodeCodePoints(left.id, right.id),
  );
  value.evidence.facts.sort(byId);
  value.evidence.decisions.sort(byId);
  for (const item of [...value.evidence.facts, ...value.evidence.decisions]) {
    item.sourceRefs = sortedStrings(item.sourceRefs);
  }
  for (const conflict of value.evidence.conflicts) {
    conflict.itemRefs = sortedStrings(conflict.itemRefs);
  }

  for (const block of value.blocks) {
    block.dependencies = sortedStrings(block.dependencies);
    block.claimRefs = sortedStrings(block.claimRefs);
    block.decisionRefs = sortedStrings(block.decisionRefs);
  }
  value.glossary.sort(byId);
  value.approvals.history.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.blockId, right.blockId)
      || left.approvedRound - right.approvedRound,
  );
  value.approvals.currentFrozen = sortedStrings(value.approvals.currentFrozen);

  value.lineage.topicMappings.sort((left, right) =>
    compareUnicodeCodePoints(left.topicId, right.topicId));
  value.lineage.impactAssessments.sort(
    (left, right) =>
      left.changedAtRound - right.changedAtRound
      || compareUnicodeCodePoints(left.upstreamBlockId, right.upstreamBlockId),
  );
  for (const assessment of value.lineage.impactAssessments) {
    assessment.affectedDownstreamIds = sortedStrings(assessment.affectedDownstreamIds);
  }
  value.lineage.feedbackResolutions.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.sourcePacketId, right.sourcePacketId)
      || compareUnicodeCodePoints(left.feedbackId, right.feedbackId)
      || compareUnicodeCodePoints(left.feedbackDigest, right.feedbackDigest),
  );
  return value;
}

export function canonicalReviewPacket(input: ReviewPacketV1): ReviewPacketV1 {
  const value = structuredClone(input);
  value.frozenCarried = sortedStrings(value.frozenCarried);
  value.reopened = sortedStrings(value.reopened);
  value.decisions.sort((left, right) => compareUnicodeCodePoints(left.blockId, right.blockId));
  value.sideNotes.sort(byId);
  value.topics.sort(byId);
  return value;
}

export function canonicalReviewState(input: ReviewStateV1): ReviewStateV1 {
  const value = structuredClone(input);
  value.reopened = sortedStrings(value.reopened);
  value.decisions.sort((left, right) => compareUnicodeCodePoints(left.blockId, right.blockId));
  value.sideNotes.sort(byId);
  value.topics.sort(byId);
  return value;
}

export function canonicalJson(value: unknown): string {
  try {
    const result = canonicalize(snapshotCanonicalInput(value, new WeakSet<object>()));
    if (typeof result !== "string") throw new TypeError(INVALID_JSON);
    return result;
  } catch {
    throw new TypeError(INVALID_JSON);
  }
}

export function canonicalJsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
