import { describe, expect, it } from "vitest";
import type { ReviewDocumentV1 } from "../../src/protocol/index.js";
import { stringsFor } from "../../src/workbench/i18n.js";
import type { ReviewInteractionController } from "../../src/workbench/interactions.js";
import {
  createPersistenceSession,
  type PersistenceSession,
  type StorageAdapter,
  type StorageCapability,
} from "../../src/workbench/persistence/index.js";
import {
  mountPersistenceControls,
  safeWindowLocalStorage,
} from "../../src/workbench/persistence/ui.js";
import {
  cloneWorkbenchReviewState,
  reduceReviewState,
  type ReviewAction,
  type WorkbenchReviewState,
} from "../../src/workbench/reducer.js";
import { buildReviewState } from "../../src/workbench/state.js";
import { reviewDocumentFixture } from "./persistence-fixtures.js";

interface FakeEventInit {
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
}

class FakeEvent {
  defaultPrevented = false;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;

  constructor(init: FakeEventInit = {}) {
    this.key = init.key ?? "";
    this.shiftKey = init.shiftKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeNode {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  private ownText = "";

  constructor(readonly ownerDocument: FakeDocument) {}

  get isConnected(): boolean {
    if (Object.is(this, this.ownerDocument.body)) return true;
    let current: FakeNode | null = this.parentNode;
    while (current !== null) {
      if (current === this.ownerDocument.body) return true;
      current = current.parentNode;
    }
    return false;
  }

  get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.childNodes.splice(0);
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const value of nodes) {
      const node = typeof value === "string"
        ? this.ownerDocument.createTextNode(value)
        : value;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.ownText = "";
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.splice(0);
    this.append(...nodes);
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument: FakeDocument, value: string) {
    super(ownerDocument);
    this.textContent = value;
  }
}

type FakeListener = (event: FakeEvent) => void;

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, FakeListener[]>();
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  required = false;
  checked = false;
  open = false;
  selected = false;
  value = "";
  type = "";
  href = "";
  download = "";
  rows = 0;

  constructor(ownerDocument: FakeDocument, readonly tagName: string) {
    super(ownerDocument);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
  }

  getAttribute(name: string): string | null {
    if (name === "id" && this.id !== "") return this.id;
    if (name === "class" && this.className !== "") return this.className;
    if (name === "href" && this.href !== "") return this.href;
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, init: FakeEventInit = {}): FakeEvent {
    const event = new FakeEvent(init);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  select(): void {
    this.selected = true;
    this.focus();
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return descendants(this).filter((element) => selector.split(",")
      .some((part) => matchesSelector(element, part.trim())));
  }
}

class FakeDocument extends FakeNode {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: FakeWindow | null = null;

  constructor() {
    super(undefined as unknown as FakeDocument);
    Object.defineProperty(this, "ownerDocument", { value: this });
    this.body = new FakeElement(this, "BODY");
    this.body.parentNode = this;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag.toUpperCase());
  }

  createTextNode(value: string): FakeText {
    return new FakeText(this, value);
  }
}

class FakeWindow {
  readonly navigator: { clipboard?: { writeText(text: string): Promise<void> } } = {};
  readonly createdUrls: string[] = [];
  readonly revokedUrls: string[] = [];
  readonly URL = {
    createObjectURL: (_blob: Blob): string => {
      const url = `blob:fake-${this.createdUrls.length + 1}`;
      this.createdUrls.push(url);
      return url;
    },
    revokeObjectURL: (url: string): void => { this.revokedUrls.push(url); },
  };
  localStorage?: Storage;

  setTimeout(callback: () => void, _delay?: number): number {
    callback();
    return 1;
  }
}

function descendants(root: FakeNode): FakeElement[] {
  const values: FakeElement[] = [];
  const visit = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof FakeElement) values.push(child);
      visit(child);
    }
  };
  visit(root);
  return values;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  const tag = /^([a-z]+)/iu.exec(selector)?.[1]?.toUpperCase();
  if (tag !== undefined && element.tagName !== tag) return false;
  const className = /\.([a-z0-9_-]+)/iu.exec(selector)?.[1];
  if (className !== undefined && !element.className.split(/\s+/u).includes(className)) return false;
  if (selector.includes(":not([disabled])") && element.disabled) return false;
  if (selector.includes("[href]") && element.href === "") return false;
  if (selector.includes("[tabindex]") && element.getAttribute("tabindex") === null) return false;
  if (selector.includes(":not([tabindex='-1'])") && element.getAttribute("tabindex") === "-1") return false;
  return true;
}

class MemoryAdapter implements StorageAdapter {
  readonly values = new Map<string, string>();
  available = true;
  failSave = false;

  probe(): StorageCapability {
    return this.available ? { available: true } : { available: false, reason: "unavailable" };
  }

  load(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  save(key: string, value: string): void {
    if (this.failSave) throw new Error("save failed");
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

interface UiHarness {
  readonly documentValue: ReviewDocumentV1;
  readonly ownerDocument: FakeDocument;
  readonly ownerWindow: FakeWindow;
  readonly adapter: MemoryAdapter;
  readonly session: PersistenceSession;
  readonly controller: ReviewInteractionController;
  readonly announcements: string[];
  readonly renderStatus: () => void;
  getState(): WorkbenchReviewState;
  apply(action: ReviewAction): void;
}

function createHarness(input: {
  readonly available?: boolean;
  readonly clipboard?: { writeText(text: string): Promise<void> };
  readonly adapter?: MemoryAdapter;
  readonly session?: PersistenceSession;
} = {}): UiHarness {
  const documentValue = reviewDocumentFixture();
  const ownerDocument = new FakeDocument();
  const ownerWindow = new FakeWindow();
  ownerDocument.defaultView = ownerWindow;
  if (input.clipboard !== undefined) ownerWindow.navigator.clipboard = input.clipboard;
  const adapter = input.adapter ?? new MemoryAdapter();
  adapter.available = input.available ?? adapter.available;
  if (input.available === false) adapter.failSave = true;
  const session = input.session ?? createPersistenceSession({
    documentValue,
    adapter,
    now: () => new Date("2026-08-13T01:02:03.000Z"),
  });
  let state = session.getState();
  const announcements: string[] = [];
  const controller: ReviewInteractionController = {
    getState: () => cloneWorkbenchReviewState(state),
    replaceState(next, message) {
      const result = session.apply(next);
      if (result.accepted) state = cloneWorkbenchReviewState(next);
      announcements.push(message);
      return result.accepted;
    },
    clearReview(message) {
      const reduced = reduceReviewState(documentValue, state, { type: "CLEAR_REVIEW" });
      if (!reduced.ok) return false;
      const result = session.clear(reduced.state);
      if (result.accepted) state = cloneWorkbenchReviewState(reduced.state);
      announcements.push(message);
      return result.accepted;
    },
    announce: (message) => { announcements.push(message); },
  };
  const rail = ownerDocument.createElement("aside");
  ownerDocument.body.append(rail);
  const controls = mountPersistenceControls({
    documentValue,
    strings: stringsFor("en"),
    rail: rail as unknown as HTMLElement,
    controller,
    session,
    now: () => new Date("2026-08-13T01:02:03.000Z"),
  });
  return {
    documentValue,
    ownerDocument,
    ownerWindow,
    adapter,
    session,
    controller,
    announcements,
    renderStatus: controls.renderStatus,
    getState: () => cloneWorkbenchReviewState(state),
    apply(action) {
      const reduced = reduceReviewState(documentValue, state, action);
      if (!reduced.ok) throw new Error(reduced.code);
      const result = session.apply(reduced.state);
      if (!result.accepted) throw new Error("apply rejected");
      state = cloneWorkbenchReviewState(reduced.state);
      controls.renderStatus();
    },
  };
}

function findElement(
  harness: UiHarness,
  predicate: (element: FakeElement) => boolean,
): FakeElement {
  const match = descendants(harness.ownerDocument.body).find(predicate);
  if (match === undefined) throw new Error("element not found");
  return match;
}

function button(harness: UiHarness, text: string, exact = true): FakeElement {
  return findElement(harness, (element) => element.tagName === "BUTTON"
    && (exact ? element.textContent === text : element.textContent.includes(text)));
}

function activeDialog(harness: UiHarness): FakeElement {
  return findElement(harness, (element) => element.tagName === "DIALOG" && element.open);
}

function within(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement {
  const match = descendants(root).find(predicate);
  if (match === undefined) throw new Error("dialog element not found");
  return match;
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe("persistence controls", () => {
  it("exports each authority view and advances the export digest only after an explicit success", async () => {
    const copied: string[] = [];
    const harness = createHarness({
      available: false,
      clipboard: { writeText: async (text) => { copied.push(text); } },
    });
    expect(findElement(harness, (element) => element.className === "persistence-status").textContent)
      .toContain("Automatic saving is unavailable");

    const markdownOpener = button(harness, "Copy packet Markdown");
    markdownOpener.click();
    let dialog = activeDialog(harness);
    const markdown = within(dialog, (element) => element.className === "export-content");
    expect(markdown.value).toContain("````json review-packet/1");
    button(harness, "Copy").click();
    await settlePromises();
    expect(copied).toEqual([markdown.value]);
    expect(harness.session.snapshot().lastExportedDigest).toBe(harness.session.snapshot().currentDigest);
    button(harness, "Close").click();
    expect(harness.ownerDocument.activeElement).toBe(markdownOpener);

    harness.apply({ type: "SET_DECISION", blockId: "B001", decision: { action: "PASS" } });
    expect(harness.session.snapshot().notice).toBe("unsaved");
    button(harness, "Export review state").click();
    dialog = activeDialog(harness);
    expect(within(dialog, (element) => element.className === "export-content").value)
      .toContain('"format":"review-state/1"');
    button(harness, "Download").click();
    expect(harness.ownerWindow.createdUrls).toHaveLength(1);
    expect(harness.ownerWindow.revokedUrls).toEqual(harness.ownerWindow.createdUrls);
    expect(harness.session.snapshot().notice).toBe("unsaved");
    button(harness, "I saved or copied this snapshot", false).click();
    expect(harness.session.snapshot().notice).toBe("manual-exported");
    button(harness, "Close").click();

    button(harness, "Export packet JSON").click();
    expect(within(activeDialog(harness), (element) => element.className === "export-content").value)
      .toContain('"format":"review-packet/1"');
  });

  it("keeps rejected recovery visible beside current unsaved and manual-export status", () => {
    const adapter = new MemoryAdapter();
    const documentValue = reviewDocumentFixture();
    const initial = createPersistenceSession({ documentValue, adapter });
    adapter.values.set(initial.snapshot().key, '{"format":"review-packet/1"}');
    const invalid = createPersistenceSession({ documentValue, adapter });
    const harness = createHarness({ adapter, session: invalid });
    const status = findElement(harness, (element) => element.className === "persistence-status");
    expect(status.textContent).toContain("Stored recovery data was rejected");

    adapter.failSave = true;
    harness.apply({ type: "SET_DECISION", blockId: "B001", decision: { action: "PASS" } });
    expect(status.textContent).toContain("Stored recovery data was rejected");
    expect(status.textContent).toContain("export state before leaving");

    button(harness, "Export review state").click();
    button(harness, "Manual copy").click();
    button(harness, "I saved or copied this snapshot", false).click();
    expect(status.textContent).toContain("Stored recovery data was rejected");
    expect(status.textContent).toContain("manually exported");
    button(harness, "Close").click();

    adapter.failSave = false;
    harness.apply({ type: "SET_DECISION", blockId: "B002", decision: { action: "PASS" } });
    expect(status.textContent).toBe("Automatic local saving is active");
    expect(harness.session.snapshot().recoveryInvalid).toBe(false);
  });

  it("keeps complete fallback text and refuses stale clipboard or manual confirmation", async () => {
    let resolveCopy: (() => void) | undefined;
    const pending = createHarness({
      available: false,
      clipboard: {
        writeText: () => new Promise<void>((resolve) => { resolveCopy = resolve; }),
      },
    });
    button(pending, "Export review state").click();
    button(pending, "Copy").click();
    pending.apply({ type: "SET_DECISION", blockId: "B001", decision: { action: "PASS" } });
    resolveCopy?.();
    await settlePromises();
    const staleDialog = activeDialog(pending);
    expect(within(staleDialog, (element) => element.className.includes("export-stale")).hidden).toBe(false);
    const staleConfirm = button(pending, "I saved or copied this snapshot", false);
    expect(staleConfirm.disabled).toBe(true);
    staleConfirm.disabled = false;
    staleConfirm.click();
    expect(pending.session.snapshot().lastExportedDigest).toBeUndefined();

    const rejected = createHarness({
      available: false,
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    button(rejected, "Copy packet Markdown").click();
    const fallbackDialog = activeDialog(rejected);
    const complete = within(fallbackDialog, (element) => element.className === "export-content").value;
    button(rejected, "Copy").click();
    await settlePromises();
    const textarea = within(fallbackDialog, (element) => element.className === "export-content");
    expect(textarea.value).toBe(complete);
    expect(textarea.selected).toBe(true);
    expect(button(rejected, "I saved or copied this snapshot", false).hidden).toBe(false);

    const unavailable = createHarness({ available: false });
    button(unavailable, "Copy packet Markdown").click();
    button(unavailable, "Copy").click();
    expect(within(activeDialog(unavailable), (element) => element.className === "export-result").textContent)
      .toContain("Clipboard write failed");
    button(unavailable, "Manual copy").click();
    expect(button(unavailable, "I saved or copied this snapshot", false).hidden).toBe(false);

    unavailable.ownerWindow.URL.createObjectURL = () => { throw new Error("download denied"); };
    button(unavailable, "Download").click();
    expect(within(activeDialog(unavailable), (element) => element.className === "export-content").selected)
      .toBe(true);
  });

  it("imports exact and confirmed prototype state atomically, then enforces strict clear", () => {
    const harness = createHarness();
    let imported = harness.getState();
    const reduced = reduceReviewState(harness.documentValue, imported, {
      type: "SET_DECISION",
      blockId: "B002",
      decision: { action: "EDIT", note: "Imported" },
    });
    if (!reduced.ok) throw new Error(reduced.code);
    imported = reduced.state;
    const built = buildReviewState(harness.documentValue, imported, "2026-08-13T01:02:03.000Z");
    if (!built.ok) throw new Error("state build failed");

    button(harness, "Import state or packet").click();
    let dialog = activeDialog(harness);
    let textarea = within(dialog, (element) => element.tagName === "TEXTAREA");
    textarea.value = JSON.stringify(built.value);
    button(harness, "Validate and import").click();
    expect(harness.getState().decisionsByBlock.get("B002")).toMatchObject({ action: "EDIT" });

    const legacy = structuredClone(built.value) as unknown as Record<string, unknown>;
    delete legacy.format;
    delete (legacy.doc as Record<string, unknown>).contentVersion;
    (legacy.decisions as Array<Record<string, unknown>>)[0]!.action = "TRIM";
    button(harness, "Import state or packet").click();
    dialog = activeDialog(harness);
    textarea = within(dialog, (element) => element.tagName === "TEXTAREA");
    textarea.value = JSON.stringify(legacy);
    button(harness, "Validate and import").click();
    expect(within(dialog, (element) => element.className.includes("import-error")).hidden).toBe(false);
    within(dialog, (element) => element.id === "legacy-identity-confirmation").checked = true;
    button(harness, "Validate and import").click();
    expect(harness.getState().decisionsByBlock.get("B002")).toMatchObject({
      action: "EDIT",
      note: "【精简】Imported",
    });

    button(harness, "Import state or packet").click();
    dialog = activeDialog(harness);
    textarea = within(dialog, (element) => element.tagName === "TEXTAREA");
    textarea.value = "{";
    const shortcut = textarea.dispatch("keydown", { key: "Enter", ctrlKey: true });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(within(dialog, (element) => element.className.includes("import-error")).textContent)
      .toContain("Import rejected");
    button(harness, "Cancel").click();

    harness.adapter.failSave = true;
    button(harness, "Clear review").click();
    dialog = activeDialog(harness);
    button(harness, "Clear and restart").click();
    expect(within(dialog, (element) => element.className.includes("dialog-error")).hidden).toBe(false);
    expect(harness.getState().decisionsByBlock.size).toBe(1);
    harness.adapter.failSave = false;
    button(harness, "Cancel").click();
    harness.apply({ type: "SET_OVERALL", overall: "recover storage" });
    button(harness, "Clear review").click();
    button(harness, "Clear and restart").click();
    expect(harness.getState().decisionsByBlock.size).toBe(0);
    expect(harness.getState().overall).toBe("");
  });

  it("traps dialog focus, handles cancel, and renders recovered and invalid notices", () => {
    const harness = createHarness();
    const opener = button(harness, "Export review state");
    opener.click();
    const dialog = activeDialog(harness);
    const focusables = dialog.querySelectorAll(
      "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])",
    ).filter((element) => !element.hidden);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (first === undefined || last === undefined) throw new Error("focusables missing");
    last.focus();
    const forward = dialog.dispatch("keydown", { key: "Tab" });
    expect(forward.defaultPrevented).toBe(true);
    expect(harness.ownerDocument.activeElement).toBe(first);
    first.focus();
    const backward = dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(harness.ownerDocument.activeElement).toBe(last);
    const canceled = dialog.dispatch("cancel");
    expect(canceled.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(harness.ownerDocument.activeElement).toBe(opener);

    let state = harness.getState();
    const changed = reduceReviewState(harness.documentValue, state, {
      type: "SET_DECISION",
      blockId: "B001",
      decision: { action: "PASS" },
    });
    if (!changed.ok) throw new Error(changed.code);
    state = changed.state;
    harness.session.apply(state);
    const restored = createPersistenceSession({
      documentValue: harness.documentValue,
      adapter: harness.adapter,
    });
    const recoveredHarness = createHarness({ adapter: harness.adapter, session: restored });
    expect(findElement(recoveredHarness, (element) => element.className === "persistence-status").textContent)
      .toContain("Recovered saved review");
    expect(recoveredHarness.announcements.join(" ")).toContain("Recovered saved review");

    harness.adapter.values.set(restored.snapshot().key, '{"format":"review-packet/1"}');
    const invalid = createPersistenceSession({
      documentValue: harness.documentValue,
      adapter: harness.adapter,
    });
    const invalidHarness = createHarness({ adapter: harness.adapter, session: invalid });
    expect(findElement(invalidHarness, (element) => element.className === "persistence-status").textContent)
      .toContain("rejected");
  });
});

describe("safeWindowLocalStorage", () => {
  it("returns accessible storage and suppresses a throwing getter", () => {
    const storage = {} as Storage;
    expect(safeWindowLocalStorage({ localStorage: storage } as Window)).toBe(storage);
    const blocked = {};
    Object.defineProperty(blocked, "localStorage", {
      get: () => { throw new Error("blocked"); },
    });
    expect(safeWindowLocalStorage(blocked as Window)).toBeUndefined();
  });
});
