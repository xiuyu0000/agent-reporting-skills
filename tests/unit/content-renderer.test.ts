import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  blockContentDigest,
  canonicalJson,
  computeReviewDigest,
  validateReviewDocument,
  type ContentNode,
  type ReviewDocumentV1,
} from "../../src/protocol/index.js";
import {
  WORKBENCH_META_NAMES,
  bootstrapWorkbench,
} from "../../src/workbench/bootstrap.js";
import { renderContentNode } from "../../src/workbench/content-renderer.js";
import { stringsFor } from "../../src/workbench/i18n.js";
import {
  GENERATOR_DATA_TOKENS,
  UI_BUILD_TOKENS,
  WORKBENCH_STYLE,
  WORKBENCH_TOKENS,
  createRawWorkbenchTemplate,
} from "../../src/workbench/shell.js";

interface RenderCases {
  injectionText: string;
  externalLink: string;
  longToken: string;
  unsafeLinks: string[];
}

class MiniNodeList<T> extends Array<T> {
  item(index: number): T | null {
    return this[index] ?? null;
  }
}

class MiniNode {
  static readonly TEXT_NODE = 3;
  readonly childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;

  constructor(
    readonly nodeType: number,
    readonly ownerDocument: MiniDocument | null,
  ) {}

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes.splice(0);
    if (value !== "") this.appendChild(new MiniText(value, this.ownerDocument));
  }

  append(...nodes: Array<MiniNode | string>): void {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new MiniText(node, this.ownerDocument) : node);
    }
  }

  appendChild<T extends MiniNode>(node: T): T {
    if (node instanceof MiniFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes.splice(0);
      return node;
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  replaceChildren(...nodes: Array<MiniNode | string>): void {
    this.childNodes.splice(0);
    this.append(...nodes);
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniNodeList<MiniElement> {
    const results = new MiniNodeList<MiniElement>();
    const visit = (node: MiniNode): void => {
      if (node instanceof MiniElement && matchesAnySelector(node, selector)) results.push(node);
      for (const child of node.childNodes) visit(child);
      if (node instanceof MiniTemplate) visit(node.content);
    };
    for (const child of this.childNodes) visit(child);
    return results;
  }
}

class MiniText extends MiniNode {
  constructor(private value: string, ownerDocument: MiniDocument | null) {
    super(3, ownerDocument);
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string) {
    this.value = value;
  }
}

class MiniFragment extends MiniNode {
  constructor(ownerDocument: MiniDocument) {
    super(11, ownerDocument);
  }
}

class MiniElement extends MiniNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  private readonly eventListeners = new Map<string, EventListener[]>();
  hidden = false;
  open = false;
  tabIndex = -1;

  constructor(
    readonly tagName: string,
    ownerDocument: MiniDocument,
  ) {
    super(1, ownerDocument);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name === "href") this.href = value;
    if (name === "lang") this.lang = value;
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name === "content") {
      (this as unknown as Record<string, unknown>).content = value;
    }
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(listener);
    this.eventListeners.set(type, listeners);
  }

  click(): void {
    const event = new Event("click", { cancelable: true });
    for (const listener of this.eventListeners.get("click") ?? []) {
      listener.call(this as unknown as EventTarget, event);
    }
  }

  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(value: string) {
    this.attributes.set("id", value);
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(value: string) {
    this.attributes.set("class", value);
  }

  get href(): string {
    return this.attributes.get("href") ?? "";
  }

  set href(value: string) {
    this.attributes.set("href", value);
  }

  get hash(): string {
    const href = this.href;
    return href.startsWith("#") ? href : new URL(href).hash;
  }

  get rel(): string {
    return this.attributes.get("rel") ?? "";
  }

  set rel(value: string) {
    this.attributes.set("rel", value);
  }

  get lang(): string {
    return this.attributes.get("lang") ?? "";
  }

  set lang(value: string) {
    this.attributes.set("lang", value);
  }

  set scope(value: string) {
    this.attributes.set("scope", value);
  }
}

class MiniTemplate extends MiniElement {
  readonly content: MiniFragment;

  constructor(ownerDocument: MiniDocument) {
    super("TEMPLATE", ownerDocument);
    this.content = new MiniFragment(ownerDocument);
  }
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly head: MiniElement;
  readonly body: MiniElement;
  title = "";
  activeElement: MiniElement | null = null;

  constructor() {
    super(9, null);
    this.documentElement = new MiniElement("HTML", this);
    this.head = new MiniElement("HEAD", this);
    this.body = new MiniElement("BODY", this);
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
  }

  createElement(tag: string): MiniElement {
    return tag.toLowerCase() === "template"
      ? new MiniTemplate(this)
      : new MiniElement(tag.toUpperCase(), this);
  }

  createElementNS(_namespace: string, tag: string): MiniElement {
    return this.createElement(tag);
  }

  createTextNode(value: string): MiniText {
    return new MiniText(value, this);
  }

  createDocumentFragment(): MiniFragment {
    return new MiniFragment(this);
  }
}

function matchesAnySelector(element: MiniElement, selectorList: string): boolean {
  return selectorList.split(",").some((selector) => matchesSelector(element, selector.trim()));
}

function matchesSelector(element: MiniElement, selector: string): boolean {
  if (selector === "*") return true;
  const structural = selector.replace(/\[[^\]]+\]/gu, "");
  const tag = /^([A-Za-z][A-Za-z0-9-]*)/u.exec(structural)?.[1];
  if (tag !== undefined && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const id = /#([A-Za-z0-9_-]+)/u.exec(structural)?.[1];
  if (id !== undefined && element.id !== id) return false;
  const className = /\.([A-Za-z0-9_-]+)/u.exec(structural)?.[1];
  if (className !== undefined && !element.className.split(/\s+/u).includes(className)) return false;
  for (const match of selector.matchAll(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/gu)) {
    const name = match[1];
    const expected = match[2];
    if (name === undefined || !element.attributes.has(name)) return false;
    if (expected !== undefined && element.getAttribute(name) !== expected) return false;
  }
  return true;
}

let baseDocument: ReviewDocumentV1;
let cases: RenderCases;

beforeAll(async () => {
  const [rawDocument, rawCases] = await Promise.all([
    readFile(resolve("tests/fixtures/protocol/review-document.json"), "utf8").then(JSON.parse),
    readFile(resolve("tests/fixtures/workbench/render-cases.json"), "utf8").then(JSON.parse),
  ]);
  baseDocument = rawDocument as ReviewDocumentV1;
  cases = rawCases as RenderCases;
});

const savedGlobals = {
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
};

afterEach(() => {
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: savedGlobals.document, writable: true },
    HTMLElement: { configurable: true, value: savedGlobals.HTMLElement, writable: true },
    Node: { configurable: true, value: savedGlobals.Node, writable: true },
  });
});

function installDom(documentValue: MiniDocument): void {
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: documentValue, writable: true },
    HTMLElement: { configurable: true, value: MiniElement, writable: true },
    Node: { configurable: true, value: MiniNode, writable: true },
  });
}

function enrichedDocument(): ReviewDocumentV1 {
  const input = structuredClone(baseDocument);
  input.document.uiLocale = "zh-CN";
  input.document.language = "en";
  input.document.title = cases.injectionText;
  input.document.summary = cases.longToken;
  input.document.round = 2;
  input.lineage.previousReviewDigest = `sha256:${"a".repeat(64)}`;
  input.continuation.objective = cases.injectionText;
  input.continuation.scope = ["UI-001 safe reading surface"];
  input.continuation.exclusions = ["No review actions yet"];
  input.continuation.currentState = [{
    type: "paragraph",
    content: [{ type: "text", text: `Current ${cases.injectionText}` }],
  }];
  input.continuation.nextActions = [{
    id: "ACT-001",
    action: "Verify self-contained evidence.",
    owner: cases.injectionText,
    verification: `Three browsers ${cases.injectionText}`,
  }];
  input.continuation.validationEvidence = ["Protocol core validated."];
  input.continuation.evidenceGaps = [cases.injectionText];
  input.evidence.sourceHierarchy.push({
    id: "SRC-002",
    rank: 2,
    label: `Time source ${cases.injectionText}`,
    reference: `https://not-a-link.invalid/${cases.injectionText}`,
    freshness: {
      kind: "time-sensitive",
      checkedAt: "2026-08-12T08:30:00Z",
      expiresAt: "2026-08-12T10:00:00Z",
    },
  });
  input.evidence.facts[0]!.content = [{
    type: "paragraph",
    content: [{ type: "text", text: `Fact ${cases.injectionText}` }],
  }];
  input.evidence.facts[0]!.sourceRefs.push("SRC-002");
  input.evidence.decisions = [{
    id: "D-001",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: `Decision ${cases.injectionText}` }],
    }],
    confidence: "medium",
    sourceRefs: ["SRC-002"],
  }];
  input.evidence.constraints = ["No network."];
  input.evidence.risks = [cases.injectionText];
  input.evidence.openQuestions = ["Does keyboard reading remain intact?"];
  input.evidence.conflicts = [{
    itemRefs: ["C-001", "D-001"],
    description: `Resolved conflict ${cases.injectionText}`,
    severity: "blocking",
    status: "resolved",
    resolution: `Use the verified contract ${cases.injectionText}`,
  }, {
    itemRefs: ["SRC-002"],
    description: "Observe freshness until expiry.",
    severity: "nonblocking",
    status: "unresolved",
  }];
  input.lineage.idHighWater.source = 2;
  input.lineage.idHighWater.decision = 1;
  input.glossary = [{ id: "G-001", term: "Closure", definition: "Every downstream dependency." }];
  input.lineage.idHighWater.glossary = 1;
  input.blocks[0]!.body = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: cases.injectionText },
        { type: "strong", text: " Strong" },
        { type: "emphasis", text: " Emphasis" },
        { type: "inlineCode", text: " inline()" },
        { type: "link", text: " evidence", href: cases.externalLink },
        { type: "link", text: " glossary link", href: "#glossary-G-001" },
        { type: "termRef", glossaryId: "G-001" },
      ],
    },
    {
      type: "list",
      ordered: false,
      items: [[{ type: "text", text: "Unordered item" }]],
    },
    {
      type: "list",
      ordered: true,
      items: [[{ type: "text", text: "Ordered item" }]],
    },
    {
      type: "table",
      headers: [[{ type: "text", text: "Header" }]],
      rows: [[[{ type: "text", text: cases.longToken }]]],
    },
    { type: "code", language: "text", text: cases.injectionText },
    { type: "code", text: "plain code" },
    {
      type: "callout",
      tone: "info",
      title: "Info title",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Info body" }] }],
    },
    {
      type: "callout",
      tone: "warning",
      content: [{ type: "list", ordered: false, items: [[{ type: "text", text: "Warning body" }]] }],
    },
    {
      type: "callout",
      tone: "decision",
      content: [{ type: "code", text: "Decision body" }],
    },
    {
      type: "steps",
      items: [{
        title: "Step one",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Step body" }] }],
      }],
    },
    {
      type: "flow",
      title: "Directed flow",
      description: "Four directional cases",
      nodes: [
        { id: "A", label: "Alpha" },
        { id: "B", label: "Beta" },
        { id: "C", label: "Gamma" },
        { id: "D", label: "Delta" },
      ],
      edges: [
        { from: "A", to: "B", label: cases.injectionText },
        { from: "B", to: "A", label: "reverse" },
        { from: "A", to: "C", label: "down" },
        { from: "D", to: "D", label: "loop" },
      ],
    },
  ];
  input.blocks[0]!.decisionRefs = ["D-001"];
  input.blocks[0]!.changed = { round: 2, summary: `Changed ${cases.injectionText}` };
  input.approvals.history = [{
    blockId: "B004",
    approvedRound: 1,
    approvedContentDigest: blockContentDigest(input.blocks[3]!),
  }];
  input.approvals.currentFrozen = ["B004"];
  const validated = validateReviewDocument(input);
  if (!validated.ok) throw new Error(validated.errors.map((error) => error.code).join(","));
  return validated.value;
}

function appendElement(parent: MiniNode, tag: string, attributes: Record<string, string> = {}): MiniElement {
  const ownerDocument = parent.ownerDocument ?? parent as MiniDocument;
  const element = ownerDocument.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.append(element);
  return element;
}

function makeShell(documentValue: ReviewDocumentV1): MiniDocument {
  const ownerDocument = new MiniDocument();
  const digest = computeReviewDigest(documentValue);
  if (!digest.ok) throw new Error("digest failed");
  const metadata: Record<string, string> = {
    "dar-generator-version": "0.2.0",
    "dar-document-id": documentValue.document.id,
    "dar-content-version": String(documentValue.document.contentVersion),
    "dar-round": String(documentValue.document.round),
    "dar-review-digest": digest.value,
  };
  for (const [name, content] of Object.entries(metadata)) {
    appendElement(ownerDocument.head, "meta", { name, content });
  }
  appendElement(ownerDocument.body, "a", {
    class: "skip-link",
    href: "#review-main",
  }).textContent = "Skip to decision blocks";
  appendElement(ownerDocument.body, "header", { id: "review-header" });
  const workspace = appendElement(ownerDocument.body, "div", { class: "workspace" });
  appendElement(workspace, "main", { id: "review-main", tabindex: "-1" });
  appendElement(workspace, "aside", { id: "decision-rail", class: "decision-rail" });
  appendElement(ownerDocument.body, "footer", { id: "review-footer" });
  appendElement(ownerDocument.body, "div", { id: "workbench-status", "aria-live": "polite" });
  const template = appendElement(ownerDocument.body, "template", {
    id: "review-document-data",
    "data-encoding": "base64",
  }) as MiniTemplate;
  template.content.textContent = Buffer.from(canonicalJson(documentValue), "utf8").toString("base64");
  return ownerDocument;
}

function errorText(ownerDocument: MiniDocument): string {
  return ownerDocument.querySelector("main")?.textContent ?? "";
}

describe("safe content renderer and bootstrap", () => {
  it("renders every structured node without interpreting untrusted text", () => {
    const documentValue = enrichedDocument();
    const ownerDocument = makeShell(documentValue);
    installDom(ownerDocument);
    bootstrapWorkbench();

    expect(ownerDocument.documentElement.lang).toBe("zh-CN");
    expect(ownerDocument.querySelector("a.skip-link")?.textContent).toBe("跳到决策块");
    expect(ownerDocument.querySelector("h1")?.textContent).toBe(cases.injectionText);
    expect(ownerDocument.querySelector("h1")?.lang).toBe("en");
    expect(ownerDocument.querySelectorAll("h1")).toHaveLength(1);
    expect(ownerDocument.querySelector("section.continuation")?.textContent).toContain("审批上下文");
    expect(ownerDocument.querySelector("section.continuation")?.textContent).toContain(cases.injectionText);
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("静态来源");
    expect(ownerDocument.querySelector("section.evidence")?.querySelector("p.evidence-notice")?.textContent).toBe(
      "本工作台是对所列证据的综合，不是新的事实源；续作前请按来源层级复核易变事实。",
    );
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("易变来源");
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("失效时间");
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("阻断 · 已解决");
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("非阻断 · 未解决");
    const source = ownerDocument.querySelector("#evidence-source-SRC-002");
    expect(source?.querySelector("span.source-reference")?.textContent).toContain("https://not-a-link.invalid/");
    expect(source?.querySelector("a")).toBeNull();
    expect(ownerDocument.querySelector("#evidence-fact-C-001")).not.toBeNull();
    expect(ownerDocument.querySelector("#evidence-decision-D-001")).not.toBeNull();
    expect(ownerDocument.querySelector("section.continuation")?.querySelectorAll("span.content-value")[0]?.lang).toBe("en");
    expect(ownerDocument.querySelector("section.evidence")?.querySelector("span.content-value")?.lang).toBe("en");
    expect(ownerDocument.querySelectorAll("article.decision-block")).toHaveLength(4);
    expect(ownerDocument.querySelectorAll("script")).toHaveLength(0);
    expect(ownerDocument.querySelectorAll("img")).toHaveLength(0);
    expect(ownerDocument.querySelector("a.link-kind")).toBeNull();
    const external = ownerDocument.querySelectorAll("a").find((anchor) => anchor.href.startsWith("https:"));
    expect(external?.rel).toBe("noopener noreferrer");
    expect(external?.textContent).toContain("延伸阅读");
    expect(external?.querySelector("span.link-kind")?.lang).toBe("zh-CN");
    const termLink = ownerDocument.querySelector("a.term-ref");
    expect(termLink?.href).toBe("#glossary-G-001");
    expect(ownerDocument.querySelectorAll(termLink?.hash ?? "#missing")).toHaveLength(1);
    const termToggle = ownerDocument.querySelector("button.term-disclosure-toggle");
    const definitionId = termToggle?.getAttribute("aria-controls") ?? "missing";
    const termDefinition = ownerDocument.querySelector(`#${definitionId}`);
    expect(termToggle?.getAttribute("type")).toBe("button");
    expect(termToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(termToggle?.textContent).toContain("展开定义");
    expect(termDefinition?.hidden).toBe(true);
    expect(termDefinition?.textContent).toContain("Every downstream dependency.");
    termToggle?.click();
    expect(termToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(termToggle?.textContent).toContain("收起定义");
    expect(termDefinition?.hidden).toBe(false);
    expect(termLink?.textContent).toBe("跳到术语表");
    const blockContext = ownerDocument.querySelector("article#block-B001")?.querySelector("details.block-context");
    expect(blockContext?.textContent).toContain("D-001");
    expect(blockContext?.textContent).toContain("本轮有变更");
    expect(blockContext?.textContent).toContain(cases.injectionText);
    expect(ownerDocument.querySelector("article#block-B002")?.querySelector("details.block-context")?.textContent).toContain("B001");
    const internalLinks = ownerDocument.querySelectorAll("a[data-internal-ref]");
    expect(internalLinks.length).toBeGreaterThan(4);
    for (const link of internalLinks) {
      expect(ownerDocument.querySelectorAll(link.hash)).toHaveLength(1);
    }
    const ids = ownerDocument.querySelectorAll("[id]").map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ownerDocument.querySelectorAll("span.callout-tone").map((node) => node.textContent)).toEqual([
      "ⓘ 信息提示",
      "⚠ 警告",
      "◆ 决策提示",
      "⚠ 警告",
    ]);
    const arrows = ownerDocument.querySelectorAll("polygon.flow-arrow");
    expect(arrows).toHaveLength(4);
    expect(new Set(arrows.map((arrow) => arrow.getAttribute("points"))).size).toBe(4);
    const loop = ownerDocument.querySelector("path.flow-loop");
    expect(loop?.getAttribute("d")).toContain("M 400");
    expect(loop?.getAttribute("d")).toContain("C 330");
    expect(ownerDocument.querySelectorAll("text.flow-label")[0]?.textContent).toBe(cases.injectionText);
    expect(ownerDocument.querySelector("details.flow-alternative")?.textContent).toContain("A → B");
    expect(ownerDocument.querySelector("div.table-region")?.tabIndex).toBe(0);
    expect(ownerDocument.querySelector("div.code-region")?.tabIndex).toBe(0);
    expect(ownerDocument.querySelectorAll("code").some((node) => node.textContent.includes(cases.injectionText))).toBe(true);
    expect(ownerDocument.querySelector("article#block-B001")?.querySelector("details.block-body")?.open).toBe(true);
    expect(ownerDocument.querySelector("article#block-B002")?.querySelector("details.block-body")?.open).toBe(false);
    expect(ownerDocument.querySelector("article#block-B004")?.textContent).toContain("已冻结 · 冻结轮次: 1");
    const initialActions = ownerDocument.querySelectorAll("button")
      .filter((button) => button.className.split(/\s+/u).includes("decision-action"));
    expect(initialActions.length).toBe(12);
    expect(initialActions.map((button) => button.getAttribute("aria-pressed")))
      .toEqual(Array.from({ length: 12 }, () => "false"));
  });

  it("fails closed on every dangerous URL even when called below the protocol boundary", () => {
    const ownerDocument = new MiniDocument();
    const fileUrl = ["file:", "", "", "tmp", "private"].join("/");
    for (const href of [...cases.unsafeLinks, fileUrl]) {
      expect(() => renderContentNode(
        ownerDocument as unknown as Document,
        {
          type: "paragraph",
          content: [{ type: "link", text: "unsafe", href }],
        },
        { glossary: new Map(), strings: stringsFor("en"), uiLocale: "en", contentLanguage: "en", nextTermDisclosureId: () => "term-definition-test" },
      )).toThrow("UNSAFE_LINK");
    }
  });

  it("keeps an empty current-state label in the UI language", () => {
    const documentValue = structuredClone(baseDocument);
    documentValue.document.uiLocale = "zh-CN";
    documentValue.document.language = "en";
    documentValue.continuation.currentState = [];
    const ownerDocument = makeShell(documentValue);
    installDom(ownerDocument);
    bootstrapWorkbench();
    const empty = ownerDocument.querySelector("section.continuation")
      ?.querySelector("div.structured-content")
      ?.querySelector("p.empty-value");
    expect(empty?.textContent).toBe("无");
    expect(empty?.lang).toBe("zh-CN");
  });

  it("renders the complete English chrome without locale fallback", () => {
    const documentValue = structuredClone(baseDocument);
    const ownerDocument = makeShell(documentValue);
    installDom(ownerDocument);
    bootstrapWorkbench();
    expect(ownerDocument.documentElement.lang).toBe("en");
    expect(ownerDocument.querySelector("a.skip-link")?.textContent).toBe("Skip to decision blocks");
    expect(ownerDocument.querySelector("section.continuation")?.textContent).toContain("Review context");
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("Evidence snapshot");
    expect(ownerDocument.querySelector("section.evidence")?.querySelector("p.evidence-notice")?.textContent).toContain(
      "Before continuing, recheck time-sensitive facts according to the source hierarchy.",
    );
    expect(ownerDocument.querySelector("section.evidence")?.textContent).toContain("Static source");
    expect(ownerDocument.querySelector("article#block-B001")?.textContent).toContain("T2 decision");
  });

  it("rejects missing glossary and flow references without partial child output", () => {
    const ownerDocument = new MiniDocument();
    expect(() => renderContentNode(
      ownerDocument as unknown as Document,
      { type: "paragraph", content: [{ type: "termRef", glossaryId: "G-404" }] },
      { glossary: new Map(), strings: stringsFor("en"), uiLocale: "en", contentLanguage: "en", nextTermDisclosureId: () => "term-definition-test" },
    )).toThrow("GLOSSARY_REFERENCE_INVALID");
    expect(() => renderContentNode(
      ownerDocument as unknown as Document,
      {
        type: "flow",
        title: "Broken",
        description: "Broken edge",
        nodes: [{ id: "A", label: "Alpha" }],
        edges: [{ from: "A", to: "B" }],
      } as ContentNode,
      { glossary: new Map(), strings: stringsFor("en"), uiLocale: "en", contentLanguage: "en", nextTermDisclosureId: () => "term-definition-test" },
    )).toThrow("FLOW_REFERENCE_INVALID");
  });

  it.each([
    ["bad canonical Base64", "A===", "DOCUMENT_BASE64_INVALID"],
    ["noncanonical Base64 pad bits", "Zh==", "DOCUMENT_BASE64_INVALID"],
    ["bad UTF-8", Buffer.from([0xff]).toString("base64"), "DOCUMENT_UTF8_INVALID"],
    ["bad JSON", Buffer.from("{", "utf8").toString("base64"), "DOCUMENT_JSON_INVALID"],
    ["bad protocol", Buffer.from('{"format":"review-document/1"}', "utf8").toString("base64"), "SCHEMA_REQUIRED"],
  ])("shows only stable error location for %s", (_label, encoded, expectedCode) => {
    const ownerDocument = makeShell(enrichedDocument());
    const template = ownerDocument.querySelector("template") as MiniTemplate;
    template.content.textContent = encoded;
    installDom(ownerDocument);
    bootstrapWorkbench();
    expect(errorText(ownerDocument)).toContain(expectedCode);
    expect(errorText(ownerDocument)).not.toContain(encoded);
    expect(ownerDocument.querySelectorAll("article")).toHaveLength(0);
  });

  it.each([
    ["dar-generator-version", "99.0.0", "META_IDENTITY_MISMATCH"],
    ["dar-generator-version", "not-semver", "META_FORMAT_INVALID"],
    ["dar-document-id", "RD-invalid", "META_FORMAT_INVALID"],
    ["dar-content-version", "0", "META_FORMAT_INVALID"],
    ["dar-round", "0", "META_FORMAT_INVALID"],
    ["dar-review-digest", "sha256:bad", "META_FORMAT_INVALID"],
    ["dar-document-id", "RD-99999999999999999999", "META_IDENTITY_MISMATCH"],
    ["dar-content-version", "2", "META_IDENTITY_MISMATCH"],
    ["dar-round", "3", "META_IDENTITY_MISMATCH"],
    ["dar-review-digest", `sha256:${"f".repeat(64)}`, "META_IDENTITY_MISMATCH"],
  ])("rejects tampered meta %s=%s", (name, value, expectedCode) => {
    const ownerDocument = makeShell(enrichedDocument());
    const meta = ownerDocument.querySelector(`meta[name='${name}']`);
    if (!meta) throw new Error("meta missing");
    meta.setAttribute("content", value);
    installDom(ownerDocument);
    bootstrapWorkbench();
    expect(errorText(ownerDocument)).toContain(expectedCode);
    expect(ownerDocument.querySelectorAll("article")).toHaveLength(0);
  });

  it("rejects duplicated shell identity and pre-existing headings", () => {
    const duplicateMeta = makeShell(enrichedDocument());
    appendElement(duplicateMeta.head, "meta", {
      name: "dar-document-id",
      content: enrichedDocument().document.id,
    });
    installDom(duplicateMeta);
    bootstrapWorkbench();
    expect(errorText(duplicateMeta)).toContain("SHELL_IDENTITY_INVALID");

    const headingShell = makeShell(enrichedDocument());
    appendElement(headingShell.body, "h1").textContent = "ATTACKER_VISIBLE";
    const attackerForm = appendElement(headingShell.body, "form");
    appendElement(attackerForm, "a", { href: "https://attacker.invalid" }).textContent = "FAKE_FORM";
    installDom(headingShell);
    bootstrapWorkbench();
    expect(errorText(headingShell)).toContain("SHELL_HEADING_INVALID");
    expect(headingShell.body.textContent).not.toContain("ATTACKER_VISIBLE");
    expect(headingShell.body.textContent).not.toContain("FAKE_FORM");
    expect(headingShell.querySelectorAll("h1")).toHaveLength(1);
    expect(headingShell.querySelectorAll("form")).toHaveLength(0);
    expect(headingShell.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("raw workbench shell contract", () => {
  it("contains the closed ten-token and five-meta interface exactly once", () => {
    const raw = createRawWorkbenchTemplate();
    expect(WORKBENCH_TOKENS).toHaveLength(10);
    expect(GENERATOR_DATA_TOKENS).toHaveLength(6);
    expect(UI_BUILD_TOKENS).toHaveLength(4);
    expect(WORKBENCH_META_NAMES).toHaveLength(5);
    for (const token of WORKBENCH_TOKENS) {
      expect(raw.split(token)).toHaveLength(2);
    }
    for (const name of WORKBENCH_META_NAMES) {
      expect(raw).toContain(`meta name="${name}"`);
    }
    expect(WORKBENCH_STYLE).toContain(":focus-visible{outline:3px");
    expect(WORKBENCH_STYLE).toContain("overflow-wrap:anywhere");
    expect(raw).toContain("default-src 'none'; connect-src 'none'");
  });
});
