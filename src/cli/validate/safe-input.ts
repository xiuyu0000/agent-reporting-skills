import { isProxy } from "node:util/types";
import { protocolError } from "../../protocol/index.js";
import {
  fromProtocolError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import type { ValidationResult } from "./types.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;

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

interface SnapshotSuccess {
  ok: true;
  value: unknown;
}

interface SnapshotFailure {
  ok: false;
}

type SnapshotResult = SnapshotSuccess | SnapshotFailure;

function copyBytes(value: object): Uint8Array | undefined {
  if (!ArrayBuffer.isView(value) || typedArrayName === undefined || typedArrayLength === undefined) {
    return undefined;
  }
  const name = Reflect.apply(typedArrayName, value, []) as unknown;
  if (name !== "Uint8Array") return undefined;
  const length = Reflect.apply(typedArrayLength, value, []) as unknown;
  if (!Number.isSafeInteger(length) || (length as number) < 0) return undefined;
  const output = new Uint8Array(length as number);
  Uint8Array.prototype.set.call(output, value as unknown as ArrayLike<number>);
  return output;
}

function snapshotValue(
  value: unknown,
  ancestors: WeakSet<object>,
  allowBytes: boolean,
): SnapshotResult {
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "string") {
    return hasUnpairedSurrogate(value) ? { ok: false } : { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "object" || isProxy(value) || ancestors.has(value)) return { ok: false };

  ancestors.add(value);
  try {
    if (allowBytes) {
      const bytes = copyBytes(value);
      if (bytes !== undefined) return { ok: true, value: bytes };
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return { ok: false };
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        return { ok: false };
      }
      const length = lengthDescriptor.value as number;
      const elementKeys = keys.filter((key) => key !== "length");
      if (elementKeys.length !== length || elementKeys.some((key) =>
        typeof key !== "string"
        || !/^(?:0|[1-9]\d*)$/u.test(key)
        || Number(key) >= length)) {
        return { ok: false };
      }
      const output = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false };
        }
        const child = snapshotValue(descriptor.value, ancestors, allowBytes);
        if (!child.ok) return child;
        Object.defineProperty(output, String(index), {
          value: child.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { ok: true, value: output };
    }

    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string" || hasUnpairedSurrogate(key)) return { ok: false };
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return { ok: false };
      const child = snapshotValue(descriptor.value, ancestors, allowBytes);
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
    return { ok: false };
  } finally {
    ancestors.delete(value);
  }
}

function snapshot<T>(value: unknown, path: string, allowBytes: boolean): ValidationResult<T> {
  const result = snapshotValue(value, new WeakSet<object>(), allowBytes);
  return result.ok
    ? validationSuccess(result.value as T)
    : validationErrors([fromProtocolError(protocolError("SCHEMA_TYPE", path))]);
}

export function snapshotSafeJson<T = unknown>(value: unknown, path = ""): ValidationResult<T> {
  return snapshot<T>(value, path, false);
}

export function snapshotSafeInput<T = unknown>(value: unknown, path = ""): ValidationResult<T> {
  return snapshot<T>(value, path, true);
}
