import {
  validateReviewDocument as generatedValidateReviewDocument,
  validateReviewPacket as generatedValidateReviewPacket,
  validateReviewState as generatedValidateReviewState,
} from "./schema.generated.js";
import type {
  ReviewDocumentV1,
  ReviewPacketV1,
  ReviewStateV1,
} from "./types.generated.js";
import {
  failure,
  protocolError,
  success,
  type ProtocolResult,
  type SchemaErrorCode,
} from "./errors.js";

interface StandaloneError {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
}

interface StandaloneValidator {
  (value: unknown): boolean;
  errors?: StandaloneError[] | null;
}

interface JsonCloneSuccess {
  ok: true;
  value: unknown;
}

interface JsonCloneFailure {
  ok: false;
  path: string;
}

type JsonCloneResult = JsonCloneSuccess | JsonCloneFailure;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function pointer(path: string, segment: string): string {
  return `${path}/${escapePointerSegment(segment)}`;
}

function cloneJsonValue(value: unknown, path: string, seen: WeakSet<object>): JsonCloneResult {
  if (value === null || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    return hasUnpairedSurrogate(value) ? { ok: false, path } : { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, path };
  }
  if (typeof value !== "object") return { ok: false, path };
  if (seen.has(value)) return { ok: false, path };
  seen.add(value);

  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return { ok: false, path };
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || typeof lengthDescriptor.value !== "number") return { ok: false, path };
      const length = lengthDescriptor.value;
      const elementKeys = keys.filter((key) => key !== "length");
      if (elementKeys.length !== length || elementKeys.some((key) =>
        typeof key !== "string"
        || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= length)) {
        return { ok: false, path };
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false, path: pointer(path, String(index)) };
        }
        const child = cloneJsonValue(descriptor.value, pointer(path, String(index)), seen);
        if (!child.ok) return child;
        output.push(child.value);
      }
      return { ok: true, value: output };
    }

    if (prototype !== Object.prototype && prototype !== null) return { ok: false, path };
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return { ok: false, path };
      if (hasUnpairedSurrogate(key)) return { ok: false, path };
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false, path: pointer(path, key) };
      }
      const child = cloneJsonValue(descriptor.value, pointer(path, key), seen);
      if (!child.ok) return child;
      Object.defineProperty(output, key, {
        value: child.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false, path };
  } finally {
    seen.delete(value);
  }
}

export function cloneSafeJson(value: unknown, path = ""): ProtocolResult<unknown> {
  const cloned = cloneJsonValue(value, path, new WeakSet<object>());
  return cloned.ok
    ? success(cloned.value)
    : failure([protocolError("SCHEMA_TYPE", cloned.path)]);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

const SCHEMA_ERROR_CODES: Readonly<Record<string, SchemaErrorCode>> = {
  additionalProperties: "SCHEMA_ADDITIONAL_PROPERTIES",
  const: "SCHEMA_CONST",
  contains: "SCHEMA_CONTAINS",
  enum: "SCHEMA_ENUM",
  format: "SCHEMA_FORMAT",
  maxContains: "SCHEMA_MAX_CONTAINS",
  maxItems: "SCHEMA_MAX_ITEMS",
  minItems: "SCHEMA_MIN_ITEMS",
  minLength: "SCHEMA_MIN_LENGTH",
  minimum: "SCHEMA_MINIMUM",
  oneOf: "SCHEMA_ONE_OF",
  pattern: "SCHEMA_PATTERN",
  required: "SCHEMA_REQUIRED",
  type: "SCHEMA_TYPE",
  uniqueItems: "SCHEMA_UNIQUE_ITEMS",
};

function schemaErrorCode(keyword: string, params: Readonly<Record<string, unknown>>): SchemaErrorCode {
  if (keyword === "contains" && typeof params.maxContains === "number") {
    return "SCHEMA_MAX_CONTAINS";
  }
  return SCHEMA_ERROR_CODES[keyword] ?? "SCHEMA_ONE_OF";
}

function locateSchemaError(error: StandaloneError, input: unknown) {
  let path = error.instancePath;
  if (error.keyword === "required") {
    path += `/${escapePointerSegment(String(error.params.missingProperty))}`;
  } else if (error.keyword === "additionalProperties") {
    path += `/${escapePointerSegment(String(error.params.additionalProperty))}`;
  }

  const blockMatch = /^\/blocks\/(\d+)/.exec(path);
  let blockId: string | null = null;
  if (blockMatch && input !== null && typeof input === "object") {
    const blocks = (input as { blocks?: unknown }).blocks;
    const index = Number(blockMatch[1]);
    if (Array.isArray(blocks)) {
      const block = blocks[index];
      if (block !== null && typeof block === "object" && typeof block.id === "string") {
        blockId = block.id;
      }
    }
  }
  return protocolError(schemaErrorCode(error.keyword, error.params), path, blockId);
}

function validateSchema<T>(validator: StandaloneValidator, value: unknown): ProtocolResult<T> {
  const safe = cloneSafeJson(value);
  if (!safe.ok) return safe;
  try {
    if (validator(safe.value)) return success(safe.value as T);
    return failure((validator.errors ?? []).map((error) => locateSchemaError(error, safe.value)));
  } catch {
    return failure([protocolError("SCHEMA_TYPE", "")]);
  }
}

export function validateReviewDocumentSchema(value: unknown): ProtocolResult<ReviewDocumentV1> {
  return validateSchema(generatedValidateReviewDocument as StandaloneValidator, value);
}

export function validateReviewPacketSchema(value: unknown): ProtocolResult<ReviewPacketV1> {
  return validateSchema(generatedValidateReviewPacket as StandaloneValidator, value);
}

export function validateReviewStateSchema(value: unknown): ProtocolResult<ReviewStateV1> {
  return validateSchema(generatedValidateReviewState as StandaloneValidator, value);
}
