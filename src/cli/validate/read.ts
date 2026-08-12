import { dirname, parse, resolve } from "node:path";
import {
  MAX_INPUT_FILE_BYTES,
  readRelativeRegularFile,
  resolveExistingInputRoot,
  validateRelativeTarget,
  type ResolvedInputRoot,
} from "../io/index.js";
import {
  fromCliIoError,
  validationError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import type { Sha256Digest } from "../../protocol/index.js";
import type { ValidationResult } from "./types.js";

export interface SafeReadValue {
  bytes: Uint8Array;
  digest: Sha256Digest;
  relativePath: string;
}

export async function resolveInputRoot(path: string): Promise<ValidationResult<{
  root: ResolvedInputRoot;
  absolutePath: string;
}>> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return validationErrors([validationError("ARGUMENT_INVALID", "/inputDir")]);
  }
  const absolutePath = resolve(path);
  const rootResult = await resolveExistingInputRoot({ inputDir: dirname(absolutePath) });
  return rootResult.ok
    ? validationSuccess({ root: rootResult.value, absolutePath })
    : validationErrors(rootResult.errors.map(fromCliIoError));
}

export async function readFromRoot(
  root: ResolvedInputRoot,
  relativePath: string,
  maxBytes = MAX_INPUT_FILE_BYTES,
): Promise<ValidationResult<SafeReadValue>> {
  const target = validateRelativeTarget(relativePath);
  if (!target.ok) return validationErrors(target.errors.map(fromCliIoError));
  const read = await readRelativeRegularFile({ root, target: target.value, maxBytes });
  return read.ok
    ? validationSuccess({ ...read.value, relativePath })
    : validationErrors(read.errors.map(fromCliIoError));
}

export async function readPath(path: string, maxBytes = MAX_INPUT_FILE_BYTES): Promise<ValidationResult<SafeReadValue>> {
  const resolved = await resolveInputRoot(path);
  if (!resolved.ok) return resolved;
  return readFromRoot(resolved.value.root, parse(resolved.value.absolutePath).base, maxBytes);
}
