import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewDocumentV1 } from "../../src/protocol/index.js";
import { stringsFor } from "../../src/workbench/i18n.js";
import { mountReviewInteractions } from "../../src/workbench/interactions.js";

class TestEvent {
  defaultPrevented = false;
  target: TestElement | null = null;

  constructor(
    readonly type: string,
    readonly key = "",
    readonly options: {
      readonly altKey?: boolean;
      readonly ctrlKey?: boolean;
      readonly metaKey?: boolean;
      readonly shiftKey?: boolean;
    } = {},
  ) {}

  get altKey(): boolean { return this.options.altKey ?? false; }
  get ctrlKey(): boolean { return this.options.ctrlKey ?? false; }
  get metaKey(): boolean { return this.options.metaKey ?? false; }
  get shiftKey(): boolean { return this.options.shiftKey ?? false; }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class TestNode {
  readonly childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;

  constructor(readonly ownerDocument: TestDocument | null) {}

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.replaceChildren(value === "" ? undefined : new TestText(value, this.ownerDocument));
  }

  append(...nodes: Array<TestNode | string>): void {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new TestText(node, this.ownerDocument) : node);
    }
  }

  appendChild<T extends TestNode>(node: T): T {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  replaceChildren(...nodes: Array<TestNode | string | undefined>): void {
    this.childNodes.splice(0);
    for (const node of nodes) {
      if (node !== undefined) this.append(node);
    }
  }

  contains(node: TestNode): boolean {
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains(node));
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const results: TestElement[] = [];
    const visit = (node: TestNode): void => {
      if (node instanceof TestElement && matchesAny(node, selector)) results.push(node);
      for (const child of node.childNodes) visit(child);
    };
    for (const child of this.childNodes) visit(child);
    return results;
  }
}

class TestText extends TestNode {
  constructor(private value: string, ownerDocument: TestDocument | null) {
    super(ownerDocument);
  }

  override get textContent(): string { return this.value; }
  override set textContent(value: string) { this.value = value; }
}

type TestListener = (event: TestEvent) => void;

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string>;
  private readonly listeners = new Map<string, TestListener[]>();
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  placeholder = "";
  required = false;
  rows = 0;
  tabIndex = -1;
  type = "";
  value = "";

  constructor(readonly tagName: string, ownerDocument: TestDocument) {
    super(ownerDocument);
    this.dataset = new Proxy<Record<string, string>>({}, {
      set: (target, key, value) => {
        if (typeof key !== "string") return false;
        const text = String(value);
        target[key] = text;
        const attribute = `data-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
        this.attributes.set(attribute, text);
        return true;
      },
    });
  }

  get id(): string { return this.attributes.get("id") ?? ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get isConnected(): boolean { return this.ownerDocument?.contains(this) ?? false; }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }

  matches(selector: string): boolean {
    return matchesAny(this, selector);
  }

  addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const normalized: TestListener = typeof listener === "function"
      ? listener as unknown as TestListener
      : (event) => listener.handleEvent(event as unknown as Event);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(normalized);
    this.listeners.set(type, listeners);
  }

  dispatch(event: TestEvent): void {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  click(): void {
    if (!this.disabled) this.dispatch(new TestEvent("click"));
  }

  focus(): void {
    if (this.ownerDocument === null) return;
    this.ownerDocument.activeElement = this;
    const event = new TestEvent("focusin");
    event.target = this;
    this.dispatch(event);
    let current = this.parentNode;
    while (current !== null) {
      if (current instanceof TestElement) current.dispatch(event);
      current = current.parentNode;
    }
  }

  scrollIntoView(): void {}
}

class TestDialog extends TestElement {
  constructor(ownerDocument: TestDocument) {
    super("DIALOG", ownerDocument);
  }

  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}

class TestDocument extends TestNode {
  readonly body: TestElement;
  activeElement: TestElement | null = null;
  selection: {
    anchorNode: TestNode | null;
    focusNode: TestNode | null;
    isCollapsed: boolean;
    rangeCount: number;
    value: string;
  } = { anchorNode: null, focusNode: null, isCollapsed: true, rangeCount: 0, value: "" };

  constructor() {
    super(null);
    this.body = new TestElement("BODY", this);
    this.append(this.body);
  }

  createElement(tag: string): TestElement {
    return tag.toLowerCase() === "dialog"
      ? new TestDialog(this)
      : new TestElement(tag.toUpperCase(), this);
  }

  createTextNode(value: string): TestText {
    return new TestText(value, this);
  }

  getSelection(): {
    readonly anchorNode: TestNode | null;
    readonly focusNode: TestNode | null;
    readonly isCollapsed: boolean;
    readonly rangeCount: number;
    toString(): string;
  } {
    return {
      ...this.selection,
      toString: () => this.selection.value,
    };
  }
}

function matchesAny(element: TestElement, selectorList: string): boolean {
  return selectorList.split(",").some((value) => matchesOne(element, value.trim()));
}

function matchesOne(element: TestElement, selectorValue: string): boolean {
  let selector = selectorValue;
  for (const match of selector.matchAll(/:not\(([^)]+)\)/gu)) {
    if (match[1] !== undefined && matchesOne(element, match[1])) return false;
  }
  selector = selector.replace(/:not\([^)]+\)/gu, "");
  const tag = /^([A-Za-z][A-Za-z0-9-]*)/u.exec(selector)?.[1];
  if (tag !== undefined && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const id = /#([A-Za-z0-9_-]+)/u.exec(selector)?.[1];
  if (id !== undefined && element.id !== id) return false;
  for (const classMatch of selector.matchAll(/\.([A-Za-z0-9_-]+)/gu)) {
    if (classMatch[1] !== undefined && !element.className.split(/\s+/u).includes(classMatch[1])) {
      return false;
    }
  }
  for (const match of selector.matchAll(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/gu)) {
    const name = match[1];
    const expected = match[2];
    if (name === undefined) return false;
    const actual = name === "disabled"
      ? element.disabled ? "" : null
      : name === "tabindex" ? String(element.tabIndex) : element.getAttribute(name);
    if (actual === null || (expected !== undefined && actual !== expected)) return false;
  }
  return true;
}

function appendElement(
  parent: TestNode,
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
): TestElement {
  const owner = parent.ownerDocument ?? parent as TestDocument;
  const element = owner.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.append(element);
  return element;
}

function documentFixture(): ReviewDocumentV1 {
  return JSON.parse(readFileSync(
    resolve("tests/fixtures/protocol/review-document.json"),
    "utf8",
  )) as ReviewDocumentV1;
}

interface MountedWorkbench {
  readonly ownerDocument: TestDocument;
  readonly header: TestElement;
  readonly main: TestElement;
  readonly rail: TestElement;
  readonly footer: TestElement;
  readonly status: TestElement;
}

function mount(): MountedWorkbench {
  const ownerDocument = new TestDocument();
  installDom(ownerDocument);
  const header = appendElement(ownerDocument.body, "header");
  const main = appendElement(ownerDocument.body, "main");
  const rail = appendElement(ownerDocument.body, "aside");
  const footer = appendElement(ownerDocument.body, "footer");
  const status = appendElement(ownerDocument.body, "div");
  const strings = stringsFor("en");
  const railHeading = appendElement(rail, "h2", { id: "decision-rail-heading" });
  railHeading.textContent = strings.decisionRail;
  const railIntro = appendElement(rail, "p");
  railIntro.textContent = strings.noDecisionTools;
  const keyboardHelp = appendElement(footer, "p");
  keyboardHelp.textContent = strings.keyboardHelp;
  const documentValue = documentFixture();
  for (const block of documentValue.blocks) {
    const article = appendElement(main, "article", { id: `block-${block.id}`, class: "decision-block" });
    const heading = appendElement(article, "h3");
    heading.textContent = block.title;
    const summary = appendElement(article, "p", { class: "summary" });
    summary.textContent = block.summary;
  }
  mountReviewInteractions({
    documentValue,
    strings,
    landmarks: {
      header: header as unknown as HTMLElement,
      main: main as unknown as HTMLElement,
      rail: rail as unknown as HTMLElement,
      footer: footer as unknown as HTMLElement,
      status: status as unknown as HTMLElement,
    },
  });
  return { ownerDocument, header, main, rail, footer, status };
}

function key(target: TestElement, value: string, options: TestEvent["options"] = {}): TestEvent {
  const event = new TestEvent("keydown", value, options);
  target.dispatch(event);
  return event;
}

function button(container: TestNode, text: string): TestElement {
  const result = container.querySelectorAll("button").find((value) => value.textContent === text);
  if (result === undefined) throw new Error(`button not found: ${text}`);
  return result;
}

function article(workbench: MountedWorkbench, id: string): TestElement {
  const result = workbench.main.querySelector(`article#block-${id}`);
  if (result === null) throw new Error(`article not found: ${id}`);
  return result;
}

const savedGlobals = {
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  window: globalThis.window,
};

function installDom(ownerDocument: TestDocument): void {
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: ownerDocument, writable: true },
    HTMLElement: { configurable: true, value: TestElement, writable: true },
    window: {
      configurable: true,
      value: { setTimeout: (callback: () => void) => { callback(); return 0; } },
      writable: true,
    },
  });
}

afterEach(() => {
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: savedGlobals.document, writable: true },
    HTMLElement: { configurable: true, value: savedGlobals.HTMLElement, writable: true },
    window: { configurable: true, value: savedGlobals.window, writable: true },
  });
});

describe("review interaction controller", () => {
  it("drives keyboard actions, overwrite, undo, dialog validation, and bulk", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);

    expect(workbench.header.querySelector(".review-progress")?.textContent).toContain("0 of 4");
    expect(workbench.main.querySelectorAll("button.decision-action")).toHaveLength(16);
    expect(workbench.rail.querySelectorAll("h2#decision-rail-heading")).toHaveLength(1);
    expect(workbench.rail.querySelector("section.review-interactions")).not.toBeNull();
    expect(workbench.footer.textContent).toContain("j/k");

    key(workbench.ownerDocument.body, "j");
    expect(workbench.ownerDocument.activeElement).toBe(article(workbench, "B002"));
    key(workbench.ownerDocument.body, "1");
    expect(article(workbench, "B002").querySelector(".decision-status")?.textContent).toContain("Pass");
    expect(workbench.ownerDocument.activeElement).toBe(article(workbench, "B003"));

    key(workbench.ownerDocument.body, "2");
    const dialog = workbench.ownerDocument.querySelector("dialog") as TestDialog;
    expect(dialog.open).toBe(true);
    button(dialog, "Save").click();
    expect(dialog.querySelector(".dialog-error")?.textContent)
      .toBe("Not saved: this action needs your written instruction or question");
    const note = dialog.querySelector("textarea");
    if (note === null) throw new Error("note missing");
    note.value = "Change the closure.";
    button(dialog, "Save").click();
    expect(dialog.open).toBe(false);
    expect(article(workbench, "B003").querySelector(".decision-status")?.textContent).toContain("Modify");

    key(workbench.ownerDocument.body, "3");
    const title = dialog.querySelector("input[data-field='title']");
    const topicNote = dialog.querySelector("textarea[data-field='note']");
    if (title === null || topicNote === null) throw new Error("topic fields missing");
    title.value = "Derived topic";
    topicNote.value = "Separate scope";
    button(dialog, "Save").click();
    expect(workbench.rail.querySelector(".topic-list")?.textContent).toContain("TOP-001");

    const b4Topic = workbench.rail.querySelectorAll(".topic-list li")[0];
    if (b4Topic === undefined) throw new Error("topic missing");
    button(b4Topic, "Delete").click();
    expect(article(workbench, "B004").querySelector(".decision-status")?.textContent).toContain("Pending");

    const bulk = workbench.header.querySelector("button.bulk-pass-button");
    if (bulk === null) throw new Error("bulk missing");
    bulk.click();
    expect(dialog.textContent).toContain("T2 excluded and unchanged: 1");
    button(dialog, "Confirm bulk pass").click();
    expect(article(workbench, "B001").querySelector(".decision-status")?.textContent).toContain("Pending");
    expect(workbench.header.querySelector(".review-feedback")?.textContent).toContain("T2 excluded");

    button(article(workbench, "B002"), "Undo decision").click();
    expect(article(workbench, "B002").querySelector(".decision-status")?.textContent).toContain("Pending");
  });

  it("manages search/filter, notes, global topics, overall, and typing shortcuts", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);
    const search = workbench.rail.querySelector("input#decision-search");
    const filter = workbench.header.querySelector("select#review-filter");
    if (search === null || filter === null) throw new Error("toolbar missing");
    search.value = "Graph";
    search.dispatch(new TestEvent("input"));
    expect(article(workbench, "B003").hidden).toBe(false);
    expect(article(workbench, "B001").hidden).toBe(true);
    key(search, "1");
    expect(article(workbench, "B003").querySelector(".decision-status")?.textContent).toContain("Pending");

    search.value = "";
    search.dispatch(new TestEvent("input"));
    filter.value = "t2";
    filter.dispatch(new TestEvent("change"));
    expect(article(workbench, "B001").hidden).toBe(false);
    expect(article(workbench, "B002").hidden).toBe(true);
    filter.value = "all";
    filter.dispatch(new TestEvent("change"));

    article(workbench, "B002").focus();
    const noteInput = workbench.rail.querySelector("textarea#side-note-input");
    if (noteInput === null) throw new Error("note input missing");
    noteInput.value = "Working note";
    key(noteInput, "Enter", { ctrlKey: true });
    expect(workbench.rail.querySelector(".side-note-list")?.textContent).toContain("NOTE-001");
    const noteItem = workbench.rail.querySelector(".side-note-list li");
    if (noteItem === null) throw new Error("note item missing");
    button(noteItem, "Edit").click();
    noteInput.value = "Edited note";
    button(workbench.rail, "Save").click();
    expect(workbench.rail.querySelector(".side-note-list")?.textContent).toContain("Edited note");
    button(workbench.rail.querySelector(".side-note-list li") ?? workbench.rail, "Delete").click();

    const globalTitle = workbench.rail.querySelector("input#global-topic-title");
    const globalNote = workbench.rail.querySelector("textarea#global-topic-note");
    if (globalTitle === null || globalNote === null) throw new Error("global topic fields missing");
    globalTitle.value = "Global idea";
    globalNote.value = "No source block";
    key(globalTitle, "Enter", { metaKey: true });
    expect(workbench.rail.querySelector(".topic-list")?.textContent).toContain("Global topic");
    const topicItem = workbench.rail.querySelector(".topic-list li");
    if (topicItem === null) throw new Error("topic item missing");
    button(topicItem, "Edit").click();
    globalTitle.value = "Updated idea";
    button(workbench.rail, "Save").click();
    expect(workbench.rail.querySelector(".topic-list")?.textContent).toContain("Updated idea");

    const overall = workbench.rail.querySelector("textarea#overall-review");
    if (overall === null) throw new Error("overall missing");
    overall.value = "Global guidance";
    key(overall, "Enter", { ctrlKey: true });
    expect(workbench.status.textContent).toBe("Save");
  });

  it("captures only an in-block quote and restores focus after cancel", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);
    const b1 = article(workbench, "B001");
    const summary = b1.querySelector("p.summary");
    if (summary === null) throw new Error("summary missing");
    workbench.ownerDocument.selection = {
      anchorNode: summary.childNodes[0] ?? summary,
      focusNode: summary.childNodes[0] ?? summary,
      isCollapsed: false,
      rangeCount: 1,
      value: "  exact\n quote  ",
    };
    b1.focus();
    key(workbench.ownerDocument.body, "2");
    const dialog = workbench.ownerDocument.querySelector("dialog") as TestDialog;
    expect(dialog.textContent).toContain("exact quote");
    button(dialog, "Cancel").click();
    expect(dialog.open).toBe(false);
    expect(workbench.ownerDocument.activeElement?.textContent).toContain("2 · Modify");

    const b2 = article(workbench, "B002");
    workbench.ownerDocument.selection = {
      anchorNode: summary,
      focusNode: b2,
      isCollapsed: false,
      rangeCount: 1,
      value: "cross block",
    };
    key(workbench.ownerDocument.body, "1");
    expect(b1.querySelector(".decision-quote-container")?.hidden).toBe(true);
  });

  it("supports HOLD and TOPIC overwrite flows plus the dialog focus boundary", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);
    const b1 = article(workbench, "B001");
    b1.focus();
    button(b1, "4 · Hold").click();
    const dialog = workbench.ownerDocument.querySelector("dialog") as TestDialog;
    const holdNote = dialog.querySelector("textarea");
    if (holdNote === null) throw new Error("hold note missing");
    expect(workbench.ownerDocument.activeElement === holdNote).toBe(true);

    const backwards = key(dialog, "Tab", { shiftKey: true });
    expect(backwards.defaultPrevented).toBe(true);
    expect(workbench.ownerDocument.activeElement?.textContent).toBe("Cancel");
    const forwards = key(dialog, "Tab");
    expect(forwards.defaultPrevented).toBe(true);
    expect(workbench.ownerDocument.activeElement === holdNote).toBe(true);

    holdNote.value = "Wait for the dependency.";
    const saved = key(dialog, "Enter", { ctrlKey: true });
    expect(saved.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(b1.querySelector(".decision-status")?.textContent).toContain("Hold");

    const holdItem = workbench.rail.querySelector(".decision-list li");
    if (holdItem === null) throw new Error("hold decision missing");
    button(holdItem, "Edit").click();
    const existingHold = dialog.querySelector("textarea");
    if (existingHold === null) throw new Error("existing hold missing");
    expect(existingHold.value).toBe("Wait for the dependency.");
    existingHold.value = "Dependency cleared later.";
    button(dialog, "Save").click();
    expect(b1.querySelector(".decision-status")?.textContent).toContain("Dependency cleared later.");

    const b2 = article(workbench, "B002");
    button(b2, "1 · Pass").click();
    const passItem = workbench.rail.querySelector(".decision-list")?.querySelectorAll("li")
      .find((item) => item.textContent.includes("B002"));
    if (passItem === undefined) throw new Error("pass decision missing");
    button(passItem, "Edit").click();
    expect(workbench.ownerDocument.activeElement?.id).toBe("block-B002");

    const b3 = article(workbench, "B003");
    button(b3, "3 · New topic").click();
    const title = dialog.querySelector("input[data-field='title']");
    if (title === null) throw new Error("topic title missing");
    title.value = "First title";
    button(dialog, "Save").click();
    const sourceTopic = workbench.rail.querySelector(".topic-list")?.querySelectorAll("li")
      .find((item) => item.textContent.includes("Source block: B003"));
    if (sourceTopic === undefined) throw new Error("source topic missing");
    button(sourceTopic, "Edit").click();
    const existingTitle = dialog.querySelector("input[data-field='title']");
    const existingTopicNote = dialog.querySelector("textarea[data-field='note']");
    if (existingTitle === null || existingTopicNote === null) throw new Error("existing topic fields missing");
    expect(existingTitle.value).toBe("First title");
    expect(existingTopicNote.value).toBe("");
    existingTitle.value = "Updated title";
    existingTopicNote.value = "Added context";
    button(dialog, "Save").click();
    expect(workbench.rail.querySelector(".topic-list")?.textContent).toContain("Updated title");

    button(article(workbench, "B004"), "2 · Modify").click();
    const cancelEvent = new TestEvent("cancel");
    dialog.dispatch(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
  });

  it("covers editor reset, annotated search, pointer navigation, and guarded shortcuts", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);
    const search = workbench.rail.querySelector("input#decision-search");
    const filter = workbench.header.querySelector("select#review-filter");
    const noteInput = workbench.rail.querySelector("textarea#side-note-input");
    const topicTitle = workbench.rail.querySelector("input#global-topic-title");
    const topicNote = workbench.rail.querySelector("textarea#global-topic-note");
    const overall = workbench.rail.querySelector("textarea#overall-review");
    if (
      search === null
      || filter === null
      || noteInput === null
      || topicTitle === null
      || topicNote === null
      || overall === null
    ) throw new Error("rail controls missing");

    article(workbench, "B003").dispatch(new TestEvent("pointerdown"));
    expect(workbench.rail.querySelector(".current-block-label")?.textContent).toContain("B003");
    key(workbench.ownerDocument.body, "k");
    expect(workbench.ownerDocument.activeElement).toBe(article(workbench, "B002"));
    key(workbench.ownerDocument.body, "n");
    expect(workbench.ownerDocument.activeElement).toBe(article(workbench, "B003"));

    noteInput.value = "Searchable annotation";
    button(workbench.rail, "Add note").click();
    search.value = "annotation";
    search.dispatch(new TestEvent("input"));
    expect(workbench.rail.querySelector(".side-note-list")?.textContent).toContain("Searchable annotation");
    search.value = "missing";
    search.dispatch(new TestEvent("input"));
    expect(workbench.rail.querySelector(".side-note-list")?.textContent).toBe("No notes recorded.");
    search.value = "";
    search.dispatch(new TestEvent("input"));

    const noteItem = workbench.rail.querySelector(".side-note-list li");
    if (noteItem === null) throw new Error("side note missing");
    button(noteItem, "Edit").click();
    key(noteInput, "Escape");
    expect(noteInput.value).toBe("");
    button(noteItem, "Edit").click();
    button(noteItem, "Delete").click();
    expect(noteInput.value).toBe("");

    topicTitle.value = "Searchable global topic";
    topicNote.value = "";
    button(workbench.rail, "Add global topic").click();
    search.value = "global topic";
    search.dispatch(new TestEvent("input"));
    expect(workbench.rail.querySelector(".topic-list")?.textContent).toContain("Searchable global topic");
    search.value = "";
    search.dispatch(new TestEvent("input"));
    const topicItem = workbench.rail.querySelector(".topic-list li");
    if (topicItem === null) throw new Error("global topic missing");
    button(topicItem, "Edit").click();
    key(topicNote, "Escape");
    expect(topicTitle.value).toBe("");
    button(topicItem, "Edit").click();
    button(topicItem, "Delete").click();
    expect(topicTitle.value).toBe("");

    overall.value = "Keep while focused";
    key(overall, "Escape");
    expect(overall.value).toBe("Keep while focused");

    filter.value = "invalid";
    filter.dispatch(new TestEvent("change"));
    expect(article(workbench, "B001").hidden).toBe(false);
    article(workbench, "B003").focus();
    filter.value = "t2";
    filter.dispatch(new TestEvent("change"));
    expect(workbench.rail.querySelector(".current-block-label")?.textContent).toContain("B001");

    const targetEvent = new TestEvent("keydown", "1");
    targetEvent.target = search;
    workbench.ownerDocument.body.dispatch(targetEvent);
    expect(article(workbench, "B001").querySelector(".decision-status")?.textContent).toContain("Pending");
    const modifier = key(workbench.ownerDocument.body, "1", { altKey: true });
    expect(modifier.defaultPrevented).toBe(false);
    const unknown = key(workbench.ownerDocument.body, "x");
    expect(unknown.defaultPrevented).toBe(false);
  });

  it("keeps reducer failures visible and rejects a stale bulk confirmation atomically", () => {
    const ownerDocument = new TestDocument();
    installDom(ownerDocument);
    const workbench = mount();
    installDom(workbench.ownerDocument);
    const noteInput = workbench.rail.querySelector("textarea#side-note-input");
    const topicTitle = workbench.rail.querySelector("input#global-topic-title");
    if (noteInput === null || topicTitle === null) throw new Error("rail controls missing");

    button(workbench.rail, "Add note").click();
    expect(workbench.status.textContent).toBe("Not saved: the note text cannot be empty");
    button(workbench.rail, "Add global topic").click();
    expect(workbench.status.textContent).toBe("Not saved: a new topic needs a title");

    const bulk = workbench.header.querySelector("button.bulk-pass-button");
    if (bulk === null) throw new Error("bulk missing");
    bulk.click();
    const dialog = workbench.ownerDocument.querySelector("dialog") as TestDialog;
    const oldConfirm = button(dialog, "Confirm bulk pass");
    button(article(workbench, "B002"), "1 · Pass").click();
    oldConfirm.click();
    expect(dialog.open).toBe(true);
    expect(workbench.status.textContent)
      .toBe("Not saved: the pending T0/T1 selection changed. Reopen bulk pass to see the current blocks");
    button(dialog, "Cancel").click();

    const staleSave = oldConfirm;
    staleSave.click();
    expect(dialog.open).toBe(false);
  });
});
