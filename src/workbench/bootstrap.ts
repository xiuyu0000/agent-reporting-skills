import {
  computeReviewDigest,
  validateReviewDocument,
  type DecisionBlock,
  type ProtocolError,
  type ReviewDocumentV1,
} from "../protocol/index.js";
import { renderContentNodes, type ContentRenderContext } from "./content-renderer.js";
import { isUiLocale, stringsFor, type WorkbenchStrings } from "./i18n.js";

export const SUPPORTED_GENERATOR_VERSION = "0.2.0" as const;

export const WORKBENCH_META_NAMES = [
  "dar-generator-version",
  "dar-document-id",
  "dar-content-version",
  "dar-round",
  "dar-review-digest",
] as const;

interface SafeWorkbenchError {
  readonly code: string;
  readonly path: string;
}

class WorkbenchLoadError extends Error {
  readonly errorCode: string;
  readonly errorPath: string;

  constructor(code: string, path: string) {
    super(code);
    this.name = "WorkbenchLoadError";
    this.errorCode = code;
    this.errorPath = path;
  }
}

interface WorkbenchLandmarks {
  readonly skip: HTMLAnchorElement;
  readonly header: HTMLElement;
  readonly main: HTMLElement;
  readonly rail: HTMLElement;
  readonly footer: HTMLElement;
  readonly status: HTMLElement;
  readonly data: HTMLTemplateElement;
}

function uniqueElement<T extends Element>(selector: string, tagName: string): T {
  const matches = document.querySelectorAll(selector);
  const element = matches.item(0);
  if (matches.length !== 1 || element?.tagName.toLowerCase() !== tagName) {
    throw new WorkbenchLoadError("SHELL_IDENTITY_INVALID", selector);
  }
  return element as T;
}

function readLandmarks(): WorkbenchLandmarks {
  const skip = uniqueElement<HTMLAnchorElement>("a.skip-link[href='#review-main']", "a");
  const firstFocusable = document.querySelector("a[href],button,input,select,textarea,[tabindex]");
  if (firstFocusable !== skip) throw new WorkbenchLoadError("SHELL_IDENTITY_INVALID", "/skip-link");
  if (document.querySelectorAll("h1").length !== 0) {
    throw new WorkbenchLoadError("SHELL_HEADING_INVALID", "/h1");
  }
  const data = uniqueElement<HTMLTemplateElement>("template#review-document-data", "template");
  if (
    data.dataset.encoding !== "base64"
    || data.content.querySelector("*") !== null
    || data.content.childNodes.length !== 1
    || data.content.firstChild?.nodeType !== Node.TEXT_NODE
  ) {
    throw new WorkbenchLoadError("DOCUMENT_ENCODING_INVALID", "/review-document-data");
  }
  return {
    skip,
    header: uniqueElement<HTMLElement>("header#review-header", "header"),
    main: uniqueElement<HTMLElement>("main#review-main", "main"),
    rail: uniqueElement<HTMLElement>("aside#decision-rail", "aside"),
    footer: uniqueElement<HTMLElement>("footer#review-footer", "footer"),
    status: uniqueElement<HTMLElement>("#workbench-status[aria-live]", "div"),
    data,
  };
}

function canonicalBase64Bytes(value: string): Uint8Array {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new WorkbenchLoadError("DOCUMENT_BASE64_INVALID", "/review-document-data");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new WorkbenchLoadError("DOCUMENT_BASE64_INVALID", "/review-document-data");
  }
  if (btoa(binary) !== value) {
    throw new WorkbenchLoadError("DOCUMENT_BASE64_INVALID", "/review-document-data");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseDocument(data: HTMLTemplateElement): ReviewDocumentV1 {
  const encoded = data.content.textContent ?? "";
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(canonicalBase64Bytes(encoded));
  } catch (error) {
    if (error instanceof WorkbenchLoadError) throw error;
    throw new WorkbenchLoadError("DOCUMENT_UTF8_INVALID", "/review-document-data");
  }
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch {
    throw new WorkbenchLoadError("DOCUMENT_JSON_INVALID", "/review-document-data");
  }
  const validated = validateReviewDocument(input);
  if (!validated.ok) throw validated.errors;
  return validated.value;
}

function metaContent(name: (typeof WORKBENCH_META_NAMES)[number]): string {
  const meta = uniqueElement<HTMLMetaElement>(`meta[name='${name}']`, "meta");
  return meta.content;
}

function verifyMetadata(documentValue: ReviewDocumentV1): void {
  const generatorVersion = metaContent("dar-generator-version");
  const documentId = metaContent("dar-document-id");
  const contentVersion = metaContent("dar-content-version");
  const round = metaContent("dar-round");
  const digest = metaContent("dar-review-digest");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(generatorVersion)) {
    throw new WorkbenchLoadError("META_FORMAT_INVALID", "/meta/dar-generator-version");
  }
  if (generatorVersion !== SUPPORTED_GENERATOR_VERSION) {
    throw new WorkbenchLoadError("META_IDENTITY_MISMATCH", "/meta/dar-generator-version");
  }
  if (!/^RD-[0-9A-F]{20}$/u.test(documentId)) {
    throw new WorkbenchLoadError("META_FORMAT_INVALID", "/meta/dar-document-id");
  }
  if (!/^[1-9]\d*$/u.test(contentVersion)) {
    throw new WorkbenchLoadError("META_FORMAT_INVALID", "/meta/dar-content-version");
  }
  if (!/^[1-9]\d*$/u.test(round)) {
    throw new WorkbenchLoadError("META_FORMAT_INVALID", "/meta/dar-round");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new WorkbenchLoadError("META_FORMAT_INVALID", "/meta/dar-review-digest");
  }
  const computed = computeReviewDigest(documentValue);
  if (!computed.ok) throw computed.errors;
  const identities: ReadonlyArray<readonly [string, string, string]> = [
    [documentId, documentValue.document.id, "/meta/dar-document-id"],
    [contentVersion, String(documentValue.document.contentVersion), "/meta/dar-content-version"],
    [round, String(documentValue.document.round), "/meta/dar-round"],
    [digest, computed.value, "/meta/dar-review-digest"],
  ];
  for (const [actual, expected, path] of identities) {
    if (actual !== expected) throw new WorkbenchLoadError("META_IDENTITY_MISMATCH", path);
  }
}

function elementWithText<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = ownerDocument.createElement(tag);
  element.textContent = text;
  return element;
}

function tierLabel(block: DecisionBlock, strings: WorkbenchStrings): string {
  if (block.tier === "T2") return strings.tierT2;
  if (block.tier === "T1") return strings.tierT1;
  return strings.tierT0;
}

function statusLabel(
  status: ReviewDocumentV1["document"]["status"],
  strings: WorkbenchStrings,
): string {
  if (status === "draft") return strings.statusDraft;
  if (status === "finalized") return strings.statusFinalized;
  return strings.statusInReview;
}

function internalReferenceLink(
  ownerDocument: Document,
  targetId: string,
  text: string,
): HTMLAnchorElement {
  const link = elementWithText(ownerDocument, "a", text);
  link.href = `#${targetId}`;
  link.setAttribute("data-internal-ref", "true");
  return link;
}

function textList(
  ownerDocument: Document,
  items: readonly string[],
  strings: WorkbenchStrings,
  contentLanguage: string,
): HTMLElement {
  if (items.length === 0) {
    const empty = elementWithText(ownerDocument, "p", strings.none);
    empty.className = "empty-value";
    return empty;
  }
  const list = ownerDocument.createElement("ul");
  list.lang = contentLanguage;
  for (const item of items) list.append(elementWithText(ownerDocument, "li", item));
  return list;
}

function referenceList(
  ownerDocument: Document,
  references: readonly string[],
  target: (reference: string) => string,
  strings: WorkbenchStrings,
): HTMLElement {
  const value = ownerDocument.createElement("span");
  value.className = "reference-list";
  if (references.length === 0) {
    value.textContent = strings.none;
    return value;
  }
  references.forEach((reference, index) => {
    if (index > 0) value.append(ownerDocument.createTextNode(", "));
    value.append(internalReferenceLink(ownerDocument, target(reference), reference));
  });
  return value;
}

function appendDefinition(
  ownerDocument: Document,
  list: HTMLDListElement,
  label: string,
  value: Node,
): void {
  list.append(elementWithText(ownerDocument, "dt", label));
  const definition = ownerDocument.createElement("dd");
  definition.append(value);
  list.append(definition);
}

function renderBlockContext(
  ownerDocument: Document,
  block: DecisionBlock,
  strings: WorkbenchStrings,
  contentLanguage: string,
): HTMLDetailsElement {
  const details = ownerDocument.createElement("details");
  details.className = "block-context";
  details.append(elementWithText(ownerDocument, "summary", strings.blockContext));
  const list = ownerDocument.createElement("dl");
  appendDefinition(
    ownerDocument,
    list,
    strings.dependencies,
    referenceList(ownerDocument, block.dependencies, (id) => `block-${id}`, strings),
  );
  appendDefinition(
    ownerDocument,
    list,
    strings.claimReferences,
    referenceList(ownerDocument, block.claimRefs, (id) => `evidence-fact-${id}`, strings),
  );
  appendDefinition(
    ownerDocument,
    list,
    strings.decisionReferences,
    referenceList(ownerDocument, block.decisionRefs, (id) => `evidence-decision-${id}`, strings),
  );
  const changed = ownerDocument.createElement("span");
  if (block.changed === undefined) {
    changed.textContent = strings.none;
  } else {
    const label = elementWithText(
      ownerDocument,
      "span",
      `${strings.changedRound} ${block.changed.round}: `,
    );
    const summary = elementWithText(ownerDocument, "span", block.changed.summary);
    summary.lang = contentLanguage;
    changed.append(label, summary);
  }
  appendDefinition(ownerDocument, list, strings.changed, changed);
  details.append(list);
  return details;
}

function renderContinuation(
  ownerDocument: Document,
  documentValue: ReviewDocumentV1,
  strings: WorkbenchStrings,
  contentContext: ContentRenderContext,
): HTMLElement {
  const continuation = ownerDocument.createElement("section");
  continuation.className = "context-panel continuation";
  continuation.append(elementWithText(ownerDocument, "h2", strings.continuation));
  const overview = ownerDocument.createElement("dl");
  const objective = elementWithText(ownerDocument, "span", documentValue.continuation.objective);
  objective.lang = documentValue.document.language;
  appendDefinition(ownerDocument, overview, strings.objective, objective);
  appendDefinition(
    ownerDocument,
    overview,
    strings.scope,
    textList(ownerDocument, documentValue.continuation.scope, strings, documentValue.document.language),
  );
  appendDefinition(
    ownerDocument,
    overview,
    strings.exclusions,
    textList(ownerDocument, documentValue.continuation.exclusions, strings, documentValue.document.language),
  );
  continuation.append(overview, elementWithText(ownerDocument, "h3", strings.currentState));
  const currentState = ownerDocument.createElement("div");
  currentState.className = "structured-content";
  currentState.lang = documentValue.document.language;
  if (documentValue.continuation.currentState.length === 0) {
    const empty = elementWithText(ownerDocument, "p", strings.none);
    empty.className = "empty-value";
    empty.lang = documentValue.document.uiLocale;
    currentState.append(empty);
  } else {
    currentState.append(renderContentNodes(
      ownerDocument,
      documentValue.continuation.currentState,
      contentContext,
    ));
  }
  continuation.append(currentState, elementWithText(ownerDocument, "h3", strings.nextActions));
  if (documentValue.continuation.nextActions.length === 0) {
    continuation.append(elementWithText(ownerDocument, "p", strings.none));
  } else {
    const actions = ownerDocument.createElement("ol");
    actions.className = "next-actions";
    for (const action of documentValue.continuation.nextActions) {
      const item = ownerDocument.createElement("li");
      const actionText = elementWithText(ownerDocument, "span", `${action.id} — ${action.action}`);
      actionText.lang = documentValue.document.language;
      item.append(actionText);
      if (action.owner !== undefined) {
        const owner = ownerDocument.createElement("p");
        const ownerValue = elementWithText(ownerDocument, "span", action.owner);
        ownerValue.className = "content-value";
        ownerValue.lang = documentValue.document.language;
        owner.append(
          elementWithText(ownerDocument, "span", `${strings.owner}: `),
          ownerValue,
        );
        item.append(owner);
      }
      const verification = ownerDocument.createElement("p");
      const verificationValue = elementWithText(ownerDocument, "span", action.verification);
      verificationValue.className = "content-value";
      verificationValue.lang = documentValue.document.language;
      verification.append(
        elementWithText(ownerDocument, "span", `${strings.verification}: `),
        verificationValue,
      );
      item.append(verification);
      actions.append(item);
    }
    continuation.append(actions);
  }
  for (const [heading, values] of [
    [strings.validationEvidence, documentValue.continuation.validationEvidence],
    [strings.evidenceGaps, documentValue.continuation.evidenceGaps],
  ] as const) {
    continuation.append(
      elementWithText(ownerDocument, "h3", heading),
      textList(ownerDocument, values, strings, documentValue.document.language),
    );
  }
  return continuation;
}

function confidenceLabel(
  confidence: ReviewDocumentV1["evidence"]["facts"][number]["confidence"],
  strings: WorkbenchStrings,
): string {
  if (confidence === "high") return strings.confidenceHigh;
  if (confidence === "medium") return strings.confidenceMedium;
  if (confidence === "low") return strings.confidenceLow;
  return strings.confidenceUnknown;
}

function renderEvidenceItems(
  ownerDocument: Document,
  heading: string,
  idPrefix: "evidence-fact" | "evidence-decision",
  items: readonly (
    | ReviewDocumentV1["evidence"]["facts"][number]
    | ReviewDocumentV1["evidence"]["decisions"][number]
  )[],
  documentValue: ReviewDocumentV1,
  strings: WorkbenchStrings,
  contentContext: ContentRenderContext,
): HTMLElement {
  const group = ownerDocument.createElement("section");
  group.className = "evidence-group";
  group.append(elementWithText(ownerDocument, "h3", heading));
  if (items.length === 0) {
    group.append(elementWithText(ownerDocument, "p", strings.none));
    return group;
  }
  const list = ownerDocument.createElement("ol");
  list.className = "evidence-items";
  for (const item of items) {
    const listItem = ownerDocument.createElement("li");
    listItem.id = `${idPrefix}-${item.id}`;
    const identity = elementWithText(
      ownerDocument,
      "p",
      `${item.id} · ${strings.confidence}: ${confidenceLabel(item.confidence, strings)}`,
    );
    identity.className = "evidence-identity";
    const content = ownerDocument.createElement("div");
    content.className = "structured-content";
    content.lang = documentValue.document.language;
    content.append(renderContentNodes(ownerDocument, item.content, contentContext));
    const sources = ownerDocument.createElement("p");
    sources.append(
      ownerDocument.createTextNode(`${strings.sourceReferences}: `),
      referenceList(ownerDocument, item.sourceRefs, (id) => `evidence-source-${id}`, strings),
    );
    listItem.append(identity, content, sources);
    list.append(listItem);
  }
  group.append(list);
  return group;
}

function evidenceItemTarget(reference: string): string {
  if (reference.startsWith("SRC-")) return `evidence-source-${reference}`;
  if (reference.startsWith("C-")) return `evidence-fact-${reference}`;
  if (reference.startsWith("D-")) return `evidence-decision-${reference}`;
  throw new WorkbenchLoadError("EVIDENCE_REFERENCE_INVALID", "/evidence/conflicts/itemRefs");
}

function renderEvidence(
  ownerDocument: Document,
  documentValue: ReviewDocumentV1,
  strings: WorkbenchStrings,
  contentContext: ContentRenderContext,
): HTMLElement {
  const evidence = ownerDocument.createElement("section");
  evidence.className = "context-panel evidence";
  evidence.append(elementWithText(ownerDocument, "h2", strings.evidence));
  const notice = elementWithText(ownerDocument, "p", strings.evidenceNotice);
  notice.className = "notice evidence-notice";
  evidence.append(notice);

  const sources = ownerDocument.createElement("section");
  sources.className = "evidence-group";
  sources.append(elementWithText(ownerDocument, "h3", strings.sourceHierarchy));
  if (documentValue.evidence.sourceHierarchy.length === 0) {
    sources.append(elementWithText(ownerDocument, "p", strings.none));
  } else {
    const sourceList = ownerDocument.createElement("ol");
    sourceList.className = "source-hierarchy";
    for (const source of documentValue.evidence.sourceHierarchy) {
      const item = ownerDocument.createElement("li");
      item.id = `evidence-source-${source.id}`;
      const label = elementWithText(ownerDocument, "strong", `${source.id} — ${source.label}`);
      label.lang = documentValue.document.language;
      const rank = elementWithText(ownerDocument, "p", `${strings.sourceRank}: ${source.rank}`);
      const reference = ownerDocument.createElement("p");
      reference.append(ownerDocument.createTextNode(`${strings.reference}: `));
      const referenceText = elementWithText(ownerDocument, "span", source.reference);
      referenceText.className = "source-reference";
      referenceText.lang = documentValue.document.language;
      reference.append(referenceText);
      const kind = source.freshness.kind === "static"
        ? strings.staticSource
        : strings.timeSensitiveSource;
      const freshness = elementWithText(
        ownerDocument,
        "p",
        `${strings.freshness}: ${kind} · ${strings.checkedAt}: ${source.freshness.checkedAt}${
          source.freshness.kind === "time-sensitive"
            ? ` · ${strings.expiresAt}: ${source.freshness.expiresAt}`
            : ""
        }`,
      );
      freshness.className = "freshness";
      item.append(label, rank, reference, freshness);
      sourceList.append(item);
    }
    sources.append(sourceList);
  }
  evidence.append(
    sources,
    renderEvidenceItems(
      ownerDocument,
      strings.facts,
      "evidence-fact",
      documentValue.evidence.facts,
      documentValue,
      strings,
      contentContext,
    ),
    renderEvidenceItems(
      ownerDocument,
      strings.decisions,
      "evidence-decision",
      documentValue.evidence.decisions,
      documentValue,
      strings,
      contentContext,
    ),
  );

  for (const [heading, values] of [
    [strings.constraints, documentValue.evidence.constraints],
    [strings.risks, documentValue.evidence.risks],
    [strings.openQuestions, documentValue.evidence.openQuestions],
  ] as const) {
    const group = ownerDocument.createElement("section");
    group.className = "evidence-group";
    group.append(
      elementWithText(ownerDocument, "h3", heading),
      textList(ownerDocument, values, strings, documentValue.document.language),
    );
    evidence.append(group);
  }

  const conflicts = ownerDocument.createElement("section");
  conflicts.className = "evidence-group";
  conflicts.append(elementWithText(ownerDocument, "h3", strings.conflicts));
  if (documentValue.evidence.conflicts.length === 0) {
    conflicts.append(elementWithText(ownerDocument, "p", strings.none));
  } else {
    const list = ownerDocument.createElement("ol");
    list.className = "conflict-list";
    for (const conflict of documentValue.evidence.conflicts) {
      const item = ownerDocument.createElement("li");
      const state = elementWithText(
        ownerDocument,
        "p",
        `${conflict.severity === "blocking" ? strings.blocking : strings.nonblocking} · ${
          conflict.status === "resolved" ? strings.resolved : strings.unresolved
        }`,
      );
      state.className = "conflict-state";
      const description = elementWithText(ownerDocument, "p", conflict.description);
      description.lang = documentValue.document.language;
      const references = ownerDocument.createElement("p");
      references.append(
        ownerDocument.createTextNode(`${strings.reference}: `),
        referenceList(ownerDocument, conflict.itemRefs, evidenceItemTarget, strings),
      );
      item.append(state, description, references);
      if (conflict.resolution !== undefined) {
        const resolution = ownerDocument.createElement("p");
        const resolutionValue = elementWithText(ownerDocument, "span", conflict.resolution);
        resolutionValue.className = "content-value";
        resolutionValue.lang = documentValue.document.language;
        resolution.append(
          elementWithText(ownerDocument, "span", `${strings.resolution}: `),
          resolutionValue,
        );
        item.append(resolution);
      }
      list.append(item);
    }
    conflicts.append(list);
  }
  evidence.append(conflicts);
  return evidence;
}

function renderBlock(
  ownerDocument: Document,
  block: DecisionBlock,
  documentValue: ReviewDocumentV1,
  strings: WorkbenchStrings,
  contentContext: ContentRenderContext,
): HTMLElement {
  const article = ownerDocument.createElement("article");
  article.className = "decision-block";
  article.dataset.tier = block.tier;
  article.id = `block-${block.id}`;
  const heading = ownerDocument.createElement("div");
  heading.className = "block-heading";
  const headingText = ownerDocument.createElement("div");
  const eyebrow = elementWithText(ownerDocument, "p", block.id);
  eyebrow.className = "eyebrow";
  const title = elementWithText(ownerDocument, "h3", block.title);
  title.lang = documentValue.document.language;
  const summary = elementWithText(ownerDocument, "p", block.summary);
  summary.className = "summary";
  summary.lang = documentValue.document.language;
  headingText.append(eyebrow, title, summary);
  const tier = elementWithText(ownerDocument, "span", tierLabel(block, strings));
  tier.className = "tier-chip";
  heading.append(headingText, tier);
  article.append(heading);

  if (documentValue.approvals.currentFrozen.includes(block.id)) {
    const approvedRound = documentValue.approvals.history
      .filter((approval) => approval.blockId === block.id)
      .reduce((latest, approval) => Math.max(latest, approval.approvedRound), 0);
    const frozen = elementWithText(
      ownerDocument,
      "p",
      `❄ ${strings.frozen} · ${strings.frozenRound}: ${approvedRound}`,
    );
    frozen.className = "status-chip";
    article.append(frozen);
  }
  if (block.tier === "T2") {
    const prompt = ownerDocument.createElement("dl");
    prompt.className = "t2-prompt";
    prompt.append(
      elementWithText(ownerDocument, "dt", strings.whyTier),
      elementWithText(ownerDocument, "dd", block.whyTier),
      elementWithText(ownerDocument, "dt", strings.ask),
      elementWithText(ownerDocument, "dd", block.ask),
    );
    for (const value of prompt.querySelectorAll("dd")) value.lang = documentValue.document.language;
    article.append(prompt);
  }
  article.append(renderBlockContext(
    ownerDocument,
    block,
    strings,
    documentValue.document.language,
  ));
  const body = ownerDocument.createElement("details");
  body.className = "block-body";
  body.open = block.tier === "T2";
  body.append(elementWithText(ownerDocument, "summary", strings.summary));
  const content = ownerDocument.createElement("div");
  content.lang = documentValue.document.language;
  content.append(renderContentNodes(ownerDocument, block.body, contentContext));
  body.append(content);
  article.append(body);
  return article;
}

function buildWorkbenchFragments(
  documentValue: ReviewDocumentV1,
  strings: WorkbenchStrings,
): {
  header: DocumentFragment;
  main: DocumentFragment;
  rail: DocumentFragment;
  footer: DocumentFragment;
} {
  const ownerDocument = document;
  const header = ownerDocument.createDocumentFragment();
  const eyebrow = elementWithText(ownerDocument, "p", strings.approvalWorkspace);
  eyebrow.className = "eyebrow";
  const title = elementWithText(ownerDocument, "h1", documentValue.document.title);
  title.lang = documentValue.document.language;
  const summary = elementWithText(ownerDocument, "p", documentValue.document.summary);
  summary.className = "summary";
  summary.lang = documentValue.document.language;
  const meta = elementWithText(
    ownerDocument,
    "p",
    `${strings.round}: ${documentValue.document.round} · ${strings.asOf}: ${documentValue.document.asOf} · ${strings.status}: ${statusLabel(documentValue.document.status, strings)}`,
  );
  meta.className = "meta";
  const notice = elementWithText(ownerDocument, "p", strings.evidenceNotice);
  notice.className = "notice";
  const counts = ownerDocument.createElement("ul");
  counts.className = "tier-counts";
  counts.setAttribute("aria-label", strings.tierCounts);
  for (const tier of ["T2", "T1", "T0"] as const) {
    const count = documentValue.blocks.filter((block) => block.tier === tier).length;
    const label = tier === "T2" ? strings.tierT2 : tier === "T1" ? strings.tierT1 : strings.tierT0;
    counts.append(elementWithText(ownerDocument, "li", `${label}: ${count}`));
  }
  header.append(eyebrow, title, summary, meta, notice, counts);

  let termDisclosureIndex = 0;
  const nextTermDisclosureId = (glossaryId: string): string => {
    termDisclosureIndex += 1;
    return `term-definition-${glossaryId}-${termDisclosureIndex}`;
  };
  const contentContext: ContentRenderContext = {
    glossary: new Map(documentValue.glossary.map((entry) => [entry.id, entry])),
    strings,
    uiLocale: documentValue.document.uiLocale,
    contentLanguage: documentValue.document.language,
    nextTermDisclosureId,
  };
  const main = ownerDocument.createDocumentFragment();
  main.append(
    renderContinuation(ownerDocument, documentValue, strings, contentContext),
    renderEvidence(ownerDocument, documentValue, strings, contentContext),
    elementWithText(ownerDocument, "h2", strings.decisionBlocks),
  );
  const blocks = ownerDocument.createElement("div");
  blocks.className = "block-list";
  for (const block of documentValue.blocks) {
    blocks.append(renderBlock(ownerDocument, block, documentValue, strings, contentContext));
  }
  main.append(blocks);
  if (documentValue.glossary.length > 0) {
    const glossary = ownerDocument.createElement("section");
    glossary.className = "glossary";
    glossary.append(elementWithText(ownerDocument, "h2", strings.glossary));
    const definitions = ownerDocument.createElement("dl");
    for (const entry of documentValue.glossary) {
      const term = elementWithText(ownerDocument, "dt", entry.term);
      term.id = `glossary-${entry.id}`;
      term.lang = documentValue.document.language;
      const definition = elementWithText(ownerDocument, "dd", entry.definition);
      definition.lang = documentValue.document.language;
      definitions.append(term, definition);
    }
    glossary.append(definitions);
    main.append(glossary);
  }

  const rail = ownerDocument.createDocumentFragment();
  const railHeading = elementWithText(ownerDocument, "h2", strings.decisionRail);
  railHeading.id = "decision-rail-heading";
  rail.append(railHeading, elementWithText(ownerDocument, "p", strings.noDecisionTools));

  const footer = ownerDocument.createDocumentFragment();
  footer.append(elementWithText(ownerDocument, "p", strings.keyboardHelp));
  return { header, main, rail, footer };
}

function safeErrors(error: unknown): SafeWorkbenchError[] {
  if (error instanceof WorkbenchLoadError) {
    return [{ code: error.errorCode, path: error.errorPath }];
  }
  if (Array.isArray(error)) {
    return error
      .filter((item): item is ProtocolError => {
        if (typeof item !== "object" || item === null) return false;
        const value = item as Partial<ProtocolError>;
        return typeof value.code === "string" && typeof value.path === "string";
      })
      .map((item) => ({ code: item.code, path: item.path }));
  }
  return [{ code: "WORKBENCH_LOAD_FAILED", path: "/" }];
}

function renderFailure(error: unknown): void {
  const panel = document.createElement("section");
  panel.className = "error-panel";
  panel.setAttribute("role", "alert");
  panel.append(elementWithText(
    document,
    "h1",
    "Review document could not be loaded safely / 审批文档无法安全加载",
  ));
  const list = document.createElement("ul");
  list.className = "error-list";
  for (const item of safeErrors(error)) {
    list.append(elementWithText(document, "li", `${item.code} ${item.path}`));
  }
  panel.append(list);
  const main = document.createElement("main");
  main.id = "review-main";
  main.append(panel);
  document.body.replaceChildren(main);
}

export function bootstrapWorkbench(): void {
  let landmarks: WorkbenchLandmarks | undefined;
  try {
    landmarks = readLandmarks();
    const documentValue = parseDocument(landmarks.data);
    verifyMetadata(documentValue);
    if (!isUiLocale(documentValue.document.uiLocale)) {
      throw new WorkbenchLoadError("LOCALE_UNSUPPORTED", "/document/uiLocale");
    }
    const strings = stringsFor(documentValue.document.uiLocale);
    const fragments = buildWorkbenchFragments(documentValue, strings);
    if (fragments.header.querySelectorAll("h1").length !== 1) {
      throw new WorkbenchLoadError("SHELL_HEADING_INVALID", "/h1");
    }
    const fragmentIds = new Set<string>();
    for (const element of fragments.main.querySelectorAll<HTMLElement>("[id]")) {
      if (element.id === "" || fragmentIds.has(element.id)) {
        throw new WorkbenchLoadError("SHELL_IDENTITY_INVALID", "/main/id");
      }
      fragmentIds.add(element.id);
    }
    for (const link of fragments.main.querySelectorAll<HTMLAnchorElement>("a[data-internal-ref]")) {
      const href = link.getAttribute("href");
      if (
        href === null
        || !/^#[A-Za-z][A-Za-z0-9_.:-]*$/u.test(href)
        || fragments.main.querySelectorAll(href).length !== 1
      ) {
        throw new WorkbenchLoadError("INTERNAL_REFERENCE_INVALID", "/main/internal-reference");
      }
    }
    const disclosureIds = new Set<string>();
    for (const toggle of fragments.main.querySelectorAll<HTMLButtonElement>("button.term-disclosure-toggle")) {
      const definitionId = toggle.getAttribute("aria-controls");
      if (
        definitionId === null
        || disclosureIds.has(definitionId)
        || fragments.main.querySelectorAll(`#${definitionId}`).length !== 1
      ) {
        throw new WorkbenchLoadError("TERM_DISCLOSURE_INVALID", "/term-disclosure");
      }
      disclosureIds.add(definitionId);
    }
    document.documentElement.lang = documentValue.document.uiLocale;
    landmarks.skip.textContent = strings.skipToMain;
    document.title = `${documentValue.document.title} — ${strings.approvalWorkspace}`;
    landmarks.header.replaceChildren(fragments.header);
    landmarks.main.replaceChildren(fragments.main);
    landmarks.rail.replaceChildren(fragments.rail);
    landmarks.footer.replaceChildren(fragments.footer);
    landmarks.status.textContent = strings.approvalWorkspace;
    landmarks.skip.addEventListener("click", (event) => {
      event.preventDefault();
      landmarks?.main.focus();
    });
  } catch (error) {
    renderFailure(error);
  }
}
