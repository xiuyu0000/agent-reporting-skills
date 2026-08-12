import {
  protocolError,
  type ProtocolError,
  type ProtocolErrorCode,
} from "../../protocol/index.js";
import { CLI_IO_ERROR_CODES } from "../result.js";
import {
  exitCodeForValidationErrors,
  fromProtocolError,
  validationError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import {
  createExactGeneratedArtifactByteVerifiers as createExactGeneratedArtifactByteVerifiersFromParsers,
} from "./parsers.js";
import { snapshotSafeJson } from "./safe-input.js";
import { isLegacyStaticContract } from "./text.js";
import {
  VAL_ERROR_CODES,
  type ExactGeneratedArtifactByteVerifierInput,
  type ExactGeneratedArtifactByteVerifiers,
  type ValErrorCode,
  type ValidationExitInput,
  type ValidationFailureRequest,
  type ValidationResult,
} from "./types.js";

function internalFailure<T = never>(): ValidationResult<T> {
  return validationErrors([validationError("INTERNAL_ERROR", "")]);
}

function ownKeysAre(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isValErrorCode(value: unknown): value is ValErrorCode {
  return typeof value === "string" && (VAL_ERROR_CODES as readonly string[]).includes(value);
}

function isSafeErrorPath(value: string): boolean {
  return (value === "" || value.startsWith("/")) && !value.includes("\0");
}

function isSafeBlockId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^B(?=0*[1-9])[0-9]{3,}$/u.test(value));
}

function canonicalProtocolError(value: unknown): ProtocolError | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!ownKeysAre(record, ["code", "path", "blockId", "message", "hint"])
    || typeof record.code !== "string"
    || typeof record.path !== "string"
    || !isSafeErrorPath(record.path)
    || !isSafeBlockId(record.blockId)
    || typeof record.message !== "string"
    || typeof record.hint !== "string") {
    return undefined;
  }
  try {
    const rebuilt = protocolError(record.code as ProtocolErrorCode, record.path, record.blockId);
    return typeof rebuilt.message === "string" && typeof rebuilt.hint === "string"
      ? rebuilt
      : undefined;
  } catch {
    return undefined;
  }
}

function isValidationError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const valCode = typeof record.code === "string"
    && (VAL_ERROR_CODES as readonly string[]).includes(record.code);
  const ioCode = typeof record.code === "string"
    && (CLI_IO_ERROR_CODES as readonly string[]).includes(record.code);
  const protocolCode = canonicalProtocolError(record) !== undefined;
  return ownKeysAre(record, ["code", "path", "blockId", "message", "hint"])
    && (valCode || ioCode || protocolCode)
    && typeof record.path === "string"
    && isSafeErrorPath(record.path)
    && (protocolCode ? isSafeBlockId(record.blockId) : record.blockId === null)
    && typeof record.message === "string"
    && typeof record.hint === "string";
}

export function rejectLegacyStaticContract(input: unknown): ValidationResult<true> {
  const snapshot = snapshotSafeJson(input, "");
  if (!snapshot.ok) return snapshot;
  try {
    return isLegacyStaticContract(snapshot.value)
      ? validationErrors([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")])
      : validationSuccess(true);
  } catch {
    return internalFailure();
  }
}

export function createValidationFailureResult(
  input: ValidationFailureRequest,
): ValidationResult<never> {
  const snapshot = snapshotSafeJson<ValidationFailureRequest>(input, "");
  if (!snapshot.ok) return internalFailure();
  try {
    const request = snapshot.value as unknown as Record<string, unknown>;
    if (request.kind === "validation-code") {
      if (!ownKeysAre(request, ["kind", "code", "path"])
        || !isValErrorCode(request.code)
        || typeof request.path !== "string"
        || !isSafeErrorPath(request.path)) {
        return internalFailure();
      }
      return validationErrors([validationError(request.code, request.path)]);
    }
    if (request.kind === "protocol-errors") {
      if (!ownKeysAre(request, ["kind", "errors"]) || !Array.isArray(request.errors)) {
        return internalFailure();
      }
      const errors: ProtocolError[] = [];
      for (const value of request.errors) {
        const error = canonicalProtocolError(value);
        if (error === undefined) return internalFailure();
        errors.push(error);
      }
      return errors.length === 0
        ? internalFailure()
        : validationErrors(errors.map(fromProtocolError));
    }
    return internalFailure();
  } catch {
    return internalFailure();
  }
}

export function exitCodeForValidationResult(input: ValidationExitInput): number {
  const snapshot = snapshotSafeJson<ValidationExitInput>(input, "");
  if (!snapshot.ok) return 70;
  try {
    const result = snapshot.value as unknown as Record<string, unknown>;
    if (result.ok === true && ownKeysAre(result, ["ok"])) return 0;
    if (result.ok !== false || !ownKeysAre(result, ["ok", "errors"])
      || !Array.isArray(result.errors) || result.errors.length === 0) {
      return 70;
    }
    if (!result.errors.every(isValidationError)) return 70;
    return exitCodeForValidationErrors(result.errors as never);
  } catch {
    return 70;
  }
}

export function createExactGeneratedArtifactByteVerifiers(
  input: ExactGeneratedArtifactByteVerifierInput,
): ValidationResult<ExactGeneratedArtifactByteVerifiers> {
  return createExactGeneratedArtifactByteVerifiersFromParsers(input);
}
