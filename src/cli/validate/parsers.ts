import {
  canonicalJson,
  canonicalReviewDocument,
  reviewDigest as reviewDigestForDocument,
  sha256Bytes,
  validateReviewDocument,
  type ReviewDocumentV1,
  type Sha256Digest,
} from "../../protocol/index.js";
import {
  fromProtocolError,
  validationError,
  validationErrors,
  validationSuccess,
} from "./errors.js";
import { validateDeliverableDocument } from "./business.js";
import { visitReviewDocumentContent } from "./document-content.js";
import { validatePrivateData, validatePrivateText } from "./privacy.js";
import { decodeStrictUtf8, hasUnreplacedPlaceholder, isSemver, parseStrictJson } from "./text.js";
import { snapshotSafeInput } from "./safe-input.js";
import type {
  GeneratedArtifactByteVerifier,
  ExactGeneratedArtifactByteVerifierInput,
  ExactGeneratedArtifactByteVerifiers,
  GeneratedReplacementByteVerifierInput,
  GeneratedReplacementByteVerifiers,
  ParsedAgentArtifact,
  ParsedApprovalArtifact,
  ValidationError,
  ValidationResult,
} from "./types.js";

const AGENT_MARKERS = [
  ["artifact", "review-agent-markdown/1"],
  ["generator-version", ""],
  ["delivery-id", ""],
  ["document-id", ""],
  ["content-version", ""],
  ["round", ""],
  ["review-digest", ""],
] as const;

const REQUIRED_H2 = [
  "Document identity",
  "Objective and boundaries",
  "Source hierarchy",
  "Current state",
  "Shared evidence",
  "Decision blocks",
  "Approval history and lineage",
  "Next actions",
  "Validation evidence",
  "Glossary",
] as const;

const REQUIRED_H3 = [
  "Objective",
  "In scope",
  "Excluded",
  "Facts",
  "Existing decisions",
  "Constraints",
  "Risks",
  "Open questions and evidence gaps",
  "Source conflicts",
  "Current frozen and active sets",
  "Consumed packets, topics, impacts, and feedback resolutions",
] as const;

const DELIVERY_ID = /^RDL-[0-9A-F]{20}$/u;
const DOCUMENT_ID = /^RD-[0-9A-F]{20}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GENERATOR_TOKENS = [
  "@@DAR_GENERATOR_VERSION@@",
  "@@DAR_DOCUMENT_ID@@",
  "@@DAR_CONTENT_VERSION@@",
  "@@DAR_ROUND@@",
  "@@DAR_REVIEW_DIGEST@@",
  "@@DAR_DOCUMENT_BASE64@@",
] as const;

const SUPPORTED_GENERATOR_VERSION = "0.2.0";
export const SUPPORTED_GENERATED_ARTIFACT_VERSIONS: readonly ["0.2.0"] = Object.freeze([
  SUPPORTED_GENERATOR_VERSION,
]);

const AGENT_H1_SUFFIX = " — Agent Continuation";
const FORMAT_OR_LINE_SEPARATOR = /[\p{Cf}\p{Zl}\p{Zp}]/u;

function agentHeadingError<T = never>(): ValidationResult<T> {
  return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/agent/title")]);
}

function isAsciiPunctuation(codePoint: number): boolean {
  return (codePoint >= 0x21 && codePoint <= 0x2f)
    || (codePoint >= 0x3a && codePoint <= 0x40)
    || (codePoint >= 0x5b && codePoint <= 0x60)
    || (codePoint >= 0x7b && codePoint <= 0x7e);
}

function encodedUnicodeScalar(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint <= 0xffff
    ? `\\u${hex.padStart(4, "0")}`
    : `\\u{${hex}}`;
}

/**
 * Encodes a review-document title for the frozen single-line Agent Markdown H1.
 * The result is data, not Markdown syntax: every ASCII punctuation scalar is
 * CommonMark escaped, while invisible/control scalars and edge ASCII spaces use
 * one canonical uppercase Unicode escape.
 */
export function encodeAgentMarkdownHeadingText(title: string): ValidationResult<string> {
  try {
    if (typeof title !== "string") return agentHeadingError();
    const scalars = Array.from(title);
    const firstNonSpace = scalars.findIndex((scalar) => scalar !== " ");
    let lastNonSpace = -1;
    for (let index = scalars.length - 1; index >= 0; index -= 1) {
      if (scalars[index] !== " ") {
        lastNonSpace = index;
        break;
      }
    }
    const output: string[] = [];
    for (const [index, scalar] of scalars.entries()) {
      const codePoint = scalar.codePointAt(0);
      if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return agentHeadingError();
      }
      const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      const isEdgeAsciiSpace = scalar === " "
        && (firstNonSpace < 0 || index < firstNonSpace || index > lastNonSpace);
      if (isControl || isEdgeAsciiSpace || FORMAT_OR_LINE_SEPARATOR.test(scalar)) {
        output.push(encodedUnicodeScalar(codePoint));
      } else if (isAsciiPunctuation(codePoint)) {
        output.push(`\\${scalar}`);
      } else {
        output.push(scalar);
      }
    }
    return validationSuccess(output.join(""));
  } catch {
    return agentHeadingError();
  }
}

function decodeCanonicalAgentHeadingText(encoded: string): string | undefined {
  if (encoded === "") return undefined;
  let decoded = "";
  for (let index = 0; index < encoded.length;) {
    const codePoint = encoded.codePointAt(index);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    if (codePoint !== 0x5c) {
      decoded += String.fromCodePoint(codePoint);
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }

    if (encoded[index + 1] === "u") {
      if (encoded[index + 2] === "{") {
        const close = encoded.indexOf("}", index + 3);
        if (close < 0) return undefined;
        const hex = encoded.slice(index + 3, close);
        if (!/^[0-9A-F]{5,6}$/u.test(hex)) return undefined;
        const escapedCodePoint = Number.parseInt(hex, 16);
        if (escapedCodePoint < 0x10000 || escapedCodePoint > 0x10ffff) return undefined;
        decoded += String.fromCodePoint(escapedCodePoint);
        index = close + 1;
        continue;
      }
      const hex = encoded.slice(index + 2, index + 6);
      if (!/^[0-9A-F]{4}$/u.test(hex)) return undefined;
      const escapedCodePoint = Number.parseInt(hex, 16);
      if (escapedCodePoint >= 0xd800 && escapedCodePoint <= 0xdfff) return undefined;
      decoded += String.fromCodePoint(escapedCodePoint);
      index += 6;
      continue;
    }

    const escapedCodePoint = encoded.codePointAt(index + 1);
    if (escapedCodePoint === undefined || !isAsciiPunctuation(escapedCodePoint)) return undefined;
    decoded += String.fromCodePoint(escapedCodePoint);
    index += 2;
  }

  const canonical = encodeAgentMarkdownHeadingText(decoded);
  return canonical.ok && canonical.value === encoded ? decoded : undefined;
}

function canonicalAgentH1(value: string): string | undefined {
  if (!value.endsWith(AGENT_H1_SUFFIX)) return undefined;
  const encodedTitle = value.slice(0, -AGENT_H1_SUFFIX.length);
  return decodeCanonicalAgentHeadingText(encodedTitle) === undefined ? undefined : value;
}

interface MarkdownHeadings {
  h1: string[];
  h2: string[];
  h3: string[];
  all: string[];
  sequence: string[];
  visibleLines: string[];
}

function scanMarkdown(text: string): MarkdownHeadings {
  const h1: string[] = [];
  const h2: string[] = [];
  const h3: string[] = [];
  const all: string[] = [];
  const sequence: string[] = [];
  const visibleLines: string[] = [];
  let fenceCharacter = "";
  let fenceLength = 0;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceCharacter !== "") {
      const close = new RegExp(`^ {0,3}${fenceCharacter}{${fenceLength},}[ \\t]*$`, "u");
      if (close.test(line)) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (fence?.[1] !== undefined) {
      fenceCharacter = fence[1][0] ?? "";
      fenceLength = fence[1].length;
      continue;
    }
    visibleLines.push(line);
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (!heading) continue;
    const value = heading[2] ?? "";
    all.push(value);
    if ((heading[1]?.length ?? 0) > 3) continue;
    sequence.push(`${heading[1]} ${value}`);
    if (heading[1] === "#") h1.push(value);
    else if (heading[1] === "##") h2.push(value);
    else h3.push(value);
  }
  return { h1, h2, h3, all, sequence, visibleLines };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function markdownSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} _-]/gu, "")
    .trim()
    .replace(/ +/gu, "-");
}

const MARKDOWN_TITLE = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^)\\\n]|\\.)*\))`;

interface MarkdownFragmentMatch {
  href: string;
  index: number;
}

const FRAGMENT_PREFIX = String.raw`(?:#|\\#|&#(?:0*35|[xX]0*23);|&num;)`;

function normalizedFragmentHref(value: string): string | undefined {
  if (value.startsWith("#")) return value;
  if (value.startsWith("\\#")) return `#${value.slice(2)}`;
  const entity = /^(?:&#(?:0*35|[xX]0*23);|&num;)/u.exec(value);
  return entity === null ? undefined : `#${value.slice(entity[0].length)}`;
}

function inlineMarkdownFragments(line: string): {
  matches: MarkdownFragmentMatch[];
  malformedIndexes: number[];
} {
  const exact = new RegExp(
    String.raw`(?<!!)\[[^\]\n]*\]\([ \t]*(?:<(${FRAGMENT_PREFIX}[^<>\s]*)>|(${FRAGMENT_PREFIX}[^\s()]*)` +
      String.raw`)(?:[ \t]+${MARKDOWN_TITLE})?[ \t]*\)`,
    "gu",
  );
  const matches = [...line.matchAll(exact)].map((match) => ({
    href: normalizedFragmentHref(match[1] ?? match[2] ?? "") ?? "",
    index: match.index,
  }));
  const parsedIndexes = new Set(matches.map((match) => match.index));
  const attemptedPattern = new RegExp(
    String.raw`(?<!!)\[[^\]\n]*\]\([ \t]*<?${FRAGMENT_PREFIX}`,
    "gu",
  );
  const attempted = [...line.matchAll(attemptedPattern)];
  return {
    matches,
    malformedIndexes: attempted
      .map((match) => match.index)
      .filter((index) => !parsedIndexes.has(index)),
  };
}

function referenceDefinitionFragment(line: string): {
  match?: MarkdownFragmentMatch;
  malformed: boolean;
} {
  const attemptedPattern = new RegExp(
    String.raw`^ {0,3}\[[^\]\n]+\]:[ \t]*<?${FRAGMENT_PREFIX}`,
    "u",
  );
  const attempted = attemptedPattern.test(line);
  if (!attempted) return { malformed: false };
  const exact = new RegExp(
    String.raw`^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<(${FRAGMENT_PREFIX}[^<>\s]*)>|(${FRAGMENT_PREFIX}[^\s]*))` +
      String.raw`(?:[ \t]+${MARKDOWN_TITLE})?[ \t]*$`,
    "u",
  ).exec(line);
  if (!exact) return { malformed: true };
  return {
    match: { href: normalizedFragmentHref(exact[1] ?? exact[2] ?? "") ?? "", index: 0 },
    malformed: false,
  };
}

function rawHtmlFragments(line: string): {
  matches: MarkdownFragmentMatch[];
  malformedIndexes: number[];
} {
  const matches: MarkdownFragmentMatch[] = [];
  const malformedIndexes: number[] = [];
  for (const tagMatch of line.matchAll(/<a\b[^>\n]*>/giu)) {
    const tag = tagMatch[0];
    const hrefNames = [...tag.matchAll(/[ \t\r\f]href(?=[ \t\r\f=/>]|$)/giu)];
    const attribute = /\bhref[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'=<>`]+))/giu;
    const hrefs = [...tag.matchAll(attribute)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
    const internal = hrefs
      .map((href) => normalizedFragmentHref(href))
      .filter((href): href is string => href !== undefined);
    if (hrefNames.length > 1 && internal.length > 0) {
      malformedIndexes.push(tagMatch.index);
    } else if (hrefs.length === 1 && internal[0] !== undefined) {
      matches.push({ href: internal[0], index: tagMatch.index });
    }
  }
  return { matches, malformedIndexes };
}

function validateMarkdownLinks(headings: MarkdownHeadings): ValidationError[] {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const heading of headings.all) {
    const base = markdownSlug(heading);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  const errors: ValidationError[] = [];
  for (const [lineIndex, line] of headings.visibleLines.entries()) {
    const inline = inlineMarkdownFragments(line);
    const definition = referenceDefinitionFragment(line);
    const html = rawHtmlFragments(line);
    if (inline.malformedIndexes.length > 0 || definition.malformed
      || html.malformedIndexes.length > 0) {
      errors.push(validationError("INTERNAL_LINK_INVALID", `/agent/lines/${lineIndex + 1}`));
    }
    const fragments = [
      ...inline.matches,
      ...(definition.match === undefined ? [] : [definition.match]),
      ...html.matches,
    ];
    for (const { href } of fragments) {
      const fragment = href.slice(1);
      if (!/^#[A-Za-z][A-Za-z0-9_.:-]*$/u.test(href) || !anchors.has(fragment)) {
        errors.push(validationError("INTERNAL_LINK_INVALID", `/agent/lines/${lineIndex + 1}`));
      }
    }
  }
  return errors;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function parseAgentArtifactSnapshot(
  bytes: Uint8Array,
  expectedDocument?: ReviewDocumentV1,
  expectedGeneratorVersion?: string,
): ValidationResult<ParsedAgentArtifact> {
  const decoded = decodeStrictUtf8(bytes, "/agent");
  if (!decoded.ok) return decoded;
  const text = decoded.value;
  const errors: ValidationError[] = [];
  if (hasUnreplacedPlaceholder(text)) errors.push(validationError("PLACEHOLDER_REMAINS", "/agent"));
  const privacy = validatePrivateText(text, "/agent");
  if (!privacy.ok) errors.push(...privacy.errors);
  if (expectedDocument !== undefined) {
    const documentPrivacy = validatePrivateData(expectedDocument, "/agent/document");
    if (!documentPrivacy.ok) errors.push(...documentPrivacy.errors);
  }
  const lines = text.split("\n");
  if (lines.length < 10 || lines[7] !== "") {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/agent/markers"));
  }
  const values = new Map<string, string>();
  const allDarMarkers = [...text.matchAll(/<!-- dar-[^:\n]*:/gu)];
  if (allDarMarkers.length !== AGENT_MARKERS.length) {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/agent/markers"));
  }
  for (const [index, [name, constant]] of AGENT_MARKERS.entries()) {
    const line = lines[index] ?? "";
    const match = new RegExp(`^<!-- dar-${name}: ([^\\n]*?) -->$`, "u").exec(line);
    if (!match || (constant !== "" && match[1] !== constant)) {
      errors.push(validationError("ARTIFACT_FORMAT_INVALID", `/agent/markers/${index}`));
      continue;
    }
    values.set(name, match[1] ?? "");
    if (countOccurrences(text, `<!-- dar-${name}:`) !== 1) {
      errors.push(validationError("ARTIFACT_FORMAT_INVALID", `/agent/markers/${index}`));
    }
  }
  const generatorVersion = values.get("generator-version") ?? "";
  const deliveryId = values.get("delivery-id") ?? "";
  const documentId = values.get("document-id") ?? "";
  const contentVersionText = values.get("content-version") ?? "";
  const roundText = values.get("round") ?? "";
  const reviewDigestValue = values.get("review-digest") ?? "";
  const contentVersion = Number(contentVersionText);
  const round = Number(roundText);
  if (!isSemver(generatorVersion) || !DELIVERY_ID.test(deliveryId)
    || !DOCUMENT_ID.test(documentId) || !Number.isSafeInteger(contentVersion) || contentVersion < 1
    || String(contentVersion) !== contentVersionText || !Number.isSafeInteger(round) || round < 1
    || String(round) !== roundText || !DIGEST.test(reviewDigestValue)) {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/agent/markers"));
  }
  const headings = scanMarkdown(lines.slice(8).join("\n"));
  const encodedExpectedTitle = expectedDocument === undefined
    ? undefined
    : encodeAgentMarkdownHeadingText(expectedDocument.document.title);
  if (encodedExpectedTitle !== undefined && !encodedExpectedTitle.ok) {
    errors.push(...encodedExpectedTitle.errors);
  }
  const expectedH1 = encodedExpectedTitle?.ok === true
    ? `${encodedExpectedTitle.value}${AGENT_H1_SUFFIX}`
    : undefined;
  const parsedH1 = headings.h1[0] ?? "";
  const unboundH1 = expectedDocument === undefined ? canonicalAgentH1(parsedH1) : parsedH1;
  const expectedSequence = [
    `# ${expectedH1 ?? unboundH1 ?? ""}`,
    "## Document identity",
    "## Objective and boundaries",
    "### Objective",
    "### In scope",
    "### Excluded",
    "## Source hierarchy",
    "## Current state",
    "## Shared evidence",
    "### Facts",
    "### Existing decisions",
    "### Constraints",
    "### Risks",
    "### Open questions and evidence gaps",
    "### Source conflicts",
    "## Decision blocks",
    "## Approval history and lineage",
    "### Current frozen and active sets",
    "### Consumed packets, topics, impacts, and feedback resolutions",
    "## Next actions",
    "## Validation evidence",
    "## Glossary",
  ];
  if (lines[8] !== `# ${expectedH1 ?? unboundH1 ?? ""}`
    || headings.h1.length !== 1 || unboundH1 === undefined
    || (expectedH1 !== undefined && headings.h1[0] !== expectedH1)
    || !sameStrings(headings.h2, REQUIRED_H2) || !sameStrings(headings.h3, REQUIRED_H3)
    || !sameStrings(headings.sequence, expectedSequence)) {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/agent/headings"));
  }
  errors.push(...validateMarkdownLinks(headings));
  if (expectedGeneratorVersion !== undefined && generatorVersion !== expectedGeneratorVersion) {
    errors.push(validationError("ARTIFACT_IDENTITY_MISMATCH", "/agent/markers"));
  }
  if (expectedDocument !== undefined) {
    const expectedReviewDigest = reviewDigestForDocument(expectedDocument);
    if (deliveryId !== expectedDocument.delivery.id
      || documentId !== expectedDocument.document.id
      || contentVersion !== expectedDocument.document.contentVersion
      || round !== expectedDocument.document.round
      || reviewDigestValue !== expectedReviewDigest) {
      errors.push(validationError("ARTIFACT_IDENTITY_MISMATCH", "/agent/markers"));
    }
  }
  if (errors.length > 0) return validationErrors(errors);
  return validationSuccess({
    generatorVersion,
    deliveryId,
    documentId,
    contentVersion,
    round,
    reviewDigest: reviewDigestValue as Sha256Digest,
    text,
  });
}

export function parseAgentArtifact(
  bytes: Uint8Array,
  expectedDocument?: ReviewDocumentV1,
  expectedGeneratorVersion?: string,
): ValidationResult<ParsedAgentArtifact> {
  const snapshot = snapshotSafeInput<{
    bytes: Uint8Array;
    expectedDocument?: ReviewDocumentV1;
    expectedGeneratorVersion?: string;
  }>({
    bytes,
    ...(expectedDocument === undefined ? {} : { expectedDocument }),
    ...(expectedGeneratorVersion === undefined ? {} : { expectedGeneratorVersion }),
  }, "/agent");
  if (!snapshot.ok) return snapshot;
  try {
    return parseAgentArtifactSnapshot(
      snapshot.value.bytes,
      snapshot.value.expectedDocument,
      snapshot.value.expectedGeneratorVersion,
    );
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/agent")]);
  }
}

function uniqueMeta(text: string, name: string): string | undefined {
  const pattern = new RegExp(`<meta name="${name}" content="([^"]*)">`, "gu");
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function uniqueCsp(text: string): string | undefined {
  const matches = [...text.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/gu)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function base64Digest(value: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(value)).slice("sha256:".length);
  return Buffer.from(digest, "hex").toString("base64");
}

function expectedOfflineCsp(text: string): string | undefined {
  const styles = [...text.matchAll(/<style>([\s\S]*?)<\/style>/gu)];
  const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
  if (styles.length !== 1 || scripts.length !== 1) return undefined;
  return [
    "default-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src 'sha256-${base64Digest(scripts[0]?.[1] ?? "")}'`,
    `style-src 'sha256-${base64Digest(styles[0]?.[1] ?? "")}'`,
  ].join("; ");
}

function fillTemplate(
  template: string,
  document: ReviewDocumentV1,
  generatorVersion: string,
): ValidationResult<string> {
  if (uniqueMeta(template, "dar-artifact") !== "review-approval-html/1") {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/approval/template/artifact")]);
  }
  let value = template;
  const replacements = new Map<string, string>([
    [GENERATOR_TOKENS[0], generatorVersion],
    [GENERATOR_TOKENS[1], document.document.id],
    [GENERATOR_TOKENS[2], String(document.document.contentVersion)],
    [GENERATOR_TOKENS[3], String(document.document.round)],
    [GENERATOR_TOKENS[4], reviewDigestForDocument(document)],
    [GENERATOR_TOKENS[5], Buffer.from(canonicalJson(canonicalReviewDocument(document)), "utf8").toString("base64")],
  ]);
  for (const token of GENERATOR_TOKENS) {
    if (countOccurrences(value, token) !== 1) {
      return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/approval/template/tokens")]);
    }
    value = value.replace(token, replacements.get(token) ?? "");
  }
  if (value.includes("@@DAR_")) {
    return validationErrors([validationError("PLACEHOLDER_REMAINS", "/approval/template")]);
  }
  return validationSuccess(value);
}

function externalResourceErrors(text: string): ValidationError[] {
  const patterns = [
    /<script\b[^>]*\bsrc\s*=/iu,
    /<link\b[^>]*\bhref\s*=/iu,
    /<(?:img|iframe|audio|video|source)\b[^>]*\bsrc\s*=/iu,
    /<form\b[^>]*\baction\s*=/iu,
  ];
  const styleContainsExternalResource = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)]
    .some((match) => /@import\b|url\s*\(/iu.test(match[1] ?? ""));
  return patterns.some((pattern) => pattern.test(text)) || styleContainsExternalResource
    ? [validationError("EXTERNAL_RESOURCE_FORBIDDEN", "/approval")]
    : [];
}

function approvalShellLinkErrors(text: string): ValidationError[] {
  const ids = new Set([...text.matchAll(/\bid="([A-Za-z][A-Za-z0-9_.:-]*)"/gu)].map((match) => match[1] ?? ""));
  const errors: ValidationError[] = [];
  for (const match of text.matchAll(/<a\b[^>]*\bhref="(#[A-Za-z][A-Za-z0-9_.:-]*)"[^>]*>/gu)) {
    const target = (match[1] ?? "").slice(1);
    if (!ids.has(target)) errors.push(validationError("INTERNAL_LINK_INVALID", "/approval/shell"));
  }
  return errors;
}

function htmlAttributeValues(tag: string, name: string): string[] {
  const pattern = new RegExp(
    String.raw`\b${name}[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>` + "`" + String.raw`]+))`,
    "giu",
  );
  return [...tag.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function approvalLandmarkErrors(text: string, path: string): ValidationError[] {
  const anchorTags = [...text.matchAll(/<a\b[^>]*>/giu)].map((match) => match[0]);
  const skipLinks = anchorTags.filter((tag) => {
    const classes = htmlAttributeValues(tag, "class");
    return classes.length === 1 && classes[0]?.split(/\s+/u).includes("skip-link") === true;
  });
  const mainTags = [...text.matchAll(/<main\b[^>]*>/giu)].map((match) => match[0]);
  const reviewMains = mainTags.filter((tag) => {
    const ids = htmlAttributeValues(tag, "id");
    return ids.length === 1 && ids[0] === "review-main";
  });
  const skipHref = skipLinks.length === 1 ? htmlAttributeValues(skipLinks[0] ?? "", "href") : [];
  const requiredLandmarks = [
    ["header", "review-header"],
    ["main", "review-main"],
    ["aside", "decision-rail"],
    ["footer", "review-footer"],
    ["div", "workbench-status"],
    ["template", "review-document-data"],
  ] as const;
  const landmarksValid = requiredLandmarks.every(([tagName, id]) => {
    const tags = [...text.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "giu"))]
      .map((match) => match[0])
      .filter((tag) => {
        const ids = htmlAttributeValues(tag, "id");
        return ids.length === 1 && ids[0] === id;
      });
    return tags.length === 1;
  });
  return skipLinks.length === 1 && skipHref.length === 1 && skipHref[0] === "#review-main"
    && reviewMains.length === 1 && landmarksValid
    ? []
    : [validationError("INTERNAL_LINK_INVALID", path)];
}

function documentInternalLinkErrors(document: ReviewDocumentV1): ValidationError[] {
  const allowed = new Set<string>([
    ...document.blocks.map((block) => `#block-${block.id}`),
    ...document.glossary.map((entry) => `#glossary-${entry.id}`),
    ...document.evidence.sourceHierarchy.map((source) => `#evidence-source-${source.id}`),
    ...document.evidence.facts.map((fact) => `#evidence-fact-${fact.id}`),
    ...document.evidence.decisions.map((decision) => `#evidence-decision-${decision.id}`),
  ]);
  const errors: ValidationError[] = [];
  visitReviewDocumentContent(document, {
    inline: (node, path) => {
      if (node.type === "link" && typeof node.href === "string"
        && node.href.startsWith("#") && !allowed.has(node.href)) {
        errors.push(validationError("INTERNAL_LINK_INVALID", `${path}/href`));
      }
    },
  });
  return errors;
}

interface ApprovalArtifactInput {
  bytes: Uint8Array;
  templateBytes: Uint8Array;
  expectedDocument: ReviewDocumentV1;
  expectedGeneratorVersion?: string;
}

interface ApprovalArtifactCoreInput {
  bytes: Uint8Array;
  templateBytes: Uint8Array;
  expectedDocument?: ReviewDocumentV1;
  expectedGeneratorVersion?: string;
}

function parseApprovalArtifactSnapshot(input: ApprovalArtifactCoreInput): ValidationResult<ParsedApprovalArtifact> {
  const decoded = decodeStrictUtf8(input.bytes, "/approval");
  if (!decoded.ok) return decoded;
  const templateDecoded = decodeStrictUtf8(input.templateBytes, "/approval/template");
  if (!templateDecoded.ok) return templateDecoded;
  const text = decoded.value;
  const errors: ValidationError[] = [];
  if (hasUnreplacedPlaceholder(text)) errors.push(validationError("PLACEHOLDER_REMAINS", "/approval"));
  errors.push(...externalResourceErrors(text));
  errors.push(...approvalShellLinkErrors(text));
  errors.push(...approvalLandmarkErrors(text, "/approval/shell"));
  errors.push(...approvalLandmarkErrors(templateDecoded.value, "/approval/template/shell"));
  const meta = {
    artifact: uniqueMeta(text, "dar-artifact"),
    generatorVersion: uniqueMeta(text, "dar-generator-version"),
    documentId: uniqueMeta(text, "dar-document-id"),
    contentVersion: uniqueMeta(text, "dar-content-version"),
    round: uniqueMeta(text, "dar-round"),
    reviewDigest: uniqueMeta(text, "dar-review-digest"),
  };
  const actualCsp = uniqueCsp(text);
  const templateCsp = uniqueCsp(templateDecoded.value);
  const calculatedCsp = expectedOfflineCsp(text);
  const calculatedTemplateCsp = expectedOfflineCsp(templateDecoded.value);
  if (actualCsp === undefined || templateCsp === undefined || calculatedCsp === undefined
    || calculatedTemplateCsp === undefined || actualCsp !== calculatedCsp
    || templateCsp !== calculatedTemplateCsp || actualCsp !== templateCsp) {
    errors.push(validationError("CSP_INVALID", "/approval/csp"));
  }
  const contentVersion = Number(meta.contentVersion);
  const round = Number(meta.round);
  if (meta.artifact !== "review-approval-html/1" || meta.generatorVersion === undefined
    || !isSemver(meta.generatorVersion) || meta.documentId === undefined || !DOCUMENT_ID.test(meta.documentId)
    || meta.contentVersion === undefined || !Number.isSafeInteger(contentVersion) || contentVersion < 1
    || String(contentVersion) !== meta.contentVersion || meta.round === undefined
    || !Number.isSafeInteger(round) || round < 1 || String(round) !== meta.round
    || meta.reviewDigest === undefined || !DIGEST.test(meta.reviewDigest)) {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/approval/meta"));
  }
  const payloadMatches = [...text.matchAll(/<template id="review-document-data" data-encoding="base64">([A-Za-z0-9+/]*={0,2})<\/template>/gu)];
  let embedded: ReviewDocumentV1 | undefined;
  if (payloadMatches.length !== 1) {
    errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/approval/document"));
  } else {
    const payload = payloadMatches[0]?.[1] ?? "";
    try {
      const payloadBytes = Buffer.from(payload, "base64");
      if (payloadBytes.toString("base64") !== payload) throw new Error("noncanonical base64");
      const payloadText = decodeStrictUtf8(payloadBytes, "/approval/document");
      if (!payloadText.ok) errors.push(...payloadText.errors);
      else {
        const parsed = parseStrictJson(payloadText.value, "/approval/document");
        if (!parsed.ok) errors.push(...parsed.errors);
        else {
          const documentPrivacy = validatePrivateData(parsed.value, "/approval/document");
          if (!documentPrivacy.ok) errors.push(...documentPrivacy.errors);
          else {
            const validated = validateReviewDocument(parsed.value);
            if (!validated.ok) {
              errors.push(...validated.errors.map((error) => {
                const mapped = fromProtocolError(error);
                return { ...mapped, path: `/approval/document${mapped.path}` };
              }));
            } else embedded = validated.value;
          }
        }
      }
    } catch {
      errors.push(validationError("ARTIFACT_FORMAT_INVALID", "/approval/document"));
    }
  }
  const embeddedDigest = embedded === undefined ? undefined : reviewDigestForDocument(embedded);
  const embeddedMatchesMeta = embedded !== undefined
    && meta.documentId === embedded.document.id
    && meta.contentVersion === String(embedded.document.contentVersion)
    && meta.round === String(embedded.document.round)
    && meta.reviewDigest === embeddedDigest;
  const embeddedMatchesExpected = input.expectedDocument === undefined || (embedded !== undefined
    && canonicalJson(canonicalReviewDocument(embedded))
      === canonicalJson(canonicalReviewDocument(input.expectedDocument)));
  if (!embeddedMatchesMeta || !embeddedMatchesExpected
    || (input.expectedGeneratorVersion !== undefined && meta.generatorVersion !== input.expectedGeneratorVersion)) {
    errors.push(validationError("ARTIFACT_IDENTITY_MISMATCH", "/approval/meta"));
  }
  const authoritativeDocument = input.expectedDocument ?? embedded;
  if (authoritativeDocument !== undefined) {
    errors.push(...documentInternalLinkErrors(authoritativeDocument));
  }
  const expected = meta.generatorVersion === undefined || authoritativeDocument === undefined
    ? validationErrors<string>([validationError("ARTIFACT_FORMAT_INVALID", "/approval/meta")])
    : fillTemplate(templateDecoded.value, authoritativeDocument, meta.generatorVersion);
  if (!expected.ok) errors.push(...expected.errors);
  else if (expected.value !== text) {
    errors.push(validationError(actualCsp === templateCsp ? "ARTIFACT_DRIFT" : "CSP_INVALID", "/approval"));
  }
  const privacy = validatePrivateText(text, "/approval");
  if (!privacy.ok) errors.push(...privacy.errors);
  if (errors.length > 0) return validationErrors(errors);
  return validationSuccess({
    generatorVersion: meta.generatorVersion!,
    document: embedded!,
    text,
  });
}

export function parseApprovalArtifact(input: ApprovalArtifactInput): ValidationResult<ParsedApprovalArtifact> {
  const snapshot = snapshotSafeInput<ApprovalArtifactInput>(input, "/approval");
  if (!snapshot.ok) return snapshot;
  try {
    const keys = Object.keys(snapshot.value);
    const allowedKeys = new Set([
      "bytes",
      "templateBytes",
      "expectedDocument",
      "expectedGeneratorVersion",
    ]);
    if (!Object.hasOwn(snapshot.value, "bytes")
      || !Object.hasOwn(snapshot.value, "templateBytes")
      || !Object.hasOwn(snapshot.value, "expectedDocument")
      || keys.some((key) => !allowedKeys.has(key))) {
      return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/approval")]);
    }
    return parseApprovalArtifactSnapshot(snapshot.value);
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/approval")]);
  }
}

export function createAgentArtifactByteVerifier(input: {
  document: ReviewDocumentV1;
  generatorVersion: string;
}): (bytes: Uint8Array) => { ok: true } | { ok: false } {
  const snapshot = snapshotSafeInput<typeof input>(input, "/verifier");
  if (!snapshot.ok) return () => ({ ok: false });
  return (bytes) => {
    try {
      return parseAgentArtifact(bytes, snapshot.value.document, snapshot.value.generatorVersion).ok
        ? { ok: true }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function createApprovalArtifactByteVerifier(input: {
  document: ReviewDocumentV1;
  generatorVersion: string;
  templateBytes: Uint8Array;
}): (bytes: Uint8Array) => { ok: true } | { ok: false } {
  const snapshot = snapshotSafeInput<typeof input>(input, "/verifier");
  if (!snapshot.ok) return () => ({ ok: false });
  return (bytes) => {
    try {
      return parseApprovalArtifact({
        bytes,
        templateBytes: snapshot.value.templateBytes,
        expectedDocument: snapshot.value.document,
        expectedGeneratorVersion: snapshot.value.generatorVersion,
      }).ok ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function isSnapshottedUint8Array(value: unknown): value is Uint8Array {
  return typeof value === "object"
    && value !== null
    && ArrayBuffer.isView(value)
    && Object.getPrototypeOf(value) === Uint8Array.prototype;
}

function exactSnapshottedByteVerifier(expected: Uint8Array): GeneratedArtifactByteVerifier {
  const frozenExpected = new Uint8Array(expected);
  return (bytes) => {
    try {
      const candidate = snapshotSafeInput<{ bytes: Uint8Array }>({ bytes }, "/verifier/bytes");
      return candidate.ok
        && isSnapshottedUint8Array(candidate.value.bytes)
        && sameBytes(candidate.value.bytes, frozenExpected)
        ? { ok: true }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function createExactGeneratedArtifactByteVerifiers(
  input: ExactGeneratedArtifactByteVerifierInput,
): ValidationResult<ExactGeneratedArtifactByteVerifiers> {
  const snapshot = snapshotSafeInput<ExactGeneratedArtifactByteVerifierInput>(input, "/generated");
  if (!snapshot.ok) return snapshot;
  try {
    const keys = Object.keys(snapshot.value);
    const expectedKeys = [
      "document",
      "generatorVersion",
      "templateBytes",
      "agentBytes",
      "approvalBytes",
    ] as const;
    if (keys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(snapshot.value, key))) {
      return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/generated")]);
    }
    if (snapshot.value.generatorVersion !== SUPPORTED_GENERATOR_VERSION) {
      return validationErrors([
        validationError("ARTIFACT_FORMAT_INVALID", "/generated/generatorVersion"),
      ]);
    }
    const document = validateDeliverableDocument(snapshot.value.document);
    if (!document.ok) {
      return validationErrors(document.errors.map((error) => ({
        ...error,
        path: `/generated/document${error.path}`,
      })));
    }
    const documentPrivacy = validatePrivateData(document.value, "/generated/document");
    if (!documentPrivacy.ok) return documentPrivacy;
    const approval = parseApprovalArtifactSnapshot({
      bytes: snapshot.value.approvalBytes,
      templateBytes: snapshot.value.templateBytes,
      expectedDocument: document.value,
      expectedGeneratorVersion: snapshot.value.generatorVersion,
    });
    const agent = parseAgentArtifactSnapshot(
      snapshot.value.agentBytes,
      document.value,
      snapshot.value.generatorVersion,
    );
    if (!agent.ok || !approval.ok) {
      return validationErrors([
        ...(agent.ok ? [] : agent.errors),
        ...(approval.ok ? [] : approval.errors),
      ]);
    }
    return validationSuccess({
      agent: exactSnapshottedByteVerifier(snapshot.value.agentBytes),
      approval: exactSnapshottedByteVerifier(snapshot.value.approvalBytes),
    });
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/generated")]);
  }
}

/**
 * Performs one paired, read-only preflight of the existing generated artifacts.
 * The Approval document is the authority for the old snapshot; the Agent
 * artifact is then bound to that exact embedded snapshot. Returned callbacks
 * accept only the two byte strings copied during this preflight.
 */
export function createGeneratedReplacementByteVerifiers(
  input: GeneratedReplacementByteVerifierInput,
): ValidationResult<GeneratedReplacementByteVerifiers> {
  const snapshot = snapshotSafeInput<GeneratedReplacementByteVerifierInput>(input, "/replacement");
  if (!snapshot.ok) return snapshot;
  try {
    if (!isSemver(snapshot.value.generatorVersion)
      || snapshot.value.generatorVersion !== SUPPORTED_GENERATOR_VERSION) {
      return validationErrors([
        validationError("ARTIFACT_FORMAT_INVALID", "/replacement/generatorVersion"),
      ]);
    }

    const current = validateReviewDocument(snapshot.value.currentDocument);
    if (!current.ok) {
      return validationErrors(current.errors.map((error) => {
        const mapped = fromProtocolError(error);
        return { ...mapped, path: `/replacement/currentDocument${mapped.path}` };
      }));
    }
    const currentPrivacy = validatePrivateData(current.value, "/replacement/currentDocument");
    if (!currentPrivacy.ok) return currentPrivacy;

    const approval = parseApprovalArtifactSnapshot({
      bytes: snapshot.value.existingApprovalBytes,
      templateBytes: snapshot.value.templateBytes,
      expectedGeneratorVersion: snapshot.value.generatorVersion,
    });
    if (!approval.ok) return approval;

    if (approval.value.document.delivery.id !== current.value.delivery.id
      || approval.value.document.document.id !== current.value.document.id) {
      return validationErrors([
        validationError("ARTIFACT_IDENTITY_MISMATCH", "/replacement/identity"),
      ]);
    }

    const agent = parseAgentArtifactSnapshot(
      snapshot.value.existingAgentBytes,
      approval.value.document,
      snapshot.value.generatorVersion,
    );
    if (!agent.ok) return agent;

    return validationSuccess({
      agent: exactSnapshottedByteVerifier(snapshot.value.existingAgentBytes),
      approval: exactSnapshottedByteVerifier(snapshot.value.existingApprovalBytes),
    });
  } catch {
    return validationErrors([validationError("ARTIFACT_FORMAT_INVALID", "/replacement")]);
  }
}
