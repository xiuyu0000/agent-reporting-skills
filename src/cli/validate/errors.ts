import { CLI_EXIT_CODES } from "../exit-codes.js";
import type { CliIoError } from "../result.js";
import type { ProtocolError } from "../../protocol/index.js";
import {
  VAL_ERROR_CODES,
  type ValErrorCode,
  type ValidateFailure,
  type ValidationError,
  type ValidationResult,
} from "./types.js";

const ERROR_TEXT: Readonly<Record<ValErrorCode, readonly [message: string, hint: string]>> = {
  ARGUMENT_INVALID: [
    "The validate command arguments do not match a supported mode.",
    "Use the documented validate mode and its exact required options.",
  ],
  INPUT_UTF8_INVALID: [
    "An input file is not strict UTF-8 text.",
    "Save the input as UTF-8 without a byte-order mark or malformed sequences.",
  ],
  INPUT_JSON_INVALID: [
    "An input file is not valid JSON.",
    "Provide one complete JSON value with unique object keys.",
  ],
  LEGACY_CONTRACT_INCOMPATIBLE: [
    "The v0.1 static dual-report contract is incompatible with the review workspace.",
    "Reinitialize as review-document/1 or use the v0.1 rollback package.",
  ],
  ARTIFACT_FORMAT_INVALID: [
    "A generated artifact does not match its frozen static grammar.",
    "Regenerate both artifacts from the exact validated review document.",
  ],
  ARTIFACT_IDENTITY_MISMATCH: [
    "A generated artifact is bound to a different delivery or review snapshot.",
    "Use artifacts generated together from this document version and round.",
  ],
  PRIVACY_VIOLATION: [
    "An input or artifact contains a prohibited privacy or credential pattern.",
    "Remove the sensitive value and retain only the minimum supporting evidence.",
  ],
  EXTERNAL_RESOURCE_FORBIDDEN: [
    "The approval artifact contains a forbidden runtime resource or outbound target.",
    "Keep scripts, styles, fonts, images, frames, and forms entirely offline.",
  ],
  CSP_INVALID: [
    "The approval artifact Content Security Policy is missing or inconsistent.",
    "Restore the fixed offline directives and exact inline script/style hashes.",
  ],
  DOCUMENT_NOT_REVIEWABLE: [
    "The document lifecycle state is not deliverable for review.",
    "Complete the draft or correct the in-review/finalized freeze state before delivery.",
  ],
  BLOCKING_CONFLICT: [
    "The document contains an unresolved blocking evidence conflict.",
    "Resolve the conflict or remove unsupported conclusions before delivery.",
  ],
  ARTIFACT_MISSING: [
    "A required generated artifact is missing.",
    "Generate and validate both the Agent Markdown and Approval HTML.",
  ],
  ARTIFACT_DRIFT: [
    "A generated artifact differs from the fixed template or embedded document.",
    "Regenerate both artifacts in one transaction from the same snapshot.",
  ],
  PLACEHOLDER_REMAINS: [
    "A generated artifact still contains an unresolved template placeholder.",
    "Fill every frozen generator token before publishing the artifact.",
  ],
  INTERNAL_LINK_INVALID: [
    "An internal link does not resolve to a known target.",
    "Correct the fragment or add the intended in-document target.",
  ],
  SPLIT_GROUP_INVALID: [
    "The split delivery is incomplete or internally inconsistent.",
    "Provide one closed group with consecutive parts and unique identities and paths.",
  ],
  INTERNAL_ERROR: [
    "Validate stopped because of an unexpected internal error.",
    "Retry from verified inputs; if the failure repeats, stop and inspect the local installation.",
  ],
};

export function validationError(code: ValErrorCode, path: string): ValidationError {
  const [message, hint] = ERROR_TEXT[code];
  return { code, path: safePointer(path), blockId: null, message, hint };
}

export function fromProtocolError(error: ProtocolError): ValidationError {
  const path = error.code === "SCHEMA_ADDITIONAL_PROPERTIES"
    ? error.path.slice(0, Math.max(0, error.path.lastIndexOf("/")))
    : error.path;
  return {
    code: error.code,
    path: safePointer(path),
    blockId: error.blockId,
    message: error.message,
    hint: error.hint,
  };
}

export function fromCliIoError(error: CliIoError): ValidationError {
  return {
    code: error.code,
    path: safePointer(error.path),
    blockId: null,
    message: error.message,
    hint: error.hint,
  };
}

function safePointer(path: string): string {
  return typeof path === "string" && (path === "" || path.startsWith("/")) && !path.includes("\0")
    ? path
    : "/";
}

export function stableErrors(errors: readonly ValidationError[]): ValidationError[] {
  return [...errors].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return 0;
  });
}

export function validationSuccess<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function validationErrors<T = never>(errors: readonly ValidationError[]): ValidationResult<T> {
  return { ok: false, errors: stableErrors(errors) };
}

export function failureEnvelope(errors: readonly ValidationError[]): ValidateFailure {
  return {
    status: "failed",
    phase: "validate",
    mutated: false,
    recoveryRequired: false,
    errors: stableErrors(errors),
  };
}

const VAL_EXIT = new Map<ValErrorCode, number>([
  ["ARGUMENT_INVALID", CLI_EXIT_CODES.CALL_OR_IO],
  ["INPUT_UTF8_INVALID", CLI_EXIT_CODES.CALL_OR_IO],
  ["INPUT_JSON_INVALID", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["LEGACY_CONTRACT_INCOMPATIBLE", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["ARTIFACT_FORMAT_INVALID", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["ARTIFACT_IDENTITY_MISMATCH", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["PRIVACY_VIOLATION", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["EXTERNAL_RESOURCE_FORBIDDEN", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["CSP_INVALID", CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY],
  ["DOCUMENT_NOT_REVIEWABLE", CLI_EXIT_CODES.BUSINESS_BLOCKED],
  ["BLOCKING_CONFLICT", CLI_EXIT_CODES.BUSINESS_BLOCKED],
  ["ARTIFACT_MISSING", CLI_EXIT_CODES.ACCEPTANCE_FAILED],
  ["ARTIFACT_DRIFT", CLI_EXIT_CODES.ACCEPTANCE_FAILED],
  ["PLACEHOLDER_REMAINS", CLI_EXIT_CODES.ACCEPTANCE_FAILED],
  ["INTERNAL_LINK_INVALID", CLI_EXIT_CODES.ACCEPTANCE_FAILED],
  ["SPLIT_GROUP_INVALID", CLI_EXIT_CODES.ACCEPTANCE_FAILED],
  ["INTERNAL_ERROR", CLI_EXIT_CODES.INTERNAL],
]);

const IO_SECURITY_CODES = new Set(["SYMLINK_REJECTED", "PATH_ESCAPE", "CROSS_DEVICE_TRANSACTION"]);
const PROTOCOL_BUSINESS_CODES = new Set(["IDENTITY_CONFIRMATION_REQUIRED"]);

export function exitCodeForValidationErrors(errors: readonly ValidationError[]): number {
  let exitCode: number = CLI_EXIT_CODES.SUCCESS;
  for (const error of errors) {
    if ((VAL_ERROR_CODES as readonly string[]).includes(error.code)) {
      exitCode = Math.max(exitCode, VAL_EXIT.get(error.code as ValErrorCode) ?? CLI_EXIT_CODES.INTERNAL);
    } else if (error.code === "PATH_INVALID" || error.code === "IO_OPERATION_FAILED") {
      exitCode = Math.max(exitCode, CLI_EXIT_CODES.CALL_OR_IO);
    } else if (IO_SECURITY_CODES.has(error.code)) {
      exitCode = Math.max(exitCode, CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY);
    } else if (PROTOCOL_BUSINESS_CODES.has(error.code)) {
      exitCode = Math.max(exitCode, CLI_EXIT_CODES.BUSINESS_BLOCKED);
    } else {
      exitCode = Math.max(exitCode, CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY);
    }
  }
  return exitCode === CLI_EXIT_CODES.SUCCESS ? CLI_EXIT_CODES.INTERNAL : exitCode;
}
