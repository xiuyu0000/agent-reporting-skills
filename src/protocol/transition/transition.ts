import {
  blockContentDigest,
  buildDependencyGraph,
  canonicalJson,
  compareUnicodeCodePoints,
  downstreamClosure,
  feedbackDigest,
  validateReviewDocument,
  validateReviewDocumentAgainst,
  validateReviewPacket,
  type ProtocolError,
  type ProtocolResult,
  type ReviewDocumentV1,
  type ReviewPacketV1,
  type Sha256Digest,
} from "../index.js";
import { deriveExecutionEligibility } from "./eligibility.js";
import { error, fail, prefixedErrors, sameValue, succeed } from "./result.js";

export interface DerivedReviewInput {
  topicId: string;
  document: ReviewDocumentV1;
}

export interface TransitionApplyPlan {
  status: "apply";
  packetId: string;
  semanticDigest: Sha256Digest;
  candidate: ReviewDocumentV1;
  derived: readonly DerivedReviewInput[];
  eligibleBlockIds: readonly string[];
  suspendedBlockIds: readonly string[];
}

export interface TransitionNoopPlan {
  status: "noop";
  packetId: string;
  semanticDigest: Sha256Digest;
}

export type TransitionPlan = TransitionApplyPlan | TransitionNoopPlan;

export interface TransitionInput {
  current: unknown;
  packet: unknown;
  candidate?: unknown;
  derived?: readonly { topicId: string; document: unknown }[];
}

type HighWater = ReviewDocumentV1["lineage"]["idHighWater"];
type Impact = ReviewDocumentV1["lineage"]["impactAssessments"][number];
type TopicMapping = ReviewDocumentV1["lineage"]["topicMappings"][number];

const HIGH_WATER_KEYS = [
  "block",
  "source",
  "fact",
  "decision",
  "glossary",
  "note",
  "topic",
] as const satisfies readonly (keyof HighWater)[];

function canonicalKey(value: unknown): string {
  return canonicalJson(value);
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

interface TransitionEnvelope {
  readonly values: Record<string, unknown>;
  readonly deferredErrors: Readonly<Record<string, ProtocolError>>;
}

function transitionEnvelope(input: unknown): ProtocolResult<TransitionEnvelope> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return fail([error("SCHEMA_TYPE", "/input")]);
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return fail([error("SCHEMA_TYPE", "/input")]);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const allowed = new Set(["current", "packet", "candidate", "derived"]);
    const errors: ProtocolError[] = [];
    const values = Object.create(null) as Record<string, unknown>;
    const deferredErrors = Object.create(null) as Record<string, ProtocolError>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        errors.push(error("SCHEMA_ADDITIONAL_PROPERTIES", "/input"));
        continue;
      }
      const descriptor = descriptors[key];
      if (!descriptor) {
        errors.push(error("SCHEMA_TYPE", `/input/${pointerSegment(key)}`));
        continue;
      }
      if (!allowed.has(key)) {
        errors.push(error("SCHEMA_ADDITIONAL_PROPERTIES", `/input/${pointerSegment(key)}`));
        continue;
      }
      if (!descriptor.enumerable) {
        const descriptorError = error("SCHEMA_TYPE", `/input/${pointerSegment(key)}`);
        if (key === "current" || key === "packet") errors.push(descriptorError);
        else deferredErrors[key] = descriptorError;
        continue;
      }
      if (!("value" in descriptor)) {
        if (key === "current" || key === "packet") {
          errors.push(error("SCHEMA_TYPE", `/input/${key}`));
        } else {
          deferredErrors[key] = error("SCHEMA_TYPE", `/input/${key}`);
        }
      } else {
        Object.defineProperty(values, key, {
          value: descriptor.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    for (const key of ["current", "packet"]) {
      if (!Object.hasOwn(descriptors, key)) errors.push(error("SCHEMA_REQUIRED", `/input/${key}`));
    }
    return errors.length === 0 ? succeed({ values, deferredErrors }) : fail(errors);
  } catch {
    return fail([error("SCHEMA_TYPE", "/input")]);
  }
}

function idNumber(value: string): number {
  const match = /(\d+)$/.exec(value);
  return match === null ? 0 : Number(match[1]);
}

function maxObservedHighWater(document: ReviewDocumentV1): HighWater {
  const maximum = (values: readonly string[]): number =>
    values.reduce((current, value) => Math.max(current, idNumber(value)), 0);
  return {
    block: maximum(document.blocks.map((block) => block.id)),
    source: maximum(document.evidence.sourceHierarchy.map((source) => source.id)),
    fact: maximum(document.evidence.facts.map((fact) => fact.id)),
    decision: maximum(document.evidence.decisions.map((decision) => decision.id)),
    glossary: maximum(document.glossary.map((entry) => entry.id)),
    note: maximum(document.lineage.feedbackResolutions
      .map((resolution) => resolution.feedbackId)
      .filter((id) => id.startsWith("NOTE-"))),
    topic: maximum(document.lineage.topicMappings.map((mapping) => mapping.topicId)),
  };
}

function validateLifecycleCurrent(current: ReviewDocumentV1): ProtocolError[] {
  const derivedDocumentIds = new Set([current.document.id]);
  const derivedDeliveryIds = new Set([current.delivery.id]);
  for (const [index, mapping] of current.lineage.topicMappings.entries()) {
    if (derivedDocumentIds.has(mapping.derivedDocumentId)
      || derivedDeliveryIds.has(mapping.derivedDeliveryId)) {
      return [error("DERIVED_TOPIC_INVALID", `/current/lineage/topicMappings/${index}`)];
    }
    derivedDocumentIds.add(mapping.derivedDocumentId);
    derivedDeliveryIds.add(mapping.derivedDeliveryId);
  }
  if (current.document.status === "draft") {
    return [error("DECISION_APPLICATION_INVALID", "/current/document/status")];
  }
  const allFrozen = current.approvals.currentFrozen.length === current.blocks.length;
  const anyChanged = current.blocks.some((block) => block.changed !== undefined);
  if (current.document.status === "finalized" && (!allFrozen || anyChanged)) {
    return [error("FINALIZATION_INVALID", "/current/document/status")];
  }
  if (current.document.status === "in-review" && allFrozen) {
    return [error("FINALIZATION_INVALID", "/current/document/status")];
  }
  return [];
}

function validateDerivedInputs(
  input: unknown,
  current: ReviewDocumentV1,
): ProtocolResult<readonly DerivedReviewInput[]> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(canonicalJson(input)) as unknown;
  } catch {
    return fail([error("SCHEMA_TYPE", "/derived")]);
  }
  if (!Array.isArray(snapshot)) return fail([error("SCHEMA_TYPE", "/derived")]);
  const errors: ProtocolError[] = [];
  const values: DerivedReviewInput[] = [];
  const topicIds = new Set<string>();
  const documentIds = new Set([
    current.document.id,
    ...current.lineage.topicMappings.map((mapping) => mapping.derivedDocumentId),
  ]);
  const deliveryIds = new Set([
    current.delivery.id,
    ...current.lineage.topicMappings.map((mapping) => mapping.derivedDeliveryId),
  ]);
  for (const [index, item] of snapshot.entries()) {
    const path = `/derived/${index}`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(error("SCHEMA_TYPE", path));
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "topicId" && key !== "document") {
        errors.push(error("SCHEMA_ADDITIONAL_PROPERTIES", `${path}/${key}`));
      }
    }
    if (typeof record.topicId !== "string") {
      errors.push(error("SCHEMA_TYPE", `${path}/topicId`));
      continue;
    }
    if (topicIds.has(record.topicId)) {
      errors.push(error("DERIVED_TOPIC_INVALID", `${path}/topicId`));
      continue;
    }
    topicIds.add(record.topicId);
    const validated = validateReviewDocument(record.document);
    if (!validated.ok) {
      errors.push(...prefixedErrors(validated.errors, `${path}/document`));
      continue;
    }
    const document = validated.value;
    const cleanInitial = document.document.round === 1
      && document.document.contentVersion === 1
      && document.document.status === "in-review"
      && document.lineage.previousReviewDigest === null
      && document.lineage.consumedPackets.length === 0
      && document.lineage.topicMappings.length === 0
      && document.lineage.impactAssessments.length === 0
      && document.lineage.feedbackResolutions.length === 0
      && document.approvals.history.length === 0
      && document.approvals.currentFrozen.length === 0
      && document.blocks.every((block) => block.changed === undefined);
    if (!cleanInitial) errors.push(error("DERIVED_TOPIC_INVALID", `${path}/document`));
    if (documentIds.has(document.document.id)) {
      errors.push(error("DERIVED_TOPIC_INVALID", `${path}/document/document/id`));
    }
    if (deliveryIds.has(document.delivery.id)) {
      errors.push(error("DERIVED_TOPIC_INVALID", `${path}/document/delivery/id`));
    }
    documentIds.add(document.document.id);
    deliveryIds.add(document.delivery.id);
    values.push({ topicId: record.topicId, document });
  }
  return errors.length === 0
    ? succeed(values.sort((left, right) => compareUnicodeCodePoints(left.topicId, right.topicId)))
    : fail(errors);
}

function existingOrderErrors(current: ReviewDocumentV1, candidate: ReviewDocumentV1): ProtocolError[] {
  const candidateIds = new Set(candidate.blocks.map((block) => block.id));
  const removed = current.blocks.filter((block) => !candidateIds.has(block.id));
  if (removed.length > 0) {
    return removed.map((block) => error("TRANSITION_BLOCK_REMOVED", "/candidate/blocks", block.id));
  }
  const currentIds = new Set(current.blocks.map((block) => block.id));
  const existingOrder = candidate.blocks.filter((block) => currentIds.has(block.id)).map((block) => block.id);
  const expectedOrder = current.blocks.map((block) => block.id);
  return sameValue(existingOrder, expectedOrder)
    ? []
    : [error("TRANSITION_BLOCK_REORDERED", "/candidate/blocks")];
}

function exactLedgerErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
): ProtocolError[] {
  const expected = [
    ...current.lineage.consumedPackets,
    { packetId: packet.packetId, semanticDigest: packet.semanticDigest },
  ];
  return sameValue(candidate.lineage.consumedPackets, expected)
    ? []
    : [error("DECISION_APPLICATION_INVALID", "/candidate/lineage/consumedPackets")];
}

function highWaterErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
): ProtocolError[] {
  const observed = maxObservedHighWater(candidate);
  const errors: ProtocolError[] = [];
  for (const key of HIGH_WATER_KEYS) {
    const expected = Math.max(
      current.lineage.idHighWater[key],
      packet.idHighWater[key],
      observed[key],
    );
    if (candidate.lineage.idHighWater[key] !== expected) {
      errors.push(error("HIGH_WATER_REGRESSION", `/candidate/lineage/idHighWater/${key}`));
    }
  }
  return errors;
}

function topicErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
  derived: readonly DerivedReviewInput[],
): ProtocolError[] {
  const errors: ProtocolError[] = [];
  const topics = new Map(packet.topics.map((topic) => [topic.id, topic]));
  const derivedByTopic = new Map(derived.map((item) => [item.topicId, item]));
  for (const [index, item] of derived.entries()) {
    if (!topics.has(item.topicId)) {
      errors.push(error("DERIVED_TOPIC_INVALID", `/derived/${index}/topicId`));
    }
  }
  const expectedNew: TopicMapping[] = [];
  for (const [index, topic] of packet.topics.entries()) {
    const item = derivedByTopic.get(topic.id);
    if (!item) {
      errors.push(error("DERIVED_TOPIC_INVALID", `/packet/topics/${index}/id`));
      continue;
    }
    expectedNew.push({
      topicId: topic.id,
      derivedDocumentId: item.document.document.id,
      derivedDeliveryId: item.document.delivery.id,
    });
  }
  const expected = [...current.lineage.topicMappings, ...expectedNew]
    .sort((left, right) => compareUnicodeCodePoints(left.topicId, right.topicId));
  if (!sameValue(candidate.lineage.topicMappings, expected)) {
    errors.push(error("DERIVED_TOPIC_INVALID", "/candidate/lineage/topicMappings"));
  }
  return errors;
}

function feedbackErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
  changedIds: ReadonlySet<string>,
  newIds: ReadonlySet<string>,
): { errors: ProtocolError[]; convertedTargets: Set<string> } {
  const errors: ProtocolError[] = [];
  const expected = new Map<string, Sha256Digest>();
  for (const note of packet.sideNotes) {
    expected.set(note.id, feedbackDigest({
      kind: "side-note",
      feedbackId: note.id,
      blockId: note.blockId,
      text: note.note,
    }));
  }
  if (packet.overall !== undefined) {
    expected.set("OVERALL", feedbackDigest({
      kind: "overall",
      feedbackId: "OVERALL",
      text: packet.overall,
    }));
  }
  const currentKeys = new Set(current.lineage.feedbackResolutions.map(canonicalKey));
  const additions = candidate.lineage.feedbackResolutions
    .map((resolution, index) => ({ resolution, index }))
    .filter(({ resolution }) => !currentKeys.has(canonicalKey(resolution)));
  const packetAdditions = additions
    .filter(({ resolution }) => resolution.sourcePacketId === packet.packetId);
  if (packetAdditions.length !== additions.length || packetAdditions.length !== expected.size) {
    errors.push(error("FEEDBACK_RESOLUTION_INVALID", "/candidate/lineage/feedbackResolutions"));
  }
  const seen = new Set<string>();
  const convertedTargets = new Set<string>();
  const reopened = new Set(packet.reopened);
  const currentFrozen = new Set(current.approvals.currentFrozen);
  const candidateFrozen = new Set(candidate.approvals.currentFrozen);
  for (const { resolution, index } of packetAdditions) {
    const path = `/candidate/lineage/feedbackResolutions/${index}`;
    const digest = expected.get(resolution.feedbackId);
    if (digest === undefined || digest !== resolution.feedbackDigest || seen.has(resolution.feedbackId)) {
      errors.push(error("FEEDBACK_RESOLUTION_INVALID", path));
    }
    seen.add(resolution.feedbackId);
    if (resolution.disposition === "converted-to-block") {
      const target = resolution.targetBlockId;
      const allowed = newIds.has(target) || (currentFrozen.has(target) && reopened.has(target));
      if (!allowed || !changedIds.has(target) || candidateFrozen.has(target)) {
        errors.push(error("FEEDBACK_RESOLUTION_INVALID", `${path}/targetBlockId`, target));
      }
      convertedTargets.add(target);
    }
  }
  for (const feedbackId of expected.keys()) {
    if (!seen.has(feedbackId)) {
      errors.push(error("FEEDBACK_RESOLUTION_INVALID", "/candidate/lineage/feedbackResolutions"));
    }
  }
  return { errors, convertedTargets };
}

function graphClosures(document: ReviewDocumentV1): ProtocolResult<Map<string, Set<string>>> {
  const graph = buildDependencyGraph(document.blocks);
  if (!graph.ok) return graph;
  const closures = new Map<string, Set<string>>();
  for (const block of document.blocks) {
    const result = downstreamClosure(graph.value, [block.id]);
    if (!result.ok) return result;
    closures.set(block.id, new Set(result.value));
  }
  return succeed(closures);
}

function impactErrors(
  current: ReviewDocumentV1,
  candidate: ReviewDocumentV1,
  semanticallyChanged: ReadonlySet<string>,
): { errors: ProtocolError[]; affectedIds: Set<string> } {
  const errors: ProtocolError[] = [];
  const currentClosures = graphClosures(current);
  const candidateClosures = graphClosures(candidate);
  if (!currentClosures.ok) return { errors: currentClosures.errors, affectedIds: new Set() };
  if (!candidateClosures.ok) return { errors: candidateClosures.errors, affectedIds: new Set() };
  const oldKeys = new Set(current.lineage.impactAssessments.map(canonicalKey));
  const additions = candidate.lineage.impactAssessments
    .map((assessment, index) => ({ assessment, index }))
    .filter(({ assessment }) => !oldKeys.has(canonicalKey(assessment)));
  const byUpstream = new Map<string, Impact>();
  for (const { assessment, index } of additions) {
    const path = `/candidate/lineage/impactAssessments/${index}`;
    if (assessment.changedAtRound !== candidate.document.round
      || !semanticallyChanged.has(assessment.upstreamBlockId)
      || byUpstream.has(assessment.upstreamBlockId)) {
      errors.push(error("IMPACT_ASSESSMENT_INVALID", path, assessment.upstreamBlockId));
    }
    byUpstream.set(assessment.upstreamBlockId, assessment);
  }
  const affectedIds = new Set<string>();
  for (const blockId of semanticallyChanged) {
    const closure = new Set([
      ...(currentClosures.value.get(blockId) ?? []),
      ...(candidateClosures.value.get(blockId) ?? []),
    ]);
    const assessment = byUpstream.get(blockId);
    if (closure.size === 0) {
      if (assessment !== undefined) {
        errors.push(error("IMPACT_ASSESSMENT_INVALID", "/candidate/lineage/impactAssessments", blockId));
      }
      continue;
    }
    if (assessment === undefined) {
      errors.push(error("IMPACT_ASSESSMENT_INVALID", "/candidate/lineage/impactAssessments", blockId));
      continue;
    }
    const declared = new Set(assessment.affectedDownstreamIds);
    if ([...declared].some((id) => !closure.has(id))) {
      errors.push(error("IMPACT_ASSESSMENT_INVALID", "/candidate/lineage/impactAssessments", blockId));
    }
    if (assessment.usedConservativeClosure
      && (declared.size !== closure.size || [...closure].some((id) => !declared.has(id)))) {
      errors.push(error("IMPACT_ASSESSMENT_INVALID", "/candidate/lineage/impactAssessments", blockId));
    }
    for (const downstreamId of semanticallyChanged) {
      if (closure.has(downstreamId) && !declared.has(downstreamId)) {
        errors.push(error(
          "IMPACT_ASSESSMENT_INVALID",
          "/candidate/lineage/impactAssessments",
          blockId,
        ));
      }
    }
    for (const affected of declared) affectedIds.add(affected);
  }
  return { errors, affectedIds };
}

function blockAndApprovalErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
): { errors: ProtocolError[]; changedIds: Set<string>; newIds: Set<string>; affectedIds: Set<string> } {
  const errors: ProtocolError[] = [];
  const currentById = new Map(current.blocks.map((block) => [block.id, block]));
  const candidateById = new Map(candidate.blocks.map((block) => [block.id, block]));
  const decisions = new Map(packet.decisions.map((decision) => [decision.blockId, decision]));
  const changedIds = new Set<string>();
  const changedExisting = new Set<string>();
  const newIds = new Set<string>();
  for (const block of candidate.blocks) {
    const before = currentById.get(block.id);
    if (before === undefined) {
      newIds.add(block.id);
      changedIds.add(block.id);
      if (block.changed?.round !== candidate.document.round) {
        errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/blocks", block.id));
      }
      continue;
    }
    const changed = blockContentDigest(before) !== blockContentDigest(block);
    if (changed) {
      changedIds.add(block.id);
      changedExisting.add(block.id);
      if (block.changed?.round !== candidate.document.round) {
        errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/blocks", block.id));
      }
    } else if (block.changed !== undefined) {
      errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/blocks", block.id));
    }
  }

  const impact = impactErrors(current, candidate, changedIds);
  errors.push(...impact.errors);
  const currentFrozen = new Set(current.approvals.currentFrozen);
  const explicitlyReopened = new Set(packet.reopened);
  for (const [index, decision] of packet.decisions.entries()) {
    if (decision.action === "PASS" && impact.affectedIds.has(decision.blockId)) {
      errors.push(error(
        "DECISION_APPLICATION_INVALID",
        `/packet/decisions/${index}/blockId`,
        decision.blockId,
      ));
    }
  }
  for (const blockId of impact.affectedIds) {
    if (currentFrozen.has(blockId) && !explicitlyReopened.has(blockId)) {
      errors.push(error(
        "IMPACT_ASSESSMENT_INVALID",
        "/candidate/lineage/impactAssessments",
        blockId,
      ));
    }
  }
  const feedback = feedbackErrors(current, packet, candidate, changedIds, newIds);
  errors.push(...feedback.errors);
  const permittedChanges = new Set([...impact.affectedIds, ...feedback.convertedTargets]);
  for (const decision of packet.decisions) {
    if (decision.action === "EDIT" || decision.action === "HOLD") permittedChanges.add(decision.blockId);
  }
  for (const blockId of changedExisting) {
    const action = decisions.get(blockId)?.action;
    if (action === "PASS" || action === "TOPIC") {
      errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/blocks", blockId));
    } else if (!permittedChanges.has(blockId)) {
      errors.push(error(
        currentFrozen.has(blockId) && !explicitlyReopened.has(blockId)
          ? "FROZEN_BLOCK_CHANGED"
          : "UNTOUCHED_BLOCK_CHANGED",
        "/candidate/blocks",
        blockId,
      ));
    }
  }
  for (const decision of packet.decisions) {
    if ((decision.action === "EDIT" || decision.action === "HOLD") && !changedIds.has(decision.blockId)) {
      errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/blocks", decision.blockId));
    }
  }

  const expectedHistory = [...current.approvals.history];
  for (const decision of packet.decisions) {
    if (decision.action !== "PASS") continue;
    const block = candidateById.get(decision.blockId);
    if (block === undefined || changedIds.has(decision.blockId)) continue;
    expectedHistory.push({
      blockId: decision.blockId,
      approvedRound: current.document.round,
      approvedContentDigest: blockContentDigest(block),
    });
  }
  const historySort = (left: typeof expectedHistory[number], right: typeof expectedHistory[number]): number =>
    compareUnicodeCodePoints(left.blockId, right.blockId) || left.approvedRound - right.approvedRound;
  expectedHistory.sort(historySort);
  if (!sameValue(candidate.approvals.history, expectedHistory)) {
    errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/approvals/history"));
  }

  const expectedFrozen = new Set(current.approvals.currentFrozen);
  for (const blockId of packet.reopened) expectedFrozen.delete(blockId);
  for (const decision of packet.decisions) {
    if (decision.action === "PASS") expectedFrozen.add(decision.blockId);
    else expectedFrozen.delete(decision.blockId);
  }
  for (const blockId of impact.affectedIds) expectedFrozen.delete(blockId);
  for (const blockId of feedback.convertedTargets) expectedFrozen.delete(blockId);
  for (const blockId of newIds) expectedFrozen.delete(blockId);
  const actualFrozen = [...candidate.approvals.currentFrozen].sort(compareUnicodeCodePoints);
  const frozenExpected = [...expectedFrozen].sort(compareUnicodeCodePoints);
  if (!sameValue(actualFrozen, frozenExpected)) {
    errors.push(error("DECISION_APPLICATION_INVALID", "/candidate/approvals/currentFrozen"));
  }

  return { errors, changedIds, newIds, affectedIds: impact.affectedIds };
}

function finalizationErrors(
  current: ReviewDocumentV1,
  packet: ReviewPacketV1,
  candidate: ReviewDocumentV1,
  blockResult: ReturnType<typeof blockAndApprovalErrors>,
): ProtocolError[] {
  const activeCurrent = current.blocks.filter(
    (block) => !current.approvals.currentFrozen.includes(block.id) || packet.reopened.includes(block.id),
  );
  const decisions = new Map(packet.decisions.map((decision) => [decision.blockId, decision]));
  const allActivePass = activeCurrent.every((block) => decisions.get(block.id)?.action === "PASS");
  const noNonPass = packet.decisions.every((decision) => decision.action === "PASS");
  const packetResolutions = candidate.lineage.feedbackResolutions
    .filter((resolution) => resolution.sourcePacketId === packet.packetId);
  const contextOnly = packetResolutions.every((resolution) => resolution.disposition === "context-only");
  const shouldFinalize = allActivePass
    && noNonPass
    && blockResult.newIds.size === 0
    && blockResult.affectedIds.size === 0
    && contextOnly;
  const errors: ProtocolError[] = [];
  if ((candidate.document.status === "finalized") !== shouldFinalize) {
    errors.push(error("FINALIZATION_INVALID", "/candidate/document/status"));
  }
  if (candidate.document.status === "finalized") {
    if (candidate.document.contentVersion !== current.document.contentVersion
      || candidate.approvals.currentFrozen.length !== candidate.blocks.length
      || candidate.blocks.some((block) => block.changed !== undefined)
      || blockResult.changedIds.size > 0) {
      errors.push(error("FINALIZATION_INVALID", "/candidate"));
    }
  } else if (candidate.document.status !== "in-review") {
    errors.push(error("FINALIZATION_INVALID", "/candidate/document/status"));
  }
  return errors;
}

export function validateTransition(input: TransitionInput): ProtocolResult<TransitionPlan> {
  const snapshot = transitionEnvelope(input);
  if (!snapshot.ok) return snapshot;
  const currentResult = validateReviewDocument(snapshot.value.values.current);
  if (!currentResult.ok) return fail(prefixedErrors(currentResult.errors, "/current"));
  const current = currentResult.value;
  const lifecycleErrors = validateLifecycleCurrent(current);
  if (lifecycleErrors.length > 0) return fail(lifecycleErrors);

  const independentPacket = validateReviewPacket(snapshot.value.values.packet);
  if (!independentPacket.ok) return fail(prefixedErrors(independentPacket.errors, "/packet"));
  const packet = independentPacket.value;
  const replay = current.lineage.consumedPackets.find((entry) => entry.packetId === packet.packetId);
  if (replay !== undefined) {
    if (replay.semanticDigest === packet.semanticDigest) {
      return succeed({
        status: "noop",
        packetId: packet.packetId,
        semanticDigest: packet.semanticDigest as Sha256Digest,
      });
    }
    return fail([error("PACKET_REPLAY_CONFLICT", "/packet/semanticDigest")]);
  }

  const boundPacket = validateReviewPacket(packet, current);
  if (!boundPacket.ok) return fail(prefixedErrors(boundPacket.errors, "/packet"));
  if (current.document.status === "finalized" && packet.reopened.length === 0) {
    return fail([error("FINALIZATION_INVALID", "/packet/reopened")]);
  }
  if (snapshot.value.deferredErrors.candidate !== undefined) {
    return fail([snapshot.value.deferredErrors.candidate]);
  }
  if (!Object.hasOwn(snapshot.value.values, "candidate")) {
    return fail([error("DECISION_APPLICATION_INVALID", "/candidate")]);
  }
  const candidateResult = validateReviewDocument(snapshot.value.values.candidate);
  if (!candidateResult.ok) return fail(prefixedErrors(candidateResult.errors, "/candidate"));
  const candidate = candidateResult.value;
  if (candidate.document.round !== current.document.round + 1) {
    return fail([error("TRANSITION_ROUND_INVALID", "/candidate/document/round")]);
  }
  const contextResult = validateReviewDocumentAgainst(current, candidate);
  if (!contextResult.ok) return fail(prefixedErrors(contextResult.errors, "/candidate"));
  if (snapshot.value.deferredErrors.derived !== undefined) {
    return fail([snapshot.value.deferredErrors.derived]);
  }
  const derivedResult = validateDerivedInputs(snapshot.value.values.derived ?? [], current);
  if (!derivedResult.ok) return derivedResult;

  const errors: ProtocolError[] = [
    ...existingOrderErrors(current, candidate),
    ...exactLedgerErrors(current, packet, candidate),
    ...highWaterErrors(current, packet, candidate),
    ...topicErrors(current, packet, candidate, derivedResult.value),
  ];
  const blockResult = blockAndApprovalErrors(current, packet, candidate);
  errors.push(...blockResult.errors);
  errors.push(...finalizationErrors(current, packet, candidate, blockResult));
  if (errors.length > 0) return fail(errors);

  const eligibility = deriveExecutionEligibility({ document: candidate });
  if (!eligibility.ok) return eligibility;
  return succeed({
    status: "apply",
    packetId: packet.packetId,
    semanticDigest: packet.semanticDigest as Sha256Digest,
    candidate,
    derived: derivedResult.value,
    eligibleBlockIds: eligibility.value.eligibleBlockIds,
    suspendedBlockIds: eligibility.value.suspendedBlockIds,
  });
}
