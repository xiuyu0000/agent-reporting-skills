import { dirname, parse, resolve } from "node:path";
import { isPromise, isProxy } from "node:util/types";
import {
  compareUnicodeCodePoints,
  migratePrototypePacketUnbound,
  parseReviewPacketMarkdown,
  parseReviewPacketMarkdownUnbound,
  sha256Bytes,
  validateReviewDocument,
  validateReviewPacket,
  type LegacyIdentityConfirmation,
  type ProtocolError,
  type ReviewDocumentV1,
  type ReviewPacketV1,
} from "../../protocol/index.js";
import {
  validateTransition,
  type TransitionApplyPlan,
} from "../../protocol/transition/index.js";
import {
  GENERATOR_VERSION,
  createReviewDocumentByteVerifier,
  generateArtifactBytes,
  serializeReviewDocument,
} from "../../generators/index.js";
import {
  MAX_INPUT_FILE_BYTES,
  assertPortableTargetSet,
  commitFreshFileTransaction,
  readRelativeRegularFile,
  resolveExistingInputRoot,
  validateRelativeTarget,
  type CliIoError,
  type CliIoResult,
  type FileTransactionTarget,
  type ValidatedRelativeTarget,
} from "../io/index.js";
import { CLI_EXIT_CODES, exitCodeForCliIoResult } from "../exit-codes.js";
import {
  createExactGeneratedArtifactByteVerifiers,
  createValidationFailureResult,
  decodeStrictUtf8,
  exitCodeForValidationResult,
  parseStrictJson,
  rejectLegacyStaticContract,
  validateDeliveryAndBuildHandoff,
  validatePrivateData,
  type DeliveryHandoff,
  type GeneratedArtifactByteVerifier,
  type ValErrorCode,
  type ValidationError,
  type ValidationResult,
} from "../validate.js";
import type {
  ConsumeApplyHandoff,
  ConsumeCommandOutcome,
  ConsumeFailure,
  ConsumeRuntimeOptions,
} from "./types.js";

interface ParsedConsumeArguments {
  current: string;
  packet: string;
  candidate: string;
  outputDir: string;
  derived: Array<{ topicId: string; path: string }>;
  legacyProfile?: "prototype-v1";
  confirmation?: LegacyIdentityConfirmation;
  confirmOutputScope?: "tracked" | "public";
}

interface ReadBytesValue {
  bytes: Uint8Array;
}

type StepResult<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: ConsumeCommandOutcome };

interface ReadyPreflight {
  outputDir: string;
  plan: TransitionApplyPlan;
  deliveries: PreparedDeliveryTarget[];
}

interface PreparedDeliveryTarget {
  topicId?: string;
  document: ReviewDocumentV1;
  contractRelativePath: string;
  contractTarget: ValidatedRelativeTarget;
  agentTarget: ValidatedRelativeTarget;
  approvalTarget: ValidatedRelativeTarget;
}

interface GeneratedDelivery extends PreparedDeliveryTarget {
  contractBytes: Uint8Array;
  agentBytes: Uint8Array;
  approvalBytes: Uint8Array;
  contractVerifier: (bytes: Uint8Array) => { ok: true } | { ok: false };
  agentVerifier: GeneratedArtifactByteVerifier;
  approvalVerifier: GeneratedArtifactByteVerifier;
  handoff: DeliveryHandoff;
}

const SINGLE_FLAGS = new Set([
  "--current",
  "--packet",
  "--candidate",
  "--output-dir",
  "--legacy-profile",
  "--confirm-document-id",
  "--confirm-content-version",
  "--confirm-round",
  "--confirm-output-scope",
]);
const REQUIRED_FLAGS = ["--current", "--packet", "--candidate", "--output-dir"] as const;
const TOPIC_ID = /^TOP-(?=0*[1-9])\d{3,}$/u;
const encoder = new TextEncoder();

function compareErrors(
  left: ValidationError | CliIoError,
  right: ValidationError | CliIoError,
): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function failure(
  errors: readonly (ValidationError | CliIoError)[],
  exitCode: number,
  mutated = false,
  recoveryRequired = false,
): ConsumeCommandOutcome {
  const result: ConsumeFailure = {
    status: "failed",
    phase: "consume",
    mutated,
    recoveryRequired,
    errors: [...errors].sort(compareErrors),
  };
  return { exitCode, result };
}

function validationFailure(result: { ok: false; errors: readonly ValidationError[] }): ConsumeCommandOutcome {
  return failure(result.errors, exitCodeForValidationResult(result));
}

function localFailure(code: ValErrorCode, path: string): ConsumeCommandOutcome {
  const result = createValidationFailureResult({ kind: "validation-code", code, path });
  if (result.ok) throw new Error("unreachable validation facade success");
  return validationFailure(result);
}

function protocolFailure(errors: readonly ProtocolError[]): ConsumeCommandOutcome {
  const result = createValidationFailureResult({ kind: "protocol-errors", errors });
  if (result.ok) throw new Error("unreachable validation facade success");
  return validationFailure(result);
}

function ioFailure(result: Extract<CliIoResult<unknown>, { ok: false }>): ConsumeCommandOutcome {
  return failure(
    result.errors,
    exitCodeForCliIoResult(result),
    result.mutated,
    result.recoveryRequired,
  );
}

function snapshotArgv(input: unknown): string[] | undefined {
  try {
    if (!Array.isArray(input) || isProxy(input)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      return undefined;
    }
    const values: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)
        || !descriptor.enumerable || typeof descriptor.value !== "string") {
        return undefined;
      }
      values.push(descriptor.value);
    }
    const allowedKeys = new Set(["length", ...values.map((_, index) => String(index))]);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      return undefined;
    }
    return values;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseArguments(input: unknown): StepResult<ParsedConsumeArguments> {
  const snapshot = snapshotArgv(input);
  if (snapshot === undefined) return { ok: false, outcome: localFailure("ARGUMENT_INVALID", "/arguments") };
  const values = snapshot[0] === "consume" ? snapshot.slice(1) : snapshot;
  const single = new Map<string, string>();
  const derived: Array<{ topicId: string; path: string }> = [];
  const derivedIds = new Set<string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === undefined || value === undefined || value.length === 0
      || !flag.startsWith("--") || value.startsWith("--")) {
      return { ok: false, outcome: localFailure("ARGUMENT_INVALID", `/arguments/${index}`) };
    }
    if (flag === "--derived") {
      const separator = value.indexOf("=");
      const topicId = separator < 0 ? "" : value.slice(0, separator);
      const path = separator < 0 ? "" : value.slice(separator + 1);
      if (!TOPIC_ID.test(topicId) || path.length === 0 || derivedIds.has(topicId)) {
        return {
          ok: false,
          outcome: localFailure("ARGUMENT_INVALID", `/arguments/derived/${derived.length}`),
        };
      }
      derivedIds.add(topicId);
      derived.push({ topicId, path });
      continue;
    }
    if (!SINGLE_FLAGS.has(flag) || single.has(flag)) {
      return { ok: false, outcome: localFailure("ARGUMENT_INVALID", `/arguments/${index}`) };
    }
    single.set(flag, value);
  }
  if (REQUIRED_FLAGS.some((flag) => !single.has(flag))) {
    return { ok: false, outcome: localFailure("ARGUMENT_INVALID", "/arguments") };
  }
  const legacyProfile = single.get("--legacy-profile");
  const confirmationValues = {
    documentId: single.get("--confirm-document-id"),
    contentVersion: single.get("--confirm-content-version"),
    round: single.get("--confirm-round"),
  };
  const confirmationCount = Object.values(confirmationValues)
    .filter((value) => value !== undefined).length;
  if ((legacyProfile !== undefined && legacyProfile !== "prototype-v1")
    || (confirmationCount > 0 && (legacyProfile !== "prototype-v1" || confirmationCount !== 3))) {
    return {
      ok: false,
      outcome: localFailure("ARGUMENT_INVALID", "/arguments/legacy-profile"),
    };
  }
  let confirmation: LegacyIdentityConfirmation | undefined;
  if (confirmationCount === 3) {
    const contentVersion = positiveInteger(confirmationValues.contentVersion);
    const round = positiveInteger(confirmationValues.round);
    if (confirmationValues.documentId === undefined || contentVersion === undefined || round === undefined) {
      return {
        ok: false,
        outcome: localFailure("ARGUMENT_INVALID", "/arguments/legacy-profile"),
      };
    }
    confirmation = {
      documentId: confirmationValues.documentId,
      contentVersion,
      round,
    };
  }
  const confirmOutputScope = single.get("--confirm-output-scope");
  if (confirmOutputScope !== undefined && confirmOutputScope !== "tracked" && confirmOutputScope !== "public") {
    return {
      ok: false,
      outcome: localFailure("ARGUMENT_INVALID", "/arguments/confirm-output-scope"),
    };
  }
  return {
    ok: true,
    value: {
      current: single.get("--current")!,
      packet: single.get("--packet")!,
      candidate: single.get("--candidate")!,
      outputDir: single.get("--output-dir")!,
      derived,
      ...(legacyProfile === undefined ? {} : { legacyProfile: "prototype-v1" as const }),
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(confirmOutputScope === undefined ? {} : { confirmOutputScope }),
    },
  };
}

async function readPathBytes(path: string): Promise<StepResult<ReadBytesValue>> {
  const absolutePath = resolve(path);
  const target = validateRelativeTarget(parse(absolutePath).base);
  if (!target.ok) return { ok: false, outcome: ioFailure(target) };
  const root = await resolveExistingInputRoot({ inputDir: dirname(absolutePath) });
  if (!root.ok) return { ok: false, outcome: ioFailure(root) };
  const read = await readRelativeRegularFile({
    root: root.value,
    target: target.value,
    maxBytes: MAX_INPUT_FILE_BYTES,
  });
  return read.ok
    ? { ok: true, value: { bytes: read.value.bytes } }
    : { ok: false, outcome: ioFailure(read) };
}

function validationStep<T>(result: ValidationResult<T>): StepResult<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, outcome: validationFailure(result) };
}

function protocolStep<T>(result: { ok: true; value: T } | { ok: false; errors: ProtocolError[] }): StepResult<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, outcome: protocolFailure(result.errors) };
}

async function readCurrent(path: string): Promise<StepResult<ReviewDocumentV1>> {
  const read = await readPathBytes(path);
  if (!read.ok) return read;
  const decoded = validationStep(decodeStrictUtf8(read.value.bytes, "/current"));
  if (!decoded.ok) return decoded;
  const parsed = validationStep(parseStrictJson(decoded.value, "/current"));
  if (!parsed.ok) return parsed;
  const legacy = validationStep(rejectLegacyStaticContract(parsed.value));
  if (!legacy.ok) return legacy;
  const privacy = validationStep(validatePrivateData(parsed.value, "/current"));
  if (!privacy.ok) return privacy;
  return protocolStep(validateReviewDocument(parsed.value));
}

async function readPacket(
  arguments_: ParsedConsumeArguments,
): Promise<StepResult<{ packet: ReviewPacketV1; markdown?: string }>> {
  const read = await readPathBytes(arguments_.packet);
  if (!read.ok) return read;
  const decoded = validationStep(decodeStrictUtf8(read.value.bytes, "/packet"));
  if (!decoded.ok) return decoded;
  if (arguments_.legacyProfile === undefined && !decoded.value.trimStart().startsWith("{")) {
    const privacy = validationStep(validatePrivateData(decoded.value, "/packet"));
    if (!privacy.ok) return privacy;
    const packet = protocolStep(parseReviewPacketMarkdownUnbound(decoded.value));
    return packet.ok
      ? { ok: true, value: { packet: packet.value, markdown: decoded.value } }
      : packet;
  }
  const parsed = validationStep(parseStrictJson(decoded.value, "/packet"));
  if (!parsed.ok) return parsed;
  const legacy = validationStep(rejectLegacyStaticContract(parsed.value));
  if (!legacy.ok) return legacy;
  const privacy = validationStep(validatePrivateData(parsed.value, "/packet"));
  if (!privacy.ok) return privacy;
  const packet = arguments_.legacyProfile === undefined
    ? validateReviewPacket(parsed.value)
    : migratePrototypePacketUnbound(parsed.value, {
        profile: arguments_.legacyProfile,
        ...(arguments_.confirmation === undefined ? {} : { confirmation: arguments_.confirmation }),
      });
  const result = protocolStep(packet);
  return result.ok ? { ok: true, value: { packet: result.value } } : result;
}

async function readTransitionValue(path: string, errorPath: string): Promise<StepResult<unknown>> {
  const read = await readPathBytes(path);
  if (!read.ok) return read;
  const decoded = validationStep(decodeStrictUtf8(read.value.bytes, errorPath));
  if (!decoded.ok) return decoded;
  const parsed = validationStep(parseStrictJson(decoded.value, errorPath));
  if (!parsed.ok) return parsed;
  const legacy = validationStep(rejectLegacyStaticContract(parsed.value));
  if (!legacy.ok) return legacy;
  const privacy = validationStep(validatePrivateData(parsed.value, errorPath));
  return privacy.ok ? { ok: true, value: parsed.value } : privacy;
}

function expectedConfirmation(plan: TransitionApplyPlan): "tracked" | "public" | undefined {
  const documents = [plan.candidate, ...plan.derived.map((item) => item.document)];
  if (documents.some((document) => document.delivery.repositoryStatus === "public-approved")) return "public";
  return documents.some((document) => document.delivery.repositoryStatus === "tracked-approved")
    ? "tracked"
    : undefined;
}

function splitGroupFailure(plan: TransitionApplyPlan): ConsumeCommandOutcome | undefined {
  if (plan.candidate.delivery.splitGroup !== undefined) {
    return localFailure("SPLIT_GROUP_INVALID", "/candidate/delivery/splitGroup");
  }
  const index = plan.derived.findIndex((item) => item.document.delivery.splitGroup !== undefined);
  return index < 0
    ? undefined
    : localFailure("SPLIT_GROUP_INVALID", `/derived/${index}/document/delivery/splitGroup`);
}

function preflightTargets(plan: TransitionApplyPlan): StepResult<PreparedDeliveryTarget[]> {
  const ordered = [
    { document: plan.candidate },
    ...[...plan.derived]
      .sort((left, right) => compareUnicodeCodePoints(left.topicId, right.topicId))
      .map((item) => ({ topicId: item.topicId, document: item.document })),
  ];
  const portableSet: ValidatedRelativeTarget[] = [];
  const deliveries: PreparedDeliveryTarget[] = [];
  for (const item of ordered) {
    const contractRelativePath = `${item.document.delivery.baseName}.review-document.json`;
    const names = [
      contractRelativePath,
      item.document.delivery.baseName,
      item.document.delivery.outputs.agent,
      item.document.delivery.outputs.approval,
    ];
    const targets: ValidatedRelativeTarget[] = [];
    for (const name of names) {
      const target = validateRelativeTarget(name);
      if (!target.ok) return { ok: false, outcome: ioFailure(target) };
      targets.push(target.value);
      portableSet.push(target.value);
    }
    deliveries.push({
      ...item,
      contractRelativePath,
      contractTarget: targets[0]!,
      agentTarget: targets[2]!,
      approvalTarget: targets[3]!,
    });
  }
  const checked = assertPortableTargetSet(portableSet);
  return checked.ok
    ? { ok: true, value: deliveries }
    : { ok: false, outcome: ioFailure(checked) };
}

function isCandidateRequest(errors: readonly ProtocolError[]): boolean {
  return errors.length === 1
    && errors[0]?.code === "DECISION_APPLICATION_INVALID"
    && errors[0]?.path === "/candidate";
}

async function preflight(argv: unknown): Promise<StepResult<ReadyPreflight>> {
  try {
    const arguments_ = parseArguments(argv);
    if (!arguments_.ok) return arguments_;
    const current = await readCurrent(arguments_.value.current);
    if (!current.ok) return current;
    const packet = await readPacket(arguments_.value);
    if (!packet.ok) return packet;
    const replay = validateTransition({ current: current.value, packet: packet.value.packet });
    if (replay.ok) {
      if (replay.value.status !== "noop") {
        return { ok: false, outcome: localFailure("INTERNAL_ERROR", "") };
      }
      return {
        ok: false,
        outcome: {
          exitCode: CLI_EXIT_CODES.SUCCESS,
          result: {
            status: "ok",
            phase: "consume",
            mode: "noop",
            mutated: false,
            summary: {
              packetId: replay.value.packetId,
              semanticDigest: replay.value.semanticDigest,
            },
          },
        },
      };
    }
    if (!isCandidateRequest(replay.errors)) {
      return { ok: false, outcome: protocolFailure(replay.errors) };
    }
    if (packet.value.markdown !== undefined) {
      const bound = parseReviewPacketMarkdown(packet.value.markdown, current.value);
      if (!bound.ok) return { ok: false, outcome: protocolFailure(bound.errors) };
    }
    const candidate = await readTransitionValue(arguments_.value.candidate, "/candidate");
    if (!candidate.ok) return candidate;
    const derived: Array<{ topicId: string; document: unknown }> = [];
    for (const [index, item] of arguments_.value.derived.entries()) {
      const document = await readTransitionValue(item.path, `/derived/${index}/document`);
      if (!document.ok) return document;
      derived.push({ topicId: item.topicId, document: document.value });
    }
    const transition = validateTransition({
      current: current.value,
      packet: packet.value.packet,
      candidate: candidate.value,
      derived,
    });
    if (!transition.ok) return { ok: false, outcome: protocolFailure(transition.errors) };
    if (transition.value.status !== "apply") {
      return { ok: false, outcome: localFailure("INTERNAL_ERROR", "") };
    }
    const splitFailure = splitGroupFailure(transition.value);
    if (splitFailure !== undefined) return { ok: false, outcome: splitFailure };
    if (expectedConfirmation(transition.value) !== arguments_.value.confirmOutputScope) {
      return {
        ok: false,
        outcome: localFailure("ARGUMENT_INVALID", "/arguments/confirm-output-scope"),
      };
    }
    const deliveries = preflightTargets(transition.value);
    if (!deliveries.ok) return deliveries;
    const outputDir = resolve(arguments_.value.outputDir);
    return {
      ok: true,
      value: {
        outputDir,
        plan: transition.value,
        deliveries: deliveries.value,
      },
    };
  } catch {
    return { ok: false, outcome: localFailure("INTERNAL_ERROR", "") };
  }
}

function getLoader(runtime: unknown): StepResult<() => Uint8Array | Promise<Uint8Array>> {
  try {
    if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime) || isProxy(runtime)) {
      return {
        ok: false,
        outcome: localFailure("ARGUMENT_INVALID", "/runtime/loadApprovalTemplateBytes"),
      };
    }
    const prototype = Object.getPrototypeOf(runtime) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(runtime);
    const keys = Reflect.ownKeys(descriptors);
    const descriptor = descriptors.loadApprovalTemplateBytes;
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 1 || keys[0] !== "loadApprovalTemplateBytes"
      || descriptor === undefined || !("value" in descriptor)
      || typeof descriptor.value !== "function") {
      return {
        ok: false,
        outcome: localFailure("ARGUMENT_INVALID", "/runtime/loadApprovalTemplateBytes"),
      };
    }
    return { ok: true, value: descriptor.value as () => Uint8Array | Promise<Uint8Array> };
  } catch {
    return {
      ok: false,
      outcome: localFailure("ARGUMENT_INVALID", "/runtime/loadApprovalTemplateBytes"),
    };
  }
}

function generateDelivery(
  delivery: PreparedDeliveryTarget,
  templateBytes: Uint8Array,
): StepResult<GeneratedDelivery> {
  const contract = serializeReviewDocument(delivery.document);
  if (!contract.ok) return { ok: false, outcome: validationFailure(contract) };
  const contractVerifier = createReviewDocumentByteVerifier(delivery.document);
  const artifacts = generateArtifactBytes({
    document: delivery.document,
    approvalTemplateBytes: templateBytes,
  });
  if (!artifacts.ok) return { ok: false, outcome: validationFailure(artifacts) };
  const verifiers = createExactGeneratedArtifactByteVerifiers({
    document: delivery.document,
    generatorVersion: GENERATOR_VERSION,
    templateBytes,
    agentBytes: artifacts.value.agent,
    approvalBytes: artifacts.value.approval,
  });
  if (!verifiers.ok) return { ok: false, outcome: validationFailure(verifiers) };
  const handoff = validateDeliveryAndBuildHandoff({
    document: delivery.document,
    agentBytes: artifacts.value.agent,
    approvalBytes: artifacts.value.approval,
    approvalTemplateBytes: templateBytes,
    expectedGeneratorVersion: GENERATOR_VERSION,
    agent: {
      relativePath: delivery.document.delivery.outputs.agent,
      byteDigest: sha256Bytes(artifacts.value.agent),
    },
    approval: {
      relativePath: delivery.document.delivery.outputs.approval,
      byteDigest: sha256Bytes(artifacts.value.approval),
    },
  });
  if (!handoff.ok) return { ok: false, outcome: validationFailure(handoff) };
  return {
    ok: true,
    value: {
      ...delivery,
      contractBytes: contract.value,
      agentBytes: artifacts.value.agent,
      approvalBytes: artifacts.value.approval,
      contractVerifier,
      agentVerifier: verifiers.value.agent,
      approvalVerifier: verifiers.value.approval,
      handoff: handoff.value.handoff,
    },
  };
}

function transactionTargets(deliveries: readonly GeneratedDelivery[]): FileTransactionTarget[] {
  const targets: FileTransactionTarget[] = [];
  for (const delivery of deliveries) {
    targets.push(
      {
        target: delivery.contractTarget,
        bytes: delivery.contractBytes,
        disposition: "create",
        verifyStaged: delivery.contractVerifier,
      },
      {
        target: delivery.agentTarget,
        bytes: delivery.agentBytes,
        disposition: "create",
        verifyStaged: delivery.agentVerifier,
      },
      {
        target: delivery.approvalTarget,
        bytes: delivery.approvalBytes,
        disposition: "create",
        verifyStaged: delivery.approvalVerifier,
      },
    );
  }
  return targets;
}

async function finish(preflightValue: ReadyPreflight, loaded: unknown): Promise<ConsumeCommandOutcome> {
  try {
    const decodedTemplate = decodeStrictUtf8(loaded as Uint8Array, "/runtime/approvalTemplateBytes");
    if (!decodedTemplate.ok) return validationFailure(decodedTemplate);
    const templateBytes = encoder.encode(decodedTemplate.value);
    const generated: GeneratedDelivery[] = [];
    for (const delivery of preflightValue.deliveries) {
      const result = generateDelivery(delivery, templateBytes);
      if (!result.ok) return result.outcome;
      generated.push(result.value);
    }
    const candidate = generated[0];
    if (candidate === undefined || candidate.topicId !== undefined) {
      return localFailure("INTERNAL_ERROR", "");
    }
    const derived: ConsumeApplyHandoff["derived"] = [];
    for (const delivery of generated.slice(1)) {
      if (delivery.topicId === undefined) return localFailure("INTERNAL_ERROR", "");
      derived.push({
        topicId: delivery.topicId,
        contract: {
          relativePath: delivery.contractRelativePath,
          byteDigest: sha256Bytes(delivery.contractBytes),
        },
        delivery: delivery.handoff,
      });
    }
    const success: ConsumeCommandOutcome = {
      exitCode: CLI_EXIT_CODES.SUCCESS,
      result: {
        status: "ok",
        phase: "consume",
        mode: "apply",
        mutated: true,
        handoff: {
          kind: "consume",
          packetId: preflightValue.plan.packetId,
          semanticDigest: preflightValue.plan.semanticDigest,
          candidate: {
            contract: {
              relativePath: candidate.contractRelativePath,
              byteDigest: sha256Bytes(candidate.contractBytes),
            },
            delivery: candidate.handoff,
          },
          derived,
        },
      },
    };
    const targets = transactionTargets(generated);
    const committed = await commitFreshFileTransaction({
      outputDir: preflightValue.outputDir,
      generatorVersion: GENERATOR_VERSION,
      targets,
    });
    if (!committed.ok) return ioFailure(committed);
    return success;
  } catch {
    return localFailure("INTERNAL_ERROR", "");
  }
}

export async function runConsumeCommand(
  argv: readonly string[],
  runtime: ConsumeRuntimeOptions = {},
): Promise<ConsumeCommandOutcome> {
  const prepared = await preflight(argv);
  if (!prepared.ok) return prepared.outcome;
  const loader = getLoader(runtime);
  if (!loader.ok) return loader.outcome;

  // This await is intentionally outside every catch. Assembly owns loader
  // installation failures and maps this sole rejected-Promise surface.
  const loadApprovalTemplateBytes = loader.value;
  const loaded = loadApprovalTemplateBytes();
  const templateBytes = isPromise(loaded) ? await loaded : loaded;

  return finish(prepared.value, templateBytes);
}
