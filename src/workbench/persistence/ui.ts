import {
  computeReviewDigest,
  type ReviewDocumentV1,
  type Sha256Digest,
} from "../../protocol/index.js";
import type { WorkbenchStrings } from "../i18n.js";
import type { ReviewInteractionController } from "../interactions.js";
import { createReviewPacketExportCache } from "../packet.js";
import { importReviewStateText, serializeReviewStateJson } from "../state.js";
import type { PersistenceSession } from "./session.js";

type ExportKind = "packet-json" | "packet-markdown" | "state";

interface ExportSnapshot {
  readonly kind: ExportKind;
  readonly content: string;
  readonly capturedDigest: Sha256Digest;
  readonly capturedAt: string;
  readonly recordCount: number;
  readonly filename: string;
  readonly mime: string;
}

export interface PersistenceControls {
  renderStatus(): void;
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

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hidden);
}

function stateRecordCount(controller: ReviewInteractionController): number {
  const state = controller.getState();
  return state.decisionsByBlock.size
    + state.sideNotesById.size
    + state.topicsById.size
    + state.reopened.size
    + (state.overall === "" ? 0 : 1);
}

export function safeWindowLocalStorage(ownerWindow: Window): Storage | undefined {
  try {
    return ownerWindow.localStorage;
  } catch {
    return undefined;
  }
}

export function mountPersistenceControls(input: {
  readonly documentValue: ReviewDocumentV1;
  readonly strings: WorkbenchStrings;
  readonly rail: HTMLElement;
  readonly controller: ReviewInteractionController;
  readonly session: PersistenceSession;
  readonly now?: () => Date;
}): PersistenceControls {
  const { documentValue, strings, rail, controller, session } = input;
  const now = input.now ?? (() => new Date());
  const ownerDocument = rail.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const packetCache = createReviewPacketExportCache(documentValue, now);
  let activeExport: ExportSnapshot | undefined;
  let activeExportStale: HTMLElement | undefined;
  let activeConfirmButton: HTMLButtonElement | undefined;
  let activeDialogOpener: HTMLElement | undefined;
  let observedDigest = session.snapshot().currentDigest;
  const reviewDigest = computeReviewDigest(documentValue);
  if (!reviewDigest.ok) throw new Error("REVIEW_DIGEST_INVALID");
  const documentReviewDigest = reviewDigest.value;

  const panel = ownerDocument.createElement("section");
  panel.className = "persistence-panel";
  panel.append(elementWithText(ownerDocument, "h3", strings.reviewRecovery));
  const status = elementWithText(ownerDocument, "p", "");
  status.className = "persistence-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = ownerDocument.createElement("div");
  actions.className = "inline-actions persistence-actions";
  const packetMarkdown = buttonWithText(ownerDocument, strings.exportPacketMarkdown);
  const packetJson = buttonWithText(ownerDocument, strings.exportPacketJson, "secondary-action");
  const exportState = buttonWithText(ownerDocument, strings.exportState, "secondary-action");
  const importState = buttonWithText(ownerDocument, strings.importState, "secondary-action");
  const clearReview = buttonWithText(ownerDocument, strings.clearReview, "secondary-action");
  actions.append(packetMarkdown, packetJson, exportState, importState, clearReview);
  panel.append(status, actions);
  rail.append(panel);

  const dialog = ownerDocument.createElement("dialog");
  dialog.className = "review-dialog persistence-dialog";
  dialog.setAttribute("aria-modal", "true");
  ownerDocument.body.append(dialog);

  function currentDigest(): Sha256Digest {
    return session.snapshot().currentDigest;
  }

  function exportIsFresh(snapshot: ExportSnapshot): boolean {
    return currentDigest() === snapshot.capturedDigest;
  }

  function renderActiveExportFreshness(): void {
    if (activeExport === undefined || activeExportStale === undefined) return;
    const stale = !exportIsFresh(activeExport);
    activeExportStale.hidden = !stale;
    if (activeConfirmButton !== undefined) activeConfirmButton.disabled = stale;
  }

  function statusMessage(snapshot = session.snapshot()): string {
    let current: string;
    if (snapshot.notice === "recovered") {
      current = `${strings.persistenceRecovered}: ${snapshot.recoveredAt ?? ""} · ${strings.recordCount}: ${snapshot.recoveredRecords ?? 0}`;
    } else if (snapshot.notice === "manual-exported") {
      current = strings.persistenceManualExported;
    } else if (snapshot.notice === "unsaved") {
      current = strings.persistenceUnsaved;
    } else if (snapshot.notice === "recovery-invalid") {
      current = strings.persistenceInvalid;
    } else {
      current = strings.persistenceSaved;
    }
    return snapshot.recoveryInvalid && snapshot.notice !== "recovery-invalid"
      ? `${strings.persistenceInvalid} · ${current}`
      : current;
  }

  function renderStatus(): void {
    const snapshot = session.snapshot();
    if (snapshot.currentDigest !== observedDigest) {
      observedDigest = snapshot.currentDigest;
      packetCache.invalidate();
    }
    status.textContent = statusMessage(snapshot);
    status.dataset.persistence = snapshot.notice;
    renderActiveExportFreshness();
  }

  function closeDialog(restore = activeDialogOpener): void {
    activeExport = undefined;
    activeExportStale = undefined;
    activeConfirmButton = undefined;
    if (dialog.open) dialog.close();
    activeDialogOpener = undefined;
    if (restore?.isConnected === true) restore.focus();
  }

  function showDialog(
    title: string,
    opener: HTMLElement,
    children: readonly Node[],
    primary?: HTMLElement,
  ): void {
    const heading = elementWithText(ownerDocument, "h2", title);
    heading.id = "persistence-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.replaceChildren(heading, ...children);
    activeDialogOpener = opener;
    dialog.showModal();
    (primary ?? focusableElements(dialog)[0])?.focus();
  }

  function confirmExport(snapshot: ExportSnapshot): boolean {
    if (!session.confirmExport(snapshot.capturedDigest)) {
      renderActiveExportFreshness();
      controller.announce(strings.exportStale);
      return false;
    }
    renderStatus();
    controller.announce(strings.exportConfirmed);
    return true;
  }

  function createExportSnapshot(kind: ExportKind): ExportSnapshot | undefined {
    const state = controller.getState();
    if (kind === "state") {
      const capturedAt = now().toISOString();
      const serialized = serializeReviewStateJson(documentValue, state, capturedAt);
      if (!serialized.ok) return undefined;
      return {
        kind,
        content: serialized.value,
        capturedDigest: currentDigest(),
        capturedAt,
        recordCount: stateRecordCount(controller),
        filename: `${documentValue.delivery.baseName}.review-state.json`,
        mime: "application/json;charset=utf-8",
      };
    }
    const packet = packetCache.get(state);
    if (!packet.ok) return undefined;
    return {
      kind,
      content: kind === "packet-json" ? packet.value.json : packet.value.markdown,
      capturedDigest: packet.value.stateDigest,
      capturedAt: packet.value.packet.reviewedAt,
      recordCount: packet.value.recordCount,
      filename: `${documentValue.delivery.baseName}.review-packet.${kind === "packet-json" ? "json" : "md"}`,
      mime: kind === "packet-json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
    };
  }

  function openExport(kind: ExportKind, opener: HTMLElement): void {
    const snapshot = createExportSnapshot(kind);
    if (snapshot === undefined) {
      controller.announce(strings.stateCommitFailed);
      return;
    }
    activeExport = snapshot;
    const metadata = elementWithText(
      ownerDocument,
      "p",
      `${strings.exportSnapshot}: ${snapshot.capturedAt} · ${strings.recordCount}: ${snapshot.recordCount}`,
    );
    const stale = elementWithText(ownerDocument, "p", strings.exportStale);
    stale.className = "dialog-error export-stale";
    stale.setAttribute("role", "alert");
    stale.hidden = true;
    activeExportStale = stale;
    const instructions = elementWithText(ownerDocument, "p", strings.manualCopyInstructions);
    const textarea = ownerDocument.createElement("textarea");
    textarea.className = "export-content";
    textarea.readOnly = true;
    textarea.rows = 14;
    textarea.value = snapshot.content;
    textarea.setAttribute("aria-label", strings.exportSnapshot);
    const copy = buttonWithText(ownerDocument, strings.copy);
    const download = buttonWithText(ownerDocument, strings.download, "secondary-action");
    const manual = buttonWithText(ownerDocument, strings.manualCopy, "secondary-action");
    const confirm = buttonWithText(
      ownerDocument,
      `${strings.confirmSaved} · ${snapshot.capturedAt} · ${strings.recordCount}: ${snapshot.recordCount}`,
      "secondary-action",
    );
    confirm.hidden = true;
    activeConfirmButton = confirm;
    const close = buttonWithText(ownerDocument, strings.close, "secondary-action");
    const result = elementWithText(ownerDocument, "p", "");
    result.className = "export-result";
    result.setAttribute("role", "status");
    const showManualFallback = (message: string): void => {
      result.textContent = message;
      textarea.focus();
      textarea.select();
      confirm.hidden = false;
    };
    copy.addEventListener("click", () => {
      let write: Promise<void>;
      try {
        const clipboard = ownerWindow.navigator.clipboard;
        if (clipboard === undefined) throw new Error("CLIPBOARD_UNAVAILABLE");
        write = clipboard.writeText(snapshot.content);
      } catch {
        showManualFallback(strings.clipboardFailed);
        return;
      }
      void write.then(() => {
        if (confirmExport(snapshot)) result.textContent = strings.exportConfirmed;
        else result.textContent = strings.exportStale;
      }).catch(() => {
        showManualFallback(strings.clipboardFailed);
      });
    });
    manual.addEventListener("click", () => {
      showManualFallback(strings.manualCopyInstructions);
    });
    download.addEventListener("click", () => {
      let url: string | undefined;
      try {
        url = ownerWindow.URL.createObjectURL(new Blob([snapshot.content], { type: snapshot.mime }));
        const createdUrl = url;
        const anchor = ownerDocument.createElement("a");
        anchor.href = createdUrl;
        anchor.download = snapshot.filename;
        anchor.hidden = true;
        ownerDocument.body.append(anchor);
        anchor.click();
        anchor.remove();
        ownerWindow.setTimeout(() => { ownerWindow.URL.revokeObjectURL(createdUrl); }, 0);
        confirm.hidden = false;
        result.textContent = strings.downloadStarted;
      } catch {
        if (url !== undefined) ownerWindow.URL.revokeObjectURL(url);
        showManualFallback(strings.clipboardFailed);
      }
    });
    confirm.addEventListener("click", () => {
      result.textContent = confirmExport(snapshot) ? strings.exportConfirmed : strings.exportStale;
    });
    close.addEventListener("click", () => closeDialog(opener));
    const buttons = ownerDocument.createElement("div");
    buttons.className = "dialog-actions";
    buttons.append(copy, download, manual, confirm, close);
    showDialog(strings.exportTitle, opener, [metadata, stale, instructions, textarea, result, buttons], copy);
  }

  function openImport(opener: HTMLElement): void {
    const identity = elementWithText(
      ownerDocument,
      "p",
      `${strings.identityBinding}: ${documentValue.document.id} · v${documentValue.document.contentVersion} · ${strings.round} ${documentValue.document.round} · ${documentReviewDigest}`,
    );
    const textarea = ownerDocument.createElement("textarea");
    textarea.rows = 14;
    textarea.setAttribute("aria-label", strings.importTitle);
    const legacy = ownerDocument.createElement("input");
    legacy.type = "checkbox";
    legacy.id = "legacy-identity-confirmation";
    const legacyLabel = ownerDocument.createElement("label");
    legacyLabel.append(legacy, ownerDocument.createTextNode(` ${strings.legacyConfirm}`));
    const error = elementWithText(ownerDocument, "p", "");
    error.className = "dialog-error import-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const submit = buttonWithText(ownerDocument, strings.importSubmit);
    const cancel = buttonWithText(ownerDocument, strings.cancel, "secondary-action");
    const doImport = (): void => {
      const imported = importReviewStateText(textarea.value, documentValue, {
        currentState: controller.getState(),
        ...(legacy.checked ? { legacyProfile: "prototype-v1", confirmIdentity: true } : {}),
      });
      if (!imported.ok) {
        error.textContent = `${strings.importFailed}: ${imported.errors.map((item) => `${item.code} ${item.path}`).join(", ")}`;
        error.hidden = false;
        textarea.focus();
        return;
      }
      if (!controller.replaceState(imported.value.workbenchState, strings.importSucceeded)) {
        error.textContent = strings.stateCommitFailed;
        error.hidden = false;
        return;
      }
      renderStatus();
      closeDialog(opener);
      controller.announce(`${strings.importSucceeded} · ${imported.value.sourceFormat}${imported.value.migrated ? " · prototype-v1" : ""}`);
    };
    submit.addEventListener("click", doImport);
    cancel.addEventListener("click", () => closeDialog(opener));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        doImport();
      }
    });
    const buttons = ownerDocument.createElement("div");
    buttons.className = "dialog-actions";
    buttons.append(submit, cancel);
    showDialog(strings.importTitle, opener, [identity, textarea, legacyLabel, error, buttons], textarea);
  }

  function openClear(opener: HTMLElement): void {
    const message = elementWithText(ownerDocument, "p", strings.clearConfirmTitle);
    const confirm = buttonWithText(ownerDocument, strings.clearConfirm);
    const cancel = buttonWithText(ownerDocument, strings.cancel, "secondary-action");
    const error = elementWithText(ownerDocument, "p", "");
    error.className = "dialog-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    confirm.addEventListener("click", () => {
      if (!controller.clearReview(strings.clearConfirm)) {
        error.textContent = strings.stateCommitFailed;
        error.hidden = false;
        return;
      }
      renderStatus();
      closeDialog(opener);
    });
    cancel.addEventListener("click", () => closeDialog(opener));
    const buttons = ownerDocument.createElement("div");
    buttons.className = "dialog-actions";
    buttons.append(confirm, cancel);
    showDialog(strings.clearConfirmTitle, opener, [message, error, buttons], confirm);
  }

  packetMarkdown.addEventListener("click", () => openExport("packet-markdown", packetMarkdown));
  packetJson.addEventListener("click", () => openExport("packet-json", packetJson));
  exportState.addEventListener("click", () => openExport("state", exportState));
  importState.addEventListener("click", () => openImport(importState));
  clearReview.addEventListener("click", () => openClear(clearReview));

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusables = focusableElements(dialog);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && ownerDocument.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && ownerDocument.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  renderStatus();
  const initial = session.snapshot();
  if (initial.notice === "recovered" || initial.notice === "recovery-invalid" || initial.notice === "unsaved") {
    controller.announce(statusMessage());
  }
  return { renderStatus };
}
