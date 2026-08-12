import { dirname, parse, resolve } from "node:path";
import {
  sha256Bytes,
  type ReviewDocumentV1,
} from "../../protocol/index.js";
import {
  GENERATOR_VERSION,
  generateArtifactBytes,
} from "../../generators/index.js";
import { containsDraftDecisionSlot } from "../../generators/draft.js";
import { generatorError } from "../../generators/errors.js";
import {
  MAX_INPUT_FILE_BYTES,
  assertPortableTargetSet,
  commitFileTransaction,
  readRelativeRegularFile,
  resolveExistingInputRoot,
  resolveOutputRoot,
  validateRelativeTarget,
  type FileTransactionTarget,
  type ResolvedInputRoot,
  type ValidatedRelativeTarget,
} from "../io/index.js";
import { CLI_EXIT_CODES, exitCodeForCliIoResult } from "../exit-codes.js";
import {
  buildBatchHandoff,
  createAgentArtifactByteVerifier,
  createApprovalArtifactByteVerifier,
  createGeneratedReplacementByteVerifiers,
  decodeStrictUtf8,
  parseStrictJson,
  validateDeliverableDocument,
  validateDeliveryAndBuildHandoff,
  validatePrivateData,
  type BatchHandoff,
  type DeliveryHandoff,
  type GeneratedArtifactByteVerifier,
  type ValidationError,
} from "../validate.js";
import type { CliIoError } from "../result.js";
import type {
  RenderCommandOutcome,
  RenderFailure,
  RenderRuntimeOptions,
  RenderSuccess,
} from "./types.js";

interface ParsedRenderArguments {
  documents: string[];
  replaceGenerated: boolean;
  confirmOutputScope?: "tracked" | "public";
}

interface LoadedDocument {
  document: ReviewDocumentV1;
  contractRelativePath: string;
}

interface PreparedDelivery extends LoadedDocument {
  agentBytes: Uint8Array;
  approvalBytes: Uint8Array;
  handoff: DeliveryHandoff;
  agentTarget: ValidatedRelativeTarget;
  approvalTarget: ValidatedRelativeTarget;
}

interface ReplacementVerifiers {
  agent: GeneratedArtifactByteVerifier;
  approval: GeneratedArtifactByteVerifier;
}

function failure(
  errors: readonly (ValidationError | CliIoError)[],
  exitCode: number,
  mutated = false,
  recoveryRequired = false,
): RenderCommandOutcome {
  const result: RenderFailure = {
    status: "failed",
    phase: "render",
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
  if (errors.some((error) => error.code === "ARTIFACT_MISSING" || error.code === "ARTIFACT_DRIFT"
    || error.code === "PLACEHOLDER_REMAINS" || error.code === "INTERNAL_LINK_INVALID"
    || error.code === "SPLIT_GROUP_INVALID")) {
    return CLI_EXIT_CODES.ACCEPTANCE_FAILED;
  }
  if (errors.every((error) => error.code === "ARGUMENT_INVALID" || error.code === "INPUT_UTF8_INVALID")) {
    return CLI_EXIT_CODES.CALL_OR_IO;
  }
  return CLI_EXIT_CODES.PROTOCOL_IDENTITY_OR_SECURITY;
}

function parseArguments(argv: readonly string[]):
  | { ok: true; value: ParsedRenderArguments }
  | { ok: false; errors: ValidationError[] } {
  const values = argv[0] === "render" ? argv.slice(1) : [...argv];
  const documents: string[] = [];
  let replaceGenerated = false;
  let confirmOutputScope: "tracked" | "public" | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--replace-generated") {
      if (replaceGenerated) return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments")] };
      replaceGenerated = true;
      continue;
    }
    if (flag !== "--document" && flag !== "--confirm-output-scope") {
      return { ok: false, errors: [generatorError("ARGUMENT_INVALID", `/arguments/${index}`)] };
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, errors: [generatorError("ARGUMENT_INVALID", `/arguments/${index}`)] };
    }
    index += 1;
    if (flag === "--document") documents.push(value);
    else {
      if (confirmOutputScope !== undefined || (value !== "tracked" && value !== "public")) {
        return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments/confirm-output-scope")] };
      }
      confirmOutputScope = value;
    }
  }
  if (documents.length === 0) {
    return { ok: false, errors: [generatorError("ARGUMENT_INVALID", "/arguments/document")] };
  }
  return {
    ok: true,
    value: {
      documents,
      replaceGenerated,
      ...(confirmOutputScope === undefined ? {} : { confirmOutputScope }),
    },
  };
}

async function readDocument(
  root: ResolvedInputRoot,
  contractRelativePath: string,
): Promise<{ ok: true; value: LoadedDocument } | { ok: false; errors: readonly (ValidationError | CliIoError)[]; exitCode: number }> {
  const target = validateRelativeTarget(contractRelativePath);
  if (!target.ok) return { ok: false, errors: target.errors, exitCode: exitCodeForCliIoResult(target) };
  const read = await readRelativeRegularFile({ root, target: target.value, maxBytes: MAX_INPUT_FILE_BYTES });
  if (!read.ok) return { ok: false, errors: read.errors, exitCode: exitCodeForCliIoResult(read) };
  const decoded = decodeStrictUtf8(read.value.bytes, "/document");
  if (!decoded.ok) return { ok: false, errors: decoded.errors, exitCode: validationExit(decoded.errors) };
  const parsed = parseStrictJson(decoded.value, "/document");
  if (!parsed.ok) return { ok: false, errors: parsed.errors, exitCode: validationExit(parsed.errors) };
  const privacy = validatePrivateData(parsed.value, "/document");
  if (!privacy.ok) return { ok: false, errors: privacy.errors, exitCode: validationExit(privacy.errors) };
  const validated = validateDeliverableDocument(parsed.value);
  if (!validated.ok) return { ok: false, errors: validated.errors, exitCode: validationExit(validated.errors) };
  if (containsDraftDecisionSlot(validated.value)) {
    const errors = [generatorError("DOCUMENT_NOT_REVIEWABLE", "/document/blocks")];
    return { ok: false, errors, exitCode: validationExit(errors) };
  }
  return { ok: true, value: { document: validated.value, contractRelativePath } };
}

function expectedConfirmation(documents: readonly ReviewDocumentV1[]): "tracked" | "public" | undefined {
  if (documents.some((document) => document.delivery.repositoryStatus === "public-approved")) return "public";
  if (documents.some((document) => document.delivery.repositoryStatus === "tracked-approved")) return "tracked";
  return undefined;
}

function preflightSplitGroup(deliveries: readonly LoadedDocument[]): ValidationError[] {
  if (deliveries.length === 1) {
    return deliveries[0]?.document.delivery.splitGroup === undefined
      ? []
      : [generatorError("SPLIT_GROUP_INVALID", "/document/delivery/splitGroup")];
  }
  const groups = deliveries.map((delivery) => delivery.document.delivery.splitGroup);
  const first = groups[0];
  if (first === undefined) return [generatorError("SPLIT_GROUP_INVALID", "/batch/group")];
  const parts = new Set<number>();
  for (const [index, group] of groups.entries()) {
    if (group === undefined || group.groupId !== first.groupId || group.total !== first.total
      || group.reason !== first.reason || parts.has(group.part)) {
      return [generatorError("SPLIT_GROUP_INVALID", `/batch/parts/${index}`)];
    }
    parts.add(group.part);
  }
  if (first.total !== deliveries.length
    || [...parts].sort((left, right) => left - right).some((part, index) => part !== index + 1)) {
    return [generatorError("SPLIT_GROUP_INVALID", "/batch/group")];
  }
  return [];
}

function preflightPortableNames(deliveries: readonly LoadedDocument[]):
  | { ok: true; artifactTargets: Map<string, ValidatedRelativeTarget> }
  | { ok: false; errors: readonly CliIoError[]; exitCode: number } {
  const allTargets: ValidatedRelativeTarget[] = [];
  const artifactTargets = new Map<string, ValidatedRelativeTarget>();
  for (const delivery of deliveries) {
    const names = [
      delivery.contractRelativePath,
      delivery.document.delivery.baseName,
      delivery.document.delivery.outputs.agent,
      delivery.document.delivery.outputs.approval,
    ];
    for (const name of names) {
      const target = validateRelativeTarget(name);
      if (!target.ok) return { ok: false, errors: target.errors, exitCode: exitCodeForCliIoResult(target) };
      allTargets.push(target.value);
      artifactTargets.set(name, target.value);
    }
  }
  const targetSet = assertPortableTargetSet(allTargets);
  if (!targetSet.ok) return { ok: false, errors: targetSet.errors, exitCode: exitCodeForCliIoResult(targetSet) };
  return { ok: true, artifactTargets };
}

function prepareDelivery(
  loaded: LoadedDocument,
  templateBytes: Uint8Array,
  targets: ReadonlyMap<string, ValidatedRelativeTarget>,
): { ok: true; value: PreparedDelivery } | { ok: false; errors: readonly ValidationError[] } {
  const generated = generateArtifactBytes({
    document: loaded.document,
    approvalTemplateBytes: templateBytes,
  });
  if (!generated.ok) return generated;
  const agentTarget = targets.get(loaded.document.delivery.outputs.agent);
  const approvalTarget = targets.get(loaded.document.delivery.outputs.approval);
  if (agentTarget === undefined || approvalTarget === undefined) {
    return { ok: false, errors: [generatorError("INTERNAL_ERROR", "/targets")] };
  }
  const complete = validateDeliveryAndBuildHandoff({
    document: loaded.document,
    agentBytes: generated.value.agent,
    approvalBytes: generated.value.approval,
    approvalTemplateBytes: templateBytes,
    expectedGeneratorVersion: GENERATOR_VERSION,
    agent: {
      relativePath: loaded.document.delivery.outputs.agent,
      byteDigest: sha256Bytes(generated.value.agent),
    },
    approval: {
      relativePath: loaded.document.delivery.outputs.approval,
      byteDigest: sha256Bytes(generated.value.approval),
    },
  });
  return complete.ok
    ? {
        ok: true,
        value: {
          ...loaded,
          agentBytes: generated.value.agent,
          approvalBytes: generated.value.approval,
          handoff: complete.value.handoff,
          agentTarget,
          approvalTarget,
        },
      }
    : complete;
}

async function prepareReplacementVerifiers(
  root: ResolvedInputRoot,
  deliveries: readonly PreparedDelivery[],
  templateBytes: Uint8Array,
): Promise<
  | { ok: true; value: ReplacementVerifiers[] }
  | { ok: false; errors: readonly (ValidationError | CliIoError)[]; exitCode: number }
> {
  const replacements: ReplacementVerifiers[] = [];
  for (const delivery of deliveries) {
    const existingAgent = await readRelativeRegularFile({
      root,
      target: delivery.agentTarget,
      maxBytes: MAX_INPUT_FILE_BYTES,
    });
    if (!existingAgent.ok) {
      return {
        ok: false,
        errors: existingAgent.errors,
        exitCode: exitCodeForCliIoResult(existingAgent),
      };
    }
    const existingApproval = await readRelativeRegularFile({
      root,
      target: delivery.approvalTarget,
      maxBytes: MAX_INPUT_FILE_BYTES,
    });
    if (!existingApproval.ok) {
      return {
        ok: false,
        errors: existingApproval.errors,
        exitCode: exitCodeForCliIoResult(existingApproval),
      };
    }
    const replacement = createGeneratedReplacementByteVerifiers({
      currentDocument: delivery.document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
      existingAgentBytes: existingAgent.value.bytes,
      existingApprovalBytes: existingApproval.value.bytes,
    });
    if (!replacement.ok) {
      return {
        ok: false,
        errors: replacement.errors,
        exitCode: validationExit(replacement.errors),
      };
    }
    replacements.push(replacement.value);
  }
  return { ok: true, value: replacements };
}

function transactionTargets(
  deliveries: readonly PreparedDelivery[],
  templateBytes: Uint8Array,
  replaceGenerated: boolean,
  replacements: readonly ReplacementVerifiers[],
): { ok: true; value: FileTransactionTarget[] } | { ok: false; errors: readonly ValidationError[] } {
  const targets: FileTransactionTarget[] = [];
  for (const [index, delivery] of deliveries.entries()) {
    const replacement = replacements[index];
    if (replaceGenerated && replacement === undefined) {
      return { ok: false, errors: [generatorError("INTERNAL_ERROR", "/replacement")] };
    }
    const agentVerifier = createAgentArtifactByteVerifier({
      document: delivery.document,
      generatorVersion: GENERATOR_VERSION,
    });
    const approvalVerifier = createApprovalArtifactByteVerifier({
      document: delivery.document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
    });
    if (replaceGenerated && replacement !== undefined) {
      targets.push({
        target: delivery.agentTarget,
        bytes: delivery.agentBytes,
        disposition: "replace",
        verifyStaged: agentVerifier,
        verifyExisting: replacement.agent,
      });
      targets.push({
        target: delivery.approvalTarget,
        bytes: delivery.approvalBytes,
        disposition: "replace",
        verifyStaged: approvalVerifier,
        verifyExisting: replacement.approval,
      });
    } else {
      targets.push({
        target: delivery.agentTarget,
        bytes: delivery.agentBytes,
        disposition: "create",
        verifyStaged: agentVerifier,
      });
      targets.push({
        target: delivery.approvalTarget,
        bytes: delivery.approvalBytes,
        disposition: "create",
        verifyStaged: approvalVerifier,
      });
    }
  }
  return { ok: true, value: targets };
}

export async function runRenderCommand(
  argv: readonly string[],
  runtime: RenderRuntimeOptions = {},
): Promise<RenderCommandOutcome> {
  try {
    const parsed = parseArguments(argv);
    if (!parsed.ok) return failure(parsed.errors, CLI_EXIT_CODES.CALL_OR_IO);
    const runtimeTemplateBytes = runtime.approvalTemplateBytes;
    if (!(runtimeTemplateBytes instanceof Uint8Array)) {
      return failure([generatorError("ARGUMENT_INVALID", "/runtime/approvalTemplateBytes")], CLI_EXIT_CODES.CALL_OR_IO);
    }
    const templateBytes = Uint8Array.from(runtimeTemplateBytes);
    const absolutePaths = parsed.value.documents.map((path) => resolve(path));
    const inputDir = dirname(absolutePaths[0]!);
    if (absolutePaths.some((path) => dirname(path) !== inputDir)) {
      return failure([generatorError("SPLIT_GROUP_INVALID", "/batch/root")], CLI_EXIT_CODES.ACCEPTANCE_FAILED);
    }
    const root = await resolveExistingInputRoot({ inputDir });
    if (!root.ok) return failure(root.errors, exitCodeForCliIoResult(root));
    const loaded: LoadedDocument[] = [];
    for (const path of absolutePaths) {
      const result = await readDocument(root.value, parse(path).base);
      if (!result.ok) return failure(result.errors, result.exitCode);
      loaded.push(result.value);
    }
    const splitErrors = preflightSplitGroup(loaded);
    if (splitErrors.length > 0) return failure(splitErrors, validationExit(splitErrors));
    const sorted = loaded.length === 1
      ? loaded
      : [...loaded].sort((left, right) =>
          left.document.delivery.splitGroup!.part - right.document.delivery.splitGroup!.part);
    const requiredConfirmation = expectedConfirmation(sorted.map((item) => item.document));
    if (requiredConfirmation !== parsed.value.confirmOutputScope) {
      return failure([generatorError("ARGUMENT_INVALID", "/arguments/confirm-output-scope")], CLI_EXIT_CODES.CALL_OR_IO);
    }
    const portable = preflightPortableNames(sorted);
    if (!portable.ok) return failure(portable.errors, portable.exitCode);
    const prepared: PreparedDelivery[] = [];
    for (const item of sorted) {
      const result = prepareDelivery(item, templateBytes, portable.artifactTargets);
      if (!result.ok) return failure(result.errors, validationExit(result.errors));
      prepared.push(result.value);
    }
    let handoff: DeliveryHandoff | BatchHandoff;
    if (prepared.length === 1) handoff = prepared[0]!.handoff;
    else {
      const batch = buildBatchHandoff({ deliveries: prepared.map((item) => ({
        document: item.document,
        contractRelativePath: item.contractRelativePath,
        handoff: item.handoff,
      })) });
      if (!batch.ok) return failure(batch.errors, validationExit(batch.errors));
      handoff = batch.value;
    }
    const replacements = parsed.value.replaceGenerated
      ? await prepareReplacementVerifiers(root.value, prepared, templateBytes)
      : { ok: true as const, value: [] };
    if (!replacements.ok) return failure(replacements.errors, replacements.exitCode);
    const targets = transactionTargets(
      prepared,
      templateBytes,
      parsed.value.replaceGenerated,
      replacements.value,
    );
    if (!targets.ok) return failure(targets.errors, validationExit(targets.errors));
    const outputRoot = await resolveOutputRoot({
      outputDir: inputDir,
      creation: "must-exist",
      freshness: "allow-business-entries",
    });
    if (!outputRoot.ok) {
      return failure(
        outputRoot.errors,
        exitCodeForCliIoResult(outputRoot),
        outputRoot.mutated,
        outputRoot.recoveryRequired,
      );
    }
    const committed = await commitFileTransaction({
      root: outputRoot.value,
      generatorVersion: GENERATOR_VERSION,
      targets: targets.value,
    });
    if (!committed.ok) {
      return failure(
        committed.errors,
        exitCodeForCliIoResult(committed),
        committed.mutated,
        committed.recoveryRequired,
      );
    }
    const result: RenderSuccess = {
      status: "ok",
      phase: "render",
      mode: prepared.length === 1 ? "delivery" : "batch",
      mutated: true,
      handoff,
    };
    return { exitCode: 0, result };
  } catch {
    return failure([generatorError("INTERNAL_ERROR", "/")], CLI_EXIT_CODES.INTERNAL);
  }
}
