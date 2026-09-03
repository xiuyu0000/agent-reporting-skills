import { parse, resolve } from "node:path";
import {
  compareUnicodeCodePoints,
  migratePrototypePacket,
  migratePrototypeState,
  parseReviewPacketMarkdown,
  parseReviewPacketMarkdownUnbound,
  validateReviewDocument,
  validateReviewPacket,
  validateReviewState,
  type LegacyIdentityConfirmation,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type Sha256Digest,
} from "../../protocol/index.js";
import { validateTransition } from "../../protocol/transition/index.js";
import {
  exitCodeForValidationErrors,
  failureEnvelope,
  fromProtocolError,
  validationError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import { buildBatchHandoff } from "./handoff.js";
import { validateDeliveryAndBuildHandoff } from "./delivery.js";
import { validateDeliverableDocument } from "./business.js";
import { approvalPayloadWarnings } from "./payload.js";
import { validatePrivateData } from "./privacy.js";
import { readFromRoot, readPath, resolveInputRoot } from "./read.js";
import type { ResolvedInputRoot } from "../io/index.js";
import { decodeStrictUtf8, isLegacyStaticContract, parseStrictJson } from "./text.js";
import type {
  ValidateCommandOutcome,
  ValidateFailure,
  ValidateSuccess,
  ValidationError,
  ValidationResult,
} from "./types.js";

export interface ValidateRuntimeOptions {
  approvalTemplateBytes?: Uint8Array;
}

interface ParsedArguments {
  mode: "delivery" | "batch" | "packet" | "state" | "transition";
  document: string[];
  input?: string;
  current?: string;
  packet?: string;
  candidate?: string;
  derived: { topicId: string; path: string }[];
  legacyProfile?: "prototype-v1";
  confirmation?: LegacyIdentityConfirmation;
}

function outcomeSuccess(result: ValidateSuccess): ValidateCommandOutcome {
  return { exitCode: 0, result };
}

function outcomeFailure(errors: readonly ValidationError[]): ValidateCommandOutcome {
  const result: ValidateFailure = failureEnvelope(errors);
  return { exitCode: exitCodeForValidationErrors(result.errors), result };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function parseArguments(argv: readonly string[]): ValidationResult<ParsedArguments> {
  const values = argv[0] === "validate" ? argv.slice(1) : [...argv];
  const mode = values[0];
  if (!(mode === "delivery" || mode === "batch" || mode === "packet"
    || mode === "state" || mode === "transition")) {
    return validationErrors([validationError("ARGUMENT_INVALID", "/arguments/mode")]);
  }
  const multi = new Map<string, string[]>();
  for (let index = 1; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || value.startsWith("--")) {
      return validationErrors([validationError("ARGUMENT_INVALID", `/arguments/${index}`)]);
    }
    const list = multi.get(flag) ?? [];
    list.push(value);
    multi.set(flag, list);
  }
  const allowedByMode: Record<typeof mode, ReadonlySet<string>> = {
    delivery: new Set(["--document"]),
    batch: new Set(["--document"]),
    packet: new Set(["--document", "--input", "--legacy-profile", "--confirm-document-id", "--confirm-content-version", "--confirm-round"]),
    state: new Set(["--document", "--input", "--legacy-profile", "--confirm-document-id", "--confirm-content-version", "--confirm-round"]),
    transition: new Set(["--current", "--packet", "--candidate", "--derived"]),
  };
  for (const [flag, list] of multi) {
    if (!allowedByMode[mode].has(flag) || (flag !== "--document" && flag !== "--derived" && list.length !== 1)) {
      return validationErrors([validationError("ARGUMENT_INVALID", "/arguments")]);
    }
  }
  const documents = multi.get("--document") ?? [];
  const derived: { topicId: string; path: string }[] = [];
  const derivedIds = new Set<string>();
  for (const [index, item] of (multi.get("--derived") ?? []).entries()) {
    const separator = item.indexOf("=");
    const topicId = separator < 0 ? "" : item.slice(0, separator);
    const path = separator < 0 ? "" : item.slice(separator + 1);
    if (!/^TOP-(?=0*[1-9])\d{3,}$/u.test(topicId) || path.length === 0 || derivedIds.has(topicId)) {
      return validationErrors([validationError("ARGUMENT_INVALID", `/arguments/derived/${index}`)]);
    }
    derivedIds.add(topicId);
    derived.push({ topicId, path });
  }
  const single = (name: string): string | undefined => multi.get(name)?.[0];
  if ((mode === "delivery" && documents.length !== 1) || (mode === "batch" && documents.length < 2)
    || ((mode === "packet" || mode === "state") && (documents.length !== 1 || single("--input") === undefined))
    || (mode === "transition" && (single("--current") === undefined || single("--packet") === undefined
      || single("--candidate") === undefined))) {
    return validationErrors([validationError("ARGUMENT_INVALID", "/arguments")]);
  }
  const profile = single("--legacy-profile");
  const confirmationValues = [
    single("--confirm-document-id"),
    single("--confirm-content-version"),
    single("--confirm-round"),
  ];
  const hasConfirmation = confirmationValues.some((value) => value !== undefined);
  let confirmation: LegacyIdentityConfirmation | undefined;
  if (profile !== undefined && profile !== "prototype-v1") {
    return validationErrors([validationError("ARGUMENT_INVALID", "/arguments/legacy-profile")]);
  }
  if (hasConfirmation) {
    const contentVersion = parsePositiveInteger(confirmationValues[1]);
    const round = parsePositiveInteger(confirmationValues[2]);
    if (profile !== "prototype-v1" || confirmationValues[0] === undefined
      || contentVersion === undefined || round === undefined) {
      return validationErrors([validationError("ARGUMENT_INVALID", "/arguments/legacy-profile")]);
    }
    confirmation = { documentId: confirmationValues[0], contentVersion, round };
  }
  return validationSuccess({
    mode,
    document: documents,
    derived,
    ...(single("--input") === undefined ? {} : { input: single("--input")! }),
    ...(single("--current") === undefined ? {} : { current: single("--current")! }),
    ...(single("--packet") === undefined ? {} : { packet: single("--packet")! }),
    ...(single("--candidate") === undefined ? {} : { candidate: single("--candidate")! }),
    ...(profile === undefined ? {} : { legacyProfile: "prototype-v1" as const }),
    ...(confirmation === undefined ? {} : { confirmation }),
  });
}

async function readJsonPath(path: string): Promise<ValidationResult<unknown>> {
  const read = await readPath(path);
  if (!read.ok) return read;
  const decoded = decodeStrictUtf8(read.value.bytes, "/input");
  if (!decoded.ok) return decoded;
  return parseStrictJson(decoded.value, "/input");
}

async function readDocumentPath(path: string): Promise<ValidationResult<ReviewDocumentV1>> {
  const parsed = await readJsonPath(path);
  if (!parsed.ok) return parsed;
  if (isLegacyStaticContract(parsed.value)) {
    return validationErrors([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")]);
  }
  const inputPrivacy = validatePrivateData(parsed.value);
  if (!inputPrivacy.ok) return inputPrivacy;
  const validated = validateReviewDocument(parsed.value);
  if (!validated.ok) return validationErrors(validated.errors.map(fromProtocolError));
  return validationSuccess(validated.value);
}

async function readTransitionDocumentValue(path: string): Promise<ValidationResult<unknown>> {
  const parsed = await readJsonPath(path);
  if (!parsed.ok) return parsed;
  if (isLegacyStaticContract(parsed.value)) {
    return validationErrors([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")]);
  }
  const privacy = validatePrivateData(parsed.value);
  return privacy.ok ? validationSuccess(parsed.value) : privacy;
}

async function loadTemplate(runtime: ValidateRuntimeOptions): Promise<ValidationResult<Uint8Array>> {
  if (!(runtime.approvalTemplateBytes instanceof Uint8Array)) {
    return validationErrors([validationError("ARGUMENT_INVALID", "/runtime/approvalTemplateBytes")]);
  }
  return validationSuccess(new Uint8Array(runtime.approvalTemplateBytes));
}

async function validateOneDelivery(
  documentPath: string,
  templateBytes: Uint8Array,
  resolvedInput?: { root: ResolvedInputRoot; absolutePath: string },
  allowSplitGroup = false,
): Promise<ValidationResult<{
  document: ReviewDocumentV1;
  handoff: Extract<ValidateSuccess, { mode: "delivery" }>["handoff"];
  contractRelativePath: string;
}>> {
  const root = resolvedInput === undefined
    ? await resolveInputRoot(documentPath)
    : validationSuccess(resolvedInput);
  if (!root.ok) return root;
  const contractRelativePath = parse(root.value.absolutePath).base;
  const contractRead = await readFromRoot(root.value.root, contractRelativePath);
  if (!contractRead.ok) return contractRead;
  const decoded = decodeStrictUtf8(contractRead.value.bytes, "/document");
  if (!decoded.ok) return decoded;
  const parsed = parseStrictJson(decoded.value, "/document");
  if (!parsed.ok) return parsed;
  if (isLegacyStaticContract(parsed.value)) {
    return validationErrors([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")]);
  }
  const prelim = validateDeliverableDocument(parsed.value);
  if (!prelim.ok) return prelim;
  if (!allowSplitGroup && prelim.value.delivery.splitGroup !== undefined) {
    return validationErrors([validationError("SPLIT_GROUP_INVALID", "/document/delivery/splitGroup")]);
  }
  const agent = await readFromRoot(root.value.root, prelim.value.delivery.outputs.agent);
  const approval = await readFromRoot(root.value.root, prelim.value.delivery.outputs.approval);
  if (!agent.ok || !approval.ok) {
    return validationErrors([
      ...(agent.ok ? [] : agent.errors),
      ...(approval.ok ? [] : approval.errors),
    ]);
  }
  const complete = validateDeliveryAndBuildHandoff({
    document: prelim.value,
    agentBytes: agent.value.bytes,
    approvalBytes: approval.value.bytes,
    approvalTemplateBytes: templateBytes,
    agent: { relativePath: agent.value.relativePath, byteDigest: agent.value.digest },
    approval: { relativePath: approval.value.relativePath, byteDigest: approval.value.digest },
  });
  return complete.ok
    ? validationSuccess({
        document: complete.value.document,
        handoff: complete.value.handoff,
        contractRelativePath,
      })
    : complete;
}

async function validatePacketInput(
  inputPath: string,
  document: ReviewDocumentV1,
  legacy: ParsedArguments["legacyProfile"],
  confirmation: ParsedArguments["confirmation"],
  bindIdentity = true,
): Promise<ValidationResult<{
  packet: ReviewPacketV1;
  normalized: boolean;
  markdown?: string;
}>> {
  const read = await readPath(inputPath);
  if (!read.ok) return read;
  const decoded = decodeStrictUtf8(read.value.bytes, "/input");
  if (!decoded.ok) return decoded;
  const trimmed = decoded.value.trimStart();
  if (legacy === undefined && !trimmed.startsWith("{")) {
    const privacy = validatePrivateData(decoded.value);
    if (!privacy.ok) return privacy;
    const markdown = bindIdentity
      ? parseReviewPacketMarkdown(decoded.value, document)
      : parseReviewPacketMarkdownUnbound(decoded.value);
    return markdown.ok
      ? validationSuccess({ packet: markdown.value, normalized: false, markdown: decoded.value })
      : validationErrors(markdown.errors.map(fromProtocolError));
  }
  const parsed = parseStrictJson(decoded.value, "/input");
  if (!parsed.ok) return parsed;
  if (isLegacyStaticContract(parsed.value)) {
    return validationErrors([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")]);
  }
  const privacy = validatePrivateData(parsed.value);
  if (!privacy.ok) return privacy;
  if (legacy !== undefined) {
    const migrated = migratePrototypePacket(parsed.value, {
      profile: legacy,
      document,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
    return migrated.ok
      ? validationSuccess({ packet: migrated.value, normalized: true })
      : validationErrors(migrated.errors.map(fromProtocolError));
  }
  const packet = validateReviewPacket(parsed.value, bindIdentity ? document : undefined);
  return packet.ok
    ? validationSuccess({ packet: packet.value, normalized: false })
    : validationErrors(packet.errors.map(fromProtocolError));
}

async function runDelivery(arguments_: ParsedArguments, runtime: ValidateRuntimeOptions): Promise<ValidateCommandOutcome> {
  const template = await loadTemplate(runtime);
  if (!template.ok) return outcomeFailure(template.errors);
  const delivery = await validateOneDelivery(arguments_.document[0]!, template.value);
  if (!delivery.ok) return outcomeFailure(delivery.errors);
  const warnings = approvalPayloadWarnings([delivery.value.document]);
  return outcomeSuccess({
    status: "ok",
    phase: "validate",
    mode: "delivery",
    mutated: false,
    handoff: delivery.value.handoff,
    ...(warnings.length === 0 ? {} : { warnings }),
  });
}

async function runBatch(arguments_: ParsedArguments, runtime: ValidateRuntimeOptions): Promise<ValidateCommandOutcome> {
  const absolute = arguments_.document.map((path) => resolve(path));
  const roots = [];
  for (const path of absolute) {
    const root = await resolveInputRoot(path);
    if (!root.ok) return outcomeFailure(root.errors);
    roots.push(root.value);
  }
  const inputRoot = roots[0]?.root.absolutePath;
  if (inputRoot === undefined || roots.some((item) => item.root.absolutePath !== inputRoot)) {
    return outcomeFailure([validationError("SPLIT_GROUP_INVALID", "/batch/root")]);
  }
  const template = await loadTemplate(runtime);
  if (!template.ok) return outcomeFailure(template.errors);
  const deliveries = [];
  for (const [index, path] of absolute.entries()) {
    const result = await validateOneDelivery(path, template.value, roots[index], true);
    if (!result.ok) return outcomeFailure(result.errors);
    deliveries.push(result.value);
  }
  const handoff = buildBatchHandoff({ deliveries });
  if (!handoff.ok) return outcomeFailure(handoff.errors);
  const ordered = [...deliveries].sort((left, right) =>
    (left.document.delivery.splitGroup?.part ?? 0) - (right.document.delivery.splitGroup?.part ?? 0));
  const warnings = approvalPayloadWarnings(ordered.map((item) => item.document));
  return outcomeSuccess({
    status: "ok",
    phase: "validate",
    mode: "batch",
    mutated: false,
    handoff: handoff.value,
    ...(warnings.length === 0 ? {} : { warnings }),
  });
}

async function runPacket(arguments_: ParsedArguments): Promise<ValidateCommandOutcome> {
  const document = await readDocumentPath(arguments_.document[0]!);
  if (!document.ok) return outcomeFailure(document.errors);
  const packet = await validatePacketInput(arguments_.input!, document.value, arguments_.legacyProfile, arguments_.confirmation);
  if (!packet.ok) return outcomeFailure(packet.errors);
  return outcomeSuccess({
    status: "ok",
    phase: "validate",
    mode: "packet",
    mutated: false,
    summary: {
      format: "review-packet/1",
      documentId: packet.value.packet.doc.id,
      contentVersion: packet.value.packet.doc.contentVersion,
      round: packet.value.packet.doc.round,
      reviewDigest: packet.value.packet.doc.reviewDigest as Sha256Digest,
      packetId: packet.value.packet.packetId,
      semanticDigest: packet.value.packet.semanticDigest as Sha256Digest,
    },
    ...(packet.value.normalized ? { normalized: packet.value.packet } : {}),
  });
}

async function runState(arguments_: ParsedArguments): Promise<ValidateCommandOutcome> {
  const document = await readDocumentPath(arguments_.document[0]!);
  if (!document.ok) return outcomeFailure(document.errors);
  const read = await readJsonPath(arguments_.input!);
  if (!read.ok) return outcomeFailure(read.errors);
  if (isLegacyStaticContract(read.value)) {
    return outcomeFailure([validationError("LEGACY_CONTRACT_INCOMPATIBLE", "/format")]);
  }
  const privacy = validatePrivateData(read.value);
  if (!privacy.ok) return outcomeFailure(privacy.errors);
  const state = arguments_.legacyProfile === undefined
    ? validateReviewState(read.value, document.value)
    : migratePrototypeState(read.value, {
        profile: arguments_.legacyProfile,
        document: document.value,
        ...(arguments_.confirmation === undefined ? {} : { confirmation: arguments_.confirmation }),
      });
  if (!state.ok) return outcomeFailure(state.errors.map(fromProtocolError));
  return outcomeSuccess({
    status: "ok",
    phase: "validate",
    mode: "state",
    mutated: false,
    summary: {
      format: "review-state/1",
      documentId: state.value.doc.id,
      contentVersion: state.value.doc.contentVersion,
      round: state.value.doc.round,
      reviewDigest: state.value.doc.reviewDigest as Sha256Digest,
      stateDigest: state.value.stateDigest as Sha256Digest,
    },
    ...(arguments_.legacyProfile === undefined ? {} : { normalized: state.value }),
  });
}

async function runTransition(arguments_: ParsedArguments): Promise<ValidateCommandOutcome> {
  const current = await readDocumentPath(arguments_.current!);
  if (!current.ok) return outcomeFailure(current.errors);
  const packet = await validatePacketInput(
    arguments_.packet!,
    current.value,
    undefined,
    undefined,
    false,
  );
  if (!packet.ok) return outcomeFailure(packet.errors);
  const replay = validateTransition({ current: current.value, packet: packet.value.packet });
  if (replay.ok) {
    return outcomeSuccess({
      status: "ok",
      phase: "validate",
      mode: "transition",
      mutated: false,
      summary: {
        status: replay.value.status,
        packetId: replay.value.packetId,
        semanticDigest: replay.value.semanticDigest,
        derivedTopicIds: [],
      },
    });
  }
  const needsCandidate = replay.errors.length === 1
    && replay.errors[0]?.code === "DECISION_APPLICATION_INVALID"
    && replay.errors[0]?.path === "/candidate";
  if (!needsCandidate) return outcomeFailure(replay.errors.map(fromProtocolError));
  if (packet.value.markdown !== undefined) {
    const boundMarkdown = parseReviewPacketMarkdown(packet.value.markdown, current.value);
    if (!boundMarkdown.ok) return outcomeFailure(boundMarkdown.errors.map(fromProtocolError));
  }
  const candidate = await readTransitionDocumentValue(arguments_.candidate!);
  if (!candidate.ok) return outcomeFailure(candidate.errors);
  const derived = [];
  // Same index space as `validateTransition`, which sorts derived entries by
  // topicId before reporting `/derived/N`.
  const derivedInput = [...arguments_.derived]
    .sort((left, right) => compareUnicodeCodePoints(left.topicId, right.topicId));
  for (const item of derivedInput) {
    const document = await readTransitionDocumentValue(item.path);
    if (!document.ok) return outcomeFailure(document.errors);
    derived.push({ topicId: item.topicId, document: document.value });
  }
  const transition = validateTransition({
    current: current.value,
    packet: packet.value.packet,
    candidate: candidate.value,
    derived,
  });
  if (!transition.ok) return outcomeFailure(transition.errors.map(fromProtocolError));
  return outcomeSuccess({
    status: "ok",
    phase: "validate",
    mode: "transition",
    mutated: false,
    summary: {
      status: transition.value.status,
      packetId: transition.value.packetId,
      semanticDigest: transition.value.semanticDigest,
      derivedTopicIds: transition.value.status === "apply"
        ? transition.value.derived.map((item) => item.topicId).sort(compareUnicodeCodePoints)
        : [],
    },
  });
}

export async function runValidateCommand(
  argv: readonly string[],
  runtime: ValidateRuntimeOptions = {},
): Promise<ValidateCommandOutcome> {
  try {
    const parsed = parseArguments(argv);
    if (!parsed.ok) return outcomeFailure(parsed.errors);
    switch (parsed.value.mode) {
      case "delivery": return await runDelivery(parsed.value, runtime);
      case "batch": return await runBatch(parsed.value, runtime);
      case "packet": return await runPacket(parsed.value);
      case "state": return await runState(parsed.value);
      case "transition": return await runTransition(parsed.value);
    }
  } catch {
    return outcomeFailure([validationError("INTERNAL_ERROR", "")]);
  }
}
