import {
  canonicalJson,
  canonicalReviewDocument,
  reviewDigest,
  type ReviewDocumentV1,
} from "../protocol/index.js";
import {
  decodeStrictUtf8,
  parseApprovalArtifact,
  validateDeliverableDocument,
} from "../cli/validate.js";
import { generatorError, generatorFailure, generatorSuccess } from "./errors.js";
import { containsDraftDecisionSlot } from "./draft.js";
import { GENERATOR_VERSION, type GeneratorResult } from "./types.js";

const encoder = new TextEncoder();
// 384 KiB, matching `WORKBENCH_SIZE_LIMIT_BYTES` in tools/build-workbench.mjs.
// The approved approval-workbench prototype's visual system needs the larger
// stylesheet, and the two gates must move together or generation fails closed
// on a template the UI build already accepted.
const MAX_SHELL_BYTES = 393_216;
const TOKENS = Object.freeze({
  generatorVersion: "@@DAR_GENERATOR_VERSION@@",
  documentId: "@@DAR_DOCUMENT_ID@@",
  contentVersion: "@@DAR_CONTENT_VERSION@@",
  round: "@@DAR_ROUND@@",
  reviewDigest: "@@DAR_REVIEW_DIGEST@@",
  documentBase64: "@@DAR_DOCUMENT_BASE64@@",
});
const ALL_TOKEN = /@@DAR_[A-Z0-9_]+@@/gu;

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function fillApprovalTemplate(
  template: string,
  document: ReviewDocumentV1,
  generatorVersion: string,
): GeneratorResult<{ html: string; payload: string }> {
  const documentJson = canonicalJson(canonicalReviewDocument(document));
  const payload = Buffer.from(documentJson, "utf8").toString("base64");
  const replacements = new Map<string, string>([
    [TOKENS.generatorVersion, generatorVersion],
    [TOKENS.documentId, document.document.id],
    [TOKENS.contentVersion, String(document.document.contentVersion)],
    [TOKENS.round, String(document.document.round)],
    [TOKENS.reviewDigest, reviewDigest(document)],
    [TOKENS.documentBase64, payload],
  ]);
  let html = template;
  for (const token of Object.values(TOKENS)) {
    if (occurrences(html, token) !== 1) {
      return generatorFailure([generatorError("ARTIFACT_FORMAT_INVALID", "/approval/template/tokens")]);
    }
    html = html.replace(token, replacements.get(token) ?? "");
  }
  if (ALL_TOKEN.test(html)) {
    ALL_TOKEN.lastIndex = 0;
    return generatorFailure([generatorError("PLACEHOLDER_REMAINS", "/approval/template")]);
  }
  ALL_TOKEN.lastIndex = 0;
  const payloadNeedle = `>${payload}</template>`;
  if (occurrences(html, payloadNeedle) !== 1) {
    return generatorFailure([generatorError("ARTIFACT_FORMAT_INVALID", "/approval/document")]);
  }
  const shell = html.replace(payloadNeedle, "></template>");
  if (encoder.encode(shell).byteLength > MAX_SHELL_BYTES) {
    return generatorFailure([generatorError("ARTIFACT_FORMAT_INVALID", "/approval/size")]);
  }
  return generatorSuccess({ html, payload });
}

export function generateApprovalHtml(
  input: unknown,
  generatorVersion: string,
  templateBytes: Uint8Array,
): GeneratorResult<string> {
  try {
    if (generatorVersion !== GENERATOR_VERSION || !(templateBytes instanceof Uint8Array)) {
      return generatorFailure([generatorError("ARGUMENT_INVALID", "/approval")]);
    }
    const validated = validateDeliverableDocument(input);
    if (!validated.ok) return generatorFailure(validated.errors);
    if (containsDraftDecisionSlot(validated.value)) {
      return generatorFailure([generatorError("DOCUMENT_NOT_REVIEWABLE", "/document/blocks")]);
    }
    const template = decodeStrictUtf8(templateBytes, "/approval/template");
    if (!template.ok) return generatorFailure(template.errors);
    const ownedTemplateBytes = encoder.encode(template.value);
    const generated = fillApprovalTemplate(template.value, validated.value, generatorVersion);
    if (!generated.ok) return generated;
    const parsed = parseApprovalArtifact({
      bytes: encoder.encode(generated.value.html),
      templateBytes: ownedTemplateBytes,
      expectedDocument: validated.value,
      expectedGeneratorVersion: generatorVersion,
    });
    return parsed.ok ? generatorSuccess(generated.value.html) : generatorFailure(parsed.errors);
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/approval")]);
  }
}

export function generateApprovalHtmlBytes(
  input: unknown,
  generatorVersion: string,
  templateBytes: Uint8Array,
): GeneratorResult<Uint8Array> {
  try {
    const generated = generateApprovalHtml(input, generatorVersion, templateBytes);
    return generated.ok ? generatorSuccess(encoder.encode(generated.value)) : generated;
  } catch {
    return generatorFailure([generatorError("INTERNAL_ERROR", "/approval")]);
  }
}
