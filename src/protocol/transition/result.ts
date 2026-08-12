import {
  canonicalJson,
  protocolError,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolResult,
} from "../index.js";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function succeed<T>(value: T): ProtocolResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(errors: readonly ProtocolError[]): ProtocolResult<T> {
  const unique = new Map<string, ProtocolError>();
  for (const error of errors) {
    unique.set(`${error.path}\u0000${error.code}\u0000${error.blockId ?? ""}`, error);
  }
  return {
    ok: false,
    mutated: false,
    errors: [...unique.values()].sort(
      (left, right) =>
        compare(left.path, right.path)
        || compare(left.code, right.code)
        || compare(left.blockId ?? "", right.blockId ?? ""),
    ),
  };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function snapshotRecord(
  input: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): ProtocolResult<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(canonicalJson(input)) as unknown;
  } catch {
    return fail([protocolError("SCHEMA_TYPE", path)]);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail([protocolError("SCHEMA_TYPE", path)]);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const errors: ProtocolError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(protocolError("SCHEMA_ADDITIONAL_PROPERTIES", `${path}/${pointerSegment(key)}`));
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      errors.push(protocolError("SCHEMA_REQUIRED", `${path}/${pointerSegment(key)}`));
    }
  }
  return errors.length === 0 ? succeed(record) : fail(errors);
}

export function prefixedErrors(
  errors: readonly ProtocolError[],
  prefix: string,
): ProtocolError[] {
  return errors.map((error) => ({ ...error, path: `${prefix}${error.path}` }));
}

export function error(
  code: ProtocolErrorCode,
  path: string,
  blockId: string | null = null,
): ProtocolError {
  return protocolError(code, path, blockId);
}

export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
