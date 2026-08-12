import { validationError, validationErrors, validationSuccess } from "./errors.js";
import type { ValidationResult } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

export function decodeStrictUtf8(bytes: Uint8Array, path: string): ValidationResult<string> {
  try {
    if (!(bytes instanceof Uint8Array)) {
      return validationErrors([validationError("INPUT_UTF8_INVALID", path)]);
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return validationErrors([validationError("INPUT_UTF8_INVALID", path)]);
    }
    const text = decoder.decode(bytes);
    if (text.includes("\0")) {
      return validationErrors([validationError("INPUT_UTF8_INVALID", path)]);
    }
    return validationSuccess(text);
  } catch {
    return validationErrors([validationError("INPUT_UTF8_INVALID", path)]);
  }
}

export function parseStrictJson(text: string, path: string): ValidationResult<unknown> {
  try {
    if (hasDuplicateObjectKeys(text)) {
      return validationErrors([validationError("INPUT_JSON_INVALID", path)]);
    }
    const value = JSON.parse(text) as unknown;
    return validationSuccess(value);
  } catch {
    return validationErrors([validationError("INPUT_JSON_INVALID", path)]);
  }
}

function hasDuplicateObjectKeys(text: string): boolean {
  let index = 0;
  const whitespace = /[\t\n\r ]/u;
  const skipWhitespace = (): void => {
    while (whitespace.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const parseValue = (): boolean => {
    skipWhitespace();
    if (text[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return false;
      }
      while (index < text.length) {
        const key = parseString();
        if (key === undefined) return false;
        if (keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") return false;
        index += 1;
        if (parseValue()) return true;
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return false;
        }
        if (text[index] !== ",") return false;
        index += 1;
        skipWhitespace();
      }
      return false;
    }
    if (text[index] === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return false;
      }
      while (index < text.length) {
        if (parseValue()) return true;
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return false;
        }
        if (text[index] !== ",") return false;
        index += 1;
      }
      return false;
    }
    if (text[index] === '"') {
      parseString();
      return false;
    }
    while (index < text.length && !/[\t\n\r ,\]}]/u.test(text[index] ?? "")) index += 1;
    return false;
  };
  return parseValue();
}

export function isLegacyStaticContract(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === "dual-audience-report-contract-v1"
    || record.format === "dual-audience-report-contract-v1";
}

export function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
