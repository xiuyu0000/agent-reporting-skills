import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  sha256Bytes,
  validateReviewDocument,
  type ReviewDocumentV1,
} from "../../protocol/index.js";
import {
  GENERATOR_VERSION,
  createReviewDocumentByteVerifier,
  serializeReviewDocument,
} from "../../generators/index.js";
import { createDraftReviewDocument } from "../../generators/draft.js";
import {
  commitFileTransaction,
  resolveOutputRoot,
  validateRelativeTarget,
} from "../io/index.js";
import { CLI_EXIT_CODES, exitCodeForCliIoResult } from "../exit-codes.js";
import type { CliIoError } from "../result.js";
import { validatePrivateData, type ValidationError } from "../validate.js";
import { generatorError } from "../../generators/errors.js";
import type {
  InitCommandOutcome,
  InitFailure,
  InitRuntimeOptions,
  InitSuccess,
} from "./types.js";

interface ParsedInitArguments {
  outputDir: string;
  baseName: string;
  title: string;
  language: string;
  uiLocale: "zh-CN" | "en";
  asOf: string;
  contractName: string;
  repositoryStatus: ReviewDocumentV1["delivery"]["repositoryStatus"];
  confirmOutputScope?: "tracked" | "public";
}

const REQUIRED_FLAGS = [
  "--output-dir",
  "--base-name",
  "--title",
  "--language",
  "--ui-locale",
  "--as-of",
] as const;
const OPTIONAL_FLAGS = new Set([
  "--contract-name",
  "--repository-status",
  "--confirm-output-scope",
]);
const BASE_NAME = /^[A-Za-z0-9_-]+$/u;
const CONTRACT_NAME = /^(?:review-document\.json|[A-Za-z0-9_-]+\.review-document\.json)$/u;

function failure(
  errors: readonly (ValidationError | CliIoError)[],
  exitCode: number,
  mutated = false,
  recoveryRequired = false,
): InitCommandOutcome {
  const result: InitFailure = {
    status: "failed",
    phase: "init",
    mutated,
    recoveryRequired,
    errors: [...errors].sort((left, right) => left.path === right.path
      ? left.code < right.code ? -1 : left.code > right.code ? 1 : 0
      : left.path < right.path ? -1 : 1),
  };
  return { exitCode, result };
}

function validationExit(errors: readonly ValidationError[]): number {
  if (errors.some((error) => error.code === "INTERNAL_ERROR")) return CLI_EXIT_CODES.INTERNAL;
  if (errors.some((error) => error.code === "DOCUMENT_NOT_REVIEWABLE" || error.code === "BLOCKING_CONFLICT")) {
    return CLI_EXIT_CODES.BUSINESS_BLOCKED;
  }
  if (errors.every((error) => error.code === "ARGUMENT_INVALID" || error.code === "INPUT_UTF8_INVALID")) {
    return CLI_EXIT_CODES.CALL_OR_IO;
  }
  return CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY;
}

function parseArguments(argv: readonly string[]):
  | { ok: true; value: ParsedInitArguments }
  | { ok: false; errors: ValidationError[] } {
  const values = argv[0] === "init" ? argv.slice(1) : [...argv];
  if (values.length % 2 !== 0) {
    return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments")] };
  }
  const options = new Map<string, string>();
  const allowed = new Set<string>([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || options.has(flag)
      || !flag.startsWith("--") || value.startsWith("--")) {
      return { ok: false, errors: [generatorError("ARGUMENT_INVALID", `/arguments/${index}`)] };
    }
    options.set(flag, value);
  }
  if (REQUIRED_FLAGS.some((flag) => !options.has(flag))) {
    return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments")] };
  }
  const repositoryStatus = options.get("--repository-status") ?? "local-only";
  const confirmOutputScope = options.get("--confirm-output-scope");
  const uiLocale = options.get("--ui-locale");
  const baseName = options.get("--base-name") ?? "";
  const contractName = options.get("--contract-name") ?? "review-document.json";
  if (!BASE_NAME.test(baseName) || !CONTRACT_NAME.test(contractName)
    || (uiLocale !== "zh-CN" && uiLocale !== "en")
    || (repositoryStatus !== "local-only" && repositoryStatus !== "tracked-approved" && repositoryStatus !== "public-approved")
    || (confirmOutputScope !== undefined && confirmOutputScope !== "tracked" && confirmOutputScope !== "public")
    || (repositoryStatus === "local-only" && confirmOutputScope !== undefined)
    || (repositoryStatus === "tracked-approved" && confirmOutputScope !== "tracked")
    || (repositoryStatus === "public-approved" && confirmOutputScope !== "public")) {
    return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments")] };
  }
  return {
    ok: true,
    value: {
      outputDir: options.get("--output-dir")!,
      baseName,
      title: options.get("--title")!,
      language: options.get("--language")!,
      uiLocale,
      asOf: options.get("--as-of")!,
      contractName,
      repositoryStatus,
      ...(confirmOutputScope === undefined ? {} : { confirmOutputScope }),
    },
  };
}

function createId(prefix: "RDL" | "RD", randomBytes: (size: number) => Uint8Array): string | undefined {
  try {
    const bytes = randomBytes(10);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 10) return undefined;
    return `${prefix}-${Buffer.from(bytes).toString("hex").toUpperCase()}`;
  } catch {
    return undefined;
  }
}

export async function runInitCommand(
  argv: readonly string[],
  runtime: InitRuntimeOptions = {},
): Promise<InitCommandOutcome> {
  try {
    const parsed = parseArguments(argv);
    if (!parsed.ok) return failure(parsed.errors, CLI_EXIT_CODES.CALL_OR_IO);
    const randomBytes = runtime.randomBytes ?? nodeRandomBytes;
    const deliveryId = createId("RDL", randomBytes);
    const documentId = createId("RD", randomBytes);
    if (deliveryId === undefined || documentId === undefined) {
      return failure([generatorError("INTERNAL_ERROR", "/random")], CLI_EXIT_CODES.INTERNAL);
    }
    const document = createDraftReviewDocument({
      deliveryId,
      documentId,
      baseName: parsed.value.baseName,
      repositoryStatus: parsed.value.repositoryStatus,
      title: parsed.value.title,
      language: parsed.value.language,
      uiLocale: parsed.value.uiLocale,
      asOf: parsed.value.asOf,
    });
    const privacy = validatePrivateData(document, "/document");
    if (!privacy.ok) return failure(privacy.errors, validationExit(privacy.errors));
    const validated = validateReviewDocument(document);
    if (!validated.ok) return failure(validated.errors, CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY);
    const serialized = serializeReviewDocument(validated.value);
    if (!serialized.ok) return failure(serialized.errors, validationExit(serialized.errors));
    const target = validateRelativeTarget(parsed.value.contractName);
    if (!target.ok) return failure(target.errors, exitCodeForCliIoResult(target));
    const root = await resolveOutputRoot({
      outputDir: parsed.value.outputDir,
      creation: "create-if-missing",
      freshness: "allow-business-entries",
    });
    if (!root.ok) {
      return failure(root.errors, exitCodeForCliIoResult(root), root.mutated, root.recoveryRequired);
    }
    const committed = await commitFileTransaction({
      root: root.value,
      generatorVersion: GENERATOR_VERSION,
      targets: [{
        target: target.value,
        bytes: serialized.value,
        disposition: "create",
        verifyStaged: createReviewDocumentByteVerifier(validated.value),
      }],
    });
    if (!committed.ok) {
      return failure(
        committed.errors,
        exitCodeForCliIoResult(committed),
        committed.mutated,
        committed.recoveryRequired,
      );
    }
    const result: InitSuccess = {
      status: "ok",
      phase: "init",
      mutated: true,
      contract: {
        relativePath: parsed.value.contractName,
        byteDigest: sha256Bytes(serialized.value),
      },
      document: {
        format: "review-document/1",
        deliveryId,
        documentId,
        contentVersion: 1,
        round: 1,
        status: "draft",
      },
    };
    return { exitCode: 0, result };
  } catch {
    return failure([generatorError("INTERNAL_ERROR", "/")], CLI_EXIT_CODES.INTERNAL);
  }
}
