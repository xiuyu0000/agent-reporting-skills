import type { CliIoErrorCode, CliIoResult } from "./result.js";

export const CLI_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  CALL_OR_IO: 2,
  PROTOCOL_IDENTITY_OR_SECURITY: 3,
  BUSINESS_BLOCKED: 4,
  ACCEPTANCE_FAILED: 5,
  INTERNAL: 70,
} as const);

const SECURITY_CODES = new Set<CliIoErrorCode>([
  "PATH_ESCAPE",
  "SYMLINK_REJECTED",
  "PORTABLE_PATH_COLLISION",
  "CROSS_DEVICE_TRANSACTION",
  "TARGET_EXISTS",
  "REPLACE_IDENTITY_MISMATCH",
  "STAGED_CONTENT_INVALID",
  "TRANSACTION_MANIFEST_INVALID",
  "TRANSACTION_OWNER_UNKNOWN",
  "TRANSACTION_DIGEST_MISMATCH",
]);

export function exitCodeForCliIoResult(result: CliIoResult<unknown>): number {
  if (result.ok) return CLI_EXIT_CODES.SUCCESS;
  if (result.recoveryRequired) return CLI_EXIT_CODES.INTERNAL;
  return result.errors.some((error) => SECURITY_CODES.has(error.code))
    ? CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY
    : CLI_EXIT_CODES.CALL_OR_IO;
}
