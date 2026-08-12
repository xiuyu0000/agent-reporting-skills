import { isProxy } from "node:util/types";
import {
  validateDeliveryArtifactSet,
  decodeStrictUtf8,
  validateDeliverableDocument,
} from "../cli/validate.js";
import { generateAgentMarkdown } from "./markdown.js";
import { generateApprovalHtml } from "./approval.js";
import { generatorError, generatorFailure, generatorSuccess } from "./errors.js";
import type {
  GeneratedArtifactBytes,
  GeneratedArtifactText,
  GeneratorResult,
} from "./types.js";
import { GENERATOR_VERSION } from "./types.js";

export type {
  GeneratedArtifactBytes,
  GeneratedArtifactText,
  GeneratorResult,
} from "./types.js";
export { GENERATOR_VERSION } from "./types.js";
export {
  createReviewDocumentByteVerifier,
  parseCanonicalReviewDocumentBytes,
  serializeReviewDocument,
} from "./review-document.js";
export { generateAgentMarkdown, generateAgentMarkdownBytes } from "./markdown.js";
export { generateApprovalHtml, generateApprovalHtmlBytes } from "./approval.js";

const encoder = new TextEncoder();

function snapshotArtifactInput(input: unknown): GeneratorResult<{
  document: unknown;
  approvalTemplateBytes: Uint8Array;
}> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) || isProxy(input)) {
      return generatorFailure([generatorError("ARGUMENT_INVALID", "/artifacts")]);
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || !keys.includes("document")
      || !keys.includes("approvalTemplateBytes")) {
      return generatorFailure([generatorError("ARGUMENT_INVALID", "/artifacts")]);
    }
    const documentDescriptor = descriptors.document;
    const templateDescriptor = descriptors.approvalTemplateBytes;
    if (documentDescriptor === undefined || templateDescriptor === undefined
      || !("value" in documentDescriptor) || !("value" in templateDescriptor)
      || !documentDescriptor.enumerable || !templateDescriptor.enumerable) {
      return generatorFailure([generatorError("ARGUMENT_INVALID", "/artifacts")]);
    }
    const document = validateDeliverableDocument(documentDescriptor.value);
    if (!document.ok) return generatorFailure(document.errors);
    const template = decodeStrictUtf8(templateDescriptor.value as Uint8Array, "/approval/template");
    if (!template.ok) return generatorFailure(template.errors);
    return generatorSuccess({
      document: document.value,
      approvalTemplateBytes: encoder.encode(template.value),
    });
  } catch {
    return generatorFailure([generatorError("ARGUMENT_INVALID", "/artifacts")]);
  }
}

function generateArtifactPair(input: unknown): GeneratorResult<{
  text: GeneratedArtifactText;
  bytes: GeneratedArtifactBytes;
}> {
  const snapshot = snapshotArtifactInput(input);
  if (!snapshot.ok) return snapshot;
  const agent = generateAgentMarkdown(snapshot.value.document, GENERATOR_VERSION);
  if (!agent.ok) return agent;
  const approval = generateApprovalHtml(
    snapshot.value.document,
    GENERATOR_VERSION,
    snapshot.value.approvalTemplateBytes,
  );
  if (!approval.ok) return approval;
  const bytes = {
    agent: encoder.encode(agent.value),
    approval: encoder.encode(approval.value),
  };
  const verified = validateDeliveryArtifactSet({
    document: snapshot.value.document,
    agentBytes: bytes.agent,
    approvalBytes: bytes.approval,
    approvalTemplateBytes: snapshot.value.approvalTemplateBytes,
    expectedGeneratorVersion: GENERATOR_VERSION,
  });
  if (!verified.ok) return generatorFailure(verified.errors);
  return generatorSuccess({
    text: { agent: agent.value, approval: approval.value },
    bytes,
  });
}

export function generateArtifactText(input: {
  document: unknown;
  approvalTemplateBytes: Uint8Array;
}): GeneratorResult<GeneratedArtifactText> {
  try {
    const generated = generateArtifactPair(input);
    return generated.ok ? generatorSuccess(generated.value.text) : generated;
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/artifacts")]);
  }
}

export function generateArtifactBytes(input: {
  document: unknown;
  approvalTemplateBytes: Uint8Array;
}): GeneratorResult<GeneratedArtifactBytes> {
  try {
    const generated = generateArtifactPair(input);
    if (!generated.ok) return generated;
    return generatorSuccess({
      agent: Uint8Array.from(generated.value.bytes.agent),
      approval: Uint8Array.from(generated.value.bytes.approval),
    });
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/artifacts")]);
  }
}
