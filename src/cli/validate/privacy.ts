import { validationError, validationErrors, validationSuccess } from "./errors.js";
import { snapshotSafeJson } from "./safe-input.js";
import { escapePointerSegment } from "./text.js";
import type { ValidationError, ValidationResult } from "./types.js";

const PRIVATE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:bearer\s+[A-Za-z0-9._~-]{12,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/iu,
  /\b(?:authorization\s*[:=]\s*(?:bearer|basic)|api[_ -]?key\s*[:=]|access[_ -]?token\s*[:=]|secret\s*[:=]|password\s*[:=]|cookie\s*[:=])\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /(?:^|[\s("'])file:\/\//iu,
  /(?:^|[\s("'])\/(?:Users|home)\/[^/\s]+\//u,
  /\b[A-Za-z]:\\Users\\[^\\\s]+\\/u,
  /\b(?:session|thread|conversation)[ _-]?id\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f-]{27,}/iu,
  /\b(?:raw (?:chat|conversation)|private (?:chat|prompt)|system prompt transcript)\b/iu,
] as const;

function hasPrivacyViolation(value: string): boolean {
  return PRIVATE_PATTERNS.some((pattern) => pattern.test(value));
}

function collect(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value === "string") {
    if (hasPrivacyViolation(value)) errors.push(validationError("PRIVACY_VIOLATION", path));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collect(item, `${path}/${index}`, errors);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (hasPrivacyViolation(key)) {
      errors.push(validationError("PRIVACY_VIOLATION", path));
      continue;
    }
    collect(item, `${path}/${escapePointerSegment(key)}`, errors);
  }
}

export function validatePrivateSnapshot(value: unknown, path = ""): ValidationResult<true> {
  const errors: ValidationError[] = [];
  collect(value, path, errors);
  return errors.length === 0 ? validationSuccess(true) : validationErrors(errors);
}

export function validatePrivateData(value: unknown, path = ""): ValidationResult<true> {
  const snapshot = snapshotSafeJson(value, path);
  return snapshot.ok ? validatePrivateSnapshot(snapshot.value, path) : snapshot;
}

export function validatePrivateText(text: string, path: string): ValidationResult<true> {
  return typeof text !== "string"
    ? validationErrors([validationError("PRIVACY_VIOLATION", path)])
    : hasPrivacyViolation(text)
    ? validationErrors([validationError("PRIVACY_VIOLATION", path)])
    : validationSuccess(true);
}
