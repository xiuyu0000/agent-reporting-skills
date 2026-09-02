import type {
  ReviewDecision,
  ReviewDocumentV1,
} from "../protocol/index.js";
import { reducerErrorMessage, type WorkbenchStrings } from "./i18n.js";
import {
  cloneWorkbenchReviewState,
  createInitialReviewState,
  normalizeQuote,
  reduceReviewState,
  type DecisionInput,
  type ReviewAction,
  type ReviewReducerResult,
  type WorkbenchReviewState,
} from "./reducer.js";
import { reopenFrozenBlock } from "./reopen.js";
import {
  activeBlockIds,
  bulkPassPreview,
  executionEligibility,
  nextBlockId,
  nextPendingBlockId,
  reviewProgress,
  reviewStats,
  visibleBlockIds,
  type BulkPassPreview,
  type ReviewFilter,
} from "./selectors.js";
import { mountTermTip } from "./term-tip.js";

interface InteractionLandmarks {
  readonly header: HTMLElement;
  readonly main: HTMLElement;
  readonly rail: HTMLElement;
  readonly footer: HTMLElement;
  readonly status: HTMLElement;
}

export interface MountReviewInteractionsInput {
  readonly documentValue: ReviewDocumentV1;
  readonly strings: WorkbenchStrings;
  readonly landmarks: InteractionLandmarks;
  readonly stateHooks?: ReviewInteractionStateHooks;
}

export interface ReviewInteractionStateHooks {
  readonly initialState?: WorkbenchReviewState;
  readonly apply?: (next: WorkbenchReviewState) => { readonly accepted: boolean };
  readonly clear?: (next: WorkbenchReviewState) => { readonly accepted: boolean };
}

export interface ReviewInteractionController {
  getState(): WorkbenchReviewState;
  replaceState(next: WorkbenchReviewState, message: string): boolean;
  clearReview(message: string): boolean;
  announce(message: string): void;
}

type DecisionAction = ReviewDecision["action"];

interface DecisionEditorContext {
  readonly kind: "decision";
  readonly blockId: string;
  readonly action: Exclude<DecisionAction, "PASS">;
  readonly quote?: string;
  readonly opener: HTMLElement;
}

interface BulkEditorContext {
  readonly kind: "bulk";
  readonly preview: BulkPassPreview;
  readonly opener: HTMLElement;
}

type EditorContext = DecisionEditorContext | BulkEditorContext;

interface BlockControls {
  readonly article: HTMLElement;
  readonly actions: HTMLElement;
  readonly status: HTMLElement;
  readonly statusDot: HTMLElement;
  readonly statusText: HTMLElement;
  readonly quote: HTMLElement;
  readonly actionButtons: ReadonlyMap<DecisionAction, HTMLButtonElement>;
  readonly sideNote: HTMLButtonElement;
  readonly undo: HTMLButtonElement;
}

interface ReopenControls {
  readonly container: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
}

interface RailControls {
  readonly search: HTMLInputElement;
  readonly currentBlock: HTMLElement;
  readonly decisions: HTMLElement;
  readonly noteInput: HTMLTextAreaElement;
  readonly noteSubmit: HTMLButtonElement;
  readonly noteCancel: HTMLButtonElement;
  readonly notes: HTMLElement;
  readonly topicTitle: HTMLInputElement;
  readonly topicNote: HTMLTextAreaElement;
  readonly topicSubmit: HTMLButtonElement;
  readonly topicCancel: HTMLButtonElement;
  readonly topics: HTMLElement;
  readonly overall: HTMLTextAreaElement;
  readonly overallSubmit: HTMLButtonElement;
  readonly noteFold: HTMLDetailsElement;
  readonly topicFold: HTMLDetailsElement;
  readonly noteTarget: HTMLElement;
}

// The prototype keeps the rail compact: records are listed, and the editor that
// writes them stays folded until it is needed, so the export call to action is
// reachable without scrolling. Any path that focuses an editor opens its fold.
function railFold(
  ownerDocument: Document,
  summaryText: string,
  children: readonly HTMLElement[],
): HTMLDetailsElement {
  const fold = ownerDocument.createElement("details");
  fold.className = "rail-fold";
  const summary = ownerDocument.createElement("summary");
  summary.textContent = summaryText;
  fold.append(summary, ...children);
  return fold;
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

function buttonWithText(
  ownerDocument: Document,
  text: string,
  className = "",
): HTMLButtonElement {
  const button = elementWithText(ownerDocument, "button", text);
  button.type = "button";
  button.className = className;
  return button;
}

function labelControl(
  ownerDocument: Document,
  text: string,
  control: HTMLElement,
): HTMLLabelElement {
  const label = ownerDocument.createElement("label");
  label.append(elementWithText(ownerDocument, "span", text), control);
  return label;
}

function decisionActionLabel(action: DecisionAction, strings: WorkbenchStrings): string {
  if (action === "PASS") return strings.actionPass;
  if (action === "EDIT") return strings.actionEdit;
  if (action === "TOPIC") return strings.actionTopic;
  return strings.actionHold;
}

function tierLabel(tier: "T2" | "T1" | "T0", strings: WorkbenchStrings): string {
  if (tier === "T2") return strings.tierT2;
  if (tier === "T1") return strings.tierT1;
  return strings.tierT0;
}

// The prototype marks every state with a coloured dot next to its text label, so
// the colour never carries meaning on its own.
function stateDot(ownerDocument: Document, state: string): HTMLSpanElement {
  const dot = ownerDocument.createElement("span");
  dot.className = `dot d-${state}`;
  return dot;
}

function iconButton(
  ownerDocument: Document,
  glyph: string,
  label: string,
  className: string,
): HTMLButtonElement {
  const button = elementWithText(ownerDocument, "button", glyph);
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function decisionDetail(
  decision: ReviewDecision,
  state: WorkbenchReviewState,
): string {
  if (decision.action === "EDIT" || decision.action === "HOLD") return decision.note;
  if (decision.action === "TOPIC") {
    return state.topicsById.get(decision.topicId)?.title ?? decision.topicId;
  }
  return "";
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input,textarea,select,[contenteditable='true']");
}

function selectedQuote(article: HTMLElement): string | undefined {
  const selection = document.getSelection();
  if (
    selection === null
    || selection.isCollapsed
    || selection.rangeCount !== 1
    || selection.anchorNode === null
    || selection.focusNode === null
    || !article.contains(selection.anchorNode)
    || !article.contains(selection.focusNode)
  ) {
    return undefined;
  }
  return normalizeQuote(selection.toString());
}

function setQuoteView(
  container: HTMLElement,
  quote: string | undefined,
  strings: WorkbenchStrings,
): void {
  container.replaceChildren();
  if (quote === undefined) {
    container.hidden = true;
    return;
  }
  const disclosure = document.createElement("details");
  disclosure.className = "quoted decision-quote";
  disclosure.append(
    elementWithText(document, "summary", strings.quote),
    elementWithText(document, "blockquote", quote),
  );
  container.append(disclosure);
  container.hidden = false;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hidden);
}

export function mountReviewInteractions({
  documentValue,
  strings,
  landmarks,
  stateHooks,
}: MountReviewInteractionsInput): ReviewInteractionController {
  let state = cloneWorkbenchReviewState(
    stateHooks?.initialState ?? createInitialReviewState(documentValue),
  );
  let filter: ReviewFilter = "all";
  let search = "";
  let currentBlockId = activeBlockIds(documentValue, state)[0] ?? documentValue.blocks[0]?.id;
  let editorContext: EditorContext | undefined;
  // A side note being edited keeps its own source block. `currentBlockId` is the
  // moving review cursor: j/k, n, a block click, and auto-advance after a decision
  // all reassign it, so reading the block from it at save time would rewrite the
  // note onto whichever block happened to be focused.
  let editingNote: { readonly id: string; readonly blockId: string } | undefined;
  let editingGlobalTopicId: string | undefined;

  const blockControls = new Map<string, BlockControls>();
  const reopenControls = new Map<string, ReopenControls>();
  const eligibilityControls = new Map<string, HTMLElement>();
  const visibleFeedback = elementWithText(document, "p", "");
  visibleFeedback.className = "review-feedback restorebar";
  visibleFeedback.hidden = true;

  // Prototype `.h-bar`: a real fill bar, the tabular decided/total figure, the
  // per-tier count chips, the inverted filter pills and the bulk control.
  const progressBar = document.createElement("div");
  progressBar.className = "progress";
  progressBar.setAttribute("role", "progressbar");
  progressBar.setAttribute("aria-label", strings.progress);
  progressBar.setAttribute("aria-valuemin", "0");
  const progressFill = document.createElement("i");
  progressBar.append(progressFill);
  const progressText = elementWithText(document, "p", "");
  progressText.className = "p-num";
  progressText.id = "review-progress";
  const tierCounts = document.createElement("ul");
  tierCounts.className = "counts";
  tierCounts.setAttribute("aria-label", strings.tierCounts);
  const tierCountValues = new Map<"T2" | "T1" | "T0", HTMLElement>();
  for (const tier of ["T2", "T1", "T0"] as const) {
    const item = document.createElement("li");
    item.className = "cnt";
    const value = elementWithText(document, "b", "");
    item.append(
      stateDot(document, tier),
      elementWithText(document, "span", `${tierLabel(tier, strings)} `),
      value,
    );
    tierCounts.append(item);
    tierCountValues.set(tier, value);
  }
  const filters = document.createElement("div");
  filters.className = "filters";
  filters.id = "review-filter";
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", strings.filter);
  const filterButtons = new Map<ReviewFilter, HTMLButtonElement>();
  for (const [value, label] of [
    ["all", strings.filterAll],
    ["pending", strings.filterPending],
    ["t2", strings.filterT2],
    ["annotated", strings.filterAnnotated],
  ] as const) {
    const button = buttonWithText(document, label);
    button.dataset.filter = value;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      filter = value;
      render();
    });
    filterButtons.set(value, button);
    filters.append(button);
  }
  const bulkButton = buttonWithText(document, strings.bulkPass, "bulk");
  bulkButton.setAttribute("aria-describedby", "review-progress");
  const toolbar = document.createElement("section");
  toolbar.className = "h-bar";
  toolbar.setAttribute("aria-label", strings.progress);
  toolbar.append(progressBar, progressText, tierCounts, filters, bulkButton);
  const warnbar = elementWithText(document, "p", strings.evidenceNotice);
  warnbar.className = "warnbar";
  const finalbar = elementWithText(document, "p", strings.reviewComplete);
  finalbar.className = "finalbar";
  finalbar.hidden = true;
  landmarks.header.append(toolbar, warnbar, finalbar, visibleFeedback);

  function createDecisionControls(
    block: ReviewDocumentV1["blocks"][number],
    article: HTMLElement,
  ): BlockControls {
    const existing = blockControls.get(block.id);
    if (existing !== undefined) return existing;
    const controls = document.createElement("section");
    controls.className = "b-actions";
    controls.setAttribute("aria-label", `${block.id} ${strings.decisionStatus}`);
    const quote = document.createElement("div");
    quote.className = "decision-quote-container";
    quote.hidden = true;
    const group = document.createElement("div");
    group.className = "acts";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", strings.decisionStatus);
    const actionButtons = new Map<DecisionAction, HTMLButtonElement>();
    for (const [action, shortcut] of [
      ["PASS", "1"],
      ["EDIT", "2"],
      ["TOPIC", "3"],
      ["HOLD", "4"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `act a-${action}`;
      const hint = elementWithText(document, "span", shortcut);
      hint.className = "k";
      button.append(
        stateDot(document, action),
        elementWithText(document, "span", decisionActionLabel(action, strings)),
        hint,
      );
      button.dataset.action = action;
      button.setAttribute("aria-pressed", "false");
      actionButtons.set(action, button);
      group.append(button);
    }
    // Prototype `.act.sidenote`: a dashed chip that opens this block's working
    // note in the rail editor. It records no decision, so it stays outside the
    // pressed action group.
    const sideNote = document.createElement("button");
    sideNote.type = "button";
    sideNote.className = "act sidenote";
    sideNote.append(elementWithText(document, "span", strings.sideNotes));
    group.append(sideNote);
    // The decision chip belongs in the block head, right-aligned in `.st-slot`.
    // Harnesses that mount a bare article keep it inside the action section.
    const status = document.createElement("span");
    status.className = "st-chip pending";
    const statusDot = stateDot(document, "PENDING");
    const statusText = elementWithText(document, "span", strings.actionPending);
    statusText.className = "txt";
    const undo = iconButton(document, "✕", strings.undoDecision, "x");
    undo.hidden = true;
    status.append(statusDot, statusText, undo);
    const slot = article.querySelector<HTMLElement>(".st-slot");
    if (slot === null) controls.append(status);
    else slot.append(status);
    controls.append(quote, group);
    article.append(controls);
    const created = {
      article,
      actions: controls,
      status,
      statusDot,
      statusText,
      quote,
      actionButtons,
      sideNote,
      undo,
    };
    blockControls.set(block.id, created);
    for (const [action, button] of actionButtons) {
      button.addEventListener("click", () => {
        currentBlockId = block.id;
        renderCurrentBlock();
        activateAction(block.id, action, button);
      });
    }
    sideNote.addEventListener("click", () => {
      currentBlockId = block.id;
      const recorded = [...state.sideNotesById.values()]
        .find((note) => note.blockId === block.id);
      if (recorded === undefined) {
        resetNoteEditor();
      } else {
        editingNote = { id: recorded.id, blockId: recorded.blockId };
        rail.noteInput.value = recorded.note;
        rail.noteSubmit.textContent = strings.save;
        rail.noteCancel.hidden = false;
      }
      renderCurrentBlock();
      rail.noteFold.open = true;
      rail.noteInput.focus();
    });
    undo.addEventListener("click", () => {
      if (dispatch({ type: "UNSET_DECISION", blockId: block.id }, strings.decisionUndone)) {
        focusBlock(block.id);
      }
    });
    return created;
  }

  function createBlockControls(
    block: ReviewDocumentV1["blocks"][number],
  ): void {
    const article = landmarks.main.querySelector<HTMLElement>(`article#block-${block.id}`);
    if (article === null) return;
    article.tabIndex = -1;
    article.addEventListener("focusin", () => {
      currentBlockId = block.id;
      renderCurrentBlock();
    });
    article.addEventListener("pointerdown", () => {
      currentBlockId = block.id;
      renderCurrentBlock();
    });
    const eligibilityStatus = elementWithText(document, "p", strings.eligibilityUnavailable);
    eligibilityStatus.className = "execution-eligibility";
    eligibilityStatus.dataset.eligibility = "unavailable";
    article.append(eligibilityStatus);
    eligibilityControls.set(block.id, eligibilityStatus);
    if (documentValue.approvals.currentFrozen.includes(block.id)) {
      const container = document.createElement("section");
      container.className = "reopen-controls";
      const status = elementWithText(document, "p", strings.frozenNotReopened);
      status.className = "reopen-status";
      const button = buttonWithText(document, strings.reopenBlock, "reopen-block secondary-action");
      button.addEventListener("click", () => {
        const result = reopenFrozenBlock(documentValue, state, block.id);
        if (acceptResult(result, strings.blockReopened)) {
          focusBlock(block.id);
        }
      });
      container.append(status, button);
      article.append(container);
      reopenControls.set(block.id, { container, button, status });
      if (!state.reopened.has(block.id)) return;
    }
    createDecisionControls(block, article);
  }

  for (const block of documentValue.blocks) createBlockControls(block);

  const interactionRail = document.createElement("section");
  interactionRail.className = "review-interactions";
  interactionRail.setAttribute("aria-label", strings.decisionStatus);
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "decision-search";
  searchInput.className = "rail-search";
  searchInput.placeholder = strings.searchPlaceholder;
  const currentBlock = elementWithText(document, "p", "");
  currentBlock.className = "rail-current";
  const stats = document.createElement("ul");
  stats.className = "stats";
  stats.setAttribute("aria-label", strings.decisionStatus);
  const statValues = new Map<DecisionAction | "PENDING", HTMLElement>();
  for (const key of ["PASS", "EDIT", "TOPIC", "HOLD", "PENDING"] as const) {
    const item = document.createElement("li");
    item.className = "cnt";
    const value = elementWithText(document, "b", "");
    const label = key === "PENDING"
      ? strings.actionPending
      : decisionActionLabel(key, strings);
    item.append(stateDot(document, key), elementWithText(document, "span", `${label} `), value);
    stats.append(item);
    statValues.set(key, value);
  }

  const decisionsHeading = elementWithText(document, "h3", strings.decisionStatus);
  const decisionsList = document.createElement("div");
  decisionsList.className = "decision-list";

  const notesHeading = elementWithText(document, "h3", strings.sideNotes);
  const noteInput = document.createElement("textarea");
  noteInput.id = "side-note-input";
  noteInput.rows = 3;
  noteInput.placeholder = strings.sideNotePlaceholder;
  const noteSubmit = buttonWithText(document, strings.addSideNote);
  const noteCancel = buttonWithText(document, strings.cancel, "secondary-action");
  noteCancel.hidden = true;
  const noteButtons = document.createElement("div");
  noteButtons.className = "inline-actions";
  noteButtons.append(noteSubmit, noteCancel);
  const notesList = document.createElement("div");
  notesList.className = "side-note-list";

  const topicsHeading = elementWithText(document, "h3", strings.topics);
  const topicTitle = document.createElement("input");
  topicTitle.type = "text";
  topicTitle.id = "global-topic-title";
  const topicNote = document.createElement("textarea");
  topicNote.id = "global-topic-note";
  topicNote.rows = 2;
  topicNote.placeholder = strings.topicNote;
  const topicSubmit = buttonWithText(document, strings.addTopic, "newtopic");
  const topicCancel = buttonWithText(document, strings.cancel, "secondary-action");
  topicCancel.hidden = true;
  const topicButtons = document.createElement("div");
  topicButtons.className = "inline-actions";
  topicButtons.append(topicSubmit, topicCancel);
  const topicsList = document.createElement("div");
  topicsList.className = "topic-list";

  const overall = document.createElement("textarea");
  overall.id = "overall-review";
  overall.rows = 3;
  overall.placeholder = strings.overallPlaceholder;
  const overallSubmit = buttonWithText(document, strings.saveOverall);

  // The note editor writes to a specific block (spec §9.2 keeps every side note
  // block-bound), so the fold names its target before the input.
  const noteTarget = document.createElement("p");
  noteTarget.className = "note-target";
  const noteFold = railFold(document, strings.addSideNote, [
    noteTarget,
    labelControl(document, strings.sideNotes, noteInput),
    noteButtons,
  ]);
  const topicFold = railFold(document, strings.addTopic, [
    labelControl(document, strings.topicTitle, topicTitle),
    labelControl(document, strings.topicNote, topicNote),
    topicButtons,
  ]);
  interactionRail.append(
    labelControl(document, strings.search, searchInput),
    stats,
    currentBlock,
    decisionsHeading,
    decisionsList,
    notesHeading,
    notesList,
    noteFold,
    topicsHeading,
    topicsList,
    topicFold,
    railFold(document, strings.overall, [
      labelControl(document, strings.overall, overall),
      overallSubmit,
    ]),
  );
  landmarks.rail.append(interactionRail);
  const rail: RailControls = {
    search: searchInput,
    currentBlock,
    decisions: decisionsList,
    noteInput,
    noteSubmit,
    noteCancel,
    notes: notesList,
    topicTitle,
    topicNote,
    topicSubmit,
    topicCancel,
    topics: topicsList,
    overall,
    overallSubmit,
    noteFold,
    topicFold,
    noteTarget,
  };

  const dialog = document.createElement("dialog");
  dialog.className = "modal review-dialog";
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);

  // The sticky header grows and shrinks with the warn/final/restore bars, so the
  // rail offset and the block scroll margin follow its measured height instead
  // of a fixed guess that would hide the top of the rail.
  function syncHeaderOffset(): void {
    const root: { style?: { setProperty?: (name: string, value: string) => void } } | undefined =
      document.documentElement;
    const measure = landmarks.header.getBoundingClientRect as (() => DOMRect) | undefined;
    if (root?.style?.setProperty === undefined || measure === undefined) return;
    const { height } = measure.call(landmarks.header);
    if (!Number.isFinite(height) || height <= 0) return;
    root.style.setProperty("--header-h", `${Math.ceil(height)}px`);
  }

  function announce(message: string): void {
    landmarks.status.textContent = "";
    visibleFeedback.textContent = message;
    visibleFeedback.hidden = false;
    window.setTimeout(() => {
      landmarks.status.textContent = message;
    }, 0);
  }

  function resetNoteEditor(): void {
    editingNote = undefined;
    rail.noteInput.value = "";
    rail.noteSubmit.textContent = strings.addSideNote;
    rail.noteCancel.hidden = true;
  }

  function resetTopicEditor(): void {
    editingGlobalTopicId = undefined;
    rail.topicTitle.value = "";
    rail.topicNote.value = "";
    rail.topicSubmit.textContent = strings.addTopic;
    rail.topicCancel.hidden = true;
  }

  function focusBlock(blockId: string | undefined): void {
    if (blockId === undefined) return;
    const controls = blockControls.get(blockId);
    const article = controls?.article
      ?? landmarks.main.querySelector<HTMLElement>(`article#block-${blockId}`);
    if (article === null || article === undefined) return;
    if (article.hidden) {
      search = "";
      rail.search.value = "";
      filter = "all";
      render();
    }
    currentBlockId = blockId;
    renderCurrentBlock();
    article.focus({ preventScroll: true });
    article.scrollIntoView({ block: "nearest" });
  }

  function renderCurrentBlock(): void {
    for (const block of documentValue.blocks) {
      const article = blockControls.get(block.id)?.article
        ?? landmarks.main.querySelector<HTMLElement>(`article#block-${block.id}`);
      if (article === null || article === undefined) continue;
      const current = block.id === currentBlockId;
      article.dataset.current = String(current);
      // `.blk` carries tier, freeze, decision and cursor state in one class list,
      // which is what drives the card's left border and focus ring.
      const parts = ["blk", `tier-${block.tier}`];
      if (documentValue.approvals.currentFrozen.includes(block.id) && !state.reopened.has(block.id)) {
        parts.push("frozen");
      }
      const decision = state.decisionsByBlock.get(block.id);
      if (decision !== undefined) parts.push(`st-${decision.action}`);
      if (current) parts.push("focused");
      article.className = parts.join(" ");
    }
    rail.currentBlock.textContent = `${strings.currentBlock}: ${currentBlockId ?? strings.none}`;
    const noteTargetId = editingNote?.blockId ?? currentBlockId;
    const noteTargetBlock = noteTargetId === undefined
      ? undefined
      : documentValue.blocks.find((value) => value.id === noteTargetId);
    rail.noteTarget.textContent = noteTargetBlock === undefined
      ? strings.noteTargetNone
      : `${strings.noteTarget} ${noteTargetBlock.id} · ${noteTargetBlock.title}`;
  }

  // One `.d-list` row: the block link (or a plain marker for a global record),
  // the truncating `.nt` text and the compact `.rb` record buttons.
  function railRow(
    lead: { readonly blockId: string } | { readonly label: string },
    text: string,
    buttons: readonly HTMLButtonElement[],
  ): HTMLLIElement {
    const item = document.createElement("li");
    if ("blockId" in lead) {
      const link = elementWithText(document, "a", lead.blockId);
      link.href = `#block-${lead.blockId}`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        focusBlock(lead.blockId);
      });
      item.append(link);
    } else {
      const marker = elementWithText(document, "span", lead.label);
      marker.className = "b-id";
      item.append(marker);
    }
    const note = elementWithText(document, "span", text);
    note.className = "nt";
    note.lang = documentValue.document.language;
    note.title = text;
    item.append(note, ...buttons);
    return item;
  }

  function renderDecisionLists(): void {
    const searchMatches = new Set(visibleBlockIds(documentValue, state, "all", search));
    rail.decisions.replaceChildren();
    const decisions = documentValue.blocks.flatMap((block) => {
      const decision = state.decisionsByBlock.get(block.id);
      return decision === undefined || !searchMatches.has(block.id) ? [] : [{ block, decision }];
    });
    if (decisions.length === 0) {
      const empty = elementWithText(document, "p", strings.noDecisions);
      empty.className = "empty";
      rail.decisions.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "d-list";
      for (const { block, decision } of decisions) {
        const detail = decisionDetail(decision, state);
        const edit = iconButton(document, "✎", strings.edit, "rb");
        edit.addEventListener("click", () => {
          currentBlockId = block.id;
          renderCurrentBlock();
          const opener = edit;
          if (decision.action === "PASS") {
            focusBlock(block.id);
          } else {
            openDecisionEditor(block.id, decision.action, opener);
          }
        });
        const remove = iconButton(document, "✕", strings.undoDecision, "rb");
        remove.addEventListener("click", () => {
          dispatch({ type: "UNSET_DECISION", blockId: block.id }, strings.decisionUndone);
          focusBlock(block.id);
        });
        list.append(railRow(
          { blockId: block.id },
          `${decisionActionLabel(decision.action, strings)}${detail === "" ? "" : ` — ${detail}`}`,
          [edit, remove],
        ));
      }
      rail.decisions.append(list);
    }

    rail.notes.replaceChildren();
    const notes = [...state.sideNotesById.values()].filter((note) => (
      search === ""
      || `${note.blockId} ${note.note}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    ));
    if (notes.length === 0) {
      const empty = elementWithText(document, "p", strings.noSideNotes);
      empty.className = "empty";
      rail.notes.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "d-list";
      for (const note of notes) {
        const edit = iconButton(document, "✎", strings.edit, "rb");
        edit.addEventListener("click", () => {
          currentBlockId = note.blockId;
          editingNote = { id: note.id, blockId: note.blockId };
          rail.noteInput.value = note.note;
          rail.noteSubmit.textContent = strings.save;
          rail.noteCancel.hidden = false;
          renderCurrentBlock();
          rail.noteFold.open = true;
          rail.noteInput.focus();
        });
        const remove = iconButton(document, "✕", strings.delete, "rb");
        remove.addEventListener("click", () => {
          dispatch({ type: "DELETE_SIDE_NOTE", noteId: note.id }, strings.delete);
          if (editingNote?.id === note.id) resetNoteEditor();
        });
        list.append(railRow(
          { blockId: note.blockId },
          `${note.id} · ${note.note}`,
          [edit, remove],
        ));
      }
      rail.notes.append(list);
    }

    rail.topics.replaceChildren();
    const topics = [...state.topicsById.values()].filter((topic) => (
      search === ""
      || `${topic.id} ${topic.sourceBlockId ?? ""} ${topic.title} ${topic.note ?? ""}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase())
    ));
    if (topics.length === 0) {
      const empty = elementWithText(document, "p", strings.noTopics);
      empty.className = "empty";
      rail.topics.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "d-list";
      for (const topic of topics) {
        const edit = iconButton(document, "✎", strings.edit, "rb");
        edit.addEventListener("click", () => {
          if (topic.sourceBlockId !== undefined) {
            currentBlockId = topic.sourceBlockId;
            renderCurrentBlock();
            openDecisionEditor(topic.sourceBlockId, "TOPIC", edit);
            return;
          }
          editingGlobalTopicId = topic.id;
          rail.topicTitle.value = topic.title;
          rail.topicNote.value = topic.note ?? "";
          rail.topicSubmit.textContent = strings.save;
          rail.topicCancel.hidden = false;
          rail.topicFold.open = true;
          rail.topicTitle.focus();
        });
        const remove = iconButton(document, "✕", strings.delete, "rb");
        remove.addEventListener("click", () => {
          dispatch({ type: "DELETE_TOPIC", topicId: topic.id }, strings.delete);
          if (editingGlobalTopicId === topic.id) resetTopicEditor();
        });
        list.append(railRow(
          topic.sourceBlockId === undefined
            ? { label: strings.globalTopic }
            : { blockId: topic.sourceBlockId },
          `${topic.id} · ${topic.title}${topic.note === undefined ? "" : ` · ${topic.note}`}`,
          [edit, remove],
        ));
      }
      rail.topics.append(list);
    }
  }

  function render(): void {
    for (const blockId of state.reopened) {
      if (blockControls.has(blockId)) continue;
      const block = documentValue.blocks.find((item) => item.id === blockId);
      const article = landmarks.main.querySelector<HTMLElement>(`article#block-${blockId}`);
      if (block !== undefined && article !== null) createDecisionControls(block, article);
    }
    const progress = reviewProgress(documentValue, state);
    const decisionStats = reviewStats(state);
    const eligibility = executionEligibility(documentValue, state);
    const eligible = new Set(eligibility.ok ? eligibility.value.eligibleBlockIds : []);
    const suspended = new Set(eligibility.ok ? eligibility.value.suspendedBlockIds : []);
    progressText.textContent = `${progress.decided} ${strings.of} ${progress.total}`;
    const percent = progress.total === 0
      ? 0
      : Math.round((progress.decided / progress.total) * 100);
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuemax", String(progress.total));
    progressBar.setAttribute("aria-valuenow", String(progress.decided));
    progressBar.setAttribute(
      "aria-valuetext",
      `${strings.progress}: ${progress.decided} ${strings.of} ${progress.total}`,
    );
    finalbar.hidden = progress.total === 0 || progress.decided < progress.total;
    for (const [tier, value] of tierCountValues) {
      const active = documentValue.blocks.filter((block) => (
        block.tier === tier
        && (!documentValue.approvals.currentFrozen.includes(block.id)
          || state.reopened.has(block.id))
      ));
      const decided = active.filter((block) => state.decisionsByBlock.has(block.id)).length;
      value.textContent = `${decided}/${active.length}`;
    }
    for (const [key, value] of statValues) {
      value.textContent = String(
        key === "PENDING" ? progress.total - progress.decided : decisionStats[key],
      );
    }
    for (const [value, button] of filterButtons) {
      const active = value === filter;
      button.className = active ? "on" : "";
      button.setAttribute("aria-pressed", String(active));
    }
    const visible = visibleBlockIds(documentValue, state, filter, search);
    const visibleSet = new Set(visible);
    if (currentBlockId !== undefined && !visibleSet.has(currentBlockId) && visible.length > 0) {
      currentBlockId = visible[0];
    }
    for (const block of documentValue.blocks) {
      const effectivelyFrozen = documentValue.approvals.currentFrozen.includes(block.id)
        && !state.reopened.has(block.id);
      const reopen = reopenControls.get(block.id);
      if (reopen !== undefined) {
        reopen.button.hidden = !effectivelyFrozen;
        reopen.status.textContent = effectivelyFrozen ? strings.frozenNotReopened : strings.reopenedActive;
        reopen.container.dataset.reopened = String(!effectivelyFrozen);
      }
      const eligibilityStatus = eligibilityControls.get(block.id);
      if (eligibilityStatus !== undefined) {
        const derived = eligible.has(block.id)
          ? "eligible"
          : suspended.has(block.id) ? "suspended" : "unavailable";
        eligibilityStatus.dataset.eligibility = derived;
        eligibilityStatus.textContent = derived === "eligible"
          ? strings.eligibilityEligible
          : derived === "suspended"
            ? strings.eligibilitySuspended
            : strings.eligibilityUnavailable;
      }
      const controls = blockControls.get(block.id);
      const article = controls?.article
        ?? landmarks.main.querySelector<HTMLElement>(`article#block-${block.id}`);
      if (article !== null && article !== undefined) article.hidden = !visibleSet.has(block.id);
      if (controls === undefined) continue;
      controls.actions.hidden = effectivelyFrozen;
      controls.status.hidden = effectivelyFrozen;
      const decision = state.decisionsByBlock.get(block.id);
      const detail = decision === undefined ? "" : decisionDetail(decision, state);
      const summary = decision === undefined
        ? strings.actionPending
        : `${decisionActionLabel(decision.action, strings)}${detail === "" ? "" : ` · ${detail}`}`;
      controls.status.className = decision === undefined ? "st-chip pending" : "st-chip";
      controls.statusDot.className = `dot d-${decision?.action ?? "PENDING"}`;
      controls.statusText.textContent = summary;
      controls.status.title = `${strings.decisionStatus}: ${summary}`;
      controls.status.dataset.action = decision?.action ?? "PENDING";
      setQuoteView(controls.quote, decision?.quote, strings);
      for (const [action, button] of controls.actionButtons) {
        const pressed = decision?.action === action;
        button.setAttribute("aria-pressed", String(pressed));
        button.className = `act a-${action}${pressed ? " on" : ""}`;
      }
      const annotated = [...state.sideNotesById.values()]
        .some((note) => note.blockId === block.id);
      controls.sideNote.className = `act sidenote${annotated ? " has" : ""}`;
      controls.undo.hidden = decision === undefined;
    }
    const preview = bulkPassPreview(documentValue, state, visible);
    bulkButton.disabled = preview.blockIds.length === 0;
    bulkButton.textContent = `${strings.bulkPass} (${preview.blockIds.length})`;
    if (document.activeElement !== rail.overall) rail.overall.value = state.overall;
    renderCurrentBlock();
    renderDecisionLists();
    syncHeaderOffset();
  }

  function acceptResult(
    result: ReviewReducerResult,
    message: string,
    mode: "apply" | "clear" = "apply",
  ): boolean {
    if (!result.ok) {
      announce(reducerErrorMessage(result.code, strings));
      return false;
    }
    const hook = mode === "clear" ? stateHooks?.clear : stateHooks?.apply;
    if (hook !== undefined && !hook(result.state).accepted) {
      announce(strings.stateCommitFailed);
      return false;
    }
    state = result.state;
    render();
    announce(message);
    return true;
  }

  function dispatch(action: ReviewAction, message: string): boolean {
    return acceptResult(reduceReviewState(documentValue, state, action), message);
  }

  function focusAfterDecision(blockId: string): void {
    const next = nextPendingBlockId(documentValue, state, blockId);
    if (next === undefined) {
      focusBlock(blockId);
      announce(`${strings.decisionSaved} · ${strings.progress}: ${reviewProgress(documentValue, state).decided} ${strings.of} ${reviewProgress(documentValue, state).total}`);
      return;
    }
    focusBlock(next);
  }

  // The action chips carry `aria-pressed`, so re-activating the recorded action
  // honours toggle semantics (spec §9.1 requires revocation back to pending).
  // PASS holds no reviewer text and unsets immediately; the input-bearing
  // actions reopen their prefilled editor instead — unsetting them on a single
  // press would destroy typed review text — and the editor offers the explicit
  // revoke button.
  function activateAction(blockId: string, action: DecisionAction, opener: HTMLElement): void {
    const existing = state.decisionsByBlock.get(blockId);
    if (existing?.action === action && action === "PASS") {
      dispatch({ type: "UNSET_DECISION", blockId }, strings.decisionUndone);
      return;
    }
    if (action === "PASS") applyPass(blockId);
    else openDecisionEditor(blockId, action, opener);
  }

  function applyPass(blockId: string): void {
    const controls = blockControls.get(blockId);
    if (controls === undefined) return;
    const quote = selectedQuote(controls.article);
    const decision: DecisionInput = quote === undefined
      ? { action: "PASS" }
      : { action: "PASS", quote };
    if (dispatch({ type: "SET_DECISION", blockId, decision }, strings.decisionSaved)) {
      focusAfterDecision(blockId);
    }
  }

  function closeEditor(restoreFocus: boolean): void {
    const context = editorContext;
    editorContext = undefined;
    if (dialog.open) dialog.close();
    if (restoreFocus && context?.opener.isConnected === true) context.opener.focus();
  }

  function dialogQuote(quote: string | undefined): HTMLElement {
    const container = document.createElement("div");
    container.className = "quoted dialog-quote";
    if (quote === undefined) {
      container.append(elementWithText(document, "p", strings.quoteNone));
    } else {
      container.append(
        elementWithText(document, "p", strings.quote),
        elementWithText(document, "blockquote", quote),
      );
    }
    return container;
  }

  function openDecisionEditor(
    blockId: string,
    action: Exclude<DecisionAction, "PASS">,
    opener: HTMLElement,
  ): void {
    const controls = blockControls.get(blockId);
    if (controls === undefined) return;
    const quote = selectedQuote(controls.article)
      ?? state.decisionsByBlock.get(blockId)?.quote;
    editorContext = quote === undefined
      ? { kind: "decision", blockId, action, opener }
      : { kind: "decision", blockId, action, quote, opener };
    const headingText = action === "EDIT"
      ? strings.editorEditTitle
      : action === "TOPIC" ? strings.editorTopicTitle : strings.editorHoldTitle;
    const heading = elementWithText(document, "h2", headingText);
    heading.id = "review-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const block = documentValue.blocks.find((value) => value.id === blockId);
    const blockLabel = elementWithText(document, "p", `${blockId} — ${block?.title ?? ""}`);
    blockLabel.lang = documentValue.document.language;
    const error = elementWithText(document, "p", strings.noteRequired);
    error.className = "dialog-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const fields = document.createElement("div");
    fields.className = "dialog-fields";
    const existing = state.decisionsByBlock.get(blockId);
    if (action === "TOPIC") {
      const title = document.createElement("input");
      title.type = "text";
      title.required = true;
      title.dataset.field = "title";
      const note = document.createElement("textarea");
      note.rows = 4;
      note.dataset.field = "note";
      if (existing?.action === "TOPIC") {
        const topic = state.topicsById.get(existing.topicId);
        title.value = topic?.title ?? "";
        note.value = topic?.note ?? "";
      }
      fields.append(
        labelControl(document, strings.topicTitle, title),
        labelControl(document, strings.topicNote, note),
      );
    } else {
      const note = document.createElement("textarea");
      note.rows = 6;
      note.required = true;
      note.dataset.field = "note";
      if (existing?.action === action) note.value = existing.note;
      fields.append(labelControl(document, headingText, note));
    }
    const save = buttonWithText(document, strings.save, "dialog-save");
    const cancel = buttonWithText(document, strings.cancel, "secondary-action dialog-cancel");
    save.addEventListener("click", submitEditor);
    cancel.addEventListener("click", () => closeEditor(true));
    const buttons = document.createElement("div");
    buttons.className = "dialog-actions";
    buttons.append(save, cancel);
    if (existing?.action === action) {
      // Editing an already-recorded decision: revocation lives here so a
      // repeated chip press never silently deletes typed review text.
      const revoke = buttonWithText(document, strings.undoDecision, "secondary-action dialog-delete");
      revoke.addEventListener("click", () => {
        if (dispatch({ type: "UNSET_DECISION", blockId }, strings.decisionUndone)) {
          closeEditor(true);
        }
      });
      buttons.append(revoke);
    }
    dialog.replaceChildren(heading, blockLabel, dialogQuote(quote), fields, error, buttons);
    dialog.showModal();
    const firstField = dialog.querySelector<HTMLElement>("input,textarea");
    firstField?.focus();
  }

  function openBulkEditor(): void {
    const visible = visibleBlockIds(documentValue, state, filter, search);
    const preview = bulkPassPreview(documentValue, state, visible);
    if (preview.blockIds.length === 0) return;
    editorContext = { kind: "bulk", preview, opener: bulkButton };
    const heading = elementWithText(document, "h2", strings.bulkConfirmTitle);
    heading.id = "review-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const scope = elementWithText(
      document,
      "p",
      `${strings.bulkScope}: ${preview.blockIds.length} · T0 ${preview.t0} · T1 ${preview.t1}`,
    );
    const excluded = elementWithText(
      document,
      "p",
      `${strings.bulkT2Excluded}: ${preview.excludedT2}`,
    );
    const confirm = buttonWithText(document, strings.bulkConfirm, "dialog-save");
    const cancel = buttonWithText(document, strings.cancel, "secondary-action dialog-cancel");
    confirm.addEventListener("click", submitEditor);
    cancel.addEventListener("click", () => closeEditor(true));
    const buttons = document.createElement("div");
    buttons.className = "dialog-actions";
    buttons.append(confirm, cancel);
    dialog.replaceChildren(heading, scope, excluded, buttons);
    dialog.showModal();
    confirm.focus();
  }

  function submitEditor(): void {
    const context = editorContext;
    if (context === undefined) return;
    if (context.kind === "bulk") {
      const { preview } = context;
      if (dispatch(
        { type: "BULK_PASS", blockIds: preview.blockIds },
        `${strings.bulkPassed}: ${preview.blockIds.length} · ${strings.bulkT2Excluded}: ${preview.excludedT2}`,
      )) {
        editorContext = undefined;
        dialog.close();
        focusBlock(nextPendingBlockId(documentValue, state, currentBlockId));
      }
      return;
    }
    const note = dialog.querySelector<HTMLTextAreaElement>("[data-field='note']")?.value ?? "";
    const title = dialog.querySelector<HTMLInputElement>("[data-field='title']")?.value ?? "";
    let decision: DecisionInput;
    if (context.action === "TOPIC") {
      decision = context.quote === undefined
        ? { action: "TOPIC", title, note }
        : { action: "TOPIC", title, note, quote: context.quote };
    } else {
      decision = context.quote === undefined
        ? { action: context.action, note }
        : { action: context.action, note, quote: context.quote };
    }
    const result = reduceReviewState(documentValue, state, {
      type: "SET_DECISION",
      blockId: context.blockId,
      decision,
    });
    if (!result.ok) {
      const error = dialog.querySelector<HTMLElement>(".dialog-error");
      if (error !== null) {
        error.textContent = reducerErrorMessage(result.code, strings);
        error.hidden = false;
      }
      dialog.querySelector<HTMLElement>("input,textarea")?.focus();
      return;
    }
    if (stateHooks?.apply !== undefined && !stateHooks.apply(result.state).accepted) {
      const error = dialog.querySelector<HTMLElement>(".dialog-error");
      if (error !== null) {
        error.textContent = strings.stateCommitFailed;
        error.hidden = false;
      }
      return;
    }
    state = result.state;
    const decidedBlock = context.blockId;
    editorContext = undefined;
    dialog.close();
    render();
    announce(strings.decisionSaved);
    focusAfterDecision(decidedBlock);
  }

  bulkButton.addEventListener("click", openBulkEditor);
  rail.search.addEventListener("input", () => {
    search = rail.search.value.trim();
    render();
  });
  rail.noteSubmit.addEventListener("click", () => {
    const target = editingNote?.blockId ?? currentBlockId;
    if (target === undefined) return;
    const action: ReviewAction = editingNote === undefined
      ? { type: "SET_SIDE_NOTE", blockId: target, note: rail.noteInput.value }
      : {
        type: "SET_SIDE_NOTE",
        blockId: target,
        noteId: editingNote.id,
        note: rail.noteInput.value,
      };
    if (dispatch(action, strings.save)) resetNoteEditor();
  });
  rail.noteCancel.addEventListener("click", () => {
    resetNoteEditor();
    renderCurrentBlock();
  });
  rail.topicSubmit.addEventListener("click", () => {
    const action: ReviewAction = editingGlobalTopicId === undefined
      ? { type: "ADD_TOPIC", title: rail.topicTitle.value, note: rail.topicNote.value }
      : {
        type: "UPDATE_TOPIC",
        topicId: editingGlobalTopicId,
        title: rail.topicTitle.value,
        note: rail.topicNote.value,
      };
    if (dispatch(action, strings.save)) resetTopicEditor();
  });
  rail.topicCancel.addEventListener("click", resetTopicEditor);
  rail.overallSubmit.addEventListener("click", () => {
    dispatch({ type: "SET_OVERALL", overall: rail.overall.value }, strings.save);
  });

  for (const [field, submit] of [
    [rail.noteInput, rail.noteSubmit],
    [rail.topicTitle, rail.topicSubmit],
    [rail.topicNote, rail.topicSubmit],
    [rail.overall, rail.overallSubmit],
  ] as const) {
    field.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === "Enter" && (keyboardEvent.metaKey || keyboardEvent.ctrlKey)) {
        keyboardEvent.preventDefault();
        submit.click();
      } else if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        if (field === rail.noteInput) resetNoteEditor();
        else if (field === rail.topicTitle || field === rail.topicNote) resetTopicEditor();
      }
    });
  }

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditor(true);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitEditor();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = focusableElements(dialog);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.body.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]") !== null || isTextEntry(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      const visible = visibleBlockIds(documentValue, state, filter, search);
      focusBlock(nextBlockId(visible, currentBlockId, event.key === "j" ? 1 : -1));
      return;
    }
    if (event.key === "n") {
      event.preventDefault();
      focusBlock(nextPendingBlockId(documentValue, state, currentBlockId));
      return;
    }
    const action = ({ "1": "PASS", "2": "EDIT", "3": "TOPIC", "4": "HOLD" } as const)[
      event.key as "1" | "2" | "3" | "4"
    ];
    if (action === undefined || currentBlockId === undefined) return;
    event.preventDefault();
    const controls = blockControls.get(currentBlockId);
    if (controls === undefined || controls.actions.hidden) {
      announce(strings.frozen);
      return;
    }
    const opener = controls.actionButtons.get(action);
    if (opener === undefined) return;
    activateAction(currentBlockId, action, opener);
  });

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", syncHeaderOffset);
  }
  mountTermTip(document);
  render();
  return {
    getState: () => cloneWorkbenchReviewState(state),
    replaceState(next, message) {
      const accepted = acceptResult(
        reduceReviewState(documentValue, state, { type: "IMPORT_STATE", state: next }),
        message,
      );
      if (accepted) {
        resetNoteEditor();
        resetTopicEditor();
      }
      return accepted;
    },
    clearReview(message) {
      const accepted = acceptResult(
        reduceReviewState(documentValue, state, { type: "CLEAR_REVIEW" }),
        message,
        "clear",
      );
      if (accepted) {
        resetNoteEditor();
        resetTopicEditor();
      }
      return accepted;
    },
    announce,
  };
}
